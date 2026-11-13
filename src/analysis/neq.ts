/**
 * Normal-equation algebra — the stacking operations of
 * network adjustment on the shared `NormalEquations` object: match and merge parameters across NEQs,
 * transform a-priori values, move position parameters to another epoch,
 * pre-eliminate nuisance parameters, stack, add pseudo-observations and
 * solve (Cholesky) with σ₀ and degrees of freedom.
 *
 * Throughout, N·Δx = b with Δx = x − x₀ (x₀ the a-priori values carried
 * in `params`), and ltpl = lᵀPl so that vᵀPv = ltpl − Δx̂ᵀb.
 */
import type { NeqParameter, NormalEquations } from './normal-equations';
import {
  choleskyInPlace,
  choleskyInverse,
  choleskySolve,
  invertSymmetric,
  schurComplement,
} from './neq-linalg';

export const MS_PER_YEAR = 365.25 * 86_400_000;

const STATION_TYPES = new Set(['STAX', 'STAY', 'STAZ', 'VELX', 'VELY', 'VELZ']);

/** Whether a parameter is a station coordinate or velocity. */
export const isStationParameter = (p: NeqParameter): boolean =>
  STATION_TYPES.has(p.type);

/**
 * Matching key of a parameter across NEQs. Station coordinates and
 * velocities match by site, point code and solution id whatever their
 * epoch (they are moved to a common epoch); every other parameter
 * (troposphere, clocks, …) also needs the same epoch and interval.
 */
export function neqParameterKey(p: NeqParameter): string {
  const base = `${p.type}|${p.site}|${p.pointCode ?? 'A'}|${p.solnId ?? '1'}`;
  return isStationParameter(p)
    ? base
    : `${base}|${p.refEpochMs}|${p.startMs ?? ''}|${p.endMs ?? ''}`;
}

/** An empty system over `params`. */
export function emptyNeq(
  params: NeqParameter[],
  sigma0Apriori = 1
): NormalEquations {
  const n = params.length;
  return {
    params,
    N: new Float64Array(n * n),
    b: new Float64Array(n),
    ltpl: 0,
    nObs: 0,
    nPreEliminated: 0,
    sigma0Apriori,
    dataStartMs: Infinity,
    dataEndMs: -Infinity,
  };
}

/** Deep copy. */
export function cloneNeq(neq: NormalEquations): NormalEquations {
  return {
    ...neq,
    params: neq.params.map((p) => ({ ...p })),
    N: neq.N.slice(),
    b: neq.b.slice(),
  };
}

/** Multiply the system by a weight factor (e.g. 1/σ̂₀² of its own fit, to
 *  combine solutions at their a-posteriori precision). */
export function scaleNeq(neq: NormalEquations, f: number): NormalEquations {
  return {
    ...neq,
    N: neq.N.map((v) => v * f),
    b: neq.b.map((v) => v * f),
    ltpl: neq.ltpl * f,
  };
}

/**
 * Change the a-priori values to `newApriori` (same parameters):
 *   b' = b − N·d,  ltpl' = ltpl − 2dᵀb + dᵀNd,  d = x₀' − x₀.
 * The solution x̂ is unchanged.
 */
export function changeApriori(
  neq: NormalEquations,
  newApriori: ArrayLike<number>
): NormalEquations {
  const n = neq.params.length;
  const d = new Float64Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    d[i] = newApriori[i]! - neq.params[i]!.apriori;
    if (d[i] !== 0) any = true;
  }
  if (!any) return neq;
  const Nd = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const ri = i * n;
    for (let j = 0; j < n; j++) s += neq.N[ri + j]! * d[j]!;
    Nd[i] = s;
  }
  let dtb = 0;
  let dtNd = 0;
  const b = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    b[i] = neq.b[i]! - Nd[i]!;
    dtb += d[i]! * neq.b[i]!;
    dtNd += d[i]! * Nd[i]!;
  }
  return {
    ...neq,
    params: neq.params.map((p, i) => ({ ...p, apriori: newApriori[i]! })),
    b,
    ltpl: neq.ltpl - 2 * dtb + dtNd,
  };
}

