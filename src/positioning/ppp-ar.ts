/**
 * PPP-AR — integer ambiguity resolution for Precise Point Positioning.
 *
 * Float PPP estimates one *ionosphere-free* ambiguity per satellite arc, a
 * real number in metres. Fixing those to integers is what takes PPP from the
 * decimetre to the centimetre level. The classic two-step decomposition is
 * used here:
 *
 *   1. **Wide-lane** N_WL = N1 − N2 from the Melbourne–Wübbena combination.
 *      The WL wavelength is ~86 cm (GPS), so the arc-averaged MW rounds to an
 *      integer reliably once the satellite WL fractional-cycle bias is removed.
 *   2. **Narrow-lane** N1, recovered from the float IF ambiguity with N_WL
 *      fixed, then resolved with LAMBDA on *between-satellite single
 *      differences* (which cancel the receiver phase bias) after removing the
 *      satellite NL fractional-cycle bias.
 *
 * The satellite WL/NL fractional-cycle biases come from a phase-bias product
 * (Bias-SINEX OSB from an AR-capable analysis centre such as CNES or CODE).
 * Without them, a single receiver cannot separate the satellite bias from the
 * integer, so those biases are required inputs — pass 0 only for a network
 * datum where they have already been removed.
 *
 * The relation between the IF ambiguity (metres) and the integers is
 *   A_IF = λ_NL·N1 + λ_NL·(f2/(f1−f2))·N_WL,   λ_NL = c/(f1+f2).
 */

import { C_LIGHT } from '../constants/gnss';
import { lambdaSearch } from './lambda';
import type { PppFixState } from './ppp';

/** Wide-lane wavelength c/(f1−f2) (m). */
export function wlWavelength(f1: number, f2: number): number {
  return C_LIGHT / (f1 - f2);
}
/** Narrow-lane wavelength c/(f1+f2) (m). */
export function nlWavelength(f1: number, f2: number): number {
  return C_LIGHT / (f1 + f2);
}

/** One satellite's float ambiguity inputs for AR. */
export interface ArSat {
  prn: string;
  /** Float ionosphere-free ambiguity (m) from the PPP EKF. */
  aIF: number;
  /** Arc-averaged Melbourne–Wübbena wide-lane estimate (cycles). */
  mwCyc: number;
  f1: number;
  f2: number;
  /** Satellite wide-lane fractional-cycle bias (cycles). Default 0. */
  wlBiasCyc?: number;
  /** Satellite narrow-lane fractional-cycle bias (cycles). Default 0. */
  nlBiasCyc?: number;
  /** Elevation (deg), used only to pick the reference satellite. */
  elevDeg?: number;
}

export interface ArOptions {
  /** Max |MW − round| to accept a wide-lane (cycles). Default 0.25. */
  wlThreshold?: number;
  /** Min LAMBDA ratio to accept the narrow-lane fix. Default 3. */
  ratioThreshold?: number;
  /** Partial fixing: when the full set fails the ratio test, drop the
   *  lowest-elevation satellite and retry while more than this many
   *  between-satellite ambiguities remain. Default 4. */
  minPartial?: number;
  /** Min bootstrapped success rate (0–1) to accept a fix, besides the
   *  ratio test. Default 0 (ratio test only). */
  minSuccessRate?: number;
  /** `fixPppPosition`: min between-satellite ambiguities to accept. Default 1. */
  minFixed?: number;
  /** `fixPppPosition`: max χ²/dof of the float ambiguities against the fixed
   *  integers (a wrong fix sits many σ away). Default Infinity. */
  maxChi2?: number;
}

export interface ArFixedSat {
  prn: string;
  nWl: number;
  n1: number;
  /** Fixed IF ambiguity (m). */
  aIF: number;
  /** PRN of this satellite's single-difference reference (itself for a
   *  reference satellite). */
  ref: string;
}

export interface ArResult {
  /** Whether the narrow-lane fix passed the ratio test. */
  fixed: boolean;
  /** LAMBDA ratio statistic (second-best / best). */
  ratio: number;
  /** Reference PRN of the first constellation (whose absolute N1 stays
   *  float); see `refPrns` for all. */
  refPrn: string | null;
  /** One reference per constellation — differences are taken within a
   *  constellation, where the receiver phase bias is common. */
  refPrns: string[];
  /** Satellites in the fix (references included, with a float-rounded N1). */
  sats: ArFixedSat[];
  /** PRNs whose wide-lane did not round confidently (excluded). */
  rejectedWl: string[];
}

