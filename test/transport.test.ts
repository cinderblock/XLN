import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { MockDevice, type MockDeviceOptions } from '../src/testing/index.js';
import { ScpiSocket } from '../src/transport.js';
import { XLNConnectionError, XLNTimeoutError } from '../src/errors.js';

let device: MockDevice | undefined;
let socket: ScpiSocket | undefined;

/** Resolve on the next `unsolicited` line, so tests never race a sleep. */
function nextUnsolicited(from: ScpiSocket, ms = 5000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('no unsolicited line arrived'));
    }, ms);
    from.once('unsolicited', (line) => {
      clearTimeout(timer);
      resolve(line);
    });
  });
}

afterEach(async () => {
  await socket?.close();
  await device?.stop();
  socket = undefined;
  device = undefined;
});

async function open(
  options: MockDeviceOptions = {},
  socketOptions: { timeout?: number } = {},
): Promise<{ device: MockDevice; socket: ScpiSocket }> {
  device = await MockDevice.start(options);
  socket = new ScpiSocket({
    host: '127.0.0.1',
    port: device.port,
    ...socketOptions,
  });
  await socket.connect();
  return { device, socket };
}

describe('framing', () => {
  it('reassembles a response split across TCP segments', async () => {
    // This is the case the 0.6.x `once('data')` handler got wrong: it resolved
    // on the first packet, truncating anything that arrived later.
    const { socket } = await open({ fragmentResponses: true });
    await expect(socket.query('*IDN?')).resolves.toBe(
      'BK PRECISION,XLN6024,276G11128,1.20,0',
    );
  });

  it('strips NUL padding observed on real hardware in 2015', async () => {
    const { socket } = await open({ padTo: 96 });
    await expect(socket.query('SOURCE:VOLTAGE?')).resolves.toBe('0.000');
  });

  it('accepts CRLF, bare LF, and bare CR terminators', async () => {
    for (const terminator of ['\r\n', '\n', '\r']) {
      const probe = await MockDevice.start({ terminator });
      const client = new ScpiSocket({ host: '127.0.0.1', port: probe.port });
      await client.connect();
      await expect(client.query('SOURCE:VOLTAGE?'), terminator).resolves.toBe(
        '0.000',
      );
      await client.close();
      await probe.stop();
    }
  });

  it('terminates commands with CRLF, one command per write', async () => {
    // "All commands are terminated with <CR> and <LF> characters" — XLN
    // manual. 0.6.x sent bare LF. Assert on the actual bytes.
    const chunks: string[] = [];
    const server = createServer((connection) => {
      connection.setEncoding('latin1');
      connection.on('data', (chunk: string) => chunks.push(chunk));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    const client = new ScpiSocket({ host: '127.0.0.1', port });
    await client.connect();
    await client.write('*CLS');
    await client.write('OUTPUT 1');
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Exact bytes: CRLF after each command, and crucially no ';' compound
    // form — no manual example uses one and the firmware is not documented to
    // accept it. (Segment boundaries are the OS's business, not ours, so
    // they are deliberately not asserted here.)
    expect(chunks.join('')).toBe('*CLS\r\nOUTPUT 1\r\n');

    await client.close();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });
});

describe('command serialization', () => {
  it('keeps concurrent queries from crossing responses', async () => {
    // Fire many queries at once with no awaiting between them. Without a
    // queue, replies would be handed to whichever caller was listening.
    const { socket } = await open({ fragmentResponses: true });

    const expected = ['0.000', '0.000', '0', 'CV', '0.000'];
    const results = await Promise.all([
      socket.query('SOURCE:VOLTAGE?'),
      socket.query('SOURCE:CURRENT?'),
      socket.query('OUTPUT?'),
      socket.query('OUTPUT:STATE?'),
      socket.query('MEASURE:VOLTAGE?'),
    ]);

    expect(results).toEqual(expected);
  });

  it('does not stall the queue when a command fails', async () => {
    const { socket } = await open({}, { timeout: 100 });
    // 'BOGUS' produces no reply from the mock, so this query times out.
    await expect(socket.query('BOGUS?')).rejects.toThrow(XLNTimeoutError);
    // The next command must still work.
    await expect(socket.query('SOURCE:VOLTAGE?')).resolves.toBe('0.000');
  });

  it('runs a transaction with nothing interleaved', async () => {
    const { device, socket } = await open();

    const other = socket.query('OUTPUT?');
    const inTransaction = socket.transaction(async (channel) => {
      await channel.write('SOURCE:VOLTAGE 12');
      return channel.query('SOURCE:VOLTAGE?');
    });

    await Promise.all([other, inTransaction]);
    await expect(inTransaction).resolves.toBe('12.000');

    const writeIndex = device.received.indexOf('SOURCE:VOLTAGE 12');
    const queryIndex = device.received.indexOf('SOURCE:VOLTAGE?');
    expect(queryIndex).toBe(writeIndex + 1);
  });
});

describe('timeouts', () => {
  it('rejects with the command name and elapsed timeout', async () => {
    const { socket } = await open({ responseDelay: 500 }, { timeout: 50 });
    await expect(socket.query('SOURCE:VOLTAGE?')).rejects.toThrow(
      /Timed out after 50 ms.*SOURCE:VOLTAGE\?/,
    );
  });

  it('discards a late reply instead of desynchronizing', async () => {
    const { socket } = await open({ responseDelay: 120 }, { timeout: 40 });

    const late = nextUnsolicited(socket);

    await expect(socket.query('SOURCE:VOLTAGE?')).rejects.toThrow(
      XLNTimeoutError,
    );

    // The late reply surfaces as an event rather than being handed to the
    // next caller.
    await expect(late).resolves.toBe('0.000');
  });
});

describe('connection lifecycle', () => {
  it('reports a refused connection clearly', async () => {
    const closed = await MockDevice.start();
    const port = closed.port;
    await closed.stop();

    const client = new ScpiSocket({ host: '127.0.0.1', port });
    await expect(client.connect()).rejects.toThrow(XLNConnectionError);
  });

  it('times out a connection to a black hole', async () => {
    // 192.0.2.0/24 is TEST-NET-1: guaranteed unroutable.
    const client = new ScpiSocket({
      host: '192.0.2.1',
      port: 5025,
      connectTimeout: 100,
    });
    await expect(client.connect()).rejects.toThrow(/Timed out after 100 ms/);
  });

  it('rejects use after close', async () => {
    const { socket } = await open();
    await socket.close();
    await expect(socket.query('*IDN?')).rejects.toThrow(XLNConnectionError);
  });

  it('is safe to close twice', async () => {
    const { socket } = await open();
    await socket.close();
    await expect(socket.close()).resolves.toBeUndefined();
  });

  it('fails an in-flight query when the device disconnects', async () => {
    const { device, socket } = await open({ responseDelay: 1000 });
    const pending = socket.query('SOURCE:VOLTAGE?');
    setTimeout(() => void device.stop(), 20);
    await expect(pending).rejects.toThrow(XLNConnectionError);
  });

  it('supports await using', async () => {
    const probe = await MockDevice.start();
    {
      await using client = new ScpiSocket({
        host: '127.0.0.1',
        port: probe.port,
      });
      await client.connect();
      await expect(client.query('*IDN?')).resolves.toContain('XLN6024');
    }
    await probe.stop();
  });
});

describe('unsolicited data', () => {
  it('emits stray lines rather than letting them shift the stream', async () => {
    const { device, socket } = await open();

    // Two separate races here, both invisible locally and both reproducible
    // on a loaded macOS runner: a client connect() can resolve before the
    // server has registered the socket, so emitting immediately would write
    // to nobody; and asserting after a fixed sleep can miss the event.
    await device.waitForConnection();

    const seen = nextUnsolicited(socket);
    device.emitUnsolicited('SPURIOUS');
    await expect(seen).resolves.toBe('SPURIOUS');
    // The very next query still gets its own answer.
    await expect(socket.query('SOURCE:VOLTAGE?')).resolves.toBe('0.000');
  });
});

describe('framing pathologies from real-world correlation bugs', () => {
  it('splits two replies delivered in a single TCP segment', async () => {
    // A handler that resolves on the `data` event would take "1.000\r\n2.000"
    // as one value and be off by one forever after. The buffer must yield two
    // distinct lines.
    //
    // Note this cannot be provoked through MockDevice: because the transport
    // is strictly one-in-flight, request 2 is not sent until reply 1 arrives,
    // so a well-behaved device has nothing to coalesce. That is the design
    // working. Driving it needs a server that volunteers both at once.
    const server = createServer((connection) => {
      connection.setEncoding('latin1');
      connection.once('data', () => {
        // Both replies, one write, one segment.
        connection.write('1.000\r\n2.000\r\n');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    const client = new ScpiSocket({ host: '127.0.0.1', port });
    await client.connect();

    const extra: string[] = [];
    client.on('unsolicited', (line) => extra.push(line));

    // The pending query takes the first line...
    await expect(client.query('SOURCE:VOLTAGE?')).resolves.toBe('1.000');
    await new Promise((resolve) => setTimeout(resolve, 30));
    // ...and the second is surfaced rather than silently prepended to the
    // next caller's answer.
    expect(extra).toEqual(['2.000']);

    await client.close();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  it('stays in sync when a late reply lands after its request timed out', async () => {
    // Reply 1 is held past the timeout; reply 2 is prompt. The late reply must
    // not be handed to the second caller.
    const { device, socket } = await open(
      { replyDelay: (n) => (n === 1 ? 300 : 0) },
      { timeout: 60 },
    );
    device.voltage = 5;
    device.current = 3;

    const unsolicited: string[] = [];
    socket.on('unsolicited', (line) => unsolicited.push(line));

    await expect(socket.query('SOURCE:VOLTAGE?')).rejects.toThrow(
      XLNTimeoutError,
    );
    // The next request must get its own answer, not the abandoned one.
    await expect(socket.query('SOURCE:CURRENT?')).resolves.toBe('3.000');

    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(unsolicited).toEqual(['5.000']);
  });
});
