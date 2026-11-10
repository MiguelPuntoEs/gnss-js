/**
 * Station coordinate time series: from daily (or weekly…) position
 * solutions to a velocity, jumps, seasonal terms and outliers — the core of
 * geodetic campaign analysis.
 *
 * Positions are expressed in a local East/North/Up frame about the median
 * position. Each component gets the standard trajectory model
 *
 *   x(t) = a + v·(t − t₀) + Σ bⱼ·H(t − tⱼ) [+ annual + semi-annual],
 *
 * fitted by weighted least squares (weights 1/σ² from the daily formal
 * errors, when given). Outliers are rejected iteratively against a robust
 * scale (1.4826 × the median absolute deviation); jumps come from the
 * caller (antenna changes, earthquakes) and, optionally, from a greedy
 * search that adds a step where it lowers the Bayesian information
 * criterion most.
 *
 * Two velocity uncertainties are given: the white-noise formal error
 * scaled by the variance factor, and a realistic one from a white + flicker
 * noise model fitted by maximum likelihood (./noise-model) — GNSS series
 * carry flicker noise, which the white-noise error ignores.
 */
import { ecefToGeodetic } from '../coordinates/ecef';
import { fitWhiteFlicker } from './noise-model';

/** One position solution (e.g. a daily PPP result). */
export interface CoordinateSample {
  /** Epoch of the solution (ms), e.g. the session midpoint. */
  tMs: number;
  /** Position, ECEF (m), all in one reference frame. */
  ecef: readonly [number, number, number];
  /** Formal 1σ in East/North/Up (m), if known. */
  sigmaEnu?: readonly [number, number, number];
}

export interface SeriesFitOptions {
  /** Known step epochs (ms): antenna/receiver changes, earthquakes… */
  jumps?: number[];
  /** Search for further jumps (BIC). Default true. */
  detectJumps?: boolean;
  /** Most jumps the search adds. Default 3. */
  maxJumps?: number;
  /** Annual + semi-annual terms: true, false or 'auto' (span ≥ 2 years). */
  seasonal?: boolean | 'auto';
  /** Outlier threshold in robust standard deviations. Default 4. */
  outlierK?: number;
  /** Reference epoch for the offset (ms). Default: middle of the span. */
  refEpochMs?: number;
  /** Samples a detected jump needs on each side. Default 5. */
  minSamplesPerSide?: number;
  /** Fit white + flicker noise for realistic velocity sigmas. Default true. */
  noiseModel?: boolean;
}

export interface SeriesComponent {
  /** Value at the reference epoch (m), relative to the reference position. */
  offset: number;
  /** Velocity (m/yr). */
  velocity: number;
  /** White-noise formal 1σ of the velocity, scaled by the variance factor. */
  velocitySigma: number;
  /** Velocity 1σ under a white + flicker noise model fitted by maximum
   *  likelihood — the realistic uncertainty; null if the series is too
   *  short or `noiseModel` is off. */
  velocitySigmaRealistic: number | null;
  /** Share of the residual variance the noise fit attributes to flicker. */
  flickerShare: number | null;
  /** Step size at each jump (m), in the order of `SeriesFit.jumps`. */
  steps: number[];
  /** Annual / semi-annual amplitudes (m), when fitted. */
  annualAmplitude: number | null;
  semiannualAmplitude: number | null;
  /** Weighted RMS of the residuals of the used samples (m). */
  wrms: number;
}

export interface SeriesPoint {
  tMs: number;
  /** Position relative to the reference position, local ENU (m). */
  enu: [number, number, number];
  /** Model value at tMs (m). */
  model: [number, number, number];
  /** Rejected as an outlier. */
  outlier: boolean;
}

export interface SeriesFit {
  /** Median position the ENU values are relative to (ECEF, m). */
  refEcef: [number, number, number];
  refEpochMs: number;
  e: SeriesComponent;
  n: SeriesComponent;
  u: SeriesComponent;
  /** Jumps in the model, chronological; `detected` = found by the search. */
  jumps: { tMs: number; detected: boolean }[];
  points: SeriesPoint[];
  spanYears: number;
  used: number;
  outliers: number;
  seasonal: boolean;
}

const MS_PER_YEAR = 365.25 * 86_400_000;
const TWO_PI = 2 * Math.PI;
/** Weights are capped so a suspiciously tiny formal error can't dominate. */
const MIN_SIGMA_M = 0.0005;

