/**
 * Coherent measurement.
 *
 * Reported by the XLN-Control agent: `measurePower()` originally did two
 * separate `await`s, so it returned `V(t) x I(t + one round trip)` — and
 * because serialization is per-request, another caller's query could land
 * between them and widen that gap arbitrarily. On a transient load that is a
 * number that was never simultaneously true.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MockDevice } from '../src/testing/index.js';
import { connect, type XLN } from '../src/xln.js';

let device: MockDevice | undefined;
let psu: XLN | undefined;

afterEach(async () => {
  await psu?.close();
  await device?.stop();
  psu = undefined;
  device = undefined;
});

async function open(): Promise<{ device: MockDevice; psu: XLN }> {
  device = await MockDevice.start();
  psu = await connect({ host: '127.0.0.1', port: device.port });
  device.voltage = 12;
  device.current = 2;
  device.output = true;
  return { device, psu };
}

describe('measure', () => {
  it('returns voltage, current and derived power together', async () => {
    const { psu } = await open();
    const reading = await psu.measure();
    expect(reading.voltage).toBe(12);
    expect(reading.current).toBe(2);
    expect(reading.power).toBe(24);
    expect(reading.timestamp).toBeGreaterThan(0);
    // Mode costs an extra round trip, so it is absent unless asked for.
    expect(reading.mode).toBeUndefined();
  });

  it('includes the regulation mode on request', async () => {
    const { device, psu } = await open();
    device.regulationMode = 'CC';
    const reading = await psu.measure({ mode: true });
    expect(reading.mode).toBe('CC');
  });

  it('does not query the mode unless asked', async () => {
    const { device, psu } = await open();
    await psu.measure();
    expect(device.received).not.toContain('OUTPUT:STATE?');
  });

  it('reads V and I back to back with nothing interleaved', async () => {
    const { device, psu } = await open();

    // Fire competing traffic at the same time. Without a transaction, one of
    // these could land between the voltage and current reads.
    await Promise.all([
      psu.measure(),
      psu.getVoltage(),
      psu.getCurrent(),
      psu.getOutput(),
    ]);

    const v = device.received.indexOf('MEASURE:VOLTAGE?');
    const i = device.received.indexOf('MEASURE:CURRENT?');
    expect(v).toBeGreaterThanOrEqual(0);
    expect(i).toBe(v + 1);
  });

  it('keeps the mode query inside the same transaction', async () => {
    const { device, psu } = await open();
    await Promise.all([psu.measure({ mode: true }), psu.getVoltage()]);

    const v = device.received.indexOf('MEASURE:VOLTAGE?');
    expect(device.received[v + 1]).toBe('MEASURE:CURRENT?');
    expect(device.received[v + 2]).toBe('OUTPUT:STATE?');
  });

  it('measurePower uses one transaction, not two loose calls', async () => {
    const { device, psu } = await open();
    await Promise.all([psu.measurePower(), psu.getVoltage()]);

    const v = device.received.indexOf('MEASURE:VOLTAGE?');
    expect(device.received[v + 1]).toBe('MEASURE:CURRENT?');
    expect(await psu.measurePower()).toBe(24);
  });
});
