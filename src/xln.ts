/**
 * Typed, promise-based control of a B&K Precision XLN series DC power supply.
 *
 * Commands are sent in the SCPI **long form** with no leading colon, matching
 * the manual's own examples exactly. That matters more than it looks: the
 * Output subsystem's short form changed from `OUT` (2013 manual) to `OUTP`
 * (2018 manual), so short forms are firmware-revision-dependent while the long
 * form is documented identically across every revision.
 */

import { XLNDeviceError, XLNProtocolError, XLNRangeError } from './errors.js';
import { lookupModel, type Range, type XLNModelSpec } from './models.js';
import {
  formatNumber,
  parseBoolean,
  parseDeviceError,
  parseIdentity,
  parseNumber,
  parseRegulationMode,
  parseStatus,
  type DeviceErrorInfo,
  type Identity,
  type RegulationMode,
  type XLNStatus,
} from './parse.js';
import {
  ScpiSocket,
  XLN_TCP_PORT,
  type CommandOptions,
  type ScpiChannel,
  type ScpiSocketOptions,
} from './transport.js';

const ERROR_QUERY = 'SYSTEM:ERROR?';

/** What the supply should do with its output at power-on. */
export type PowerOnMode = 'off' | 'last' | 'user';

export interface XLNOptions extends ScpiSocketOptions {
  /**
   * Query `SYSTEM:ERROR?` after every write and throw if the device reports a
   * problem. Defaults to `true`.
   *
   * This firmware has no `*OPC?` and set commands return nothing, so without
   * this a rejected `setCurrent()` fails completely silently. Given the device
   * is a 1440 W supply, the safe default wins over the round trip it costs.
   * Set `false` when you need maximum throughput and are checking errors
   * yourself.
   */
  autoCheckErrors?: boolean;
  /**
   * Reject out-of-range values locally, before sending. Defaults to `true`.
   *
   * Only active when the model was recognized from `*IDN?`. Turn off if the
   * built-in limit table is wrong for your unit — and please report it.
   */
  validateRanges?: boolean;
  /**
   * Override model detection.
   *
   * Only needed if `*IDN?` reports something this library does not recognize.
   */
  model?: string;
}

/**
 * An open connection to an XLN supply.
 *
 * Create with {@link connect}; every method is async and commands are
 * serialized internally, so it is safe to share one instance across callers.
 *
 * ```ts
 * await using psu = await connect({ host: '192.168.1.50' });
 * await psu.setVoltage(12);
 * await psu.setCurrent(1);
 * await psu.setOutput(true);
 * console.log(await psu.measureCurrent());
 * ```
 */
export class XLN {
  /** The underlying connection, for raw commands this API does not cover. */
  readonly socket: ScpiSocket;
  /** Parsed `*IDN?` response, captured at connect time. */
  readonly identity: Identity;
  /**
   * Capability table for the detected model, or `undefined` if `*IDN?`
   * reported a model this library does not know. Range checking is skipped
   * when this is `undefined`.
   */
  readonly spec: XLNModelSpec | undefined;

  private readonly autoCheckErrors: boolean;
  private readonly validateRanges: boolean;

  private constructor(
    socket: ScpiSocket,
    identity: Identity,
    spec: XLNModelSpec | undefined,
    options: XLNOptions,
  ) {
    this.socket = socket;
    this.identity = identity;
    this.spec = spec;
    this.autoCheckErrors = options.autoCheckErrors ?? true;
    this.validateRanges = options.validateRanges ?? true;

    if (this.autoCheckErrors) {
      // Only fires on reconnects — the initial 'connected' is emitted before
      // this instance exists. A supply that dropped the link may have
      // power-cycled with errors already queued; clearing them keeps the next
      // command from being blamed for a fault that predates it.
      this.socket.on('connected', () => {
        void this.socket.write('*CLS').catch(() => undefined);
      });
    }
  }

