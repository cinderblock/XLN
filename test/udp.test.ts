/**
 * The UDP status channel.
 *
 * Undocumented in every B&K manual revision, but real: verified on an XLN6024
 * running firmware 1.20. See `plans/xln-modernization.md` for the probe
 * results that established the frame layout.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MockDevice } from '../src/testing/index.js';
import { connect, type XLN } from '../src/xln.js';
import { parseUdpStatus, UdpStatusChannel } from '../src/udp.js';
import { XLNProtocolError, XLNTimeoutError } from '../src/errors.js';

let device: MockDevice | undefined;
let psu: XLN | undefined;

afterEach(async () => {
  await psu?.close();
  await device?.stop();
  psu = undefined;
  device = undefined;
});

/** The exact frame captured from an XLN6024 with the output off. */
const REAL_FRAME =
  '                OFF                0.000 V   0.000 A                                            ';

describe('parseUdpStatus', () => {
  it('parses the frame captured from real hardware', () => {
    const status = parseUdpStatus(REAL_FRAME, 1234);
    expect(status.state).toBe('OFF');
    expect(status.output).toBe(false);
    expect(status.voltage).toBe(0);
    expect(status.current).toBe(0);
    expect(status.power).toBe(0);
    expect(status.timestamp).toBe(1234);
  });

  it('anchors on unit markers, not offsets or whitespace', () => {
    // Field offsets shift as values gain digits, so column positions must not
    // be load-bearing.
    const wide = '   CC        24.000 V   12.500 A    ';
    const status = parseUdpStatus(wide);
    expect(status.state).toBe('CC');
    expect(status.voltage).toBe(24);
    expect(status.current).toBe(12.5);
    expect(status.power).toBe(300);
    expect(status.output).toBe(true);
  });

  it('handles a value that has swallowed the space before its unit', () => {
    // The observed frame writes the number at a fixed offset and the unit at
    // another, so a six-character value runs straight into it.
    const merged =
      '                CC                 12.000V   2.000 A                 ';
    const status = parseUdpStatus(merged);
    expect(status.voltage).toBe(12);
    expect(status.current).toBe(2);
    expect(status.power).toBe(24);
  });

  it('treats any non-OFF state as output on', () => {
    expect(parseUdpStatus('  CV  1.000 V  2.000 A').output).toBe(true);
    expect(parseUdpStatus('  OFF 0.000 V  0.000 A').output).toBe(false);
    // Lowercase from a hypothetical firmware revision must still work.
    expect(parseUdpStatus('  off 0.000 V  0.000 A').state).toBe('OFF');
  });

  it('strips the NUL padding real datagrams carry', () => {
    const padded = `${REAL_FRAME}\0\0\0`;
    expect(parseUdpStatus(padded).voltage).toBe(0);
  });

  it('rejects a frame with no readings', () => {
    expect(() => parseUdpStatus('   ')).toThrow(XLNProtocolError);
    expect(() => parseUdpStatus('  OFF  ')).toThrow(XLNProtocolError);
  });
});

describe('UdpStatusChannel', () => {
  it('polls a device and reports availability', async () => {
    device = await MockDevice.start({ udp: true });
    const channel = new UdpStatusChannel({
      host: '127.0.0.1',
      port: device.udpPort!,
    });

    expect(await channel.available()).toBe(true);
    device.output = true;
    device.voltage = 12;
    device.current = 2;
    device.regulationMode = 'CC';

    const status = await channel.poll();
    expect(status.state).toBe('CC');
    expect(status.voltage).toBe(12);
    expect(status.current).toBe(2);
    expect(status.power).toBe(24);
    channel.close();
  });

  it('times out rather than hanging when nothing answers', async () => {
    const channel = new UdpStatusChannel({
      host: '127.0.0.1',
      port: 1, // nothing listens here
      timeout: 100,
    });
    await expect(channel.poll()).rejects.toThrow(XLNTimeoutError);
    expect(await channel.available()).toBe(false);
    channel.close();
  });

  it('reports unavailable when the device ignores small datagrams', async () => {
    // Real hardware is length-sensitive; simulate a unit that never answers.
    device = await MockDevice.start({ udp: true, udpMinSize: 100_000 });
    const channel = new UdpStatusChannel({
      host: '127.0.0.1',
      port: device.udpPort!,
      timeout: 100,
    });
    expect(await channel.available()).toBe(false);
    channel.close();
  });
});

describe('measure() over UDP', () => {
  async function open(deviceOptions = {}, options = {}): Promise<XLN> {
    device = await MockDevice.start({ udp: true, ...deviceOptions });
    psu = await connect({
      host: '127.0.0.1',
      port: device.port,
      udpPort: device.udpPort!,
      ...options,
    });
    return psu;
  }

  it('uses UDP by default when the device answers', async () => {
    const supply = await open();
    expect(supply.usingUdp).toBe(true);

    device!.output = true;
    device!.voltage = 12;
    device!.current = 2;

    const before = device!.received.length;
    const reading = await supply.measure();

    expect(reading.voltage).toBe(12);
    expect(reading.current).toBe(2);
    expect(reading.power).toBe(24);
    // Nothing went over SCPI.
    expect(device!.received.length).toBe(before);
  });

  it('reports regulation mode without an extra round trip', async () => {
    const supply = await open();
    device!.output = true;
    device!.voltage = 5;
    device!.current = 1;
    device!.regulationMode = 'CC';

    const reading = await supply.measure({ mode: true });
    expect(reading.mode).toBe('CC');
    expect(device!.received).not.toContain('OUTPUT:STATE?');
  });

  it('omits mode while the output is off, since OFF is not a loop', async () => {
    const supply = await open();
    const reading = await supply.measure({ mode: true });
    expect(reading.mode).toBeUndefined();
  });

  it('falls back to SCPI when the device does not answer UDP', async () => {
    const supply = await open({ udp: false });
    expect(supply.usingUdp).toBe(false);

    device!.output = true;
    device!.voltage = 9;
    device!.current = 3;

    const reading = await supply.measure();
    expect(reading.voltage).toBe(9);
    expect(device!.received).toContain('MEASURE:VOLTAGE?');
  });

  it('can be disabled explicitly, skipping the probe', async () => {
    const supply = await open({}, { udp: false });
    expect(supply.usingUdp).toBe(false);

    device!.output = true;
    device!.voltage = 7;
    device!.current = 1;

    const reading = await supply.measure();
    expect(reading.voltage).toBe(7);
    expect(device!.received).toContain('MEASURE:VOLTAGE?');
  });

  it('falls back to SCPI mid-session if a datagram is lost', async () => {
    const supply = await open();
    expect(supply.usingUdp).toBe(true);

    device!.output = true;
    device!.voltage = 15;
    device!.current = 1;

    // Kill only the UDP responder; SCPI stays up.
    await device!.stopUdp();

    const reading = await supply.measure();
    expect(reading.voltage).toBe(15);
    expect(device!.received).toContain('MEASURE:VOLTAGE?');
  });

  it('leaves control commands on SCPI regardless', async () => {
    const supply = await open();
    await supply.setVoltage(12);
    await supply.setOutput(true);
    expect(device!.received).toContain('SOURCE:VOLTAGE 12');
    expect(device!.received).toContain('OUTPUT 1');
  });
});
