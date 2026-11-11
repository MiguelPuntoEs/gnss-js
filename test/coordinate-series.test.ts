import { describe, it, expect } from 'vitest';
import {
  fitCoordinateSeries,
  type CoordinateSample,
} from '../src/analysis/coordinate-series';
import { geodeticToEcef } from '../src/coordinates/ecef';

const DAY = 86_400_000;
const YEAR = 365.25 * DAY;
const T0 = Date.UTC(2023, 0, 1);

// A station near Delft; local ENU → ECEF.
const LAT = (52 * Math.PI) / 180;
const LON = (4.4 * Math.PI) / 180;
const REF = geodeticToEcef(LAT, LON, 50);
function enuToEcef(e: number, n: number, u: number): [number, number, number] {
  const sl = Math.sin(LAT);
  const cl = Math.cos(LAT);
  const so = Math.sin(LON);
  const co = Math.cos(LON);
  return [
    REF[0] - so * e - sl * co * n + cl * co * u,
    REF[1] + co * e - sl * so * n + cl * so * u,
    REF[2] + cl * n + sl * u,
  ];
}

/** Deterministic noise in [−1, 1]. */
const noise = (i: number, k: number) => Math.sin(i * 12.9898 + k * 78.233) % 1;

/** Weekly samples over 3 years: Eurasia-like velocity, an annual vertical
 *  signal, white noise (1.5 mm h / 4 mm v), optional jump and blunders. */
function series(opts: {
  jumpAt?: number;
  jump?: [number, number, number];
  blunders?: number[];
}): CoordinateSample[] {
  const v: [number, number, number] = [0.0205, 0.0148, 0.0008]; // m/yr
  const out: CoordinateSample[] = [];
  for (let i = 0; i < 157; i++) {
    const tMs = T0 + i * 7 * DAY;
    const yr = (tMs - T0) / YEAR;
    let e = v[0] * yr + 0.0015 * noise(i, 1);
    let n = v[1] * yr + 0.0015 * noise(i, 2);
    let u =
      v[2] * yr +
      0.004 * Math.sin((2 * Math.PI * tMs) / YEAR) +
      0.004 * noise(i, 3);
    if (opts.jumpAt != null && tMs >= opts.jumpAt && opts.jump) {
      e += opts.jump[0];
      n += opts.jump[1];
      u += opts.jump[2];
    }
    if (opts.blunders?.includes(i)) u += 0.08;
    out.push({
      tMs,
      ecef: enuToEcef(e, n, u),
      sigmaEnu: [0.002, 0.002, 0.005],
    });
  }
  return out;
}

describe('fitCoordinateSeries', () => {
  it('recovers the velocity and the annual signal', () => {
    const f = fitCoordinateSeries(series({}), { detectJumps: false })!;
    expect(f.spanYears).toBeGreaterThan(2.9);
    expect(f.seasonal).toBe(true);
    expect(f.e.velocity).toBeCloseTo(0.0205, 3); // ±0.5 mm/yr
    expect(f.n.velocity).toBeCloseTo(0.0148, 3);
    expect(Math.abs(f.u.velocity - 0.0008)).toBeLessThan(0.001);
    expect(f.u.annualAmplitude!).toBeGreaterThan(0.003);
    expect(f.u.annualAmplitude!).toBeLessThan(0.005);
    expect(f.e.velocitySigma).toBeGreaterThan(0);
    expect(f.e.velocitySigma).toBeLessThan(0.0005);
    expect(f.outliers).toBe(0);
  });

  it('rejects blunders as outliers', () => {
    const f = fitCoordinateSeries(series({ blunders: [30, 90] }), {
      detectJumps: false,
    })!;
    expect(f.outliers).toBe(2);
    expect(f.points[30]!.outlier).toBe(true);
    expect(f.points[90]!.outlier).toBe(true);
    expect(f.u.velocity).toBeCloseTo(0.0008, 3);
  });

  it('estimates a known jump (antenna change) and keeps the velocity', () => {
    const jumpAt = T0 + 1.4 * YEAR;
    const f = fitCoordinateSeries(
      series({ jumpAt, jump: [0.012, -0.004, 0.02] }),
      { jumps: [jumpAt], detectJumps: false }
    )!;
    expect(f.jumps).toEqual([{ tMs: jumpAt, detected: false }]);
    expect(f.e.steps[0]).toBeCloseTo(0.012, 3);
    expect(f.u.steps[0]).toBeCloseTo(0.02, 2);
    expect(f.e.velocity).toBeCloseTo(0.0205, 3);
  });

  it('finds an unannounced jump by itself', () => {
    const jumpAt = T0 + 1.4 * YEAR + 3 * DAY;
    const f = fitCoordinateSeries(
      series({ jumpAt, jump: [0.012, -0.004, 0.02] })
    )!;
    expect(f.jumps.length).toBe(1);
    expect(f.jumps[0]!.detected).toBe(true);
    expect(Math.abs(f.jumps[0]!.tMs - jumpAt)).toBeLessThan(7 * DAY);
    expect(f.e.velocity).toBeCloseTo(0.0205, 3);
  });

  it('adds no jump to a clean series', () => {
    const f = fitCoordinateSeries(series({}))!;
    expect(f.jumps).toEqual([]);
  });

  it('needs at least five samples', () => {
    expect(fitCoordinateSeries(series({}).slice(0, 4))).toBeNull();
  });
});