/**
 * Resolve PPP integer ambiguities from the float IF ambiguities and their
 * covariance. `Qaif` is the n×n float covariance (m²) in the same order as
 * `sats`. Returns the fixed narrow-lane / wide-lane integers and the ratio
 * test result. A `fixed: false` result means the data did not support a
 * confident fix (keep the float solution).
 *
 * Everything is differenced between satellites of the same constellation
 * (one reference each, the highest), which removes the receiver's
 * wide-lane and narrow-lane phase biases — those differ per constellation
 * and per receiver, so an undifferenced ambiguity is never an integer.
 */
export function resolvePppAmbiguities(
  sats: ArSat[],
  Qaif: Float64Array,
  opts: ArOptions = {}
): ArResult {
  const wlThreshold = opts.wlThreshold ?? 0.25;
  const ratioThreshold = opts.ratioThreshold ?? 3;
  const minPartial = opts.minPartial ?? 4;
  const minSuccess = opts.minSuccessRate ?? 0;
  const n = sats.length;
  const none = (rejectedWl: string[], ratio = 0): ArResult => ({
    fixed: false,
    ratio,
    refPrn: null,
    refPrns: [],
    sats: [],
    rejectedWl,
  });

  // --- Step 1: per-constellation reference + wide-lane rounding ------
  // SD wide-lane: (MW_i − b_i) − (MW_ref − b_ref) is an integer. The
  // reference's own N_WL is set to round(MW_ref − b_ref) — any integer
  // works, its receiver part cancels in every difference below.
  const elev = (i: number) => sats[i]!.elevDeg ?? -1;
  const wlOf = (i: number) => sats[i]!.mwCyc - (sats[i]!.wlBiasCyc ?? 0);
  const refOfSys = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const sys = sats[i]!.prn[0]!;
    const r = refOfSys.get(sys);
    if (r === undefined || elev(i) > elev(r)) refOfSys.set(sys, i);
  }
  const nWlOf = new Map<number, number>();
  const refIdx = new Map<number, number>(); // sat → its reference
  const rejectedWl: string[] = [];
  for (const r of refOfSys.values()) {
    nWlOf.set(r, Math.round(wlOf(r)));
    refIdx.set(r, r);
  }
  for (let i = 0; i < n; i++) {
    if (refIdx.has(i)) continue;
    const r = refOfSys.get(sats[i]!.prn[0]!)!;
    const sdWl = wlOf(i) - wlOf(r);
    const k = Math.round(sdWl);
    if (Math.abs(sdWl - k) <= wlThreshold) {
      nWlOf.set(i, nWlOf.get(r)! + k);
      refIdx.set(i, r);
    } else rejectedWl.push(sats[i]!.prn);
  }

  // --- Step 2: float narrow-lane N1 per satellite --------------------
  // A_IF = λ_NL·N1 + λ_NL·(f2/(f1−f2))·N_WL  ⇒  N1 = A_IF/λ_NL − (f2/(f1−f2))·N_WL,
  // then remove the satellite NL fractional-cycle bias.
  const lamNl = (i: number) => nlWavelength(sats[i]!.f1, sats[i]!.f2);
  const n1Float = (i: number) => {
    const s = sats[i]!;
    return (
      s.aIF / lamNl(i) -
      (s.f2 / (s.f1 - s.f2)) * nWlOf.get(i)! -
      (s.nlBiasCyc ?? 0)
    );
  };
  const qN1 = (a: number, b: number) =>
    Qaif[a * n + b]! / (lamNl(a) * lamNl(b));

  // --- Step 3+4: SD ambiguities, LAMBDA, partial fixing --------------
  // Candidates: non-reference satellites with a fixed wide-lane, highest
  // first, so partial fixing drops from the low end.
  let cand = [...refIdx.keys()]
    .filter((i) => refIdx.get(i) !== i)
    .sort((a, b) => elev(b) - elev(a));
  if (cand.length < 1) return none(rejectedWl);

  let best: { set: number[]; ratio: number; fix: Float64Array } | null = null;
  let firstRatio = 0;
  for (;;) {
    const m = cand.length;
    const sd = new Float64Array(m);
    const Qsd = new Float64Array(m * m);
    for (let a = 0; a < m; a++) {
      const ia = cand[a]!;
      const ra = refIdx.get(ia)!;
      sd[a] = n1Float(ia) - n1Float(ra);
      for (let b = 0; b < m; b++) {
        const ib = cand[b]!;
        const rb = refIdx.get(ib)!;
        Qsd[a * m + b] = qN1(ia, ib) - qN1(ia, rb) - qN1(ra, ib) + qN1(ra, rb);
      }
    }
    const res = lambdaSearch(sd, Qsd, m, 2);
    const ratio = res ? Math.min(res.ratio, 999.9) : 0;
    if (best === null && firstRatio === 0) firstRatio = ratio;
    if (res && ratio >= ratioThreshold && res.successRate >= minSuccess) {
      best = { set: cand, ratio, fix: Float64Array.from(res.candidates[0]!) };
      break;
    }
    if (m <= minPartial) break;
    cand = cand.slice(0, -1);
  }
  if (!best) return { ...none(rejectedWl, firstRatio), refPrn: null };

  // --- Step 5: assemble fixed integers -------------------------------
  const refN1 = new Map<number, number>();
  for (const r of refOfSys.values()) refN1.set(r, Math.round(n1Float(r)));
  const out: ArFixedSat[] = [];
  const emit = (i: number, n1: number) => {
    const s = sats[i]!;
    const l = lamNl(i);
    const nWl = nWlOf.get(i)!;
    out.push({
      prn: s.prn,
      nWl,
      n1,
      aIF: l * n1 + l * (s.f2 / (s.f1 - s.f2)) * nWl,
      ref: sats[refIdx.get(i)!]!.prn,
    });
  };
  const usedRefs = new Set(best.set.map((i) => refIdx.get(i)!));
  for (const r of usedRefs) emit(r, refN1.get(r)!);
  best.set.forEach((i, a) =>
    emit(i, refN1.get(refIdx.get(i)!)! + Math.round(best!.fix[a]!))
  );
  const refPrns = [...usedRefs].map((r) => sats[r]!.prn);
  return {
    fixed: true,
    ratio: best.ratio,
    refPrn: refPrns[0] ?? null,
    refPrns,
    sats: out,
    rejectedWl,
  };
}

