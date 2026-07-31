/**
 * Cancellation and reconnect behaviour.
 *
 * These cover the failure modes a long-running monitoring loop actually hits:
 * a supply that gets unplugged, and a caller that wants to give up on a
 * request without poisoning the connection for everyone else.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MockDevice } from '../src/testing/index.js';
import { ScpiSocket } from '../src/transport.js';
import { connect, type XLN } from '../src/xln.js';
import { XLNConnectionError } from '../src/errors.js';

let device: MockDevice | undefined;
let socket: ScpiSocket | undefined;
let psu: XLN | undefined;

afterEach(async () => {
  await psu?.close();
  await socket?.close();
  await device?.stop();
  psu = undefined;
  socket = undefined;
  device = undefined;
});

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('AbortSignal', () => {
  it('aborts a connection attempt in progress', async () => {
    const controller = new AbortController();
    // TEST-NET-1 never answers, so the attempt is still open when we abort.
    const client = new ScpiSocket({
      host: '192.0.2.1',
      port: 5025,
      connectTimeout: 10_000,
      signal: controller.signal,
    });
    const attempt = client.connect();
    setTimeout(() => {
      controller.abort();
    }, 30);
    await expect(attempt).rejects.toThrow(/aborted/i);
  });

  it('rejects immediately if the signal is already aborted', async () => {
    device = await MockDevice.start();
    socket = new ScpiSocket({ host: '127.0.0.1', port: device.port });
    await socket.connect();

    await expect(
      socket.query('*IDN?', { signal: AbortSignal.abort() }),
    ).rejects.toThrow(XLNConnectionError);
  });

  it('cancels an in-flight query without desynchronizing the stream', async () => {
    device = await MockDevice.start({ responseDelay: 150 });
    socket = new ScpiSocket({ host: '127.0.0.1', port: device.port });
    await socket.connect();

    const unsolicited: string[] = [];
    socket.on('unsolicited', (line) => unsolicited.push(line));

    const controller = new AbortController();
    const aborted = socket.query('SOURCE:VOLTAGE?', {
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 30);
    await expect(aborted).rejects.toThrow(/Aborted/);

    // The abandoned reply is discarded, not handed to the next caller.
    await wait(250);
    expect(unsolicited).toEqual(['0.000']);

    device.voltage = 7;
    await expect(socket.query('SOURCE:VOLTAGE?')).resolves.toBe('7.000');
  });

  it('honours a per-command timeout override', async () => {
    device = await MockDevice.start({ responseDelay: 200 });
    socket = new ScpiSocket({
      host: '127.0.0.1',
      port: device.port,
      timeout: 5000,
    });
    await socket.connect();

    await expect(
      socket.query('SOURCE:VOLTAGE?', { timeout: 40 }),
    ).rejects.toThrow(/Timed out after 40 ms/);
  });
});

describe('auto-reconnect', () => {
  it('is off by default', async () => {
    device = await MockDevice.start();
    socket = new ScpiSocket({ host: '127.0.0.1', port: device.port });
    await socket.connect();

    const closed = new Promise<void>((resolve) =>
      socket!.once('close', resolve),
    );
    await device.stop();
    await closed;

    expect(socket.connected).toBe(false);
  });

  it('reconnects after the device comes back', async () => {
    device = await MockDevice.start();
    const port = device.port;

    socket = new ScpiSocket({
      host: '127.0.0.1',
      port,
      autoReconnect: { minDelay: 20, maxDelay: 50 },
    });
    await socket.connect();

    const events: string[] = [];
    socket.on('disconnected', () => events.push('disconnected'));
    socket.on('connected', () => events.push('connected'));

    const reconnected = new Promise<void>((resolve) =>
      socket!.once('connected', resolve),
    );

    await device.stop();
    // Bring an identical device back up on the same port.
    device = await MockDevice.startOn(port);
    await reconnected;

    expect(events).toEqual(['disconnected', 'connected']);
    expect(socket.connected).toBe(true);
    await expect(socket.query('*IDN?')).resolves.toContain('XLN6024');
  });

  it('rejects commands while disconnected rather than buffering them', async () => {
    // Replaying setpoints into a supply that may have power-cycled is not
    // something the library should do implicitly.
    device = await MockDevice.start();
    socket = new ScpiSocket({
      host: '127.0.0.1',
      port: device.port,
      autoReconnect: { minDelay: 10_000 },
    });
    await socket.connect();

    const down = new Promise<void>((resolve) =>
      socket!.once('disconnected', () => {
        resolve();
      }),
    );
    await device.stop();
    await down;

    await expect(socket.query('*IDN?')).rejects.toThrow(XLNConnectionError);
  });

  it('gives up after maxAttempts and closes', async () => {
    device = await MockDevice.start();
    const port = device.port;
    socket = new ScpiSocket({
      host: '127.0.0.1',
      port,
      autoReconnect: { minDelay: 10, maxDelay: 10, maxAttempts: 2 },
      connectTimeout: 200,
    });
    await socket.connect();

    const closed = new Promise<void>((resolve) =>
      socket!.once('close', resolve),
    );
    await device.stop();
    device = undefined;
    await closed;

    expect(socket.connected).toBe(false);
  });

  it('stops reconnecting once closed deliberately', async () => {
    device = await MockDevice.start();
    socket = new ScpiSocket({
      host: '127.0.0.1',
      port: device.port,
      autoReconnect: { minDelay: 10 },
    });
    await socket.connect();

    let connects = 0;
    socket.on('connected', () => connects++);

    await socket.close();
    await device.stop();
    await wait(100);

    expect(connects).toBe(0);
    expect(socket.connected).toBe(false);
  });

  it('re-clears the device error queue after reconnecting', async () => {
    // A supply that dropped the link may have power-cycled with faults
    // queued; those must not be blamed on the caller's next command.
    device = await MockDevice.start();
    const port = device.port;

    psu = await connect({
      host: '127.0.0.1',
      port,
      autoReconnect: { minDelay: 20 },
    });

    const reconnected = new Promise<void>((resolve) =>
      psu!.socket.once('connected', resolve),
    );
    await device.stop();
    device = await MockDevice.startOn(port);
    device.pushError(-2);
    await reconnected;
    await wait(50);

    expect(device.received).toContain('*CLS');
    await expect(psu.setVoltage(5)).resolves.toBeUndefined();
  });
});
