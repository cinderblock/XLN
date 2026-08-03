import { afterEach, describe, expect, it } from 'vitest';
import { MockDevice, type MockDeviceOptions } from '../src/testing/index.js';
import type { XLN } from '../src/xln.js';
import { connect, type XLNOptions } from '../src/xln.js';
import { XLNDeviceError, XLNRangeError } from '../src/errors.js';

let device: MockDevice | undefined;
let psu: XLN | undefined;

afterEach(async () => {
  await psu?.close();
  await device?.stop();
  psu = undefined;
  device = undefined;
});

async function open(
  deviceOptions: MockDeviceOptions = {},
  options: Partial<XLNOptions> = {},
): Promise<{ device: MockDevice; psu: XLN }> {
  device = await MockDevice.start(deviceOptions);
  // The mock does not serve UDP unless asked, so skip the probe rather than
  // paying its timeout in every test. UDP has its own suite.
  psu = await connect({
    host: '127.0.0.1',
    port: device.port,
    udp: false,
    ...options,
  });
  return { device, psu };
}

describe('connect', () => {
  it('identifies the device and resolves its model spec', async () => {
    const { psu } = await open();
    expect(psu.identity.manufacturer).toBe('BK PRECISION');
    expect(psu.identity.model).toBe('XLN6024');
    expect(psu.identity.serial).toBe('276G11128');
    // The trailing field is not part of the version.
    expect(psu.identity.firmware).toBe('1.20');
    expect(psu.spec?.model).toBe('XLN6024');
    expect(psu.spec?.voltage.max).toBe(60);
  });

  it('resolves a -GL model name to the base model', async () => {
    // The bench unit reports no suffix, but -GL is what the catalogue calls
    // the Ethernet variants, so a unit reporting it must still resolve.
    const { psu } = await open({
      identity: 'B&K Precision, XLN6024-GL, SN1, 1.00',
    });
    expect(psu.identity.model).toBe('XLN6024-GL');
    expect(psu.spec?.model).toBe('XLN6024');
  });

  it('clears a stale error queue so it is not blamed on the first command', async () => {
    device = await MockDevice.start();
    device.pushError(-2);
    psu = await connect({ host: '127.0.0.1', port: device.port, udp: false });
    // Had *CLS not run, this would throw the leftover -2.
    await expect(psu.setVoltage(5)).resolves.toBeUndefined();
  });

  it('clears errors before *IDN?, so the clear is confirmed done', async () => {
    // Regression: writes resolve when the bytes reach the OS, not when the
    // device has acted on them. With *CLS sent last, it could still be in
    // flight after connect() returned and would then wipe the error raised by
    // the caller's first command. Ordering it before the *IDN? query makes
    // the query's round trip the proof that it landed.
    const { device } = await open();
    const clearIndex = device.received.indexOf('*CLS');
    const idnIndex = device.received.indexOf('*IDN?');
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(clearIndex).toBeLessThan(idnIndex);
  });

  it('does not clear the error queue when error checking is off', async () => {
    const { device } = await open({}, { autoCheckErrors: false });
    expect(device.received).not.toContain('*CLS');
  });

  it('leaves spec undefined for an unrecognized model', async () => {
    const { psu } = await open({ identity: 'Acme, WIDGET9000, 1, 1.0' });
    expect(psu.spec).toBeUndefined();
    // Range checking is skipped rather than guessed at.
    await expect(psu.setVoltage(9999)).resolves.toBeUndefined();
  });

  it('honours an explicit model override', async () => {
    const { psu } = await open(
      { identity: 'Acme, MYSTERY, 1, 1.0' },
      { model: 'XLN30052' },
    );
    expect(psu.spec?.model).toBe('XLN30052');
  });

  it('closes the socket if identification fails', async () => {
    const { psu } = await open({ identity: 'no-commas-here' }).catch(
      (error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        return { psu: undefined };
      },
    );
    expect(psu).toBeUndefined();
  });
});

