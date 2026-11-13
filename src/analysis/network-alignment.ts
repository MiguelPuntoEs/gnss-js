/**
 * Network alignment: the transformation that maps one day's solutions of
 * reference stations onto their known coordinates, applied to every station
 * of that day.
 *
 * Daily PPP positions share errors over a region — orbit and clock errors
 * of the day, the frame realisation of the product — so a station's series
 * scatters more than the station moves. Estimating those common errors from
 * reference stations with trusted coordinates (IGS/EUREF, propagated to the
 * day by their velocities) and removing them is the regional counterpart of
 * a datum definition by minimum constraints, and of "common-mode
 * filtering" in GNSS time-series work.
 *
 * Model (position-vector convention, small angles, as `applyHelmert`):
 *   x_ref = x + t + d·x + r × x
 * 'translation' estimates t only — the robust choice for a regional network,
 * where rotations are nearly indistinguishable from translations; 'similarity'
 * adds rotation and scale (7 parameters) for a continental or wider spread.
 */

export type HelmertModel = 'translation' | 'rigid' | 'similarity';

/** Number of transformation parameters of a model: translation (3),
 *  + rotation ('rigid', 6), + scale ('similarity', 7). */
export const helmertParameterCount = (m: HelmertModel): number =>
  m === 'translation' ? 3 : m === 'rigid' ? 6 : 7;

/**
 * Rows of the Helmert design matrix at position `x` (relative to whatever
 * centre the caller uses): coordinate k → coefficients of
 * (tx, ty, tz[, r1, r2, r3[, d]]) in the position-vector convention
 * x' = x + t + d·x + r × x. Shared by `estimateHelmert` and the
 * minimum-constraint datum (`neq-datum`).
 */
export function helmertDesign(
  x: readonly number[],
  model: HelmertModel
): number[][] {
  const np = helmertParameterCount(model);
  const rows: number[][] = [0, 1, 2].map((k) => {
    const row = new Array<number>(np).fill(0);
    row[k] = 1;
    return row;
  });
  if (np >= 6) {
    rows[0]![4] = x[2]!;
    rows[0]![5] = -x[1]!;
    rows[1]![3] = -x[2]!;
    rows[1]![5] = x[0]!;
    rows[2]![3] = x[1]!;
    rows[2]![4] = -x[0]!;
  }
  if (np === 7) for (let k = 0; k < 3; k++) rows[k]![6] = x[k]!;
  return rows;
}

export interface HelmertFit {
  model: HelmertModel;
  /** Translation (m). */
  t: [number, number, number];
  /** Rotation (rad), zero for 'translation'. */
  r: [number, number, number];
  /** Scale (unitless, e.g. 1e-9 = 1 ppb), zero for 'translation'. */
  d: number;
  /** Residual (reference − transformed) per input pair, ECEF (m). */
  residuals: [number, number, number][];
  /** Pairs kept in the final fit (false = rejected reference). */
  used: boolean[];
  /** RMS of the used residuals, per coordinate (m). */
  rms: number;
}

export interface HelmertOptions {
  model?: HelmertModel;
  /** A reference whose 3-D residual exceeds this is dropped (m). Default 0.015. */
  maxResidualM?: number;
  /** Keep at least this many references. Default: 3 (translation) or 4. */
  minRefs?: number;
  /** Reject instead by local components: a reference whose horizontal or
   *  vertical residual exceeds these (m) is dropped, worst ratio first
   *  (EUREF-style checks, e.g. 5 mm / 15 mm). Overrides
   *  `maxResidualM` when given. */
  maxResidualHorizontalM?: number;
  maxResidualVerticalM?: number;
}

/** Residual split into horizontal length and |up| at position x (m). */
export function horizontalVertical(
  x: V3,
  d: V3
): { horizontal: number; vertical: number } {
  const p = Math.hypot(x[0], x[1]);
  // Spherical up is enough to split a mm-level residual.
  const r = Math.hypot(p, x[2]);
  const up = (d[0] * x[0] + d[1] * x[1] + d[2] * x[2]) / r;
  return {
    horizontal: Math.sqrt(
      Math.max(d[0] ** 2 + d[1] ** 2 + d[2] ** 2 - up * up, 0)
    ),
    vertical: Math.abs(up),
  };
}

type V3 = readonly [number, number, number];