  /**
   * Open a connection and identify the device.
   *
   * Sends `*IDN?` to detect the model, and — when `autoCheckErrors` is on —
   * `*CLS` to empty the device's error queue, so that stale errors from a
   * previous session are not attributed to your first command.
   */
  static async connect(options: XLNOptions): Promise<XLN> {
    const socket = new ScpiSocket(options);
    await socket.connect();

    try {
      // Order matters. Writes resolve once the bytes reach the OS, not once
      // the device has acted on them, so a trailing `*CLS` could still be in
      // flight when the caller issues their first command — and would then
      // wipe the very error that command produced. Putting it before the
      // `*IDN?` query means the query's round trip proves it was processed.
      if (options.autoCheckErrors ?? true) {
        await socket.write('*CLS');
      }

      const identity = parseIdentity(await socket.query('*IDN?'));
      const spec = lookupModel(options.model ?? identity.model);

      return new XLN(socket, identity, spec, options);
    } catch (error) {
      await socket.close();
      throw error;
    }
  }

  /** Close the connection. Does **not** change the output state. */
  async close(): Promise<void> {
    await this.socket.close();
  }

  /** Supports `await using psu = await connect(...)`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  // --- IEEE-488.2 common commands ----------------------------------------

  /** Re-query `*IDN?` from the device. */
  async getIdentity(): Promise<Identity> {
    return parseIdentity(await this.query('*IDN?'));
  }

  /** Clear the device's status and error queue (`*CLS`). */
  async clearStatus(): Promise<void> {
    await this.command('*CLS');
  }

  /** Reset the supply to its power-on state (`*RST`). */
  async reset(): Promise<void> {
    await this.command('*RST');
  }

  /** Save the current settings to a memory slot, 0-9 (`*SAV`). */
  async saveToMemory(slot: number): Promise<void> {
    this.assertSlot(slot);
    await this.command(`*SAV ${slot}`);
  }

  /** Recall settings from a memory slot, 0-9 (`*RCL`). */
  async recallFromMemory(slot: number): Promise<void> {
    this.assertSlot(slot);
    await this.command(`*RCL ${slot}`);
  }

  /** Abort the current output action (`ABORT`). */
  async abort(): Promise<void> {
    await this.command('ABORT');
  }

  // --- measurement -------------------------------------------------------

  /** Measure the actual output voltage, in volts. */
  async measureVoltage(): Promise<number> {
    return this.queryNumber('MEASURE:VOLTAGE?');
  }

  /** Measure the actual output current, in amps. */
  async measureCurrent(): Promise<number> {
    return this.queryNumber('MEASURE:CURRENT?');
  }

  /** Measured output power, in watts. Convenience over two measurements. */
  async measurePower(): Promise<number> {
    const volts = await this.measureVoltage();
    const amps = await this.measureCurrent();
    return volts * amps;
  }

  /** Return the last-fetched output voltage without re-measuring. */
  async fetchVoltage(): Promise<number> {
    return this.queryNumber('FETCH:VOLTAGE?');
  }

  /** Return the last-fetched output current without re-measuring. */
  async fetchCurrent(): Promise<number> {
    return this.queryNumber('FETCH:CURRENT?');
  }

  // --- source setpoints --------------------------------------------------

  /** Programmed output voltage setpoint, in volts. */
  async getVoltage(): Promise<number> {
    return this.queryNumber('SOURCE:VOLTAGE?');
  }

  /** Set the output voltage setpoint, in volts. */
  async setVoltage(volts: number): Promise<void> {
    this.assertInRange('voltage', volts, this.spec?.voltage, 'V');
    await this.command(`SOURCE:VOLTAGE ${formatNumber(volts)}`);
  }

  /** Programmed output current setpoint, in amps. */
  async getCurrent(): Promise<number> {
    return this.queryNumber('SOURCE:CURRENT?');
  }

  /** Set the output current setpoint, in amps. */
  async setCurrent(amps: number): Promise<void> {
    this.assertInRange('current', amps, this.spec?.current, 'A');
    await this.command(`SOURCE:CURRENT ${formatNumber(amps)}`);
  }

  // --- output ------------------------------------------------------------

  /** Whether the output is currently enabled. */
  async getOutput(): Promise<boolean> {
    return parseBoolean(await this.query('OUTPUT?'), 'OUTPUT?');
  }