describe('setpoints and measurement', () => {
  it('round-trips voltage and current', async () => {
    const { psu } = await open();
    await psu.setVoltage(12.5);
    await psu.setCurrent(1.25);
    expect(await psu.getVoltage()).toBe(12.5);
    expect(await psu.getCurrent()).toBe(1.25);
  });

  it('reads back zero while the output is off', async () => {
    const { psu } = await open();
    await psu.setVoltage(12);
    await psu.setCurrent(2);
    expect(await psu.measureVoltage()).toBe(0);

    await psu.setOutput(true);
    expect(await psu.measureVoltage()).toBe(12);
    expect(await psu.measureCurrent()).toBe(2);
    expect(await psu.measurePower()).toBe(24);
  });

  it('sends the documented long-form commands with no leading colon', async () => {
    const { device, psu } = await open();
    await psu.setVoltage(12);
    await psu.setOutput(true);
    await psu.getRegulationMode();
    await psu.clearProtection();

    expect(device.received).toContain('SOURCE:VOLTAGE 12');
    expect(device.received).toContain('OUTPUT 1');
    expect(device.received).toContain('OUTPUT:STATE?');
    expect(device.received).toContain('OUTPUT:PROTECTION:CLEAR');
    // No command may start with a colon: the manual never documents one, and
    // the OUT/OUTP short form is firmware-revision-dependent.
    for (const command of device.received) {
      expect(command.startsWith(':'), command).toBe(false);
      expect(/^:?OUT[?\s]/.test(command), command).toBe(false);
    }
  });

  it('distinguishes output on/off from regulation mode', async () => {
    const { device, psu } = await open();
    device.output = true;
    device.regulationMode = 'CC';
    expect(await psu.getOutput()).toBe(true);
    expect(await psu.getRegulationMode()).toBe('CC');
  });

  it('understands ON/OFF boolean replies', async () => {
    const { psu } = await open({ verboseBooleans: true });
    await psu.setOutput(true);
    expect(await psu.getOutput()).toBe(true);
  });
});

describe('range validation', () => {
  it('rejects a voltage above the model rating before sending', async () => {
    const { device, psu } = await open();
    const before = device.received.length;
    await expect(psu.setVoltage(75)).rejects.toThrow(XLNRangeError);
    // Nothing was transmitted.
    expect(device.received.length).toBe(before);
  });

  it('rejects a negative current', async () => {
    const { psu } = await open();
    await expect(psu.setCurrent(-1)).rejects.toThrow(XLNRangeError);
  });

  it('enforces the non-zero minimum on high-voltage models', async () => {
    // The XLN30052 cannot be programmed below 5 V or 0.02 A.
    const { psu } = await open({ identity: 'B&K, XLN30052-GL, 1, 1.0' });
    await expect(psu.setVoltage(1)).rejects.toThrow(XLNRangeError);
    await expect(psu.setVoltage(100)).resolves.toBeUndefined();
    await expect(psu.setCurrent(0.001)).rejects.toThrow(XLNRangeError);
  });

  it('range-checks slew rates in V/ms', async () => {
    const { psu } = await open();
    // XLN6024 tops out at 3 V/ms. A caller thinking in V/s would pass 3000.
    await expect(psu.setVoltageSlewRate(3000)).rejects.toThrow(XLNRangeError);
    await expect(psu.setVoltageSlewRate(2.5)).resolves.toBeUndefined();
  });

  it('can be disabled', async () => {
    const { psu } = await open({}, { validateRanges: false });
    await expect(psu.setVoltage(75)).resolves.toBeUndefined();
  });

  it('rejects invalid memory slots regardless of validation setting', async () => {
    const { psu } = await open({}, { validateRanges: false });
    await expect(psu.saveToMemory(10)).rejects.toThrow(XLNRangeError);
    await expect(psu.saveToMemory(1.5)).rejects.toThrow(XLNRangeError);
  });
});

