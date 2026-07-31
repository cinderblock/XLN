/**
 * Response parsing.
 *
 * The XLN manual documents which commands return a value but is silent on the
 * exact encoding for several of them (booleans, regulation mode, the error
 * queue, the legacy `STATUS?` bitfield). Everything here therefore parses
 * defensively — accepting every plausible encoding — and throws
 * {@link XLNProtocolError} with the raw text rather than silently guessing.
 */

import { XLNProtocolError } from './errors.js';

/** Parsed `*IDN?` response. */
export interface Identity {
  readonly manufacturer: string;
  readonly model: string;
  readonly serial: string;
  readonly firmware: string;
  /** The unparsed response, for when the split above gets it wrong. */
  readonly raw: string;
}

/** A single entry from the device's error queue. */
export interface DeviceErrorInfo {
  readonly code: number;
  readonly description: string;
}

/**
 * Which loop the supply is currently regulating on.
 *
 * Deliberately an *open* union. The manual only ever says "(CV or CC)" and
 * never states the encoding, so an unrecognized reply is passed through
 * (uppercased) rather than throwing — a monitoring loop should degrade, not
 * die, on a value we failed to anticipate. Compare against `'CV'`/`'CC'` and
 * keep an else-branch.
 */
export type RegulationMode = 'CV' | 'CC' | (string & Record<never, never>);

/**
 * Error codes from the XLN manual's event table.
 *
 * The manual writes these as `-000` through `-012`; `-000` means no error.
 */
const ERROR_DESCRIPTIONS = new Map<number, string>([
  [0, 'No error'],
  [-1, 'Command error'],
  [-2, 'Execution error'],
  [-3, 'Query error'],
  [-4, 'Input range error'],
  [-5, 'Parallel/series function: error mode'],
  [-6, 'Parallel/series function: multi-master'],
  [-7, 'Parallel/series function: no slave found'],
  [-8, 'Parallel/series function: communication with slave A error'],
  [-9, 'Parallel/series function: communication with slave B error'],
  [-10, 'Parallel/series function: communication with slave C error'],
  [-11, 'Parallel/series function: sync signal error when output on'],
  [-12, 'Parallel/series function: sync signal error when output off'],
]);

/** Description for a device error code, or a generic label if unrecognized. */
export function describeErrorCode(code: number): string {
  return ERROR_DESCRIPTIONS.get(code) ?? `Unknown error code ${code}`;
}

/** Parse a numeric response such as `12.345` or `+1.2E+01`. */
export function parseNumber(response: string, command?: string): number {
  const text = response.trim();
  // Reject anything that isn't purely a number: the device echoes units in
  // some firmware revisions ("12.345 V"), which we tolerate, but a word
  // response like "ERROR" must not become NaN silently.
  const match =
    /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*[A-Za-z/]*$/.exec(text);
  if (!match) {
    throw new XLNProtocolError('Expected a number', response, command);
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    throw new XLNProtocolError('Expected a finite number', response, command);
  }
  return value;
}

/**
 * Parse a boolean response.
 *
 * Accepts `0`/`1`, `OFF`/`ON`, and `FALSE`/`TRUE` in any case, since the
 * manual does not state which the firmware uses.
 */
export function parseBoolean(response: string, command?: string): boolean {
  const text = response.trim().toUpperCase();
  switch (text) {
    case '0':
    case '+0':
    case '-0':
    case 'OFF':
    case 'FALSE':
    case 'NO':
      return false;
    case '1':
    case '+1':
    case 'ON':
    case 'TRUE':
    case 'YES':
      return true;
    default:
      throw new XLNProtocolError('Expected a boolean', response, command);
  }
}

/** Parse an `*IDN?` response into its four comma-separated fields. */
export function parseIdentity(response: string): Identity {
  const raw = response.trim();
  const parts = raw.split(',').map((p) => p.trim());
  if (parts.length < 2) {
    throw new XLNProtocolError(
      'Expected a comma-separated identity string',
      response,
      '*IDN?',
    );
  }
  return {
    manufacturer: parts[0] ?? '',
    model: parts[1] ?? '',
    serial: parts[2] ?? '',
    // The manual describes the last field as "firmware type, & version" — it
    // can itself contain commas, so everything after the third field is joined
    // back together rather than truncated.
    firmware: parts.slice(3).join(', '),
    raw,
  };
}

/**
 * Parse a `SYS:ERR?` response.
 *
 * The wire format is undocumented. Three shapes are accepted:
 * a bare code (`0`, `-000`, `-1`), a SCPI-style pair (`-1,"Command error"`),
 * and a quoted description alone is rejected. Returns `null` when the device
 * reports no error.
 */