/** Solve A·x = b for a small symmetric positive-definite A (Cholesky). */
function solveSpd(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i]![j]!;
      for (let k = 0; k < j; k++) s -= L[i]![k]! * L[j]![k]!;
      if (i === j) {
        if (s <= 0) return null; // not positive definite
        L[i]![j] = Math.sqrt(s);
      } else {
        L[i]![j] = s / L[j]![j]!;
      }
    }
  }
  // Forward solve L·y = b, then back solve Lᵀ·x = y.
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= L[i]![k]! * y[k]!;
    y[i] = s / L[i]![i]!;
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!;
    for (let k = i + 1; k < n; k++) s -= L[k]![i]! * x[k]!;
    x[i] = s / L[i]![i]!;
  }
  return x;
}

export interface FixedPositionResult {
  /** Whether the narrow-lane fix passed the ratio test. */
  fixed: boolean;
  /** Ambiguity-fixed position (m); equals `floatPosition` when not fixed. */
  position: [number, number, number];
  /** The input float position (m). */
  floatPosition: [number, number, number];
  /** Displacement fixed − float (m), ENU-agnostic ECEF. */
  shift: [number, number, number];
  /** Position covariance (m², ECEF 3×3) given the fixed integers —
   *  Q_xx − Q_xz·Q_zz⁻¹·Q_zx. Absent when not fixed. */
  covariance?: number[][];
  /** Satellites whose ambiguities were fixed (excl. the SD reference). */
  nFixed: number;
  ratio: number;
  refPrn: string | null;
}

/**
 * Ambiguity-fixed (PPP-AR) position from a float `solvePpp` final state and
 * the satellite fractional-cycle biases (from `estimateNetworkFcbs`).
 *
 * Resolves the integers (`resolvePppAmbiguities`), then **conditions the
 * float position on the fixed between-satellite ambiguities** — the standard
 * constrained solution
 *   x_fixed = x_float − Q_xz · Q_zz⁻¹ · (z_float − ẑ),
 * where z = D·a are the single-differenced ambiguities (D removes the
 * reference satellite, cancelling the receiver term), Q_zz = D·Q_aa·Dᵀ and
 * Q_xz = Q_xa·Dᵀ come from the EKF covariance. Only satellite-to-satellite
 * integers constrain the position; the reference (and the receiver clock it
 * absorbs) stays free. Returns the float position unchanged if the fix fails.
 */