/** Solve the normal equations; returns the parameters and N⁻¹. */
function lsq(
  A: number[][],
  y: number[],
  w: number[]
): { x: number[]; Ninv: number[][] } | null {
  const p = A[0]?.length ?? 0;
  const N = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b = new Array<number>(p).fill(0);
  for (let i = 0; i < A.length; i++) {
    const a = A[i]!;
    for (let j = 0; j < p; j++) {
      b[j] += w[i]! * a[j]! * y[i]!;
      for (let k = 0; k < p; k++) N[j]![k] += w[i]! * a[j]! * a[k]!;
    }
  }
  // Gauss-Jordan on [N | I].
  const M = N.map((row, i) => [
    ...row,
    ...Array.from({ length: p }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++)
      if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    if (Math.abs(M[piv]![c]!) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv]!, M[c]!];
    const d = M[c]![c]!;
    for (let k = 0; k < 2 * p; k++) M[c]![k] /= d;
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = M[r]![c]!;
      if (f === 0) continue;
      for (let k = 0; k < 2 * p; k++) M[r]![k] -= f * M[c]![k]!;
    }
  }
  const Ninv = M.map((row) => row.slice(p));
  const x = Ninv.map((row) => row.reduce((s, v, k) => s + v * b[k]!, 0));
  return { x, Ninv };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Robust standard deviation: 1.4826 × median absolute deviation. */
function robustSigma(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

interface Design {
  refEpochMs: number;
  jumps: number[];
  seasonal: boolean;
}

function designRow(tMs: number, d: Design): number[] {
  const dt = (tMs - d.refEpochMs) / MS_PER_YEAR;
  const row = [1, dt];
  for (const j of d.jumps) row.push(tMs >= j ? 1 : 0);
  if (d.seasonal) {
    const ph = TWO_PI * (tMs / MS_PER_YEAR);
    row.push(Math.sin(ph), Math.cos(ph), Math.sin(2 * ph), Math.cos(2 * ph));
  }
  return row;
}

interface ComponentSolution {
  x: number[];
  Ninv: number[][];
  /** Weighted residual sum of squares over the used samples. */
  wrss: number;
  sumW: number;
  residuals: number[];
}

function fitComponent(
  t: number[],
  y: number[],
  w: number[],
  used: boolean[],
  d: Design
): ComponentSolution | null {
  const A: number[][] = [];
  const yy: number[] = [];
  const ww: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (!used[i]) continue;
    A.push(designRow(t[i]!, d));
    yy.push(y[i]!);
    ww.push(w[i]!);
  }
  if (A.length <= (A[0]?.length ?? 0)) return null;
  const s = lsq(A, yy, ww);
  if (!s) return null;
  const residuals = t.map(
    (ti, i) =>
      y[i]! - designRow(ti, d).reduce((acc, a, k) => acc + a * s.x[k]!, 0)
  );
  let wrss = 0;
  let sumW = 0;
  for (let i = 0; i < t.length; i++) {
    if (!used[i]) continue;
    wrss += w[i]! * residuals[i]! ** 2;
    sumW += w[i]!;
  }
  return { ...s, wrss, sumW, residuals };
}

/**
 * Fit the trajectory model to a station's position series. Needs at least
 * five samples spanning some time; the velocity is meaningful once the span
 * covers a good part of a year (seasonal signals otherwise alias into it).
 */
