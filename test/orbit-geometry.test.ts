import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sunEcef } from '../src/positioning';
import {
  betaAngle,
  computeTlePositions,
  elementSummary,
  inertialVelocity,
  parseOmmJson,
  parseTle,
  predictPasses,
  shadowIntervals,
  stateToKeplerian,
  sunlitFraction,
  tlePositionEcef,
  tleSatellite,
  type GpElements,
} from '../src/orbit';

const DIR = join(__dirname, '../test-fixtures/sgp4');
const omm = parseOmmJson(
  readFileSync(join(DIR, 'celestrak_gnss_2026-11-14.json'), 'utf-8')
);
const byName = (p: string): GpElements =>
  omm.find((e) => e.name?.startsWith(p))!;
const T = Date.UTC(2026, 10, 14, 19, 0, 0);
const DELFT: [number, number, number] = [3924687.7, 301132.7, 5001910.9];

const ISS = parseTle(
  [
    '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927',
    '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
  ].join('\n')
).sets[0]!;
const MOLNIYA = parseTle(
  [
    '1 08195U 75081A   06176.33215444  .00000099  00000-0  11873-3 0   813',
    '2 08195  64.1586 279.0717 6877146 264.7651  20.2257  2.00491383225656',
  ].join('\n')
).sets[0]!;

describe('elementSummary', () => {
  it('classifies the regimes', () => {
    expect(elementSummary(ISS).regime).toBe('LEO');
    expect(elementSummary(byName('GPS BIII-7')).regime).toBe('MEO');
    expect(elementSummary(byName('SES-5')).regime).toBe('GEO');
    expect(elementSummary(byName('QZS-2')).regime).toBe('IGSO');
    expect(elementSummary(byName('BEIDOU-3 IGSO-1')).regime).toBe('IGSO');
    expect(elementSummary(MOLNIYA).regime).toBe('HEO');
  });

  it('gives the textbook numbers', () => {
    const gps = elementSummary(byName('GPS BIII-7'));
    expect(gps.periodMin).toBeCloseTo(718, 0); // half a sidereal day
    expect(gps.semiMajorAxisKm).toBeGreaterThan(26500);
    expect(gps.semiMajorAxisKm).toBeLessThan(26620);
    const gal = elementSummary(byName('GSAT0211'));
    expect(gal.periodMin / 60).toBeGreaterThan(14.0);
    expect(gal.periodMin / 60).toBeLessThan(14.2);
    const iss = elementSummary(ISS);
    expect(iss.perigeeKm).toBeGreaterThan(330);
    expect(iss.apogeeKm).toBeLessThan(370);
  });
});

describe('stateToKeplerian', () => {
  it('recovers a GPS orbit from its state', () => {
    const el = byName('GPS BIII-7');
    const p = tlePositionEcef(tleSatellite(el), T)!;
    const k = stateToKeplerian([p.x, p.y, p.z], inertialVelocity(p));
    expect(k.i).toBeCloseTo(el.inclination, 0); // osculating vs mean
    expect(k.e).toBeLessThan(0.03);
    expect(k.period / 60).toBeCloseTo(718, -1);
  });

  it('is self-consistent on an eccentric orbit', () => {
    // r, v of a 7000 × 20000 km orbit at perigee, inclined 30°
    const mu = 3.986004418e14;
    const rp = 7.0e6;
    const ra = 2.0e7;
    const a = (rp + ra) / 2;
    const vp = Math.sqrt(mu * (2 / rp - 1 / a));
    const inc = (30 * Math.PI) / 180;
    const k = stateToKeplerian(
      [rp, 0, 0],
      [0, vp * Math.cos(inc), vp * Math.sin(inc)]
    );
    expect(k.a).toBeCloseTo(a, 0);
    expect(k.e).toBeCloseTo((ra - rp) / (ra + rp), 9);
    expect(k.i).toBeCloseTo(30, 9);
    expect(k.trueAnomaly).toBeCloseTo(0, 6);
    expect(k.argPerigee).toBeCloseTo(0, 6);
  });
});