/**
 * Move the station coordinates to `epochMs` with known (a-priori)
 * velocities, as when daily NEQs are stacked into a weekly one
 * without estimating velocities: the correction Δx is the same at any
 * epoch, only the a-priori value and the reference epoch change. Sites
 * without a velocity keep their a-priori value (static assumption).
 */
export function moveToEpoch(
  neq: NormalEquations,
  epochMs: number | ((p: NeqParameter) => number),
  velocity?: (site: string, solnId: string) => readonly number[] | undefined
): NormalEquations {
  return {
    ...neq,
    params: neq.params.map((p) => {
      const k = ['STAX', 'STAY', 'STAZ'].indexOf(p.type);
      if (k < 0) return p;
      const v = velocity?.(p.site, p.solnId ?? '1');
      const t = typeof epochMs === 'number' ? epochMs : epochMs(p);
      const dt = (t - p.refEpochMs) / MS_PER_YEAR;
      return {
        ...p,
        refEpochMs: t,
        apriori: p.apriori + (v ? v[k]! * dt : 0),
      };
    }),
  };
}

/** Index of each parameter key. */
export function neqIndex(neq: NormalEquations): Map<string, number> {
  const m = new Map<string, number>();
  neq.params.forEach((p, i) => m.set(neqParameterKey(p), i));
  return m;
}

/**
 * Pre-eliminate (Schur complement) the parameters selected by `which`:
 * they stay implicitly estimated, their information passes to the others,
 * and they count as unknowns for the degrees of freedom. Also the way to
 * "delete" a station from a NEQ without losing the rest of its data.
 */
export function preEliminate(
  neq: NormalEquations,
  which: (p: NeqParameter, i: number) => boolean
): NormalEquations {
  const keep: number[] = [];
  const elim: number[] = [];
  neq.params.forEach((p, i) => (which(p, i) ? elim : keep).push(i));
  if (!elim.length) return neq;
  const r = schurComplement(neq.N, neq.b, neq.params.length, keep, elim);
  return {
    ...neq,
    params: keep.map((i) => neq.params[i]!),
    N: r.N,
    b: r.b,
    ltpl: neq.ltpl - r.dLtpl,
    nPreEliminated: neq.nPreEliminated + elim.length,
  };
}

/**
 * Stack NEQs: the union of their parameters (matched by
 * `neqParameterKey`, in order of first appearance) and the sums of N, b,
 * lᵀPl and observation counts. Where two NEQs carry different a-priori
 * values for the same parameter, the later ones are transformed to the
 * first one's (`changeApriori`). Station coordinates must refer to one
 * epoch — use `moveToEpoch` first when their epochs differ.
 */
export function stackNeqs(neqs: readonly NormalEquations[]): NormalEquations {
  const index = new Map<string, number>();
  const params: NeqParameter[] = [];
  for (const q of neqs)
    for (const p of q.params) {
      const k = neqParameterKey(p);
      if (!index.has(k)) {
        index.set(k, params.length);
        params.push({ ...p });
      }
    }
  const out = emptyNeq(params, neqs[0]?.sigma0Apriori ?? 1);
  const n = params.length;
  for (let q of neqs) {
    const map = q.params.map((p) => index.get(neqParameterKey(p))!);
    if (q.params.some((p, i) => p.apriori !== params[map[i]!]!.apriori))
      q = changeApriori(
        q,
        map.map((g) => params[g]!.apriori)
      );
    const m = q.params.length;
    for (let i = 0; i < m; i++) {
      const gi = map[i]! * n;
      const ri = i * m;
      out.b[map[i]!] += q.b[i]!;
      for (let j = 0; j < m; j++) out.N[gi + map[j]!] += q.N[ri + j]!;
    }
    out.ltpl += q.ltpl;
    out.nObs += q.nObs;
    out.nPreEliminated += q.nPreEliminated;
    out.dataStartMs = Math.min(out.dataStartMs, q.dataStartMs);
    out.dataEndMs = Math.max(out.dataEndMs, q.dataEndMs);
  }
  return out;
}

