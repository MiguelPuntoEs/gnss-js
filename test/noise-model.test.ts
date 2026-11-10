import { describe, it, expect } from 'vitest';
import { fitWhiteFlicker } from '../src/analysis/noise-model';
import { fitCoordinateSeries } from '../src/analysis/coordinate-series';
import { geodeticToEcef } from '../src/coordinates/ecef';

/** Seeded standard normal (mulberry32 + Box-Muller). */
function gauss(seed: number) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () =>
    Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
}

/** Flicker noise by Hosking fractional integration (d = 0.5). */
function flicker(n: number, rnd: () => number): number[] {
  const h = [1];
  for (let i = 1; i < n; i++) h.push((h[i - 1]! * (i - 0.5)) / i);
  const w = Array.from({ length: n }, rnd);
  return w.map((_, i) => {
    let s = 0;
    for (let k = 0; k <= i; k++) s += h[k]! * w[i - k]!;
    return s;
  });
}

// Weekly samples over 4 years, offset + velocity design.
const N = 208;
const tYears = Array.from({ length: N }, (_, i) => (i * 7) / 365.25);
const A = tYears.map((t) => [1, t - 2]);

describe('fitWhiteFlicker', () => {
  it('finds almost no flicker in white noise', () => {
    const rnd = gauss(1);
    const y = tYears.map((t) => 0.01 * t + 0.002 * rnd());
    const f = fitWhiteFlicker(A, y, tYears)!;
    expect(f.flickerShare).toBeLessThan(0.15);
    expect(f.velocity).toBeCloseTo(0.01, 3);
  });

  it(
    'gives velocity errors that match the actual scatter (Monte Carlo)',
    { timeout: 60_000 },
    () => {
      // 40 series with white + flicker noise: the spread of the estimated
      // velocities around the truth should match the realistic sigma, while
      // the white-noise sigma (φ = 0) is far too small.
      const vel: number[] = [];
      const sig: number[] = [];
      const share: number[] = [];
      for (let k = 0; k < 40; k++) {
        const rnd = gauss(100 + k);
        const fl = flicker(N, rnd);
        const y = tYears.map(
          (t, i) => 0.01 * t + 0.001 * rnd() + 0.0015 * fl[i]!
        );
        const f = fitWhiteFlicker(A, y, tYears)!;
        vel.push(f.velocity - 0.01);
        sig.push(f.velocitySigma);
        share.push(f.flickerShare);
      }
      const rms = Math.sqrt(vel.reduce((s, v) => s + v * v, 0) / vel.length);
      const meanSig = sig.reduce((s, v) => s + v, 0) / sig.length;
      expect(share.reduce((s, v) => s + v, 0) / share.length).toBeGreaterThan(
        0.5
      );
      expect(meanSig / rms).toBeGreaterThan(0.6);
      expect(meanSig / rms).toBeLessThan(1.6);
    }
  );
});

describe('fitCoordinateSeries — realistic velocity sigma', () => {
  it('is larger than the white-noise sigma when the series has flicker', () => {
    const lat = (49 * Math.PI) / 180;
    const lon = (12.9 * Math.PI) / 180;
    const ref = geodeticToEcef(lat, lon, 600);
    const rnd = gauss(11);
    const fl = [flicker(N, rnd), flicker(N, rnd), flicker(N, rnd)];
    const samples = tYears.map((t, i) => {
      const e = 0.02 * t + 0.001 * rnd() + 0.0015 * fl[0]![i]!;
      const n = 0.015 * t + 0.001 * rnd() + 0.0015 * fl[1]![i]!;
      const u = 0.003 * rnd() + 0.003 * fl[2]![i]!;
      const sl = Math.sin(lat);
      const cl = Math.cos(lat);
      const so = Math.sin(lon);
      const co = Math.cos(lon);
      return {
        tMs: Date.UTC(2022, 0, 1) + t * 365.25 * 86_400_000,
        ecef: [
          ref[0] - so * e - sl * co * n + cl * co * u,
          ref[1] + co * e - sl * so * n + cl * so * u,
          ref[2] + cl * n + sl * u,
        ] as [number, number, number],
      };
    });
    const f = fitCoordinateSeries(samples, {
      detectJumps: false,
      seasonal: false,
    })!;
    for (const c of [f.e, f.n, f.u]) {
      expect(c.velocitySigmaRealistic).not.toBeNull();
      expect(c.velocitySigmaRealistic!).toBeGreaterThan(1.5 * c.velocitySigma);
    }
  });
});
