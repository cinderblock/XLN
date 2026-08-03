import { describe, expect, it } from 'vitest';
import {
  formatNumber,
  parseBoolean,
  parseDeviceError,
  parseIdentity,
  parseNumber,
  parseRegulationMode,
  parseStatus,
} from '../src/parse.js';
import { XLNProtocolError } from '../src/errors.js';

describe('parseNumber', () => {
  it('parses plain and signed decimals', () => {
    expect(parseNumber('12.345')).toBe(12.345);
    expect(parseNumber('-0.5')).toBe(-0.5);
    expect(parseNumber('+3')).toBe(3);
    expect(parseNumber('.25')).toBe(0.25);
  });

  it('tolerates surrounding whitespace and echoed units', () => {
    expect(parseNumber('  12.345  ')).toBe(12.345);
    // The manual shows the device accepting "VOLT 3.3V", so a unit suffix on
    // the way back is plausible.
    expect(parseNumber('3.3V')).toBe(3.3);
    expect(parseNumber('2.4 V/ms')).toBe(2.4);
  });

  it('rejects non-numeric responses rather than yielding NaN', () => {
    expect(() => parseNumber('ERROR')).toThrow(XLNProtocolError);
    expect(() => parseNumber('')).toThrow(XLNProtocolError);
    expect(() => parseNumber('CV')).toThrow(XLNProtocolError);
  });

  it('attaches the raw response to the error', () => {
    expect(() => parseNumber('nope', 'MEASURE:VOLTAGE?')).toThrow(
      /"nope".*MEASURE:VOLTAGE\?/s,
    );
  });
});

describe('parseBoolean', () => {
  it('accepts every encoding the firmware might use', () => {
    for (const truthy of ['1', '+1', 'ON', 'on', 'TRUE', 'yes']) {
      expect(parseBoolean(truthy), truthy).toBe(true);
    }
    for (const falsy of ['0', '-0', 'OFF', 'off', 'FALSE', 'no']) {
      expect(parseBoolean(falsy), falsy).toBe(false);
    }
  });

  it('rejects anything else', () => {
    expect(() => parseBoolean('2')).toThrow(XLNProtocolError);
    expect(() => parseBoolean('')).toThrow(XLNProtocolError);
  });
});

describe('parseIdentity', () => {
  it('parses the exact string real hardware returns', () => {
    // Captured from an XLN6024 on firmware 1.20. Note: no spaces after the
    // commas, no -GL suffix despite being an Ethernet unit, and a FIFTH field.
    const identity = parseIdentity('BK PRECISION,XLN6024,276G11128,1.20,0');
    expect(identity.manufacturer).toBe('BK PRECISION');
    expect(identity.model).toBe('XLN6024');
    expect(identity.serial).toBe('276G11128');
    expect(identity.firmware).toBe('1.20');
  });

  it('treats the trailing field as separate, not part of the version', () => {
    // The *IDN? table calls field 4 "firmware type, & version", which reads
    // like one field but is two — the manual's own CIDN? entry gives the
    // template as `...,fw_version,0`. Joining them would report "1.20, 0".
    const identity = parseIdentity('BK PRECISION,XLN6024,276G11128,1.20,0');
    expect(identity.firmware).toBe('1.20');
    expect(identity.fields).toEqual([
      'BK PRECISION',
      'XLN6024',
      '276G11128',
      '1.20',
      '0',
    ]);
  });

  it('tolerates spaces after commas', () => {
    const identity = parseIdentity('B&K Precision, XLN6024-GL, SN1, 1.00');
    expect(identity.manufacturer).toBe('B&K Precision');
    expect(identity.model).toBe('XLN6024-GL');
  });

  it('rejects a response with no commas', () => {
    expect(() => parseIdentity('XLN6024')).toThrow(XLNProtocolError);
  });
});

