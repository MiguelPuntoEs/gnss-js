import { describe, expect, it } from 'vitest';
import { getRINEX, getDateFromRINEX } from '../src/time/rinex';

describe('getRINEX', () => {
  it('formats a date as a RINEX epoch line', () => {
    const d = new Date(Date.UTC(2024, 0, 15, 12, 0, 0));
    expect(getRINEX(d)).toBe('> 2024 01 15 12 00 00.0000000');
  });

  it('pads single-digit fields and carries milliseconds', () => {
    const d = new Date(Date.UTC(2026, 6, 3, 4, 5, 6, 250));
    expect(getRINEX(d)).toBe('> 2026 07 03 04 05 06.2500000');
  });
});

describe('getDateFromRINEX', () => {
  it('parses a RINEX epoch line back to a Date', () => {
    const d = getDateFromRINEX('> 2024 01 15 12 00 00.0000000');
    expect(d.toISOString()).toBe('2024-01-15T12:00:00.000Z');
  });

  it('round-trips through getRINEX including fractional seconds', () => {
    for (const iso of [
      '2024-01-15T12:00:00.000Z',
      '2026-07-03T04:05:06.250Z',
      '1999-12-31T23:59:59.999Z',
    ]) {
      const d = new Date(iso);
      expect(getDateFromRINEX(getRINEX(d)).getTime()).toBe(d.getTime());
    }
  });
});
