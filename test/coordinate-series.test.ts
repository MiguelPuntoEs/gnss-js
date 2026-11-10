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