describe('automatic error checking', () => {
  it('throws when the device reports an error after a write', async () => {
    const { device, psu } = await open();
    device.pushError(-4);
    await expect(psu.setVoltage(12)).rejects.toThrow(XLNDeviceError);
  });

  it('names the offending command and describes the code', async () => {
    const { device, psu } = await open();
    device.pushError(-1);
    await expect(psu.setOutput(true)).rejects.toThrow(
      /error -1 \(Command error\) after "OUTPUT 1"/,
    );
  });

  it('checks errors immediately after the write, atomically', async () => {
    const { device, psu } = await open();
    await psu.setVoltage(12);
    const writeIndex = device.received.indexOf('SOURCE:VOLTAGE 12');
    expect(device.received[writeIndex + 1]).toBe('SYSTEM:ERROR?');
  });

  it('does not interleave two concurrent write-then-check pairs', async () => {
    const { device, psu } = await open();
    await Promise.all([psu.setVoltage(12), psu.setCurrent(3)]);

    const relevant = device.received.filter(
      (c) => c !== '*CLS' && c !== '*IDN?',
    );
    expect(relevant).toEqual([
      'SOURCE:VOLTAGE 12',
      'SYSTEM:ERROR?',
      'SOURCE:CURRENT 3',
      'SYSTEM:ERROR?',
    ]);
  });

  it('skips the round trip when disabled', async () => {
    const { device, psu } = await open({}, { autoCheckErrors: false });
    device.pushError(-1);
    await expect(psu.setVoltage(12)).resolves.toBeUndefined();
    expect(device.received).not.toContain('SYSTEM:ERROR?');
  });
});

describe('error queue', () => {
  it('returns null when there is no error', async () => {
    const { psu } = await open();
    expect(await psu.getError()).toBeNull();
  });

  it('drains the queue in FIFO order', async () => {
    const { device, psu } = await open();
    device.pushError(-1);
    device.pushError(-3);
    expect(await psu.getErrors()).toEqual([
      { code: -1, description: 'Command error' },
      { code: -3, description: 'Query error' },
    ]);
    expect(await psu.getError()).toBeNull();
  });

  it('stops at the documented queue depth', async () => {
    const { device, psu } = await open();
    // The mock caps at 10 like the real device, but make the intent explicit:
    // getErrors must terminate even if the device never reports zero.
    for (let i = 0; i < 20; i++) device.pushError(-1);
    const errors = await psu.getErrors();
    expect(errors.length).toBeLessThanOrEqual(10);
  });
});

describe('system and status', () => {
  it('decodes the legacy STATUS? bitfield', async () => {
    const { device, psu } = await open();
    device.statusBytes = [0b0000_0100, 0b0000_0010, 0];
    const status = await psu.getStatus();
    expect(status.enabled.output).toBe(true);
    expect(status.occurred.overTemperature).toBe(true);
    expect(status.occurred.acLow).toBe(false);
  });

  it('round-trips the power-on configuration', async () => {
    const { psu } = await open();
    await psu.setPowerOnMode('user');
    await psu.setPowerOnVoltage(5);
    await psu.setPowerOnOutput(true);
    expect(await psu.getPowerOnMode()).toBe('user');
    expect(await psu.getPowerOnVoltage()).toBe(5);
    expect(await psu.getPowerOnOutput()).toBe(true);
  });

  it('round-trips protection settings including over-power', async () => {
    const { psu } = await open();
    await psu.setOverPowerProtection(true);
    await psu.setOverPowerLevel(1000);
    expect(await psu.getOverPowerProtection()).toBe(true);
    expect(await psu.getOverPowerLevel()).toBe(1000);

    await psu.setOverVoltageLevel(50);
    expect(await psu.getOverVoltageLevel()).toBe(50);
  });

  it('rejects an over-power level above the model rating', async () => {
    const { psu } = await open();
    await expect(psu.setOverPowerLevel(2000)).rejects.toThrow(XLNRangeError);
  });

  it('round-trips memory presets', async () => {
    const { psu } = await open();
    await psu.selectMemorySlot(3);
    await psu.setMemoryVoltage(24);
    await psu.setMemoryCurrent(2);
    await psu.saveMemory();
    expect(await psu.getMemorySlot()).toBe(3);
    expect(await psu.getMemoryVoltage()).toBe(24);
    expect(await psu.getMemoryCurrent()).toBe(2);
  });
});

describe('resource management', () => {
  it('supports await using', async () => {
    const probe = await MockDevice.start();
    {
      await using supply = await connect({
        host: '127.0.0.1',
        port: probe.port,
        udp: false,
      });
      await supply.setVoltage(12);
    }
    // Disposal closed the connection but left the output state alone.
    expect(probe.received).not.toContain('OUTPUT 0');
    await probe.stop();
  });
});