describe('Sun geometry', () => {
  it('sunlit fraction: noon side lit, midnight side in umbra', () => {
    const sun = sunEcef(T);
    const s = Math.hypot(...sun);
    const u = sun.map((x) => x / s) as [number, number, number];
    const r = 2.66e7;
    expect(sunlitFraction([u[0] * r, u[1] * r, u[2] * r], sun)).toBe(1);
    expect(sunlitFraction([-u[0] * r, -u[1] * r, -u[2] * r], sun)).toBe(0);
  });

  it('GPS: eclipses happen exactly when |β| is small', () => {
    let eclipsing = 0;
    for (const el of omm.filter((e) => e.name?.startsWith('GPS'))) {
      const sat = tleSatellite(el);
      const p = tlePositionEcef(sat, T)!;
      const beta = betaAngle(p, sunEcef(T));
      const sh = shadowIntervals(
        (t) => tlePositionEcef(sat, t),
        T,
        T + 12 * 3600_000
      );
      // GPS shadow cone: |β| < ~13.9°; margin for β drift over 12 h
      if (Math.abs(beta) > 15)
        expect(sh, `${el.name} β=${beta.toFixed(1)}`).toHaveLength(0);
      if (Math.abs(beta) < 12) {
        expect(
          sh.length,
          `${el.name} β=${beta.toFixed(1)}`
        ).toBeGreaterThanOrEqual(1);
        const longest = Math.max(...sh.map((s) => s.end - s.start));
        expect(longest / 60_000).toBeLessThan(60); // GPS max ≈ 56 min
        eclipsing++;
      }
    }
    // in any season one or two GPS planes are near β = 0
    expect(eclipsing).toBeGreaterThan(0);
  });

  it('GEO: no eclipses in mid-November (seasons straddle the equinoxes)', () => {
    const sat = tleSatellite(byName('SES-5'));
    const sh = shadowIntervals(
      (t) => tlePositionEcef(sat, t),
      T,
      T + 24 * 3600_000
    );
    expect(sh).toHaveLength(0);
    expect(
      Math.abs(betaAngle(tlePositionEcef(sat, T)!, sunEcef(T)))
    ).toBeGreaterThan(8.7);
  });
});

describe('predictPasses', () => {
  it('agrees with the sampled elevation series', () => {
    const el = byName('GPS BIII-7');
    const sat = tleSatellite(el);
    const t0 = T - 12 * 3600_000;
    const t1 = T + 12 * 3600_000;
    const passes = predictPasses(
      (t) => tlePositionEcef(sat, t),
      DELFT,
      t0,
      t1,
      { maskDeg: 10, stepMs: 60_000 }
    );
    expect(passes.length).toBeGreaterThanOrEqual(1);
    const times: number[] = [];
    for (let t = t0; t <= t1; t += 30_000) times.push(t);
    const series = computeTlePositions([sat], times, DELFT).positions[sat.id]!;
    for (const p of passes) {
      expect(p.rise).toBeLessThan(p.maxTime);
      expect(p.maxTime).toBeLessThan(p.set);
      expect(p.maxElevation).toBeGreaterThanOrEqual(10);
      // sampled max within the pass ≤ refined max, and close to it
      let sampled = -90;
      times.forEach((t, k) => {
        if (t >= p.rise && t <= p.set)
          sampled = Math.max(sampled, (series[k]!.el * 180) / Math.PI);
      });
      expect(sampled).toBeLessThanOrEqual(p.maxElevation + 1e-6);
      expect(p.maxElevation - sampled).toBeLessThan(0.1);
    }
  });

  it('predicts short LEO passes', () => {
    const sat = tleSatellite(ISS);
    const t0 = Date.UTC(2008, 8, 20, 12, 0, 0);
    const passes = predictPasses(
      (t) => tlePositionEcef(sat, t),
      DELFT,
      t0,
      t0 + 86400_000,
      { maskDeg: 10 }
    );
    expect(passes.length).toBeGreaterThanOrEqual(2);
    for (const p of passes) {
      const min = (p.set - p.rise) / 60_000;
      expect(min).toBeGreaterThan(0);
      expect(min).toBeLessThan(12);
    }
  });
});
