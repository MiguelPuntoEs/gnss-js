import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseNavFile } from '../src/rinex/nav';
import type { KeplerEphemeris } from '../src/rinex/nav';
import { computeSatPosition } from '../src/orbit';
import { almanacSatPosition, almanacEpochMs } from '../src/orbit/almanac';
import type { SbfKeplerAlmanac } from '../src/sbf/nav';

const BRDC = join(__dirname, '../test-fixtures/brdc_v3_igs.nav');

/**
 * Oracle strategy: an almanac is an ephemeris with the correction
 * terms dropped, so a synthetic almanac built from a REAL broadcast
 * ephemeris must land within the dropped terms' effect (km-class at
 * the reference epoch) of the full ephemeris propagation — and the
 * ephemeris path is itself oracle-validated against precise orbits.
 * This pins the epoch conventions (GPS/GAL week vs BDT week+14 s),
 * the per-system node rotations incl. the BDS GEO frame, and the
 * deliberately unfolded time handling.
 */
const toAlm = (e: KeplerEphemeris): SbfKeplerAlmanac => ({
  system: e.system as 'G' | 'E' | 'C',
  prn: e.prn,
  weekAlm: e.week,
  toaSec: e.toe,
  sqrtA: e.sqrtA,
  e: e.e,
  i0OrDeltaI: e.i0,
  omega0: e.omega0,
  omega: e.omega,
  m0: e.m0,
  omegaDot: e.omegaDot,
  af0: e.af0,
  af1: e.af1,
  health: 0,
});

const dist = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe.skipIf(!existsSync(BRDC))('almanacSatPosition', () => {
  const nav = existsSync(BRDC)
    ? parseNavFile(readFileSync(BRDC, 'utf-8'))
    : null!;
  const kepler = () =>
    (nav.ephemerides as KeplerEphemeris[]).filter((e) => 'sqrtA' in e);

  const firstOf = (pred: (e: KeplerEphemeris) => boolean) =>
    kepler().find(pred)!;

  it.each([
    ['GPS', (e: KeplerEphemeris) => e.system === 'G', 15e3],
    ['Galileo', (e: KeplerEphemeris) => e.system === 'E', 15e3],
    [
      'BeiDou MEO/IGSO',
      (e: KeplerEphemeris) =>
        e.system === 'C' &&
        Number(e.prn.slice(1)) > 5 &&
        Number(e.prn.slice(1)) < 59,
      15e3,
    ],
    [
      'BeiDou GEO',
      (e: KeplerEphemeris) => e.system === 'C' && Number(e.prn.slice(1)) <= 5,
      15e3,
    ],
  ])(
    '%s: synthetic almanac lands km-class from the full ephemeris at toe',
    (_label, pred, tol) => {
      const eph = firstOf(pred);
      expect(eph).toBeDefined();
      const alm = toAlm(eph);
      const t = almanacEpochMs(alm);
      const full = computeSatPosition(eph, t);
      const approx = almanacSatPosition(alm, t);
      const d = dist(approx, full);
      // Above ~1 m proves the harmonics really are dropped; below the
      // tolerance proves epochs/rotations/GM are right (a timescale
      // slip of even 1 s would cost ~3 km, 14 s ~42 km).
      expect(d).toBeGreaterThan(1);
      expect(d).toBeLessThan(tol);
    }
  );

  it('tracks the constellation across the day (GPS, +21 h)', () => {
    // Almanac from the day's first G record, compared against the
    // ephemeris broadcast ~21 h later — the almanac-vs-eph distance
    // must stay almanac-class, proving the day-scale propagation.
    const first = firstOf((e) => e.system === 'G');
    const later = kepler()
      .filter((e) => e.prn === first.prn)
      .sort((a, b) => b.toe - a.toe)[0]!;
    expect(later.toe - first.toe).toBeGreaterThan(20 * 3600);
    const alm = toAlm(first);
    const t = almanacEpochMs(toAlm(later));
    const d = dist(almanacSatPosition(alm, t), computeSatPosition(later, t));
    expect(d).toBeLessThan(60e3);
  });

  it('does not fold multi-day offsets into the half-week window', () => {
    const eph = firstOf((e) => e.system === 'G');
    const alm = toAlm(eph);
    const t0 = almanacEpochMs(alm);
    const plus5d = almanacSatPosition(alm, t0 + 5 * 86400_000);
    // A ±302400 s fold would alias +5 d onto −2 d.
    const minus2d = almanacSatPosition(alm, t0 - 2 * 86400_000);
    expect(dist(plus5d, minus2d)).toBeGreaterThan(1e5);
    // And the orbit radius stays nominal far from the epoch.
    const r = Math.hypot(plus5d.x, plus5d.y, plus5d.z);
    expect(r).toBeGreaterThan(26e6);
    expect(r).toBeLessThan(27e6);
  });

  it('evaluates the almanac clock polynomial', () => {
    const eph = firstOf((e) => e.system === 'G');
    const alm = toAlm(eph);
    const t = almanacEpochMs(alm);
    expect(almanacSatPosition(alm, t).clockBias).toBe(alm.af0);
    expect(almanacSatPosition(alm, t + 3600_000).clockBias).toBeCloseTo(
      alm.af0 + alm.af1 * 3600,
      18
    );
  });
});