/** One row of a linear (pseudo-)observation: Σ coef·Δx[index] = value. */
export interface NeqObservationRow {
  terms: readonly (readonly [index: number, coef: number])[];
  /** Observed value of the combination of corrections Δx. */
  value: number;
  /** Its standard deviation, in the units of the parameters. */
  sigma: number;
}

/**
 * Add pseudo-observations (constraints) to a system: N += AᵀWA,
 * b += AᵀWl, ltpl += lᵀWl, nObs += rows. W = σ₀²/σ² so they enter at
 * the system's unit weight. Returns a new object; the input is untouched.
 */
export function addObservations(
  neq: NormalEquations,
  rows: readonly NeqObservationRow[]
): NormalEquations {
  const n = neq.params.length;
  const N = neq.N.slice();
  const b = neq.b.slice();
  let ltpl = neq.ltpl;
  const s0 = neq.sigma0Apriori;
  for (const r of rows) {
    const w = (s0 * s0) / (r.sigma * r.sigma);
    for (const [i, ci] of r.terms) {
      b[i] += w * ci * r.value;
      for (const [j, cj] of r.terms) N[i * n + j] += w * ci * cj;
    }
    ltpl += w * r.value * r.value;
  }
  return { ...neq, N, b, ltpl, nObs: neq.nObs + rows.length };
}

/** Constrain parameters to their a-priori value (or `value` corrections)
 *  with standard deviation `sigma` — fixing (tiny σ) or loose constraints. */
export function constrainParameters(
  neq: NormalEquations,
  which: (p: NeqParameter, i: number) => boolean,
  sigma: number
): NormalEquations {
  const rows: NeqObservationRow[] = [];
  neq.params.forEach((p, i) => {
    if (which(p, i)) rows.push({ terms: [[i, 1]], value: 0, sigma });
  });
  return addObservations(neq, rows);
}

export interface NeqSolution {
  params: NeqParameter[];
  /** Corrections to the a-priori values. */
  dx: Float64Array;
  /** A-priori + correction. */
  estimate: Float64Array;
  /** Covariance (n×n row-major) scaled by σ̂₀² (or by σ₀² a-priori when
   *  there is no redundancy to estimate σ̂₀). */
  cov: Float64Array;
  /** Weighted sum of squared residuals vᵀPv. */
  vtpv: number;
  /** nObs − unknowns (explicit + pre-eliminated). */
  dof: number;
  /** A-posteriori σ₀ (same unit as `sigma0Apriori`); null without dof. */
  sigma0: number | null;
}

/**
 * Solve the system with Cholesky. The system must be regular — add datum
 * constraints first (see `neq-datum`). Throws naming the first parameter
 * the data do not determine.
 */
export function solveNeq(neq: NormalEquations): NeqSolution {
  const n = neq.params.length;
  const L = neq.N.slice();
  const bad = choleskyInPlace(L, n);
  if (bad >= 0) {
    const p = neq.params[bad]!;
    throw new Error(
      `solveNeq: singular system at parameter ${bad} (${p.type} ${p.site} ${p.solnId ?? ''}) — datum or parameter not determined`
    );
  }
  const dx = choleskySolve(L, n, neq.b);
  let xtb = 0;
  for (let i = 0; i < n; i++) xtb += dx[i]! * neq.b[i]!;
  const vtpv = neq.ltpl - xtb;
  const dof = neq.nObs - n - neq.nPreEliminated;
  const sigma0 = dof > 0 ? Math.sqrt(Math.max(vtpv, 0) / dof) : null;
  const f = (sigma0 ?? neq.sigma0Apriori) ** 2;
  const cov = choleskyInverse(L, n);
  for (let i = 0; i < cov.length; i++) cov[i] *= f;
  return {
    params: neq.params,
    dx,
    estimate: dx.map((v, i) => v + neq.params[i]!.apriori),
    cov,
    vtpv,
    dof,
    sigma0,
  };
}

