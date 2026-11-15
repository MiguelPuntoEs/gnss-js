import { describe, expect, test } from 'vitest';
import {
  getDateFromDayOfWeek,
  getDateFromDayOfYear,
  getDateFromJulianDate,
  getDateFromRINEX,
  getDateFromUnixTime,
  getDateFromUtc,
  getGpsLeap,
  getHoursFromTimeDifference,
  getJulianDate,
  getLeap,
  getMinutesFromTimeDifference,
  getMJD,
  getSecondsFromTimeDifference,
  getTimeDifferenceFromObject,
  getTotalDaysFromTimeDifference,
  getUtcDate,
  isLeapSecond,
  Scale,
} from '../src/time';

/** Every leap second: first UTC instant of the new count, new TAI−UTC (IERS). */
const LEAPS: [string, number][] = [
  ['1972-07-01', 11],
  ['1973-01-01', 12],
  ['1974-01-01', 13],
  ['1975-01-01', 14],
  ['1976-01-01', 15],
  ['1977-01-01', 16],
  ['1978-01-01', 17],
  ['1979-01-01', 18],
  ['1980-01-01', 19],
  ['1981-07-01', 20],
  ['1982-07-01', 21],
  ['1983-07-01', 22],
  ['1985-07-01', 23],
  ['1988-01-01', 24],
  ['1990-01-01', 25],
  ['1991-01-01', 26],
  ['1992-07-01', 27],
  ['1993-07-01', 28],
  ['1994-07-01', 29],
  ['1996-01-01', 30],
  ['1997-07-01', 31],
  ['1999-01-01', 32],
  ['2006-01-01', 33],
  ['2009-01-01', 34],
  ['2012-07-01', 35],
  ['2015-07-01', 36],
  ['2017-01-01', 37],
];

const at = (iso: string) => new Date(iso).getTime();

describe('leap seconds', () => {
  test.each(LEAPS)('step at %s to %i s', (day, leap) => {
    const step = at(`${day}T00:00:00Z`);
    // UTC → GPS on both sides of the step: GPS = UTC + (TAI−UTC) − 19 s
    for (const dt of [-1500, -500, 0, 500, 1000]) {
      const n = dt < 0 ? leap - 1 : leap;
      const gps = getDateFromUtc(new Date(step + dt)).getTime();
      expect(gps - (step + dt)).toBe((n - 19) * 1000);
      expect(getDateFromUnixTime(step + dt).getTime()).toBe(gps);
    }
    // GPS second that is 23:59:60 UTC: old count, flagged as a leap second
    const inside = new Date(step + (leap - 1 - 19) * 1000 + 500);
    expect(getLeap(inside)).toBe(leap - 1);
    expect(isLeapSecond(inside)).toBe(true);
    // one second later the new count applies and UTC reads 00:00:00
    const after = new Date(step + (leap - 19) * 1000);
    expect(getLeap(after)).toBe(leap);
    expect(getUtcDate(after).getTime()).toBe(step);
    expect(isLeapSecond(after)).toBe(false);
    expect(isLeapSecond(new Date(inside.getTime() - 1000))).toBe(false);
  });

  test('GPS → UTC → GPS is exact outside leap seconds, 1980–2030', () => {
    for (
      let t = at('1980-01-06T00:00:00Z');
      t < at('2030-01-01T00:00:00Z');
      t += 3_600_500
    ) {
      const d = new Date(t);
      if (isLeapSecond(d)) continue;
      expect(getDateFromUtc(getUtcDate(d)).getTime()).toBe(t);
    }
  });

  test('GPS − UTC is 18 s now and 0 at the GPS epoch', () => {
    expect(getGpsLeap(new Date('2026-11-15T00:00:00Z'))).toBe(18);
    expect(getGpsLeap(new Date('1980-01-06T00:00:00Z'))).toBe(0);
  });
});