export function parseDeviceError(
  response: string,
  command = 'SYS:ERR?',
): DeviceErrorInfo | null {
  const text = response.trim();
  const match = /^([+-]?\d+)\s*(?:,\s*"?([^"]*)"?\s*)?$/.exec(text);
  if (!match) {
    throw new XLNProtocolError('Expected an error code', response, command);
  }
  // `-000` must normalize to 0, not -0.
  const code = Number(match[1]) || 0;
  if (code === 0) return null;
  const reported = match[2]?.trim();
  return {
    code,
    description:
      reported !== undefined && reported.length > 0
        ? reported
        : describeErrorCode(code),
  };
}

/**
 * Parse an `OUTPUT:STATE?` response into the active regulation loop.
 *
 * Returns the uppercased reply unchanged if it is neither `CV` nor `CC`. Only
 * an empty reply is an error. See {@link RegulationMode} for why this does not
 * validate harder.
 */
export function parseRegulationMode(
  response: string,
  command = 'OUTPUT:STATE?',
): RegulationMode {
  const text = response.trim().toUpperCase();
  if (text.length === 0) {
    throw new XLNProtocolError('Expected a regulation mode', response, command);
  }
  return text;
}

/**
 * Latched and configured flags from the legacy `STATUS?` command.
 *
 * This is the only way to read over-temperature and AC-low faults; they have
 * no SCPI query. Bit assignments are from the manual's `STATUS?` section.
 */
export interface XLNStatus {
  /** Byte 0 — which protections are currently *enabled*. */
  readonly enabled: {
    readonly overVoltage: boolean;
    readonly overCurrent: boolean;
    readonly overPower: boolean;
    readonly ccToCv: boolean;
    readonly cvToCc: boolean;
    readonly output: boolean;
    readonly backlight: boolean;
    readonly aux5V: boolean;
  };
  /** Byte 1 — which faults have *occurred* and are latched. */
  readonly occurred: {
    readonly overVoltage: boolean;
    readonly overCurrent: boolean;
    readonly overPower: boolean;
    readonly ccToCv: boolean;
    readonly cvToCc: boolean;
    readonly acLow: boolean;
    readonly overTemperature: boolean;
  };
  /** The three raw bytes, in case a bit is needed that isn't decoded above. */
  readonly bytes: readonly [number, number, number];
}

const bit = (byte: number, n: number): boolean => (byte & (1 << n)) !== 0;

/**
 * Parse a legacy `STATUS?` response into decoded flags.
 *
 * The manual says only "the system will return three (3) bytes" without
 * stating the encoding, so decimal triplets (`160,0,0`), space-separated
 * values, and contiguous hex (`A00000`) are all accepted.
 */
export function parseStatus(response: string, command = 'STATUS?'): XLNStatus {
  const text = response.trim();
  let bytes: number[] | undefined;

  const separated = text.split(/[\s,]+/).filter((p) => p.length > 0);
  if (separated.length === 3) {
    const parsed = separated.map((p) =>
      /^0[xX][0-9a-fA-F]+$/.test(p) ? Number(p) : Number.parseInt(p, 10),
    );
    if (parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xff)) {
      bytes = parsed;
    }
  }

  if (!bytes && /^[0-9a-fA-F]{6}$/.test(text)) {
    bytes = [
      Number.parseInt(text.slice(0, 2), 16),
      Number.parseInt(text.slice(2, 4), 16),
      Number.parseInt(text.slice(4, 6), 16),
    ];
  }

  if (!bytes) {
    throw new XLNProtocolError(
      'Expected three status bytes',
      response,
      command,
    );
  }

  const [b0 = 0, b1 = 0, b2 = 0] = bytes;
  return {
    enabled: {
      overVoltage: bit(b0, 7),
      overCurrent: bit(b0, 6),
      overPower: bit(b0, 5),
      ccToCv: bit(b0, 4),
      cvToCc: bit(b0, 3),
      output: bit(b0, 2),
      backlight: bit(b0, 1),
      aux5V: bit(b0, 0),
    },
    occurred: {
      overVoltage: bit(b1, 7),
      overCurrent: bit(b1, 6),
      overPower: bit(b1, 5),
      ccToCv: bit(b1, 4),
      cvToCc: bit(b1, 3),
      acLow: bit(b1, 2),
      overTemperature: bit(b1, 1),
    },
    bytes: [b0, b1, b2],
  };
}

/**
 * Format a number for transmission.
 *
 * Avoids exponential notation, which the hand-rolled firmware parser is not
 * documented to accept, and trims to a resolution the hardware can act on
 * (the finest across the range is 1 mV / 1 mA).
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Cannot send non-finite value ${value} to the device`);
  }
  // 4 decimals covers the 1 mV / 1 mA resolution of every model plus the
  // 0.001 A/ms current slew rate step of the high-voltage models.
  const text = value.toFixed(4);
  // Strip trailing zeros but keep at least one digit after the point removed
  // entirely, e.g. 12.5000 -> "12.5", 12.0000 -> "12".
  return text.replace(/\.?0+$/, '') || '0';
}
