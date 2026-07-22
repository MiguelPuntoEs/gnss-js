import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseNavFile } from '../src/rinex';
import { computeSatPosition, rangeRate, dopplerHz } from '../src/orbit';
import { C_LIGHT } from '../src/constants/gnss';

const DIR = join(__dirname, '../test-fixtures');
const HAS_DATA = existsSync(join(DIR, 'BRDC.nav'));

// Mid-validity evaluation time for the 2024-001 BRDC fixture.
const T_MS = Date.UTC(2024, 0, 1, 2, 0, 0);
const ABMF: [number, number, number] = [2919785.712, -5383745.067, 1774604.692];

/**
 * The analytic velocity must match a central finite difference of the
 * position to sub-mm/s (Kepler) / sub-cm/s (integrated + GEO): the two
 * derivations share nothing but the ephemeris, so agreement pins both.
 */
describe.skipIf(!HAS_DATA)('satellite velocity', () => {
  const nav = parseNavFile(readFileSync(join(DIR, 'BRDC.nav'), 'utf-8'));

  // One satellite per constellation, including a BDS GEO (C01–C05).
  const wanted = ['G', 'R', 'E', 'C'];
  const picks = new Map<string, (typeof nav.ephemerides)[number]>();
  for (const eph of nav.ephemerides) {
    const sys = eph.prn[0]!;
    if (!wanted.includes(sys)) continue;
    // Generic C pick must be a MEO/IGSO (C01–C05 are GEO).
    if (sys === 'C' && Number(eph.prn.slice(1)) <= 5) {
      if (!picks.has('C-GEO')) picks.set('C-GEO', eph);
    } else if (!picks.has(sys)) picks.set(sys, eph);
  }

  for (const [label, eph] of picks) {
    it(`matches finite-difference velocity (${label} ${eph.prn})`, () => {
      const h = 2000; // ms — coarser than the internal GEO differencing
      const p0 = computeSatPosition(eph, T_MS);
      const pm = computeSatPosition(eph, T_MS - h);
      const pp = computeSatPosition(eph, T_MS + h);
      expect(Number.isFinite(p0.x)).toBe(true);

      const fdx = (pp.x - pm.x) / ((2 * h) / 1000);
      const fdy = (pp.y - pm.y) / ((2 * h) / 1000);
      const fdz = (pp.z - pm.z) / ((2 * h) / 1000);

      // Orbital speeds are km/s-scale; agreement to cm/s is 6 orders
      // below signal.
      expect(Math.abs(p0.vx - fdx)).toBeLessThan(0.01);
      expect(Math.abs(p0.vy - fdy)).toBeLessThan(0.01);
      expect(Math.abs(p0.vz - fdz)).toBeLessThan(0.01);

      // ECEF speed sanity: MEO ~2.6–3.9 km/s, GEO (Earth-fixed) slow.
      const speed = Math.hypot(p0.vx, p0.vy, p0.vz);
      if (label === 'C-GEO') expect(speed).toBeLessThan(500);
      else {
        expect(speed).toBeGreaterThan(1000);
        expect(speed).toBeLessThan(5000);
      }
    });
  }

  it('range rate matches the numeric derivative of range', () => {
    const eph = picks.get('G')!;
    const h = 1000;
    const at = (t: number) => {
      const p = computeSatPosition(eph, t);
      return Math.hypot(p.x - ABMF[0], p.y - ABMF[1], p.z - ABMF[2]);
    };
    const rr = rangeRate(computeSatPosition(eph, T_MS), ABMF);
    const fd = (at(T_MS + h) - at(T_MS - h)) / ((2 * h) / 1000);
    expect(Math.abs(rr - fd)).toBeLessThan(0.01);
    // Range rates are bounded by ~±800 m/s for a ground receiver.
    expect(Math.abs(rr)).toBeLessThan(1000);
  });

  it('converts range rate to carrier Doppler', () => {
    // A satellite closing at 500 m/s shifts L1 up by f·v/c.
    const f = 1575.42e6;
    expect(dopplerHz(-500, f)).toBeCloseTo((500 * f) / C_LIGHT, 6);
    expect(dopplerHz(0, f)).toBeCloseTo(0, 12);
  });
});
