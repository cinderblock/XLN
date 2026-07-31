/**
 * Per-model capability table.
 *
 * The XLN series has no runtime way to ask the device for its own limits — the
 * firmware does not implement the SCPI `MIN`/`MAX`/`DEF` query parameters, and
 * `OUTPUT:LIMIT:*?` returns the *user-configured soft limit*, not the hardware
 * rating. So the limits have to live in a table here, keyed off `*IDN?`.
 *
 * Source: B&K Precision XLN Series manual (c) 2009-2018 and the XLN datasheet.
 * See `plans/xln-modernization.md` for exact page references.
 */

/** Model names this library knows the limits for. */
export const XLN_MODELS = [
  'XLN3640',
  'XLN6024',
  'XLN8018',
  'XLN10014',
  'XLN15010',
  'XLN30052',
  'XLN60026',
] as const;

export type XLNModelName = (typeof XLN_MODELS)[number];

/** An inclusive numeric range. */
export interface Range {
  readonly min: number;
  readonly max: number;
}

export interface XLNModelSpec {
  readonly model: XLNModelName;
  /** Programmable output voltage, in volts. */
  readonly voltage: Range;
  /** Programmable output current, in amps. */
  readonly current: Range;
  /** Rated output power, in watts. */
  readonly power: number;
  /** Voltage slew rate, in **volts per millisecond**. */
  readonly voltageSlewRate: Range;
  /** Current slew rate, in **amps per millisecond**. */
  readonly currentSlewRate: Range;
  /** Accepted range for `OUTPUT:LIMIT:VOLTAGE`, in volts. */
  readonly voltageLimit: Range;
  /** Accepted range for `OUTPUT:LIMIT:CURRENT`, in amps. */
  readonly currentLimit: Range;
  /** Adjustable over-voltage protection range, in volts. */
  readonly overVoltageProtection: Range;
  /**
   * True when the soft-limit ceilings above are inferred (rated + 0.5) rather
   * than read from a manual table. Only affects how strict range checking is.
   */
  readonly limitsInferred: boolean;
  /** High-current models expose an auxiliary 5 V / 1 A output (`SYS:E5V`). */
  readonly hasAux5V: boolean;
}

const SPECS: Record<XLNModelName, XLNModelSpec> = {
  XLN3640: {
    model: 'XLN3640',
    voltage: { min: 0, max: 36 },
    current: { min: 0, max: 40 },
    power: 1440,
    voltageSlewRate: { min: 0.01, max: 2.4 },
    currentSlewRate: { min: 0.01, max: 2.5 },
    // Not tabulated in the manual for this model; rated + 0.5 by analogy.
    voltageLimit: { min: 0, max: 36.5 },
    currentLimit: { min: 0.01, max: 40.5 },
    overVoltageProtection: { min: 2, max: 38 },
    limitsInferred: true,
    hasAux5V: true,
  },
  XLN6024: {
    model: 'XLN6024',
    voltage: { min: 0, max: 60 },
    current: { min: 0, max: 24 },
    power: 1440,
    voltageSlewRate: { min: 0.01, max: 3 },
    currentSlewRate: { min: 0.01, max: 1.2 },
    voltageLimit: { min: 0, max: 60.5 },
    currentLimit: { min: 0.01, max: 24.5 },
    overVoltageProtection: { min: 3, max: 64 },
    limitsInferred: false,
    hasAux5V: true,
  },
  XLN8018: {
    model: 'XLN8018',
    voltage: { min: 0, max: 80 },
    current: { min: 0, max: 18 },
    power: 1440,
    voltageSlewRate: { min: 0.01, max: 3.2 },
    currentSlewRate: { min: 0.01, max: 0.72 },
    voltageLimit: { min: 0, max: 80.5 },
    currentLimit: { min: 0.01, max: 18.5 },
    overVoltageProtection: { min: 4, max: 85 },
    limitsInferred: true,
    hasAux5V: true,
  },
  XLN10014: {
    model: 'XLN10014',
    voltage: { min: 0, max: 100 },
    current: { min: 0, max: 14.4 },
    power: 1440,
    voltageSlewRate: { min: 0.01, max: 3.3 },
    currentSlewRate: { min: 0.01, max: 0.48 },
    voltageLimit: { min: 0, max: 100.5 },
    currentLimit: { min: 0.01, max: 14.9 },
    overVoltageProtection: { min: 5, max: 105 },
    limitsInferred: true,
    hasAux5V: true,
  },
  // The high-voltage models have non-zero *minimum* output settings.
  XLN15010: {
    model: 'XLN15010',
    voltage: { min: 5, max: 150 },
    current: { min: 0.04, max: 10.4 },
    power: 1560,
    voltageSlewRate: { min: 0.01, max: 1 },
    currentSlewRate: { min: 0.001, max: 0.104 },
    voltageLimit: { min: 5, max: 150.5 },
    currentLimit: { min: 0.04, max: 10.45 },
    overVoltageProtection: { min: 5, max: 158 },
    limitsInferred: false,
    hasAux5V: false,
  },
  XLN30052: {
    model: 'XLN30052',
    voltage: { min: 5, max: 300 },
    current: { min: 0.02, max: 5.2 },
    power: 1560,
    voltageSlewRate: { min: 0.01, max: 3.3 },
    currentSlewRate: { min: 0.001, max: 0.052 },
    voltageLimit: { min: 5, max: 300.5 },
    currentLimit: { min: 0.02, max: 5.25 },
    overVoltageProtection: { min: 5, max: 315 },
    limitsInferred: false,
    hasAux5V: false,
  },
  XLN60026: {
    model: 'XLN60026',
    voltage: { min: 5, max: 600 },
    current: { min: 0.01, max: 2.6 },
    power: 1560,
    voltageSlewRate: { min: 0.01, max: 6.6 },
    currentSlewRate: { min: 0.001, max: 0.026 },
    voltageLimit: { min: 5, max: 600.5 },
    currentLimit: { min: 0.01, max: 2.65 },
    overVoltageProtection: { min: 5, max: 630 },
    limitsInferred: false,
    hasAux5V: false,
  },
};

/**
 * Look up the spec for a model name.
 *
 * Tolerates the `-GL` suffix (the Ethernet/GPIB-equipped variants — which are
 * the only ones this library can talk to over TCP in the first place),
 * surrounding whitespace, and lowercase.
 *
 * Returns `undefined` for models not in the table, in which case the caller
 * should skip range validation rather than guess.
 */
export function lookupModel(name: string): XLNModelSpec | undefined {
  const normalized = name
    .trim()
    .toUpperCase()
    .replace(/[\s_-]*GL$/, '');
  return SPECS[normalized as XLNModelName];
}

/** All known model specs, for documentation and testing. */
export function allModels(): readonly XLNModelSpec[] {
  return XLN_MODELS.map((m) => SPECS[m]);
}