  /** Enable or disable the output. */
  async setOutput(enabled: boolean): Promise<void> {
    await this.command(`OUTPUT ${enabled ? 1 : 0}`);
  }

  /**
   * Which loop the supply is currently regulating on — `'CV'` or `'CC'`.
   *
   * Note this maps to `OUTPUT:STATE?`, which despite the name reports the
   * regulation *mode*, not on/off. Use {@link getOutput} for on/off.
   */
  async getRegulationMode(): Promise<RegulationMode> {
    return parseRegulationMode(await this.query('OUTPUT:STATE?'));
  }

  /** Soft voltage limit, in volts. */
  async getVoltageLimit(): Promise<number> {
    return this.queryNumber('OUTPUT:LIMIT:VOLTAGE?');
  }

  /** Set the soft voltage limit, in volts. */
  async setVoltageLimit(volts: number): Promise<void> {
    this.assertInRange('voltage limit', volts, this.spec?.voltageLimit, 'V');
    await this.command(`OUTPUT:LIMIT:VOLTAGE ${formatNumber(volts)}`);
  }

  /** Soft current limit, in amps. */
  async getCurrentLimit(): Promise<number> {
    return this.queryNumber('OUTPUT:LIMIT:CURRENT?');
  }

  /** Set the soft current limit, in amps. */
  async setCurrentLimit(amps: number): Promise<void> {
    this.assertInRange('current limit', amps, this.spec?.currentLimit, 'A');
    await this.command(`OUTPUT:LIMIT:CURRENT ${formatNumber(amps)}`);
  }

  /** Voltage slew rate, in **volts per millisecond**. */
  async getVoltageSlewRate(): Promise<number> {
    return this.queryNumber('OUTPUT:SR:VOLTAGE?');
  }

  /**
   * Set the voltage slew rate.
   *
   * @param voltsPerMillisecond Rate in **V/ms**, not V/s. The front panel
   * displays this as `VOLT SLEW RATE = 3.0000 V/mS`.
   */
  async setVoltageSlewRate(voltsPerMillisecond: number): Promise<void> {
    this.assertInRange(
      'voltage slew rate',
      voltsPerMillisecond,
      this.spec?.voltageSlewRate,
      'V/ms',
    );
    await this.command(
      `OUTPUT:SR:VOLTAGE ${formatNumber(voltsPerMillisecond)}`,
    );
  }

  /** Current slew rate, in **amps per millisecond**. */
  async getCurrentSlewRate(): Promise<number> {
    return this.queryNumber('OUTPUT:SR:CURRENT?');
  }

  /**
   * Set the current slew rate.
   *
   * @param ampsPerMillisecond Rate in **A/ms**, not A/s.
   */
  async setCurrentSlewRate(ampsPerMillisecond: number): Promise<void> {
    this.assertInRange(
      'current slew rate',
      ampsPerMillisecond,
      this.spec?.currentSlewRate,
      'A/ms',
    );
    await this.command(`OUTPUT:SR:CURRENT ${formatNumber(ampsPerMillisecond)}`);
  }

  /** Reset latched protection faults so the output can be re-enabled. */
  async clearProtection(): Promise<void> {
    await this.command('OUTPUT:PROTECTION:CLEAR');
  }

  // --- protection --------------------------------------------------------

  /** Whether any protection is currently tripped (`PROTECTION?`). */
  async getProtectionTripped(): Promise<boolean> {
    return parseBoolean(await this.query('PROTECTION?'), 'PROTECTION?');
  }

  /** Whether over-voltage protection is enabled. */
  async getOverVoltageProtection(): Promise<boolean> {
    return this.queryBoolean('SOURCE:VOLTAGE:PROTECTION?');
  }

  /** Enable or disable over-voltage protection. */
  async setOverVoltageProtection(enabled: boolean): Promise<void> {
    await this.command(`SOURCE:VOLTAGE:PROTECTION ${enabled ? 1 : 0}`);
  }

  /** Over-voltage trip level, in volts. */
  async getOverVoltageLevel(): Promise<number> {
    return this.queryNumber('SOURCE:VOLTAGE:PROTECTION:LEVEL?');
  }

