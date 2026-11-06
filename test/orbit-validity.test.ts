import { describe, it, expect } from 'vitest';
import type { Ephemeris } from '../src/rinex/nav';
import {
  EPHEMERIS_VALIDITY_MS,
  isEphemerisValid,
  nearestValidEphemeris,
  selectEphemeris,
} from '../src/orbit/index';

const T = Date.UTC(2026, 10, 6, 10, 0, 0); // GPS-scale epoch under test
const LEAP_MS = 18_000; // GPS − UTC in 2026
const MIN = 60_000;

/** Only `system` and `tocDate` matter to the validity rule. */
const eph = (prn: string, tocMs: number) =>
  ({ prn, system: prn[0], tocDate: new Date(tocMs) }) as unknown as Ephemeris;

describe('isEphemerisValid', () => {
  it('GPS / QZSS: ±2 h around toc', () => {
    for (const p of ['G01', 'J02']) {
      expect(isEphemerisValid(eph(p, T - 120 * MIN), T)).toBe(true);
      expect(isEphemerisValid(eph(p, T + 120 * MIN), T)).toBe(true);
      expect(isEphemerisValid(eph(p, T - 120 * MIN - 1), T)).toBe(false);
    }
  });

  it('GLONASS: ±15 min on the UTC axis', () => {
    const utc = T - LEAP_MS;
    expect(isEphemerisValid(eph('R01', utc + 15 * MIN), T)).toBe(true);
    expect(isEphemerisValid(eph('R01', utc - 15 * MIN), T)).toBe(true);
    expect(isEphemerisValid(eph('R01', utc + 15 * MIN + 1000), T)).toBe(false);
    // Compared on the GPS axis instead, this tb would wrongly pass by 18 s.
    expect(isEphemerisValid(eph('R01', T + 15 * MIN - 8000), T)).toBe(false);
  });

  it('SBAS GEO: 6 min, also on the UTC axis', () => {
    const utc = T - LEAP_MS;
    expect(isEphemerisValid(eph('S36', utc - 6 * MIN), T)).toBe(true);
    expect(isEphemerisValid(eph('S36', utc - 6 * MIN - 1000), T)).toBe(false);
    expect(isEphemerisValid(eph('S36', T - 3 * 60 * MIN), T)).toBe(false);
  });

  it('Galileo 2.5 h, BeiDou 90 min, NavIC 2 h', () => {
    expect(EPHEMERIS_VALIDITY_MS).toMatchObject({
      E: 150 * MIN,
      C: 90 * MIN,
      I: 120 * MIN,
    });
    expect(isEphemerisValid(eph('E05', T - 149 * MIN), T)).toBe(true);
    expect(isEphemerisValid(eph('C11', T - 91 * MIN), T)).toBe(false);
  });

  it('an unknown system is never valid', () => {
    expect(isEphemerisValid(eph('X01', T), T)).toBe(false);
  });
});

describe('nearestValidEphemeris / selectEphemeris', () => {
  it('picks the nearest toc among the valid ones', () => {
    const list = [
      eph('G01', T - 180 * MIN),
      eph('G01', T - 90 * MIN),
      eph('G01', T + 30 * MIN),
    ];
    expect(nearestValidEphemeris(list, T)).toBe(list[2]);
    expect(selectEphemeris(list, 'G01', T)).toBe(list[2]);
  });

  it('measures GLONASS nearness on the UTC axis', () => {
    // tb 30 s before vs 4 s after T. On the GPS axis the later one is
    // nearer (4 s vs 30 s); on the UTC axis (T − 18 s), where GLONASS tocs
    // live, the earlier one is (12 s vs 22 s) — and that is the right pick.
    const early = eph('R07', T - 30_000);
    const late = eph('R07', T + 4_000);
    expect(nearestValidEphemeris([late, early], T)).toBe(early);
  });

  it('null when nothing is valid', () => {
    expect(nearestValidEphemeris([eph('R05', T - 40 * MIN)], T)).toBeNull();
    expect(nearestValidEphemeris(undefined, T)).toBeNull();
    expect(
      selectEphemeris([eph('G01', T - 5 * 60 * MIN)], 'G01', T)
    ).toBeNull();
  });
});
