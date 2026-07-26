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