  /** Set the over-voltage trip level, in volts. */
  async setOverVoltageLevel(volts: number): Promise<void> {
    this.assertInRange(
      'over-voltage level',
      volts,
      this.spec?.overVoltageProtection,
      'V',
    );
    await this.command(
      `SOURCE:VOLTAGE:PROTECTION:LEVEL ${formatNumber(volts)}`,
    );
  }

  /** Whether over-current protection is enabled. */
  async getOverCurrentProtection(): Promise<boolean> {
    return this.queryBoolean('SOURCE:CURRENT:PROTECTION?');
  }

  /** Enable or disable over-current protection. */
  async setOverCurrentProtection(enabled: boolean): Promise<void> {
    await this.command(`SOURCE:CURRENT:PROTECTION ${enabled ? 1 : 0}`);
  }

  /** Over-current trip level, in amps. */
  async getOverCurrentLevel(): Promise<number> {
    return this.queryNumber('SOURCE:CURRENT:PROTECTION:LEVEL?');
  }

  /** Set the over-current trip level, in amps. */
  async setOverCurrentLevel(amps: number): Promise<void> {
    this.assertInRange(
      'over-current level',
      amps,
      this.spec?.currentLimit,
      'A',
    );
    await this.command(`SOURCE:CURRENT:PROTECTION:LEVEL ${formatNumber(amps)}`);
  }

  /** Whether over-power protection is enabled. */
  async getOverPowerProtection(): Promise<boolean> {
    return this.queryBoolean('PROTECTION:OPP?');
  }

  /** Enable or disable over-power protection. */
  async setOverPowerProtection(enabled: boolean): Promise<void> {
    await this.command(`PROTECTION:OPP ${enabled ? 1 : 0}`);
  }

  /** Over-power trip level, in watts. */
  async getOverPowerLevel(): Promise<number> {
    return this.queryNumber('PROTECTION:OPP:LEVEL?');
  }

  /** Set the over-power trip level, in watts. */
  async setOverPowerLevel(watts: number): Promise<void> {
    const range =
      this.spec === undefined
        ? undefined
        : ({ min: 0, max: this.spec.power } as const);
    this.assertInRange('over-power level', watts, range, 'W');
    await this.command(`PROTECTION:OPP:LEVEL ${formatNumber(watts)}`);
  }

  /** Whether tripping on a CV-to-CC transition is enabled. */
  async getCvToCcProtection(): Promise<boolean> {
    return this.queryBoolean('PROTECTION:CVCC?');
  }

  /** Enable or disable tripping on a CV-to-CC transition. */
  async setCvToCcProtection(enabled: boolean): Promise<void> {
    await this.command(`PROTECTION:CVCC ${enabled ? 1 : 0}`);
  }

  /** Whether tripping on a CC-to-CV transition is enabled. */
  async getCcToCvProtection(): Promise<boolean> {
    return this.queryBoolean('PROTECTION:CCCV?');
  }

  /** Enable or disable tripping on a CC-to-CV transition. */
  async setCcToCvProtection(enabled: boolean): Promise<void> {
    await this.command(`PROTECTION:CCCV ${enabled ? 1 : 0}`);
  }

  // --- system ------------------------------------------------------------

  /**
   * Read one entry from the device's error queue, or `null` if it is empty.
   *
   * The queue holds up to 10 entries, is FIFO, and reading an entry removes
   * it. Note this returns the error rather than throwing it — unlike the
   * automatic check performed when `autoCheckErrors` is enabled.
   */
  async getError(): Promise<DeviceErrorInfo | null> {
    return parseDeviceError(await this.query(ERROR_QUERY));
  }

  /**
   * Drain and return every entry in the device's error queue.
   *
   * Stops at the documented depth of 10 even if the device keeps producing
   * entries, so this cannot loop forever.
   */
  async getErrors(): Promise<DeviceErrorInfo[]> {
    const errors: DeviceErrorInfo[] = [];
    for (let i = 0; i < 10; i++) {
      const error = await this.getError();
      if (!error) break;
      errors.push(error);
    }
    return errors;
  }

