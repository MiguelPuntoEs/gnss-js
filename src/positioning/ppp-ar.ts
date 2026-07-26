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
}

export interface ArFixedSat {
  prn: string;
  nWl: number;
  n1: number;
  /** Fixed IF ambiguity (m). */
  aIF: number;
}

export interface ArResult {
  /** Whether the narrow-lane fix passed the ratio test. */
  fixed: boolean;
  /** LAMBDA ratio statistic (second-best / best). */
  ratio: number;
  /** Reference PRN whose absolute N1 stays float (SD datum). */
  refPrn: string | null;
  /** Fixed satellites (includes the reference with its float-rounded N1). */
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
 */
export function resolvePppAmbiguities(
  sats: ArSat[],
  Qaif: Float64Array,
  opts: ArOptions = {}
): ArResult {
  const wlThreshold = opts.wlThreshold ?? 0.25;
  const ratioThreshold = opts.ratioThreshold ?? 3;

  // --- Step 1: wide-lane rounding (per satellite) --------------------
  const kept: number[] = []; // indices into sats
  const nWl: number[] = [];
  const rejectedWl: string[] = [];
  for (let i = 0; i < sats.length; i++) {
    const s = sats[i]!;
    const wlFloat = s.mwCyc - (s.wlBiasCyc ?? 0);
    const r = Math.round(wlFloat);
    if (Math.abs(wlFloat - r) <= wlThreshold) {
      kept.push(i);
      nWl.push(r);
    } else {
      rejectedWl.push(s.prn);
    }
  }

  if (kept.length < 2) {
    return {
      fixed: false,
      ratio: 0,
      refPrn: null,
      sats: [],
      rejectedWl,
    };
  }

  // --- Step 2: float narrow-lane N1 per kept satellite ---------------
  // A_IF = λ_NL·N1 + λ_NL·(f2/(f1−f2))·N_WL  ⇒  N1 = A_IF/λ_NL − (f2/(f1−f2))·N_WL,
  // then remove the satellite NL fractional-cycle bias.
  const n1Float: number[] = [];
  const lamNl: number[] = [];
  for (let k = 0; k < kept.length; k++) {
    const s = sats[kept[k]!]!;
    const lNl = nlWavelength(s.f1, s.f2);
    lamNl.push(lNl);
    const n1 =
      s.aIF / lNl - (s.f2 / (s.f1 - s.f2)) * nWl[k]! - (s.nlBiasCyc ?? 0);
    n1Float.push(n1);
  }

  // Reference satellite: highest elevation (or first) — its absolute N1
  // stays float; single differences fix the rest relative to it.
  let ref = 0;
  for (let k = 1; k < kept.length; k++) {
    const e = sats[kept[k]!]!.elevDeg ?? -1;
    if (e > (sats[kept[ref]!]!.elevDeg ?? -1)) ref = k;
  }

  // --- Step 3: build SD float ambiguities + covariance ---------------
  // N1 covariance from the IF covariance: Q_N1[i,j] = Q_aif[i,j]/(λ_NLi·λ_NLj).
  // SD operator D removes the reference: sd_k = N1_k − N1_ref.
  const m = kept.length - 1; // number of SD ambiguities
  const sd = new Float64Array(m);
  const Qsd = new Float64Array(m * m);
  const others: number[] = [];
  for (let k = 0; k < kept.length; k++) if (k !== ref) others.push(k);

  const n = sats.length;
  const qN1 = (ka: number, kb: number): number =>
    Qaif[kept[ka]! * n + kept[kb]!]! / (lamNl[ka]! * lamNl[kb]!);

  for (let a = 0; a < m; a++) {
    const ka = others[a]!;
    sd[a] = n1Float[ka]! - n1Float[ref]!;
    for (let b = 0; b < m; b++) {
      const kb = others[b]!;
      // Var(N1_ka − N1_ref, N1_kb − N1_ref)
      Qsd[a * m + b] =
        qN1(ka, kb) - qN1(ka, ref) - qN1(ref, kb) + qN1(ref, ref);
    }
  }

  // --- Step 4: LAMBDA integer least squares on the SD ambiguities ----
  const res = lambdaSearch(sd, Qsd, m, 2);
  const ratio = res ? Math.min(res.ratio, 999.9) : 0;
  const fixed = !!res && ratio >= ratioThreshold;

  // --- Step 5: assemble fixed integers -------------------------------
  const refN1 = Math.round(n1Float[ref]!);
  const sdFix = res?.candidates[0];
  const outSats: ArFixedSat[] = [];
  for (let k = 0; k < kept.length; k++) {
    const s = sats[kept[k]!]!;
    let n1: number;
    if (k === ref) {
      n1 = refN1;
    } else {
      const a = others.indexOf(k);
      n1 =
        fixed && sdFix
          ? refN1 + Math.round(sdFix[a]!)
          : Math.round(n1Float[k]!);
    }
    const lNl = lamNl[k]!;
    const aIF = lNl * n1 + lNl * (s.f2 / (s.f1 - s.f2)) * nWl[k]!;
    outSats.push({ prn: s.prn, nWl: nWl[k]!, n1, aIF });
  }

  return {
    fixed,
    ratio,
    refPrn: sats[kept[ref]!]!.prn,
    sats: outSats,
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

  const res = resolvePppAmbiguities(sats, Qaif, opts);
  if (!res.fixed || res.refPrn === null) {
    return { ...noFix, ratio: res.ratio, refPrn: res.refPrn };
  }

  // Kept satellites (WL-fixed) in the resolver's order, mapped to EKF indices
  // and their float / fixed IF ambiguities.
  const idxOfPrn = new Map(amb.map((a) => [a.prn, a.index]));
  const floatOfPrn = new Map(amb.map((a) => [a.prn, a.aIF]));
  const kept = res.sats.filter((s) => idxOfPrn.has(s.prn));
  const refPos = kept.findIndex((s) => s.prn === res.refPrn);
  if (refPos < 0 || kept.length < 2) {
    return { ...noFix, ratio: res.ratio, refPrn: res.refPrn };
  }

  const ambIdx = kept.map((s) => idxOfPrn.get(s.prn)!);
  const aFloat = kept.map((s) => floatOfPrn.get(s.prn)!);
  const aFixed = kept.map((s) => s.aIF);
  const others = kept.map((_, i) => i).filter((i) => i !== refPos);
  const m = others.length;

  // Q_aa (kept×kept) and Q_xa (3×kept) from the EKF covariance.
  const P = state.covariance;
  const qAA = (i: number, j: number) => P[ambIdx[i]!]![ambIdx[j]!]!;
  const qXA = (r: number, i: number) => P[r]![ambIdx[i]!]!;

  // z = D·a (single differences vs the reference): Q_zz and Q_xz.
  const Qzz: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
  const z: number[] = new Array(m).fill(0);
  for (let a = 0; a < m; a++) {
    const ia = others[a]!;
    z[a] = aFloat[ia]! - aFloat[refPos]! - (aFixed[ia]! - aFixed[refPos]!);
    for (let b = 0; b < m; b++) {
      const ib = others[b]!;
      Qzz[a]![b] =
        qAA(ia, ib) - qAA(ia, refPos) - qAA(refPos, ib) + qAA(refPos, refPos);
    }
  }
  const Qxz: number[][] = [0, 1, 2].map((r) =>
    others.map((ia) => qXA(r, ia) - qXA(r, refPos))
  );

  // x_fixed = x_float − Q_xz · Q_zz⁻¹ · z.
  const y = solveSpd(Qzz, z);
  if (!y) return { ...noFix, ratio: res.ratio, refPrn: res.refPrn };
  const shift: [number, number, number] = [0, 0, 0];
  for (let r = 0; r < 3; r++) {
    let s = 0;
    for (let a = 0; a < m; a++) s += Qxz[r]![a]! * y[a]!;
    shift[r] = -s;
  }
  return {
    fixed: true,
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