export function fitCoordinateSeries(
  samples: readonly CoordinateSample[],
  opts: SeriesFitOptions = {}
): SeriesFit | null {
  const pts = [...samples].sort((a, b) => a.tMs - b.tMs);
  if (pts.length < 5) return null;
  const t = pts.map((p) => p.tMs);
  const spanYears = (t[t.length - 1]! - t[0]!) / MS_PER_YEAR;
  if (spanYears <= 0) return null;

  // Local ENU about the median position.
  const ref: [number, number, number] = [0, 1, 2].map((k) =>
    median(pts.map((p) => p.ecef[k]!))
  ) as [number, number, number];
  const [lat, lon] = ecefToGeodetic(ref[0], ref[1], ref[2]);
  const sl = Math.sin(lat);
  const cl = Math.cos(lat);
  const so = Math.sin(lon);
  const co = Math.cos(lon);
  const enu = pts.map((p): [number, number, number] => {
    const dx = p.ecef[0] - ref[0];
    const dy = p.ecef[1] - ref[1];
    const dz = p.ecef[2] - ref[2];
    return [
      -so * dx + co * dy,
      -sl * co * dx - sl * so * dy + cl * dz,
      cl * co * dx + cl * so * dy + sl * dz,
    ];
  });
  const weights = [0, 1, 2].map((k) =>
    pts.map((p) => {
      const s = p.sigmaEnu?.[k];
      return s && s > 0 ? 1 / Math.max(s, MIN_SIGMA_M) ** 2 : 1;
    })
  );
  const series = [0, 1, 2].map((k) => enu.map((v) => v[k]!));

  const seasonal =
    opts.seasonal === 'auto' || opts.seasonal === undefined
      ? spanYears >= 2
      : opts.seasonal;
  const design: Design = {
    refEpochMs: opts.refEpochMs ?? (t[0]! + t[t.length - 1]!) / 2,
    jumps: [...(opts.jumps ?? [])]
      .filter((j) => j > t[0]! && j <= t[t.length - 1]!)
      .sort((a, b) => a - b),
    seasonal,
  };
  const detected = new Set<number>();
  const k = opts.outlierK ?? 4;
  const used = pts.map(() => true);

  const fitAll = () =>
    [0, 1, 2].map((c) =>
      fitComponent(t, series[c]!, weights[c]!, used, design)
    );

  // Robust loop: reject samples whose residual in any component exceeds k
  // robust sigmas, refit, until stable.
  const robustPass = (): ComponentSolution[] | null => {
    for (let iter = 0; iter < 10; iter++) {
      const sol = fitAll();
      if (sol.some((s) => !s)) return null;
      const scales = sol.map((s) =>
        Math.max(robustSigma(s!.residuals.filter((_, i) => used[i])), 1e-4)
      );
      let changed = false;
      for (let i = 0; i < t.length; i++) {
        const bad = sol.some(
          (s, c) => Math.abs(s!.residuals[i]!) > k * scales[c]!
        );
        if (bad === used[i]) {
          used[i] = !bad;
          changed = true;
        }
      }
      if (!changed) return sol as ComponentSolution[];
    }
    return fitAll() as ComponentSolution[];
  };

  let sol = robustPass();
  if (!sol) return null;

  // Greedy jump search: the step (all three components at once) that
  // lowers BIC = n·ln(RSS/n) + p·ln(n) the most, repeated.
  if (opts.detectJumps ?? true) {
    const minSide = opts.minSamplesPerSide ?? 5;
    for (let added = 0; added < (opts.maxJumps ?? 3); added++) {
      const idx = t.map((_, i) => i).filter((i) => used[i]);
      const nUsed = idx.length;
      const bicOf = (s: ComponentSolution[], p: number) =>
        s.reduce((acc, c) => acc + nUsed * Math.log(c.wrss / c.sumW), 0) +
        3 * p * Math.log(nUsed);
      const p0 = designRow(t[0]!, design).length;
      const bic0 = bicOf(sol, p0);
      let best: { tMs: number; bic: number; sol: ComponentSolution[] } | null =
        null;
      for (let j = minSide; j <= nUsed - minSide; j++) {
        const tj = (t[idx[j - 1]!]! + t[idx[j]!]!) / 2;
        if (design.jumps.some((x) => Math.abs(x - tj) < 7 * 86_400_000))
          continue;
        const trial: Design = {
          ...design,
          jumps: [...design.jumps, tj].sort((a, b) => a - b),
        };
        const s = [0, 1, 2].map((c) =>
          fitComponent(t, series[c]!, weights[c]!, used, trial)
        );
        if (s.some((x) => !x)) continue;
        const bic = bicOf(s as ComponentSolution[], p0 + 1);
        if (!best || bic < best.bic)
          best = { tMs: tj, bic, sol: s as ComponentSolution[] };
      }
      // Require a decisive improvement (ΔBIC > 10, "very strong").
      if (!best || bic0 - best.bic <= 10) break;
      design.jumps = [...design.jumps, best.tMs].sort((a, b) => a - b);
      detected.add(best.tMs);
      sol = robustPass();
      if (!sol) return null;
    }
  }

  const nJ = design.jumps.length;
  const component = (c: number): SeriesComponent => {
    const s = sol![c]!;
    const nUsed = used.filter(Boolean).length;
    const p = s.x.length;
    // Variance factor: weighted residuals vs their formal errors.
    const vf = nUsed > p ? s.wrss / (nUsed - p) : 1;
    const amp = (i: number) =>
      seasonal ? Math.hypot(s.x[i]!, s.x[i + 1]!) : null;
    const noise =
      (opts.noiseModel ?? true)
        ? fitWhiteFlicker(
            t.flatMap((ti, i) => (used[i] ? [designRow(ti, design)] : [])),
            series[c]!.filter((_, i) => used[i]),
            t.flatMap((ti, i) => (used[i] ? [ti / MS_PER_YEAR] : []))
          )
        : null;
    return {
      offset: s.x[0]!,
      velocity: s.x[1]!,
      velocitySigma: Math.sqrt(s.Ninv[1]![1]! * vf),
      velocitySigmaRealistic: noise?.velocitySigma ?? null,
      flickerShare: noise?.flickerShare ?? null,
      steps: s.x.slice(2, 2 + nJ),
      annualAmplitude: amp(2 + nJ),
      semiannualAmplitude: amp(4 + nJ),
      wrms: Math.sqrt(s.wrss / s.sumW),
    };
  };

  const points: SeriesPoint[] = pts.map((p, i) => ({
    tMs: p.tMs,
    enu: enu[i]!,
    model: [0, 1, 2].map((c) => series[c]![i]! - sol![c]!.residuals[i]!) as [
      number,
      number,
      number,
    ],
    outlier: !used[i],
  }));
  return {
    refEcef: ref,
    refEpochMs: design.refEpochMs,
    e: component(0),
    n: component(1),
    u: component(2),
    jumps: design.jumps.map((tMs) => ({ tMs, detected: detected.has(tMs) })),
    points,
    spanYears,
    used: used.filter(Boolean).length,
    outliers: used.filter((u) => !u).length,
    seasonal,
  };
}