  /** Device serial number (`SYSTEM:SERIES?`). */
  async getSerialNumber(): Promise<string> {
    return (await this.query('SYSTEM:SERIES?')).trim();
  }

  /** Whether the front-panel beeper is enabled. */
  async getBeep(): Promise<boolean> {
    return this.queryBoolean('SYSTEM:BEEP?');
  }

  /** Enable or disable the front-panel beeper. */
  async setBeep(enabled: boolean): Promise<void> {
    await this.command(`SYSTEM:BEEP ${enabled ? 1 : 0}`);
  }

  /** Whether the front-panel keys are locked out. */
  async getKeyLock(): Promise<boolean> {
    return this.queryBoolean('SYSTEM:KEY:LOCK?');
  }

  /** Lock or unlock the front-panel keys. */
  async setKeyLock(locked: boolean): Promise<void> {
    await this.command(`SYSTEM:KEY:LOCK ${locked ? 1 : 0}`);
  }

  /** Whether the LCD backlight is on. */
  async getBacklight(): Promise<boolean> {
    return this.queryBoolean('SYSTEM:LCD:BL?');
  }

  /** Turn the LCD backlight on or off. */
  async setBacklight(enabled: boolean): Promise<void> {
    await this.command(`SYSTEM:LCD:BL ${enabled ? 1 : 0}`);
  }

  /**
   * Whether the auxiliary 5 V / 1 A output is enabled.
   *
   * Only present on the high-current models (XLN3640/6024/8018/10014).
   */
  async getAux5V(): Promise<boolean> {
    return this.queryBoolean('SYSTEM:E5V?');
  }

  /** Enable or disable the auxiliary 5 V output. */
  async setAux5V(enabled: boolean): Promise<void> {
    await this.command(`SYSTEM:E5V ${enabled ? 1 : 0}`);
  }

  /** What the supply does with its output at power-on. */
  async getPowerOnMode(): Promise<PowerOnMode> {
    const response = await this.query('SYSTEM:POWER:TYPE?');
    const text = response.trim().toUpperCase();
    switch (text) {
      case '0':
      case 'OFF':
        return 'off';
      case '1':
      case 'LAST':
        return 'last';
      case '2':
      case 'USER':
        return 'user';
      default:
        throw new XLNProtocolError(
          'Expected a power-on mode of OFF, LAST or USER',
          response,
          'SYSTEM:POWER:TYPE?',
        );
    }
  }

  /** Set what the supply does with its output at power-on. */
  async setPowerOnMode(mode: PowerOnMode): Promise<void> {
    const value = { off: 0, last: 1, user: 2 }[mode];
    await this.command(`SYSTEM:POWER:TYPE ${value}`);
  }

  /** User-defined power-on voltage, in volts (used when mode is `'user'`). */
  async getPowerOnVoltage(): Promise<number> {
    return this.queryNumber('SYSTEM:POWER:VOLTAGE?');
  }

  /** Set the user-defined power-on voltage, in volts. */
  async setPowerOnVoltage(volts: number): Promise<void> {
    this.assertInRange('power-on voltage', volts, this.spec?.voltage, 'V');
    await this.command(`SYSTEM:POWER:VOLTAGE ${formatNumber(volts)}`);
  }

  /** User-defined power-on current, in amps (used when mode is `'user'`). */
  async getPowerOnCurrent(): Promise<number> {
    return this.queryNumber('SYSTEM:POWER:CURRENT?');
  }

  /** Set the user-defined power-on current, in amps. */
  async setPowerOnCurrent(amps: number): Promise<void> {
    this.assertInRange('power-on current', amps, this.spec?.current, 'A');
    await this.command(`SYSTEM:POWER:CURRENT ${formatNumber(amps)}`);
  }

  /** Whether the output is enabled at power-on (used when mode is `'user'`). */
  async getPowerOnOutput(): Promise<boolean> {
    return this.queryBoolean('SYSTEM:POWER:STATE?');
  }

