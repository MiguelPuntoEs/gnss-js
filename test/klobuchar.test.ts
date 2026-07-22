import { describe, it, expect } from 'vitest';
import { klobucharDelay } from '../src/positioning';
import type { KlobucharCoeffs } from '../src/positioning';

const D2R = Math.PI / 180;

// Representative broadcast coefficients (2024-001 BRDC header values).
const COEFFS: KlobucharCoeffs = {
  alpha: [2.0489e-8, 7.4506e-9, -1.1921e-7, 0],
  beta: [1.2288e5, -1.6384e4, -2.6214e5, 6.5536e4],
};

/**
 * Independent reimplementation, written directly from the IS-GPS-200
 * step list (different structure: no Horner, explicit powers). The two
 * implementations share no code — agreement over a broad input grid
 * pins the transcription of the spec.
 */
function reference(
  c: KlobucharCoeffs,
  lat: number,
  lon: number,
  az: number,
  el: number,
  tow: number
): number {
  const E = el / Math.PI;
  const psi = 0.0137 / (E + 0.11) - 0.022;
  let phiI = lat / Math.PI + psi * Math.cos(az);
  phiI = Math.min(0.416, Math.max(-0.416, phiI));
  const lambdaI =
    lon / Math.PI + (psi * Math.sin(az)) / Math.cos(phiI * Math.PI);
  const phiM = phiI + 0.064 * Math.cos((lambdaI - 1.617) * Math.PI);
  let t = 4.32e4 * lambdaI + tow;
  t -= Math.floor(t / 86400) * 86400;
  const amp = Math.max(
    0,
    c.alpha[0]! +
      c.alpha[1]! * phiM +
      c.alpha[2]! * phiM ** 2 +
      c.alpha[3]! * phiM ** 3
  );
  const per = Math.max(
    72000,
    c.beta[0]! +
      c.beta[1]! * phiM +
      c.beta[2]! * phiM ** 2 +
      c.beta[3]! * phiM ** 3
  );
  const F = 1 + 16 * (0.53 - E) ** 3;
  const x = (2 * Math.PI * (t - 50400)) / per;
  return Math.abs(x) < 1.57
    ? F * (5e-9 + amp * (1 - x ** 2 / 2 + x ** 4 / 24))
    : F * 5e-9;
}

describe('klobucharDelay', () => {
  it('matches an independent spec transcription over an input grid', () => {
    for (const lat of [-60, -20, 0, 35, 70]) {
      for (const lon of [-150, -4, 100]) {
        for (const el of [5, 15, 45, 88]) {
          for (const az of [0, 130, 250]) {
            for (const tow of [0, 30000, 50400, 86000, 400000]) {
              const got = klobucharDelay(
                COEFFS,
                lat * D2R,
                lon * D2R,
                az * D2R,
                el * D2R,
                tow
              );
              const want = reference(
                COEFFS,
                lat * D2R,
                lon * D2R,
                az * D2R,
                el * D2R,
                tow
              );
              expect(got).toBeCloseTo(want, 15);
            }
          }
        }
      }
    }
  });

  it('returns the 5 ns night floor away from the daytime cosine', () => {
    // Local midnight at Greenwich: tow such that pierce-point local
    // time is far from 14:00. Zenith view keeps F ≈ 1.
    const d = klobucharDelay(COEFFS, 51 * D2R, 0, 0, 89 * D2R, 10000);
    expect(d).toBeGreaterThan(4.9e-9);
    expect(d).toBeLessThan(5.5e-9);
  });

  it('daytime delay exceeds night, low elevation exceeds zenith', () => {
    const day = 50400; // 14:00 local at lon 0
    const night = 10000;
    const zenithDay = klobucharDelay(COEFFS, 40 * D2R, 0, 0, 88 * D2R, day);
    const zenithNight = klobucharDelay(COEFFS, 40 * D2R, 0, 0, 88 * D2R, night);
    const slantDay = klobucharDelay(COEFFS, 40 * D2R, 0, 0, 5 * D2R, day);
    expect(zenithDay).toBeGreaterThan(zenithNight);
    expect(slantDay).toBeGreaterThan(zenithDay * 2); // obliquity F ~ 3
    // Physical range: L1 delay 1–35 m → 3–120 ns
    expect(zenithDay).toBeGreaterThan(3e-9);
    expect(slantDay).toBeLessThan(1.5e-7);
  });

  it('has no gross jump across the day-time cosine edge (|x| = 1.57)', () => {
    // The spec truncates the cosine series at |x| = 1.57; the residual
    // step there is ~2% of AMP. Steps along the curve must stay at the
    // natural-slope scale, never a hard discontinuity.
    const at = (tow: number) =>
      klobucharDelay(COEFFS, 40 * D2R, 0, 180 * D2R, 30 * D2R, tow);
    for (let tow = 20000; tow < 30000; tow += 10) {
      expect(Math.abs(at(tow) - at(tow + 10))).toBeLessThan(2e-9);
    }
  });

  it('returns 0 for malformed coefficient arrays', () => {
    expect(klobucharDelay({ alpha: [], beta: [] }, 0, 0, 0, 1, 0)).toBe(0);
  });
});
