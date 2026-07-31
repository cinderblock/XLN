import { describe, expect, it } from 'vitest';
import { allModels, lookupModel, XLN_MODELS } from '../src/models.js';

describe('lookupModel', () => {
  it('finds every model in the table', () => {
    for (const name of XLN_MODELS) {
      expect(lookupModel(name)?.model, name).toBe(name);
    }
  });

  it('strips the -GL suffix', () => {
    // Only -GL models have Ethernet, so this is the common case over TCP.
    expect(lookupModel('XLN6024-GL')?.model).toBe('XLN6024');
    expect(lookupModel('XLN6024GL')?.model).toBe('XLN6024');
    expect(lookupModel('XLN6024 GL')?.model).toBe('XLN6024');
  });

  it('tolerates case and whitespace from *IDN?', () => {
    expect(lookupModel('  xln6024-gl  ')?.model).toBe('XLN6024');
  });

  it('returns undefined rather than guessing', () => {
    expect(lookupModel('XLN9999')).toBeUndefined();
    expect(lookupModel('')).toBeUndefined();
  });
});

describe('model table', () => {
  it('has coherent ranges', () => {
    for (const spec of allModels()) {
      expect(spec.voltage.min, spec.model).toBeLessThan(spec.voltage.max);
      expect(spec.current.min, spec.model).toBeLessThan(spec.current.max);
      // Soft limits must reach at least the rated output.
      expect(spec.voltageLimit.max, spec.model).toBeGreaterThanOrEqual(
        spec.voltage.max,
      );
      expect(spec.currentLimit.max, spec.model).toBeGreaterThanOrEqual(
        spec.current.max,
      );
      expect(spec.power, spec.model).toBeGreaterThan(0);
    }
  });

  it('keeps slew rates in per-millisecond units', () => {
    // A V/s value would be three orders of magnitude larger; this guards
    // against someone "fixing" the table to the wrong unit.
    for (const spec of allModels()) {
      expect(spec.voltageSlewRate.max, spec.model).toBeLessThan(10);
      expect(spec.currentSlewRate.max, spec.model).toBeLessThan(10);
    }
  });

  it('records non-zero minimums on the high-voltage models', () => {
    for (const model of ['XLN15010', 'XLN30052', 'XLN60026'] as const) {
      const spec = lookupModel(model);
      expect(spec?.voltage.min, model).toBe(5);
      expect(spec?.current.min, model).toBeGreaterThan(0);
      expect(spec?.hasAux5V, model).toBe(false);
    }
  });
});