  /** Set whether the output is enabled at power-on. */
  async setPowerOnOutput(enabled: boolean): Promise<void> {
    await this.command(`SYSTEM:POWER:STATE ${enabled ? 1 : 0}`);
  }

  /** Restore factory default settings. */
  async recallFactoryDefaults(): Promise<void> {
    await this.command('SYSTEM:RECALL:DEFAULT');
  }

  /**
   * Read the legacy three-byte status bitfield.
   *
   * This is the only way to read latched over-temperature and AC-low faults —
   * neither has a SCPI query. Uses the non-SCPI legacy `STATUS?` command.
   */
  async getStatus(): Promise<XLNStatus> {
    return parseStatus(await this.query('STATUS?'));
  }

  // --- memory preset subsystem -------------------------------------------

  /** The currently selected memory slot, 0-9. */
  async getMemorySlot(): Promise<number> {
    return this.queryNumber('MEMORY?');
  }

  /** Select a memory slot, 0-9, for subsequent memory operations. */
  async selectMemorySlot(slot: number): Promise<void> {
    this.assertSlot(slot);
    await this.command(`MEMORY ${slot}`);
  }

  /** Voltage stored in the selected memory slot, in volts. */
  async getMemoryVoltage(): Promise<number> {
    return this.queryNumber('MEMORY:VSET?');
  }

  /** Set the voltage for the selected memory slot, in volts. */
  async setMemoryVoltage(volts: number): Promise<void> {
    this.assertInRange('memory voltage', volts, this.spec?.voltage, 'V');
    await this.command(`MEMORY:VSET ${formatNumber(volts)}`);
  }

  /** Current stored in the selected memory slot, in amps. */
  async getMemoryCurrent(): Promise<number> {
    return this.queryNumber('MEMORY:ISET?');
  }

  /** Set the current for the selected memory slot, in amps. */
  async setMemoryCurrent(amps: number): Promise<void> {
    this.assertInRange('memory current', amps, this.spec?.current, 'A');
    await this.command(`MEMORY:ISET ${formatNumber(amps)}`);
  }

  /** Commit the pending memory subsystem values to the selected slot. */
  async saveMemory(): Promise<void> {
    await this.command('MEMORY:SAVE');
  }

  // --- escape hatches ----------------------------------------------------

  /**
   * Send a raw command that produces no response.
   *
   * Still goes through the queue and the `autoCheckErrors` check.
   */
  async command(command: string, options?: CommandOptions): Promise<void> {
    if (!this.autoCheckErrors) {
      await this.socket.write(command, options);
      return;
    }
    await this.socket.transaction(async (channel: ScpiChannel) => {
      await channel.write(command);
      const error = parseDeviceError(await channel.query(ERROR_QUERY, options));
      if (error) {
        throw new XLNDeviceError(error.code, error.description, command);
      }
    }, options);
  }

  /** Send a raw query and return the device's reply verbatim. */
  async query(command: string, options?: CommandOptions): Promise<string> {
    return this.socket.query(command, options);
  }

  // --- internals ---------------------------------------------------------

  private async queryNumber(command: string): Promise<number> {
    return parseNumber(await this.query(command), command);
  }

  private async queryBoolean(command: string): Promise<boolean> {
    return parseBoolean(await this.query(command), command);
  }

  private assertSlot(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot > 9) {
      throw new XLNRangeError('memory slot', slot, 0, 9, '');
    }
  }

  private assertInRange(
    quantity: string,
    value: number,
    range: Range | undefined,
    unit: string,
  ): void {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${quantity} must be a finite number, got ${value}`);
    }
    if (!this.validateRanges || !range) return;
    if (value < range.min || value > range.max) {
      throw new XLNRangeError(quantity, value, range.min, range.max, unit);
    }
  }
}

/**
 * Connect to an XLN supply.
 *
 * ```ts
 * import { connect } from 'xln';
 *
 * await using psu = await connect({ host: '192.168.1.50' });
 * console.log(psu.identity.model);
 * ```
 */
export function connect(options: XLNOptions): Promise<XLN> {
  return XLN.connect(options);
}

export { XLN_TCP_PORT };