describe('Julian dates', () => {
  test('anchors', () => {
    // MJD 44244 = GPS epoch; J2000.0 = JD 2451545.0 TT = 11:58:55.816 UTC
    expect(getMJD(new Date('1980-01-06T00:00:00Z'), Scale.UTC)).toBe(44244);
    expect(getMJD(new Date('1980-01-06T00:00:00Z'), Scale.GPS)).toBe(44244);
    const j2000 = getDateFromUtc(new Date('2000-01-01T11:58:55.816Z'));
    expect(getJulianDate(j2000, Scale.TT)).toBeCloseTo(2451545.0, 9);
    expect(getDateFromJulianDate(2451545.0, Scale.TT).getTime()).toBe(
      j2000.getTime()
    );
    expect(getDateFromJulianDate(2451545.0, Scale.UTC).toISOString()).toBe(
      getDateFromUtc(new Date('2000-01-01T12:00:00Z')).toISOString()
    );
  });

  test.each([Scale.TAI, Scale.TT, Scale.GPS, Scale.UTC])(
    'round trip to the millisecond (scale %i)',
    (scale) => {
      for (
        let t = at('1980-01-06T00:00:00Z');
        t < at('2100-01-01T00:00:00Z');
        t += 86_400_000 * 7 + 4_321_987
      ) {
        const d = new Date(t);
        if (scale === Scale.UTC && isLeapSecond(d)) continue;
        expect(
          getDateFromJulianDate(getJulianDate(d, scale), scale).getTime()
        ).toBe(t);
      }
    }
  );
});

describe('getDateFromRINEX', () => {
  test.each([
    ['> 2026 11 15 12 30 45.1234567', '2026-11-15T12:30:45.123Z'],
    ['> 2026 11 15 12 30 45.5', '2026-11-15T12:30:45.500Z'],
    ['> 2026 11 15 12 30 45.0000000  0 31', '2026-11-15T12:30:45.000Z'],
    ['>2026 1 5 2 3 4', '2026-01-05T02:03:04.000Z'],
    [' 26 11 15 12 30 45.0000000  0 12G01G02', '2026-11-15T12:30:45.000Z'],
    [' 99 12 31 23 59 59.9990000', '1999-12-31T23:59:59.999Z'],
  ])('%s', (text, iso) => {
    expect(getDateFromRINEX(text).toISOString()).toBe(iso);
  });

  test.each([
    'hello',
    '',
    '> 2026 13 01 00 00 00.0',
    '> 2026 02 30 00 00 00.0',
    '> 2026 11 15 24 00 00.0',
    '> 2026 11 15 12 60 00.0',
    '> 2026 11 15 12 30 60.0',
  ])('rejects %j', (text) => {
    expect(Number.isNaN(getDateFromRINEX(text).getTime())).toBe(true);
  });
});

describe('calendar inputs', () => {
  const ref = new Date('2025-06-01T07:00:00Z');
  test('day of year must be a day of the reference year', () => {
    expect(getDateFromDayOfYear(365, ref).toISOString()).toBe(
      '2025-12-31T07:00:00.000Z'
    );
    expect(
      getDateFromDayOfYear(366, new Date('2024-06-01T07:00:00Z')).toISOString()
    ).toBe('2024-12-31T07:00:00.000Z');
    for (const n of [0, 366, 1.5, NaN])
      expect(() => getDateFromDayOfYear(n, ref)).toThrow(RangeError);
  });
  test('day of week must be 0–6', () => {
    for (const n of [-1, 7, 2.5])
      expect(() => getDateFromDayOfWeek(n, ref)).toThrow(/between 0 and 6/);
  });
});

describe('time difference components', () => {
  test.each([-1000, -90_061_000, 98_745_000, 500, 0])(
    '%i ms adds back up',
    (ms) => {
      const parts = {
        days: getTotalDaysFromTimeDifference(ms),
        hours: getHoursFromTimeDifference(ms),
        minutes: getMinutesFromTimeDifference(ms),
        seconds: getSecondsFromTimeDifference(ms),
      };
      expect(getTimeDifferenceFromObject(parts)).toBe(
        Math.sign(ms) * Math.floor(Math.abs(ms) / 1000) * 1000
      );
    }
  );
  test('−1 s is −1 s, not −1 d −1 h −1 min −1 s', () => {
    expect(getTotalDaysFromTimeDifference(-1000)).toBe(0);
    expect(getHoursFromTimeDifference(-1000)).toBe(0);
    expect(getSecondsFromTimeDifference(-1000)).toBe(-1);
  });
});