export function fixPppPosition(
  state: PppFixState,
  fcb: { satWlFcb: Map<string, number>; satNlFcb: Map<string, number> },
  opts: ArOptions = {}
): FixedPositionResult {
  const floatPos = state.position;
  const noFix: FixedPositionResult = {
    fixed: false,
    position: floatPos,
    floatPosition: floatPos,
    shift: [0, 0, 0],
    nFixed: 0,
    ratio: 0,
    refPrn: null,
  };

  const amb = state.ambiguities;
  if (amb.length < 3) return noFix;

  // Resolve integers over the active ambiguities.
  const sats: ArSat[] = amb.map((a) => ({
    prn: a.prn,
    aIF: a.aIF,
    mwCyc: a.mwCyc,
    f1: a.f1,
    f2: a.f2,
    wlBiasCyc: fcb.satWlFcb.get(a.prn) ?? 0,
    nlBiasCyc: fcb.satNlFcb.get(a.prn) ?? 0,
    elevDeg: a.elevDeg,
  }));
  const n = sats.length;
  const Qaif = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      Qaif[i * n + j] = state.covariance[amb[i]!.index]![amb[j]!.index]!;

  const res = resolvePppAmbiguities(sats, Qaif, {
    ...opts,
    minPartial: opts.minPartial ?? Math.max(4, opts.minFixed ?? 0),
  });
  if (!res.fixed || res.refPrn === null) {
    return { ...noFix, ratio: res.ratio, refPrn: res.refPrn };
  }

  // Fixed satellites mapped to EKF indices; each non-reference one gives a
  // between-satellite constraint against its constellation's reference.
  const idxOfPrn = new Map(amb.map((a) => [a.prn, a.index]));
  const floatOfPrn = new Map(amb.map((a) => [a.prn, a.aIF]));
  const fixedOf = new Map(res.sats.map((s) => [s.prn, s.aIF]));
  const pairs = res.sats
    .filter(
      (s) => s.ref !== s.prn && idxOfPrn.has(s.prn) && idxOfPrn.has(s.ref)
    )
    .map((s) => ({ prn: s.prn, ref: s.ref }));
  const m = pairs.length;
  if (m < Math.max(1, opts.minFixed ?? 1))
    return { ...noFix, ratio: res.ratio, refPrn: res.refPrn };

  // Q_aa and Q_xa from the EKF covariance.
  const P = state.covariance;
  const ix = (prn: string) => idxOfPrn.get(prn)!;
  const qAA = (i: string, j: string) => P[ix(i)]![ix(j)]!;
  const qXA = (r: number, i: string) => P[r]![ix(i)]!;

  // z = D·a (single differences vs each reference): Q_zz and Q_xz.
  const Qzz: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
  const z: number[] = new Array(m).fill(0);
  for (let a = 0; a < m; a++) {
    const { prn: ia, ref: ra } = pairs[a]!;
    z[a] =
      floatOfPrn.get(ia)! -
      floatOfPrn.get(ra)! -
      (fixedOf.get(ia)! - fixedOf.get(ra)!);
    for (let b = 0; b < m; b++) {
      const { prn: ib, ref: rb } = pairs[b]!;
      Qzz[a]![b] = qAA(ia, ib) - qAA(ia, rb) - qAA(ra, ib) + qAA(ra, rb);
    }
  }
  const Qxz: number[][] = [0, 1, 2].map((r) =>
    pairs.map(({ prn, ref }) => qXA(r, prn) - qXA(r, ref))
  );

  // x_fixed = x_float − Q_xz · Q_zz⁻¹ · z.
  const y = solveSpd(Qzz, z);
  if (!y) return { ...noFix, ratio: res.ratio, refPrn: res.refPrn };
  let chi2 = 0;
  for (let a = 0; a < m; a++) chi2 += z[a]! * y[a]!;
  if (chi2 / m > (opts.maxChi2 ?? Infinity))
    return { ...noFix, ratio: res.ratio, refPrn: res.refPrn };
  const shift: [number, number, number] = [0, 0, 0];
  for (let r = 0; r < 3; r++) {
    let s = 0;
    for (let a = 0; a < m; a++) s += Qxz[r]![a]! * y[a]!;
    shift[r] = -s;
  }
  // Q_xx|fixed = Q_xx − Q_xz · Q_zz⁻¹ · Q_zx.
  const covariance: number[][] = [0, 1, 2].map((r) => [
    P[r]![0]!,
    P[r]![1]!,
    P[r]![2]!,
  ]);
  for (let c = 0; c < 3; c++) {
    const w = solveSpd(Qzz, Qxz[c]!);
    if (!w) return { ...noFix, ratio: res.ratio, refPrn: res.refPrn };
    for (let r = 0; r < 3; r++) {
      let s = 0;
      for (let a = 0; a < m; a++) s += Qxz[r]![a]! * w[a]!;
      covariance[r]![c]! -= s;
    }
  }
  return {
    fixed: true,
    covariance,
    position: [
      floatPos[0] + shift[0],
      floatPos[1] + shift[1],
      floatPos[2] + shift[2],
    ],
    floatPosition: floatPos,
    shift,
    nFixed: m,
    ratio: res.ratio,
    refPrn: res.refPrn,
  };
}