/**
 * Normal equations from a solution and its covariance — a SINEX
 * covariance file, a PPP day — removing the constraints the solution was
 * computed with (`aprioriCov`, SOLUTION/MATRIX_APRIORI):
 *   N = C⁻¹ − C₀⁻¹,  b = C⁻¹·(x̂ − x₀) − C₀⁻¹·(x̂₀_c − x₀)
 * where the constraint pulls towards the a-priori values (x̂₀_c = x₀), so
 * b = C⁻¹·(x̂ − x₀). The result is at unit weight: N = σ̂₀²-scaled
 * information, so stacking such NEQs weights them by their own precision.
 * `vtpv`/`dof` (if known, at unit weight ≈ dof) let σ̂₀ be recovered.
 */
export function neqFromCovariance(opts: {
  params: NeqParameter[];
  estimate: ArrayLike<number>;
  /** n×n covariance, row-major. */
  cov: ArrayLike<number>;
  /** Constraint covariance (n×n) or its diagonal (n); omit if none. */
  aprioriCov?: ArrayLike<number>;
  /** Observations behind the solution (for the degrees of freedom). */
  nObs?: number;
  /** Unknowns of the original solution beyond `params` (pre-eliminated). */
  nPreEliminated?: number;
  dataStartMs?: number;
  dataEndMs?: number;
}): NormalEquations {
  const { params } = opts;
  const n = params.length;
  const Ci = invertSymmetric(opts.cov, n);
  if (!Ci) throw new Error('neqFromCovariance: covariance not invertible');
  const dx = new Float64Array(n);
  for (let i = 0; i < n; i++) dx[i] = opts.estimate[i]! - params[i]!.apriori;
  const b = new Float64Array(n);
  let xtb = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += Ci[i * n + j]! * dx[j]!;
    b[i] = s;
    xtb += dx[i]! * s;
  }
  const ac = opts.aprioriCov;
  if (ac) {
    if (ac.length === n) {
      for (let i = 0; i < n; i++) if (ac[i]! > 0) Ci[i * n + i] -= 1 / ac[i]!;
    } else {
      const A = invertSymmetric(ac, n);
      if (!A) throw new Error('neqFromCovariance: MATRIX_APRIORI singular');
      for (let i = 0; i < n * n; i++) Ci[i] -= A[i]!;
    }
  }
  const nObs = opts.nObs ?? 0;
  const nPre = opts.nPreEliminated ?? 0;
  const dof = nObs - n - nPre;
  // Constrained: x̂ minimises vᵀPv + Δxᵀ C₀⁻¹ Δx; choose lᵀPl so that the
  // free solution's vᵀPv equals the degrees of freedom (unit weight).
  return {
    params,
    N: Ci,
    b,
    ltpl: (dof > 0 ? dof : 0) + xtb,
    nObs,
    nPreEliminated: nPre,
    sigma0Apriori: 1,
    dataStartMs: opts.dataStartMs ?? 0,
    dataEndMs: opts.dataEndMs ?? 0,
  };
}

/**
 * Re-express a system in new parameters y through a linear map
 *   Δx_old = T·Δy   (each old parameter a few (newIndex, coef) terms)
 *   N' = TᵀNT, b' = Tᵀb.
 * The caller makes the a-priori values consistent (x₀_old = T·y₀ + const);
 * new parameters no old one maps to stay zero rows (undetermined).
 */
export function transformNeq(
  neq: NormalEquations,
  newParams: NeqParameter[],
  map: readonly (readonly (readonly [number, number])[])[]
): NormalEquations {
  const n = neq.params.length;
  const m = newParams.length;
  const N = new Float64Array(m * m);
  const b = new Float64Array(m);
  // NT = N·T (n × m)
  const NT = new Float64Array(n * m);
  for (let j = 0; j < n; j++)
    for (const [q, c] of map[j]!)
      for (let i = 0; i < n; i++) NT[i * m + q] += neq.N[i * n + j]! * c;
  for (let i = 0; i < n; i++)
    for (const [p, c] of map[i]!) {
      b[p] += c * neq.b[i]!;
      const ri = i * m;
      for (let q = 0; q < m; q++) N[p * m + q] += c * NT[ri + q]!;
    }
  return { ...neq, params: newParams, N, b };
}
