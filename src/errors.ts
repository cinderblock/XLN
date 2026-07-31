/**
 * Error hierarchy for the `xln` library.
 *
 * Every error thrown by this library derives from {@link XLNError}, so
 * `catch (e) { if (e instanceof XLNError) ... }` is always sufficient.
 */

/** Base class for every error thrown by this library. */
export class XLNError extends Error {
  override readonly name: string = 'XLNError';
}

/** The TCP connection failed, dropped, or was used after being closed. */
export class XLNConnectionError extends XLNError {
  override readonly name = 'XLNConnectionError';
}

/** A command did not receive a response within the configured timeout. */
export class XLNTimeoutError extends XLNError {
  override readonly name = 'XLNTimeoutError';

  constructor(
    /** The command that timed out. */
    readonly command: string,
    /** The timeout that elapsed, in milliseconds. */
    readonly timeout: number,
  ) {
    super(
      `Timed out after ${timeout} ms waiting for a response to ${JSON.stringify(
        command,
      )}`,
    );
  }
}

/**
 * The device replied, but the reply could not be interpreted.
 *
 * The XLN manual leaves several response encodings undocumented (see
 * `plans/xln-modernization.md`). If you hit this, the raw response is attached
 * — please open an issue with it.
 */
export class XLNProtocolError extends XLNError {
  override readonly name = 'XLNProtocolError';

  constructor(
    message: string,
    /** The raw response text, exactly as received (after NUL stripping). */
    readonly response: string,
    /** The command that produced it, if known. */
    readonly command?: string,
  ) {
    super(
      `${message} (response: ${JSON.stringify(response)}${
        command === undefined ? '' : `, command: ${JSON.stringify(command)}`
      })`,
    );
  }
}

/**
 * The device reported an error via `SYS:ERR?`.
 *
 * Thrown automatically after writes when `autoCheckErrors` is enabled, and
 * returned (not thrown) by {@link XLN.getError}.
 */
export class XLNDeviceError extends XLNError {
  override readonly name = 'XLNDeviceError';

  constructor(
    /** Numeric error code as reported by the device, e.g. `-1`. */
    readonly code: number,
    /** Human-readable description, from the manual's error table. */
    readonly description: string,
    /** The command that provoked the error, if known. */
    readonly command?: string,
  ) {
    super(
      `Device reported error ${code} (${description})${
        command === undefined ? '' : ` after ${JSON.stringify(command)}`
      }`,
    );
  }
}

/**
 * A value was outside the range this model supports.
 *
 * Thrown before anything is sent to the device. Disable with
 * `validateRanges: false` if the limit table is wrong for your unit — and
 * please report it.
 */
export class XLNRangeError extends XLNError {
  override readonly name = 'XLNRangeError';

  constructor(
    /** What was being set, e.g. `'voltage'`. */
    readonly quantity: string,
    /** The rejected value. */
    readonly value: number,
    /** Lowest accepted value. */
    readonly min: number,
    /** Highest accepted value. */
    readonly max: number,
    /** Unit for the message, e.g. `'V'`. */
    unit: string,
  ) {
    super(
      `${quantity} ${value}${unit} is out of range; this model accepts ` +
        `${min}${unit} to ${max}${unit}`,
    );
  }
}