describe('parseDeviceError', () => {
  it('treats every spelling of zero as no error', () => {
    expect(parseDeviceError('0')).toBeNull();
    expect(parseDeviceError('-000')).toBeNull();
    expect(parseDeviceError('+0')).toBeNull();
    expect(parseDeviceError('0,"No error"')).toBeNull();
  });

  it('parses bare codes and looks up the description', () => {
    expect(parseDeviceError('-001')).toEqual({
      code: -1,
      description: 'Command error',
    });
    expect(parseDeviceError('-4')).toEqual({
      code: -4,
      description: 'Input range error',
    });
  });

  it('prefers a description supplied by the device', () => {
    expect(parseDeviceError('-1,"Something specific"')).toEqual({
      code: -1,
      description: 'Something specific',
    });
  });

  it('handles codes outside the documented table', () => {
    expect(parseDeviceError('-99')?.description).toMatch(/Unknown error code/);
  });

  it('rejects unparseable responses', () => {
    expect(() => parseDeviceError('No error')).toThrow(XLNProtocolError);
  });
});

describe('parseRegulationMode', () => {
  it('accepts CV and CC in any case', () => {
    expect(parseRegulationMode('CV')).toBe('CV');
    expect(parseRegulationMode('cc')).toBe('CC');
    expect(parseRegulationMode(' CV ')).toBe('CV');
  });

  it('passes through an unexpected reply instead of throwing', () => {
    // The manual only says "(CV or CC)" and never states the encoding. A
    // monitoring loop must degrade rather than die on a value we did not
    // anticipate, so the uppercased reply comes back as-is.
    expect(parseRegulationMode('1')).toBe('1');
    expect(parseRegulationMode('unreg')).toBe('UNREG');
  });

  it('still rejects an empty reply', () => {
    expect(() => parseRegulationMode('   ')).toThrow(XLNProtocolError);
  });
});

describe('parseStatus', () => {
  // Captured from an XLN6024 on firmware 1.20. The manual calls the enable
  // byte "byte 0", but it arrives LAST — reading the string left to right
  // decodes every flag as false.
  it('decodes the output bit from real hardware', () => {
    const off = parseStatus('000000');
    expect(off.enabled.output).toBe(false);

    const on = parseStatus('000004');
    expect(on.enabled.output).toBe(true);
  });

  it('decodes the OVP and OCP enable bits from real hardware', () => {
    expect(parseStatus('000080').enabled.overVoltage).toBe(true);
    expect(parseStatus('000080').enabled.overCurrent).toBe(false);

    expect(parseStatus('000040').enabled.overCurrent).toBe(true);
    expect(parseStatus('000040').enabled.overVoltage).toBe(false);
  });

  it('decodes latched fault flags from the middle byte', () => {
    // 0b0000_0110 = AC low and over-temperature both latched.
    const status = parseStatus('000600');
    expect(status.occurred.acLow).toBe(true);
    expect(status.occurred.overTemperature).toBe(true);
    expect(status.occurred.overVoltage).toBe(false);
    // The enable byte is untouched.
    expect(status.enabled.output).toBe(false);
  });

  it('reports bytes in manual order, not wire order', () => {
    const status = parseStatus('000204');
    expect(status.bytes).toEqual([0x04, 0x02, 0x00]);
    expect(status.enabled.output).toBe(true);
    expect(status.occurred.overTemperature).toBe(true);
  });

  it('accepts decimal and space-separated forms', () => {
    expect(parseStatus('0,0,4').enabled.output).toBe(true);
    expect(parseStatus('0 0 4').enabled.output).toBe(true);
  });

  it('rejects the wrong number of bytes', () => {
    expect(() => parseStatus('1,2')).toThrow(XLNProtocolError);
    expect(() => parseStatus('hello')).toThrow(XLNProtocolError);
  });
});

describe('formatNumber', () => {
  it('never uses exponential notation', () => {
    // The hand-rolled firmware parser is not documented to accept it.
    expect(formatNumber(0.0001)).toBe('0.0001');
    expect(formatNumber(1e-4)).toBe('0.0001');
    expect(formatNumber(600)).toBe('600');
  });

  it('trims trailing zeros without eating significant ones', () => {
    expect(formatNumber(12.5)).toBe('12.5');
    expect(formatNumber(12)).toBe('12');
    expect(formatNumber(100)).toBe('100');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(-0.5)).toBe('-0.5');
  });

  it('rejects non-finite values', () => {
    expect(() => formatNumber(Number.NaN)).toThrow(TypeError);
    expect(() => formatNumber(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});