describe('fitCoordinateSeries outlier test on short series', () => {
  // Seeded Gaussian noise (Park–Miller + Box–Muller).
  let seed = 7;
  const uni = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gauss = () =>
    Math.sqrt(-2 * Math.log(uni() + 1e-12)) * Math.cos(2 * Math.PI * uni());
  const monthly = (n: number, blunderUp = 0): CoordinateSample[] =>
    Array.from({ length: n }, (_, i) => {
      const tMs = T0 + i * 30 * DAY;
      const yr = (tMs - T0) / YEAR;
      return {
        tMs,
        ecef: enuToEcef(
          0.02 * yr + 0.0015 * gauss(),
          0.015 * yr + 0.0015 * gauss(),
          0.004 * gauss() + (i === n >> 1 ? blunderUp : 0)
        ),
        sigmaEnu: [0.002, 0.002, 0.005],
      };
    });

  it('keeps every day of clean 12-day series (it used to drop one in 7)', () => {
    let lost = 0;
    for (let rep = 0; rep < 100; rep++)
      if (fitCoordinateSeries(monthly(12))!.outliers) lost++;
    expect(lost).toBeLessThanOrEqual(5);
  });

  it('still catches a 3 cm vertical blunder in 12 days', () => {
    let caught = 0;
    for (let rep = 0; rep < 50; rep++)
      if (fitCoordinateSeries(monthly(12, 0.03))!.points[6]!.outlier) caught++;
    expect(caught).toBeGreaterThanOrEqual(40);
  });
});

describe('fitCoordinateSeries known jumps', () => {
  it('merges steps with no sample between them instead of failing', () => {
    const pts: CoordinateSample[] = Array.from({ length: 13 }, (_, i) => {
      const tMs = T0 + i * 30 * DAY;
      const step = i >= 5 ? 0.02 : 0;
      return {
        tMs,
        ecef: enuToEcef(0.02 * ((tMs - T0) / YEAR) + step, 0, 0),
        sigmaEnu: [0.002, 0.002, 0.005],
      };
    });
    // Three steps inside the gap between samples 4 and 5 (an earthquake
    // sequence between two monthly days).
    const gap = T0 + 4 * 30 * DAY;
    const f = fitCoordinateSeries(pts, {
      jumps: [gap + 2 * DAY, gap + 9 * DAY, gap + 20 * DAY],
      detectJumps: false,
    });
    expect(f).not.toBeNull();
    expect(f!.jumps).toHaveLength(1);
    expect(f!.e.steps[0]).toBeCloseTo(0.02, 3);
  });
});

describe('fitCoordinateSeries jump search under flicker noise', () => {
  // Seeded Gaussian noise, and flicker noise by Kasdin's fractional
  // integration (α = 1): what GNSS series carry. Under it a white-noise
  // BIC finds two or three steps in every five-year series.
  let seed = 11;
  const uni = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gauss = () =>
    Math.sqrt(-2 * Math.log(uni() + 1e-12)) * Math.cos(2 * Math.PI * uni());
  const flicker = (n: number): number[] => {
    const h = [1];
    for (let k = 1; k < n; k++) h.push((h[k - 1]! * (k - 0.5)) / k);
    const w = Array.from({ length: n }, gauss);
    return w.map((_, i) => {
      let s = 0;
      for (let k = 0; k <= i; k++) s += h[k]! * w[i - k]!;
      return s;
    });
  };
  /** Five years every 5 days: 1.5 mm white + flicker (2.5× in Up). */
  const noisy = (step = 0): CoordinateSample[] => {
    const n = 365;
    const f = [flicker(n), flicker(n), flicker(n)];
    return Array.from({ length: n }, (_, i) => {
      const tMs = T0 + i * 5 * DAY;
      const c = (k: number, s: number) =>
        s * (0.0015 * gauss() + 0.0005 * f[k]![i]!);
      return {
        tMs,
        ecef: enuToEcef(c(0, 1) + (i >= n / 2 ? step : 0), c(1, 1), c(2, 2.5)),
        sigmaEnu: [0.001, 0.001, 0.003],
      };
    });
  };

  it('adds no steps to flicker noise', () => {
    let found = 0;
    for (let k = 0; k < 4; k++)
      found += fitCoordinateSeries(noisy(), { seasonal: false })!.jumps.length;
    expect(found).toBeLessThanOrEqual(1);
  }, 60_000);

  it('still finds a real 8 mm step in it', () => {
    const f = fitCoordinateSeries(noisy(0.008), { seasonal: false })!;
    const truth = T0 + 182.5 * 5 * DAY;
    const k = f.jumps.findIndex((j) => Math.abs(j.tMs - truth) < 15 * DAY);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(f.e.steps[k]!).toBeCloseTo(0.008, 2);
  }, 60_000);
});