/** Apply an estimated transformation to one position. */
export function applyHelmertFit(
  x: V3,
  f: HelmertFit
): [number, number, number] {
  const [r1, r2, r3] = f.r;
  return [
    x[0] + f.t[0] + f.d * x[0] - r3 * x[1] + r2 * x[2],
    x[1] + f.t[1] + r3 * x[0] + f.d * x[1] - r1 * x[2],
    x[2] + f.t[2] - r2 * x[0] + r1 * x[1] + f.d * x[2],
  ];
}

/** Solve a small symmetric system by Gauss-Jordan; null if singular. */
function solve(N: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = N.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-6) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k <= n; k++) M[r]![k] -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/**
 * Estimate the transformation from `from` (e.g. the day's PPP positions of
 * the reference stations) to `to` (their known coordinates at that epoch).
 * Rejects the worst-fitting reference while any exceeds `maxResidualM`.
 */
export function estimateHelmert(
  from: readonly V3[],
  to: readonly V3[],
  opts: HelmertOptions = {}
): HelmertFit | null {
  const model = opts.model ?? 'translation';
  const nPar = helmertParameterCount(model);
  const minRefs = opts.minRefs ?? (model === 'translation' ? 3 : 4);
  const maxRes = opts.maxResidualM ?? 0.015;
  const byComponent =
    opts.maxResidualHorizontalM !== undefined ||
    opts.maxResidualVerticalM !== undefined;
  if (from.length !== to.length) return null;
  const used = from.map(() => true);

  // Centre the coordinates so rotation/scale don't couple with the huge
  // geocentric values (better conditioning); undone at the end.
  const c: [number, number, number] = [0, 1, 2].map(
    (k) => from.reduce((s, p) => s + p[k]!, 0) / Math.max(from.length, 1)
  ) as [number, number, number];

  for (;;) {
    const idx = used.flatMap((u, i) => (u ? [i] : []));
    if (idx.length < minRefs || idx.length * 3 <= nPar) return null;
    const N = Array.from({ length: nPar }, () =>
      new Array<number>(nPar).fill(0)
    );
    const b = new Array<number>(nPar).fill(0);
    for (const i of idx) {
      const x = [from[i]![0] - c[0], from[i]![1] - c[1], from[i]![2] - c[2]];
      const rows = helmertDesign(x, model);
      for (let k = 0; k < 3; k++) {
        const row = rows[k]!;
        const y = to[i]![k]! - from[i]![k]!;
        for (let a = 0; a < nPar; a++) {
          b[a] += row[a]! * y;
          for (let bb = 0; bb < nPar; bb++) N[a]![bb] += row[a]! * row[bb]!;
        }
      }
    }
    const p = solve(N, b);
    if (!p) return null;
    const r: [number, number, number] =
      nPar >= 6 ? [p[3]!, p[4]!, p[5]!] : [0, 0, 0];
    const d = nPar === 7 ? p[6]! : 0;
    // Translation about the geocentre: t' = t − (d·c + r × c).
    const t: [number, number, number] = [
      p[0]! - (d * c[0] - r[2] * c[1] + r[1] * c[2]),
      p[1]! - (r[2] * c[0] + d * c[1] - r[0] * c[2]),
      p[2]! - (-r[1] * c[0] + r[0] * c[1] + d * c[2]),
    ];
    const fit: HelmertFit = { model, t, r, d, residuals: [], used, rms: 0 };
    fit.residuals = from.map((x, i) => {
      const y = applyHelmertFit(x, fit);
      return [to[i]![0] - y[0], to[i]![1] - y[1], to[i]![2] - y[2]];
    });
    let worst = -1;
    let worstNorm = byComponent ? 1 : maxRes;
    let ss = 0;
    for (const i of idx) {
      const n = Math.hypot(...fit.residuals[i]!);
      ss += n * n;
      // Ratio to the component thresholds, or the 3-D norm.
      const score = byComponent
        ? (() => {
            const hv = horizontalVertical(from[i]!, fit.residuals[i]!);
            return Math.max(
              hv.horizontal / (opts.maxResidualHorizontalM ?? Infinity),
              hv.vertical / (opts.maxResidualVerticalM ?? Infinity)
            );
          })()
        : n;
      if (score > worstNorm) {
        worstNorm = score;
        worst = i;
      }
    }
    fit.rms = Math.sqrt(ss / (3 * idx.length));
    if (worst < 0 || idx.length <= minRefs) {
      fit.used = [...used];
      return fit;
    }
    used[worst] = false;
  }
}
