/**
 * Static float Precise Point Positioning (PPP).
 *
 * Dual-frequency ionosphere-free code + carrier phase, precise satellite
 * orbits and clocks (SP3), a forward Extended Kalman Filter estimating
 * [position, receiver clock, zenith wet troposphere, one float ambiguity
 * per satellite arc]. No base station — absolute cm–dm coordinates from a
 * single observation file.
 *
 * Corrections applied (see PppOptions to toggle the optional ones):
 *  - precise satellite orbit + clock (SP3, Lagrange / linear)
 *  - periodic relativistic satellite-clock term (−2·r·v/c²)
 *  - Earth-rotation (Sagnac) during signal transit
 *  - dry troposphere (Saastamoinen ZHD, a priori) + estimated wet ZWD,
 *    mapped by the Niell mapping function
 *  - elevation-dependent weighting, cycle-slip re-initialisation
 *  - (optional, added by the caller supplying products) satellite &
 *    receiver antenna phase-centre offsets, phase wind-up, solid-earth tides
 *
 * The ionosphere-free combination removes the first-order ionosphere; the
 * float ambiguity absorbs the phase biases and the integer cycles.
 */

import { C_LIGHT, OMEGA_E } from '../constants/gnss';
import { ecefToGeodetic, getEnuDifference, getAer } from '../coordinates/ecef';
import { sp3Position, type Sp3File } from '../rinex/sp3';
import { clkBias, type ClkFile } from '../rinex/clk';
import type { SatOsbTable } from '../rinex/bias-sinex';
import { fixPppPosition } from './ppp-ar';

const NO_FCB = {
  satWlFcb: new Map<string, number>(),
  satNlFcb: new Map<string, number>(),
};
import { niellMapping } from './ppp-tropo';
import {
  type PppCorrections,
  applyCorrections,
  type SatGeom,
} from './ppp-corrections';

/* ================================================================== */
/*  Public types                                                       */
/* ================================================================== */

/** One satellite's dual-frequency observation at an epoch. */
export interface PppSatObs {
  prn: string;
  /** Band-1 / band-2 centre frequencies (Hz). */
  f1: number;
  f2: number;
  /** Pseudorange on band 1 / band 2 (metres). */
  c1: number;
  c2: number;
  /** Carrier phase on band 1 / band 2 (cycles). */
  l1: number;
  l2: number;
  /** ANTEX frequency codes for the two bands (e.g. 'G01','G02'). Used by
   * the antenna corrections; optional if corrections are off. */
  band1?: string;
  band2?: string;
  /** RINEX-3 tracking codes for the two bands (e.g. '1C','2W'). Used to look
   * up satellite code (OSB) biases from an SSR/HAS source; optional. */
  code1?: string;
  code2?: string;
  /** RINEX-3 tracking codes of the two *carriers* (e.g. '1C','2W'), for
   *  satellite phase-bias (OSB) lookup when they differ from the code's
   *  (GPS: C1W code with L1C phase). Default: `code1` / `code2`. */
  phase1?: string;
  phase2?: string;
  /** True if a cycle slip is flagged on either band (LLI or detected). */
  slip: boolean;
}

export interface PppEpoch {
  /** GPS-scale epoch time (ms). */
  timeMs: number;
  obs: PppSatObs[];
}

export interface PppOptions {
  /** A priori receiver ECEF position (m). Required — from the RINEX header
   * approx position or an SPP solution. */
  aprioriPos: [number, number, number];
  /**
   * Rover dynamics. 'static' (default): the position is a single constant
   * state, so all epochs average into one converged coordinate. 'kinematic':
   * the position is white noise (RTKLIB `PMODE_PPP_KINEMA`) — re-estimated
   * each epoch from that epoch's measurements while the carrier ambiguities
   * (and troposphere) persist, so a moving receiver is tracked epoch by epoch.
   */
  mode?: 'static' | 'kinematic';
  /** Ground-truth ECEF (m) for reporting ENU error in the series. */
  groundTruth?: [number, number, number];
  /** Elevation cutoff (deg). Default 10. */
  elevationMaskDeg?: number;
  /** Optional corrections (antenna PCO/PCV, wind-up, tides). */
  corrections?: PppCorrections;
  /** IF code σ at zenith (m). Default 3.0 (already IF-inflated). */
  codeSigma?: number;
  /** IF phase σ at zenith (m). Default 0.01. */
  phaseSigma?: number;
  /** Wet-troposphere random-walk process noise (m²/epoch). Default 1e-8. */
  ztdProcessNoise?: number;
  /** Model + estimate the troposphere. Default true. */
  troposphere?: boolean;
  /**
   * Estimate north/east horizontal troposphere gradients (Chen & Herring
   * mapping, random walk) as geodetic software does. Unmodelled gradients
   * bias the horizontal position by up to several mm, station by station.
   * `true` uses the defaults. Default off.
   */
  estimateGradients?:
    | boolean
    | {
        /** A-priori 1σ (m). Default 0.003. */
        sigmaM?: number;
        /** Random walk (m/√h). Default 0.0003. */
        randomWalkMPerSqrtH?: number;
      };
  /** A-priori troposphere model (zenith hydrostatic delay, mapping
   *  functions, gradients) — e.g. GPT3 + VMF3 from `gnss-js/troposphere`.
   *  Default: Saastamoinen with the standard atmosphere + Niell. */
  troposphereModel?: PppTroposphereModel;
  /** Expose the final EKF state (position + ambiguities + covariance) in the
   * solution for ambiguity-resolved positioning. Default false. */
  exposeState?: boolean;
  /** 1σ (m) of `aprioriPos`, per axis. Default 100 m (a header or code
   *  position). A surveyed starting mark (a few mm–cm) makes the filter
   *  start converged: the ambiguities are determined at once. */
  aprioriSigmaM?: number;
  /** Kinematic: the receiver stands still for this long (s) at the start —
   *  on the known mark before moving — so its position is one state over
   *  that time, not re-estimated each epoch. Default 0. */
  initialStaticSec?: number;
  /** Record per-epoch diagnostics in the series (`PppEpochResult.diagnostics`):
   *  the receiver clocks and, per satellite, the post-fit residuals and
   *  whether each observation was used — for processing reports. Default
   *  false (one small object per satellite and epoch). */
  diagnostics?: boolean;
  /**
   * Cycle-slip repair. When a satellite comes back after a short gap (or with
   * its loss-of-lock flag set) its carrier jumps are estimated instead of
   * re-initialising the ambiguity: the wide-lane jump from the
   * Melbourne–Wübbena combination, the L1 jump from the geometry-free phase
   * with the ionosphere extrapolated across the gap. Only integer-consistent
   * repairs are accepted; otherwise the ambiguity resets as before. Turns a
   * full re-convergence (~15 min) after a short outage into none. Default
   * on, gaps up to 120 s; `false` disables.
   */
  slipRepair?:
    | boolean
    | {
        /** Longest gap bridged (s). Default 120. */
        maxGapS?: number;
        /** Max distance of the wide-lane / L1 jump from an integer (cycles). Default 0.15. */
        maxFrac?: number;
        /** Extra σ (m) given to a repaired ambiguity. Default 0. */
        softSigmaM?: number;
      };
  /** High-rate precise satellite clocks (RINEX CLOCK, typically 30 s). When
   * given, satellite clock offsets come from this by linear interpolation
   * instead of the SP3 5-minute clocks — the dominant PPP accuracy term.
   * Satellites/epochs absent from the CLK fall back to the SP3 clock. */
  clk?: ClkFile;
  /** Satellite observable-specific biases (code + phase OSB) consistent with
   *  the orbit/clock product — e.g. the CNES "ABS" biases that accompany GFZ
   *  rapid products. With phase OSBs the float ambiguities keep their integer
   *  nature (between satellites), which is what PPP-AR (`fixPppPosition`)
   *  needs. Used with an Sp3File; a custom source supplies its own biases. */
  osb?: SatOsbTable;
  /**
   * Integer ambiguity resolution (PPP-AR). Needs satellite phase biases
   * (`osb`, or a source with `phaseBias`) — without them the ambiguities
   * aren't integers and this is ignored. Every `everyS` seconds the
   * converged ambiguities are resolved (wide-lane by rounding, narrow-lane
   * by LAMBDA, between satellites of a constellation) and, if the fix is
   * accepted, the epoch gets an ambiguity-fixed position next to the float
   * one. `true` uses the defaults.
   */
  ar?:
    | boolean
    | {
        /** LAMBDA ratio test threshold. Default 3. */
        ratio?: number;
        /** Max wide-lane fractional part (cycles). Default 0.15. */
        wlThreshold?: number;
        /** Min arc age before an ambiguity is a candidate (s). Default 600. */
        minArcS?: number;
        /** Attempt interval (s). Default 120. */
        everyS?: number;
        /** Min bootstrapped success rate. Default 0.999. */
        successRate?: number;
        /** Min between-satellite ambiguities in a fix. Default 5. */
        minFixed?: number;
        /** Max χ²/dof of the float ambiguities vs the integers. Default 20. */
        maxChi2?: number;
        /** Static sessions whose final fix attempt failed fall back to the
         *  last accepted fix only if it lies within this 3D distance (m) of
         *  the final float position; otherwise `ar.rejected` is set and
         *  `ar.position` is null. Default 0.03. */
        maxFloatGapM?: number;
      };
}

/** A troposphere model the PPP engine can use (structurally the
 *  `TroposphereModel` of `gnss-js/troposphere`). */
export interface PppTroposphereModel {
  delays(
    utcMs: number,
    latRad: number,
    lonRad: number,
    hEll: number,
    elRad: number,
    azRad: number
  ): { zhd: number; mh: number; mw: number; gradient: number };
}

export interface PppEpochResult {
  timeMs: number;
  /** ENU error vs ground truth (m), if truth given. */
  enu: [number, number, number] | null;
  /** 3D error vs ground truth (m), if truth given. */
  error3d: number | null;
  position: [number, number, number];
  nSats: number;
  /** Estimated zenith wet delay (m). */
  ztdWet: number;
  /** A priori zenith hydrostatic delay (m, Saastamoinen). ZTD = this + ztdWet. */
  ztdHydrostatic: number;
  /** Formal 1σ of the zenith wet (= total) delay after this epoch (m). */
  ztdSigma?: number;
  /** North/east troposphere gradients and their formal 1σ (m), when
   *  `estimateGradients` — what troposphere SINEX calls TGNTOT/TGETOT. */
  gradients?: { n: number; e: number; sigmaN: number; sigmaE: number };
  /** RMS of post-fit phase residuals this epoch (m). */
  phaseResRms: number;
  /** Formal 3D position σ after this epoch's update (m) — large when few
   *  satellites or fresh ambiguities carry the solution (kinematic). */
  posSigma3d: number;
  /** Satellites whose cycle slip was repaired this epoch. */
  slipsRepaired?: number;
  /** PPP-AR: between-satellite ambiguities fixed (0 = float only). */
  nFixed: number;
  /** PPP-AR: the ambiguity-fixed position, when the latest attempt fixed. */
  fixedPosition: [number, number, number] | null;
  /** Receiver clocks and per-satellite residuals, when
   *  `PppOptions.diagnostics` is set. */
  diagnostics?: PppEpochDiagnostics;
}

/** One epoch's processing detail (`PppOptions.diagnostics`). */
export interface PppEpochDiagnostics {
  /** Receiver clock offset per constellation (m; divide by c for seconds).
   *  Each constellation has its own, absorbing the inter-system bias. */
  clockM: Record<string, number>;
  /** Formal 1σ of the position after this epoch's update, East/North/Up
   *  (m), from the filter covariance. */
  positionSigmaEnu: [number, number, number];
  /** Satellites above the elevation mask with dual-frequency data. */
  sats: PppSatDiagnostics[];
}

/** One satellite in one epoch (`PppOptions.diagnostics`). */
export interface PppSatDiagnostics {
  prn: string;
  elevDeg: number;
  azDeg: number;
  /** Post-fit ionosphere-free code residual against the epoch's final state
   *  (m), the constellation's mean over used observations removed (the
   *  receiver clock is a free parameter each epoch). */
  codeRes: number;
  /** Post-fit ionosphere-free phase residual (m), same convention; null
   *  before the satellite has an ambiguity. */
  phaseRes: number | null;
  /** The code observation entered the filter (not screened or gated out). */
  codeUsed: boolean;
  /** The phase observation entered the filter. */
  phaseUsed: boolean;
  /** The ambiguity was (re)initialised this epoch: new arc or cycle slip. */
  slip: boolean;
}

export interface PppSolution {
  /** Final estimated ECEF position (m). */
  position: [number, number, number];
  /** Final geodetic [latDeg, lonDeg, heightM]. */
  llh: [number, number, number];
  /** Per-epoch series (convergence). */
  series: PppEpochResult[];
  /** Estimated zenith wet delay at the end (m). */
  ztdWet: number;
  /** A priori zenith hydrostatic delay at the end (m). ZTD = this + ztdWet. */
  ztdHydrostatic: number;
  /** Epochs processed. */
  epochsUsed: number;
  /** Seconds from first epoch until 3D error first stays < 0.1 m
   * (null if never, or no ground truth). */
  convergenceSec: number | null;
  /** Final 3D error vs ground truth (m), if given. */
  finalError3d: number | null;
  /** PPP-AR summary, when `ar` was requested with a phase-bias product. */
  ar?: {
    /** Seconds from the first epoch to the first accepted fix (null: none). */
    firstFixSec: number | null;
    /** Ambiguities fixed at the end (0: the session ends float). */
    nFixedEnd: number;
    /** The ambiguity-fixed position: at the end, or (static) at the last
     *  accepted fix when the final attempt failed; null if never fixed. */
    position: [number, number, number] | null;
    /** Epoch of that fix (ms). */
    positionEpochMs: number | null;
    /** Covariance of `position` given the fixed integers (m², ECEF 3×3). */
    covariance: number[][] | null;
    /** 3D distance (m) between the fix and the final float position. */
    floatGapM: number | null;
    /** Set when the final attempt failed and the earlier fallback fix lay
     *  more than `maxFloatGapM` from the final float position (a stale fix
     *  the filter later moved away from); `position` is then null. */
    rejected: 'float-gap' | null;
    /** Share of epochs with at least one ambiguity fixed. */
    fixedEpochShare: number;
  };
  /** Per-arc converged float ambiguities — one per continuous satellite
   * tracking arc — the raw material for ambiguity resolution (PPP-AR). */
  arcs: PppArc[];
  /** Final EKF state (position + active ambiguities + full covariance) for
   * ambiguity-resolved (fixed) positioning. Present only when
   * `PppOptions.exposeState` is set. */
  finalState?: PppFixState;
}

/** Final float state exposed for PPP-AR position fixing (`fixPppPosition`). */
export interface PppFixState {
  /** Float position (m); rows 0–2 of the covariance. */
  position: [number, number, number];
  /** Full EKF covariance (n×n). State order: X,Y,Z,ZWD, clocks…, ambiguities. */
  covariance: number[][];
  /** Active ambiguities at the final epoch. */
  ambiguities: {
    prn: string;
    /** Row/column of this ambiguity in `covariance`. */
    index: number;
    /** Float ionosphere-free ambiguity (m). */
    aIF: number;
    /** Arc-averaged Melbourne–Wübbena wide-lane (cycles). */
    mwCyc: number;
    f1: number;
    f2: number;
    /** Mean satellite elevation over the arc (deg). */
    elevDeg: number;
  }[];
}

/** A converged carrier-phase arc: the float ionosphere-free ambiguity plus
 * the wide-lane, for integer resolution / FCB estimation. */
export interface PppArc {
  prn: string;
  /** Final float ionosphere-free ambiguity (m). */
  aIF: number;
  /** Arc-averaged Melbourne–Wübbena wide-lane (cycles). */
  mwCyc: number;
  f1: number;
  f2: number;
  /** Mean satellite elevation over the arc (deg). */
  meanElevDeg: number;
  /** Epochs in the arc. */
  nEpochs: number;
  startMs: number;
  endMs: number;
}

/* ================================================================== */
/*  Small dense linear algebra (state ~ 5 + #ambiguities)              */
/* ================================================================== */

/** Least-squares [Δx, Δy, Δz, Δclock] from time-differenced phase. */
function tdLsq(
  qs: readonly { v: { e: [number, number, number] }; d: number }[]
): [number, number, number, number] | null {
  const M = [0, 1, 2, 3].map(() => [0, 0, 0, 0, 0]);
  for (const q of qs) {
    const a = [-q.v.e[0], -q.v.e[1], -q.v.e[2], 1];
    for (let i = 0; i < 4; i++) {
      M[i]![4]! += a[i]! * q.d;
      for (let j = 0; j < 4; j++) M[i]![j]! += a[i]! * a[j]!;
    }
  }
  // Gauss–Jordan with partial pivoting on the 4×4 normal equations.
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++)
      if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-9) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k < 5; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return [0, 1, 2, 3].map((i) => M[i]![4]! / M[i]![i]!) as [
    number,
    number,
    number,
    number,
  ];
}

function tdResidual(
  q: { v: { e: [number, number, number] }; d: number },
  s: [number, number, number, number]
): number {
  return q.d - (-q.v.e[0] * s[0] - q.v.e[1] * s[1] - q.v.e[2] * s[2] + s[3]);
}

/** Time-differenced iono-free phase jump (m) that flags a cycle slip. */
const TD_SLIP_M = 0.08;
/** Code residual spread (m, beyond 3σ of position) that screens a satellite. */
const CODE_GATE_M = 15;

/**
 * Sequential (scalar) EKF measurement update — process one measurement at
 * a time; avoids inverting the innovation matrix and stays numerically
 * stable with a freely-varying receiver clock and many ambiguities.
 *
 * `h` is sparse (position, clock, ZWD and one ambiguity of ~100 states), so
 * P·hᵀ only reads the non-zero columns, and the rank-1 covariance update —
 * exactly symmetric — is computed on one triangle and mirrored: ~5× fewer
 * operations than the dense form, the bulk of a day's PPP.
 */
function ekfUpdateScalar(
  x: number[],
  P: number[][],
  h: number[],
  innovation: number,
  r: number,
  /** Reject the measurement if innovation² > (rejectK·√S)². 0 = no gate. */
  rejectK = 0
): boolean {
  const n = x.length;
  const nz: number[] = [];
  for (let k = 0; k < n; k++) if (h[k] !== 0) nz.push(k);
  // P·hᵀ over the non-zero entries of h.
  const Ph = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const Pi = P[i]!;
    let s = 0;
    for (const k of nz) s += Pi[k]! * h[k]!;
    Ph[i] = s;
  }
  let hPh = 0;
  for (const k of nz) hPh += h[k]! * Ph[k]!;
  const s = hPh + r;
  if (s <= 0) return false;
  if (rejectK > 0 && innovation * innovation > rejectK * rejectK * s) {
    return false; // outlier — skip
  }
  // State update x += K·innovation, K = P·hᵀ / s.
  for (let i = 0; i < n; i++) x[i]! += (Ph[i]! / s) * innovation;
  // P −= (P·hᵀ)(P·hᵀ)ᵀ / s: symmetric, so one triangle, mirrored.
  for (let i = 0; i < n; i++) {
    const ki = Ph[i]! / s;
    if (ki === 0) continue;
    const Pi = P[i]!;
    for (let j = i; j < n; j++) {
      const v = Pi[j]! - ki * Ph[j]!;
      Pi[j] = v;
      P[j]![i] = v;
    }
  }
  return true;
}

/* ================================================================== */
/*  Iono-free helpers                                                  */
/* ================================================================== */

/** Iono-free combination coefficients for two frequencies. */
function ifCoeffs(f1: number, f2: number): { g: number; lambdaIf: number } {
  const g = (f1 * f1) / (f1 * f1 - f2 * f2);
  // Iono-free wavelength (for reference; ambiguity kept in metres).
  const lambdaIf = C_LIGHT / (f1 + f2);
  return { g, lambdaIf };
}

/* ================================================================== */
/*  Precise satellite source (SP3/CLK today, SSR/HAS via an adapter)   */
/* ================================================================== */

/** A raw satellite sample at an emission time: ECEF position + velocity
 *  (m, m/s) and the clock offset (s) WITHOUT the periodic relativistic term —
 *  the PPP light-time loop adds relativity + Sagnac. Null when unavailable. */
export interface SatSample {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  clkS: number;
}

/** Supplies precise satellite state to the PPP filter. Implemented by the SP3
 *  path (default) and by an SSR/HAS source (broadcast eph + corrections), so
 *  the same filter runs on precise products or a real-time correction stream. */
export interface PppEphemerisSource {
  satState(prn: string, tEmitMs: number): SatSample | null;
  /** Optional satellite code (OSB) bias (m) for a RINEX-3 tracking code, to
   *  make the pseudorange consistent with the (SSR/HAS) clock reference. The
   *  corrected code is `observed − codeBias`. SP3/CLK sources omit this (the
   *  float ambiguity + broadcast clock reference absorb it). */
  codeBias?(prn: string, signalCode: string, tEmitMs: number): number | null;
  /** Optional satellite *phase* bias (m) for a carrier tracking code
   *  ('1C','2W'…): the corrected carrier is `observed − phaseBias`. Only
   *  integer-clock products (for PPP-AR) provide these. */
  phaseBias?(prn: string, signalCode: string, tEmitMs: number): number | null;
}

/** Default source: SP3 orbits + clocks, with optional high-rate CLK. Velocity
 *  is a central finite difference (±0.5 s); the clock prefers the high-rate CLK
 *  and falls back to the SP3 5-minute clock — matching the original solver. */
export class Sp3EphemerisSource implements PppEphemerisSource {
  constructor(
    private readonly sp3: Sp3File,
    private readonly clk?: ClkFile,
    private readonly osb?: SatOsbTable
  ) {
    if (osb) {
      this.codeBias = (prn, code, t) => osb.get(prn, 'C' + code, t);
      this.phaseBias = (prn, code, t) => osb.get(prn, 'L' + code, t);
    }
  }
  codeBias?: PppEphemerisSource['codeBias'];
  phaseBias?: PppEphemerisSource['phaseBias'];
  satState(prn: string, tEmitMs: number): SatSample | null {
    const p = sp3Position(this.sp3, prn, tEmitMs);
    if (!p || p.clk == null) return null;
    const pPlus = sp3Position(this.sp3, prn, tEmitMs + 500);
    const pMinus = sp3Position(this.sp3, prn, tEmitMs - 500);
    let vx = 0;
    let vy = 0;
    let vz = 0;
    if (pPlus && pMinus) {
      vx = pPlus.x - pMinus.x;
      vy = pPlus.y - pMinus.y;
      vz = pPlus.z - pMinus.z;
    }
    const clkS = (this.clk ? clkBias(this.clk, prn, tEmitMs) : null) ?? p.clk;
    return { x: p.x, y: p.y, z: p.z, vx, vy, vz, clkS };
  }
}

/**
 * Remove the source's satellite code/phase biases (OSB) from one observation,
 * so the code matches the clock reference and — with phase OSBs — the carrier
 * ambiguities are integers between satellites. Code biases are optional
 * (SP3/CLK sources fold them into the float ambiguity); a source that
 * publishes phase biases but has none for this satellite/signal drops it,
 * since one non-integer ambiguity would spoil the fix for all.
 */
function applySatBiases(
  source: PppEphemerisSource,
  o: PppSatObs,
  tMs: number
): PppSatObs | null {
  if (!source.codeBias && !source.phaseBias) return o;
  const b1 = source.codeBias?.(o.prn, o.code1 ?? '', tMs) ?? 0;
  const b2 = source.codeBias?.(o.prn, o.code2 ?? '', tMs) ?? 0;
  let l1 = o.l1;
  let l2 = o.l2;
  if (source.phaseBias) {
    const p1 = source.phaseBias(o.prn, o.phase1 ?? o.code1 ?? '', tMs);
    const p2 = source.phaseBias(o.prn, o.phase2 ?? o.code2 ?? '', tMs);
    if (p1 == null || p2 == null) return null;
    l1 -= p1 / (C_LIGHT / o.f1);
    l2 -= p2 / (C_LIGHT / o.f2);
  }
  return { ...o, c1: o.c1 - b1, c2: o.c2 - b2, l1, l2 };
}

/* ================================================================== */
/*  Satellite state (position, velocity, clock) at emission            */
/* ================================================================== */

interface SatState {
  x: number;
  y: number;
  z: number;
  clkM: number; // c·(dt_sat + relativistic), metres
}

/** Rotate an ECEF vector by Earth rotation during signal travel (Sagnac). */
function sagnacRotate(
  x: number,
  y: number,
  z: number,
  travelS: number
): [number, number, number] {
  const theta = OMEGA_E * travelS;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [x * c + y * s, -x * s + y * c, z];
}

/**
 * Satellite ECEF position at reception frame, plus clock (incl. periodic
 * relativistic term). Returns null if outside the SP3 span or clock
 * missing. `travelS` in/out via the returned geometry range.
 *
 * The emission time comes from the pseudorange, t_rx − P/c − dt_sat (as
 * RTKLIB's satposs): P carries the receiver clock offset, so a receiver
 * whose clock drifts up to a millisecond (many Septentrio and Javad
 * receivers by default, free-running phone clocks) still gets satellites
 * at the right instant. Timing the emission from the geometric range alone
 * misplaced them by the receiver clock offset — at 0.36 ms that was
 * ~11 cm of East error through Earth rotation (IGS station GRAZ).
 */
function satStateAtEmission(
  source: PppEphemerisSource,
  prn: string,
  recvTimeMs: number,
  rcv: [number, number, number],
  pseudorangeM?: number
): { state: SatState; travelS: number } | null {
  if (pseudorangeM !== undefined && pseudorangeM > 1e6) {
    let tEmit = recvTimeMs - (pseudorangeM / C_LIGHT) * 1000;
    const s0 = source.satState(prn, tEmit);
    if (!s0) return null;
    tEmit -= s0.clkS * 1000;
    const s = source.satState(prn, tEmit);
    if (!s) return null;
    // Earth rotation during the (geometric) travel time.
    let travelS = 0.075;
    let pos: [number, number, number] = [s.x, s.y, s.z];
    for (let iter = 0; iter < 3; iter++) {
      pos = sagnacRotate(s.x, s.y, s.z, travelS);
      travelS =
        Math.hypot(pos[0] - rcv[0], pos[1] - rcv[1], pos[2] - rcv[2]) / C_LIGHT;
    }
    const velDotPos = s.x * s.vx + s.y * s.vy + s.z * s.vz;
    const relS = (-2 * velDotPos) / (C_LIGHT * C_LIGHT);
    return {
      state: {
        x: pos[0],
        y: pos[1],
        z: pos[2],
        clkM: C_LIGHT * (s.clkS + relS),
      },
      travelS,
    };
  }
  let travelS = 0.075; // ~ 20000 km / c initial guess
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let clkS: number | null = null;
  let velDotPos = 0;
  for (let iter = 0; iter < 3; iter++) {
    const tEmit = recvTimeMs - travelS * 1000;
    const s = source.satState(prn, tEmit);
    if (!s) return null;
    // r·v (un-rotated) for the periodic relativistic term.
    velDotPos = s.x * s.vx + s.y * s.vy + s.z * s.vz;
    clkS = s.clkS;
    const [rx, ry, rz] = sagnacRotate(s.x, s.y, s.z, travelS);
    sx = rx;
    sy = ry;
    sz = rz;
    const dx = sx - rcv[0];
    const dy = sy - rcv[1];
    const dz = sz - rcv[2];
    const range = Math.hypot(dx, dy, dz);
    travelS = range / C_LIGHT;
  }
  if (clkS == null) return null;
  // Periodic relativistic correction −2·(r·v)/c²  (seconds).
  const relS = (-2 * velDotPos) / (C_LIGHT * C_LIGHT);
  const clkM = C_LIGHT * (clkS + relS);
  return { state: { x: sx, y: sy, z: sz, clkM }, travelS };
}

/* ================================================================== */
/*  Static float PPP solver (forward EKF over all epochs)              */
/* ================================================================== */

const IDX_X = 0;
const IDX_Y = 1;
const IDX_Z = 2;
const IDX_ZWD = 3;
const IDX_GN = 4;
const IDX_GE = 5;
/** position(3) + zenith wet delay(1) + north/east gradient(2); the
 *  gradient states stay at zero variance unless `estimateGradients`. */
const NBASE = 6;
/** Wet slant delay from the troposphere states: zenith wet × its mapping
 *  plus the horizontal gradients. */
const wetSlant = (
  x: readonly number[],
  v: { mw: number; mgN: number; mgE: number }
) => x[IDX_ZWD]! * v.mw + x[IDX_GN]! * v.mgN + x[IDX_GE]! * v.mgE;

function gradientConfig(
  opts: PppOptions
): { sigmaM: number; randomWalkMPerSqrtH: number } | null {
  const g = opts.estimateGradients;
  if (!g) return null;
  const c = g === true ? {} : g;
  return {
    sigmaM: c.sigmaM ?? 0.003,
    randomWalkMPerSqrtH: c.randomWalkMPerSqrtH ?? 0.0003,
  };
}

/** Chen & Herring (1997) gradient mapping function. */
const gradientMapping = (el: number) =>
  1 / (Math.sin(el) * Math.tan(el) + 0.0032);
// Per-constellation receiver clocks (absorbing the inter-system bias) and
// float ambiguities are appended dynamically after the base states.
const CLK_VAR = 1e10; // white-noise clock variance reset each epoch (σ≈100 km)
const POS_VAR = 60 * 60; // kinematic white-noise position variance (σ = 60 m)

/**
 * Streaming float PPP — the forward EKF as a stateful engine fed one epoch at a
 * time (mirrors {@link RtkFloatEngine}). `process(epoch)` returns that epoch's
 * result and carries the filter forward; `solution()` finalises the session.
 * `solvePpp` (below) is a thin batch wrapper. Same estimator as before — a
 * broadcast/SP3/SSR source supplies satellite state via {@link PppEphemerisSource}.
 */
export class PppEngine {
  private readonly source: PppEphemerisSource;
  private readonly opts: PppOptions;
  private readonly elevMask: number;
  private readonly codeSigma: number;
  private readonly phaseSigma: number;
  private readonly ztdQ: number;
  private readonly kinematic: boolean;
  private readonly corrections?: PppCorrections;
  private readonly truth?: [number, number, number];

  // Filter state (reset() initialises; mutated in place across epochs).
  private x!: number[];
  private P!: number[][];
  private clkIdx!: Map<string, number>;
  private clockSeeded!: Set<string>;
  private ambIdx!: Map<string, number>;
  private lastSeen!: Map<string, number>;
  private arcs!: PppArc[];
  private arcSnap!: Map<
    string,
    {
      aIF: number;
      mwCyc: number;
      f1: number;
      f2: number;
      elevSum: number;
      nEpochs: number;
      startMs: number;
      endMs: number;
    }
  >;
  private mwState!: Map<string, { mean: number; n: number; lastEi: number }>;
  /** Previous epoch's phase terms per satellite, for the time-differenced
   *  (clock-free) cycle-slip test. */
  private tdPrev!: Map<
    string,
    { ei: number; lIf: number; sat: [number, number, number]; model: number }
  >;
  /** Consecutive gated-out phase updates per satellite. */
  private phaseRejects!: Map<string, number>;
  /** Per satellite: last good epoch's phases + a geometry-free history (for
   *  the ionosphere trend) and the integer offsets applied after repairs. */
  private repairState!: Map<
    string,
    {
      tMs: number;
      mw: number;
      gf: { t: number; v: number }[];
      dn1: number;
      dn2: number;
      /** MW samples since a break whose wide-lane was still uncertain. */
      pendingMw?: number[];
    }
  >;
  private lastSeenMs!: Map<string, number>;
  /** PPP-AR: the latest accepted fix (null: float). */
  /** The most recent accepted fix (static sessions fall back to it when
   *  the final attempt fails). */
  private lastAccepted: {
    position: [number, number, number];
    covariance: number[][] | null;
    tMs: number;
  } | null = null;
  private lastFix!: {
    position: [number, number, number];
    covariance: number[][] | null;
    nFixed: number;
    ratio: number;
  } | null;
  private lastArMs!: number;
  private firstFixMs!: number | null;
  private fixedEpochs!: number;
  private series!: PppEpochResult[];
  private ei = 0;
  private t0 = 0;
  private lastEpochMs: number | null = null;
  private convergenceSec: number | null = null;
  private convergedStreak = 0;

  constructor(opts: PppOptions, source: PppEphemerisSource) {
    this.opts = opts;
    this.source = source;
    this.elevMask = ((opts.elevationMaskDeg ?? 10) * Math.PI) / 180;
    this.codeSigma = opts.codeSigma ?? 3.0;
    this.phaseSigma = opts.phaseSigma ?? 0.01;
    this.ztdQ = opts.ztdProcessNoise ?? 1e-8;
    this.kinematic = opts.mode === 'kinematic';
    this.corrections = opts.corrections;
    this.truth = opts.groundTruth;
    this.reset();
  }

  /** Reinitialise the filter (fresh session). */
  reset(): void {
    const { opts } = this;
    // State vector and covariance. Position is estimated absolutely (metres).
    this.x = [
      opts.aprioriPos[0],
      opts.aprioriPos[1],
      opts.aprioriPos[2],
      0.1,
      0,
      0,
    ];
    const P: number[][] = [];
    for (let i = 0; i < NBASE; i++) P.push(new Array<number>(NBASE).fill(0));
    const s0 = (opts.aprioriSigmaM ?? 100) ** 2; // 100 m: a header position
    P[IDX_X]![IDX_X] = s0;
    P[IDX_Y]![IDX_Y] = s0;
    P[IDX_Z]![IDX_Z] = s0;
    P[IDX_ZWD]![IDX_ZWD] = 0.5 * 0.5;
    const grad = gradientConfig(opts);
    if (grad) {
      P[IDX_GN]![IDX_GN] = grad.sigmaM ** 2;
      P[IDX_GE]![IDX_GE] = grad.sigmaM ** 2;
    }
    this.P = P;
    this.lastEpochMs = null;
    this.clkIdx = new Map();
    this.clockSeeded = new Set();
    this.ambIdx = new Map();
    this.lastSeen = new Map();
    this.arcs = [];
    this.arcSnap = new Map();
    this.mwState = new Map();
    this.tdPrev = new Map();
    this.phaseRejects = new Map();
    this.repairState = new Map();
    this.lastSeenMs = new Map();
    this.lastFix = null;
    this.lastArMs = -Infinity;
    this.firstFixMs = null;
    this.fixedEpochs = 0;
    this.series = [];
    this.ei = 0;
    this.t0 = 0;
    this.convergenceSec = null;
    this.convergedStreak = 0;
  }

  private flushArc(prn: string, minEpochs = 10): void {
    const s = this.arcSnap.get(prn);
    this.arcSnap.delete(prn);
    if (!s || s.nEpochs < minEpochs) return;
    this.arcs.push({
      prn,
      aIF: s.aIF,
      mwCyc: s.mwCyc,
      f1: s.f1,
      f2: s.f2,
      meanElevDeg: s.elevSum / s.nEpochs,
      nEpochs: s.nEpochs,
      startMs: s.startMs,
      endMs: s.endMs,
    });
  }

  /**
   * Apply the integer offsets of earlier repairs to an observation, and if it
   * comes back from a gap / with a slip flag, try to repair it. Returns the
   * (possibly corrected) observation and whether it was repaired now.
   */
  private repairSlip(
    o: PppSatObs,
    tMs: number
  ): {
    o: PppSatObs;
    repaired: boolean;
    defer?: boolean;
    /** GF-blind: integer candidates for the filter to choose between. */
    candidates?: { n1: number; n2: number }[];
  } {
    const cfg = this.opts.slipRepair ?? true;
    const st = this.repairState.get(o.prn);
    const lam1 = C_LIGHT / o.f1;
    const lam2 = C_LIGHT / o.f2;
    const lamW = C_LIGHT / (o.f1 - o.f2);
    const fix = (dn1: number, dn2: number): PppSatObs => ({
      ...o,
      l1: o.l1 - dn1,
      l2: o.l2 - dn2,
    });
    const gfOf = (q: PppSatObs) => q.l1 * lam1 - q.l2 * lam2;
    const mwOf = (q: PppSatObs) =>
      q.l1 - q.l2 - (q.f1 * q.c1 + q.f2 * q.c2) / (q.f1 + q.f2) / lamW;
    if (!cfg || !st) return { o, repaired: false };
    const maxGapMs = ((cfg === true ? undefined : cfg.maxGapS) ?? 120) * 1000;
    const maxFrac = (cfg === true ? undefined : cfg.maxFrac) ?? 0.15;
    let q = fix(st.dn1, st.dn2);
    const gapMs = tMs - st.tMs;
    if (gapMs > maxGapMs) return { o: q, repaired: false }; // too long: reset (offsets kept)
    // Was there a break? (flag, or more than ~2 nominal epochs missing)
    const broke = o.slip || gapMs > 3 * this.nominalStepMs();
    // Only repair a real break (flag or gap). Unflagged slips are left to
    // the MW / time-differenced detectors: between sparse epochs a moving
    // ionosphere alone shifts the geometry-free phase by several cm, and
    // "repairing" that inserts wrong integers.
    if (!broke && !st.pendingMw) return { o: q, repaired: false };
    const gfPred = this.predictGf(st.gf, tMs, Math.abs(lam1 - lam2));
    const gfNow = gfOf(q);
    const refuse = () => {
      st.pendingMw = undefined;
      return { o: q, repaired: false };
    };
    // Wide-lane jump from MW, L1 jump from GF (ionosphere extrapolated).
    if (gfPred == null) return refuse();
    const mw = [...(st.pendingMw ?? []), mwOf(q)];
    const dWl = mw.reduce((s, v) => s + v, 0) / mw.length - st.mw;
    const nWl = Math.round(dWl);
    const dGf = gfNow - gfPred;
    const n1Of = (w: number) => (dGf - lam2 * w) / (lam1 - lam2);
    const frac = (v: number) => Math.abs(v - Math.round(v));
    // GF-blind pairs: on Galileo E1/E5a a (ΔWL ±1, ΔN1 ±4) slip moves the
    // geometry-free phase by only 3 mm, so the GF can't tell nWl from nWl±1
    // and only the MW is left — whose low-elevation multipath can be off by
    // a whole cycle for tens of seconds. Hand the GF-consistent candidates
    // to the filter instead: they differ by ~76 cm in the iono-free phase,
    // which the other satellites' solution resolves.
    const cands = [0, -1, 1]
      .map((k) => nWl + k)
      .filter((w) => frac(n1Of(w)) <= maxFrac)
      .map((w) => ({ n1: Math.round(n1Of(w)), n2: Math.round(n1Of(w)) - w }));
    if (!cands.length) return refuse();
    if (cands.length > 1) {
      st.pendingMw = undefined;
      return { o: { ...q, slip: false }, repaired: false, candidates: cands };
    }
    const n1 = cands[0]!.n1;
    if (cands[0]!.n2 !== n1 - nWl) return refuse(); // only an alternative fits
    if (Math.abs(dWl - nWl) > maxFrac * 1.5) {
      // Not sure of the wide-lane yet: hold the satellite out and average
      // the MW over a few more epochs (at 1 Hz: seconds) before deciding.
      if (mw.length >= 10) return refuse();
      st.pendingMw = mw;
      return { o: q, repaired: false, defer: true };
    }
    st.pendingMw = undefined;
    const n2 = n1 - nWl;
    st.dn1 += n1;
    st.dn2 += n2;
    q = fix(st.dn1, st.dn2);
    this.repairedNow.add(o.prn);
    return { o: { ...q, slip: false }, repaired: true };
  }

  /** Linear extrapolation of the geometry-free history to t; null with < 3
   *  points, when the ionosphere isn't behaving linearly (fit scatter
   *  > 1 cm), or when the extrapolation itself is too uncertain to resolve a
   *  cycle of λ1−λ2. The fit window scales with the gap (3×, 30 s–3 min),
   *  not a fixed number of points: at 1 Hz six points span 5 s, and their
   *  slope carried across a 60 s gap is off by about one cycle; a long
   *  window on a short gap is biased by the ionosphere's curvature. */
  private predictGf(
    h: { t: number; v: number }[],
    t: number,
    cycleM: number
  ): number | null {
    if (h.length < 3) return null;
    const last = h.at(-1)!.t;
    const win = Math.min(180_000, Math.max(30_000, 3 * (t - last)));
    const pts = h.filter((p) => p.t >= last - win);
    const n = pts.length;
    if (n < 3) return null;
    const mt = pts.reduce((a, p) => a + p.t, 0) / n;
    const mv = pts.reduce((a, p) => a + p.v, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (const p of pts) {
      sxy += (p.t - mt) * (p.v - mv);
      sxx += (p.t - mt) ** 2;
    }
    if (!(sxx > 0)) return null;
    const slope = sxy / sxx;
    const rms = Math.sqrt(
      pts.reduce((a, p) => a + (p.v - (mv + slope * (p.t - mt))) ** 2, 0) / n
    );
    if (rms > 0.01) return null;
    // Prediction σ (scatter floored at 3 mm: a short fit can look too good).
    const sigma = Math.max(rms, 0.003) * Math.sqrt(1 / n + (t - mt) ** 2 / sxx);
    if (sigma > 0.1 * cycleM) return null;
    return mv + slope * (t - mt);
  }

  /** Satellites repaired in the current epoch (soft-repair variance bump). */
  private repairedNow = new Set<string>();
  private stepMs = 0;
  private prevEpochMs = 0;
  /** The receiver's nominal epoch interval (smallest seen). */
  private nominalStepMs(): number {
    return this.stepMs || 30_000;
  }

  /** Remember a satellite's good observation for later repairs. */
  private rememberForRepair(o: PppSatObs, tMs: number, mwMean: number): void {
    const lam1 = C_LIGHT / o.f1;
    const lam2 = C_LIGHT / o.f2;
    const st = this.repairState.get(o.prn) ?? {
      tMs,
      mw: mwMean,
      gf: [],
      dn1: 0,
      dn2: 0,
    };
    st.tMs = tMs;
    st.mw = mwMean;
    st.gf.push({ t: tMs, v: o.l1 * lam1 - o.l2 * lam2 });
    // Keep the 3 minutes the ionosphere fit uses.
    while (st.gf.length > 2 && st.gf[0]!.t < tMs - 180_000) st.gf.shift();
    this.repairState.set(o.prn, st);
  }

  /** Detect a cycle slip via the Melbourne–Wübbena wide-lane ambiguity. */
  private detectSlip(o: PppSatObs, ei: number): boolean {
    const lamW = C_LIGHT / (o.f1 - o.f2);
    const lw = o.l1 - o.l2; // wide-lane phase (cycles)
    const pn = (o.f1 * o.c1 + o.f2 * o.c2) / (o.f1 + o.f2); // narrow-lane code (m)
    const mw = lw - pn / lamW; // wide-lane ambiguity (cycles)
    const st = this.mwState.get(o.prn);
    let slip = o.slip;
    if (!st || ei - st.lastEi > 2)
      slip = true; // new arc / gap
    else if (Math.abs(mw - st.mean) > 4) slip = true; // > 4 WL cycles jump
    if (slip) this.mwState.set(o.prn, { mean: mw, n: 1, lastEi: ei });
    else {
      const n = st!.n + 1;
      this.mwState.set(o.prn, {
        mean: st!.mean + (mw - st!.mean) / Math.min(n, 100),
        n,
        lastEi: ei,
      });
    }
    return slip;
  }

  private growState(initVal: number, initVar: number): number {
    const idx = this.x.length;
    this.x.push(initVal);
    for (const row of this.P) row.push(0);
    this.P.push(new Array<number>(this.x.length).fill(0));
    this.P[idx]![idx] = initVar;
    return idx;
  }

  private dropState(idx: number): void {
    this.x.splice(idx, 1);
    this.P.splice(idx, 1);
    for (const row of this.P) row.splice(idx, 1);
    // Reindex ambiguities AND clocks above the dropped slot.
    for (const [prn, i] of this.ambIdx) {
      if (i === idx) this.ambIdx.delete(prn);
      else if (i > idx) this.ambIdx.set(prn, i - 1);
    }
    for (const [sys, i] of this.clkIdx) {
      if (i > idx) this.clkIdx.set(sys, i - 1);
    }
  }

  /** State index of a constellation's receiver clock, creating it lazily. */
  private clockOf(sys: string): number {
    let i = this.clkIdx.get(sys);
    if (i === undefined) {
      i = this.growState(0, CLK_VAR);
      this.clkIdx.set(sys, i);
    }
    return i;
  }

  /** Process one epoch, carrying the filter forward; returns its result. */
  process(epoch: PppEpoch): PppEpochResult {
    const {
      source,
      opts,
      elevMask,
      codeSigma,
      phaseSigma,
      ztdQ,
      kinematic,
      corrections,
      truth,
      x,
      P,
      clkIdx,
      clockSeeded,
      ambIdx,
      lastSeen,
      arcSnap,
      mwState,
      series,
      tdPrev,
      phaseRejects,
    } = this;
    const flushArc = this.flushArc.bind(this);
    const detectSlip = this.detectSlip.bind(this);
    const growState = this.growState.bind(this);
    const dropState = this.dropState.bind(this);
    const clockOf = this.clockOf.bind(this);
    const ei = this.ei;
    if (ei === 0) this.t0 = epoch.timeMs;
    const t0 = this.t0;

    // ── Time update ──
    // Position: static holds it constant (no process noise). Kinematic treats
    // it as white noise (RTKLIB PMODE_PPP_KINEMA) — after the first epoch,
    // decorrelate the position states and reset their variance so the rover is
    // re-estimated from this epoch's measurements; epoch-to-epoch continuity
    // still lives in the persisting carrier-ambiguity states.
    // During an initial static period (on the start mark) the position is
    // held as one state, like a static session.
    const holding =
      ei > 0 &&
      (opts.initialStaticSec ?? 0) > 0 &&
      epoch.timeMs - this.t0 < (opts.initialStaticSec ?? 0) * 1000;
    if (kinematic && ei > 0 && !holding) {
      for (const p of [IDX_X, IDX_Y, IDX_Z]) {
        for (let j = 0; j < x.length; j++) {
          P[p]![j] = 0;
          P[j]![p] = 0;
        }
        P[p]![p] = POS_VAR;
      }
    }
    // Each constellation clock: white noise — reset its variance so it is
    // freely re-estimated each epoch.
    for (const ci of clkIdx.values()) P[ci]![ci] = CLK_VAR;
    // Zenith wet delay: random walk.
    P[IDX_ZWD]![IDX_ZWD]! += ztdQ * (ei > 0 ? 1 : 0);
    // Gradients: random walk in time.
    const grad = gradientConfig(opts);
    if (grad && this.lastEpochMs !== null) {
      const dtH = Math.max(0, epoch.timeMs - this.lastEpochMs) / 3_600_000;
      const q = grad.randomWalkMPerSqrtH ** 2 * dtH;
      P[IDX_GN]![IDX_GN]! += q;
      P[IDX_GE]![IDX_GE]! += q;
    }
    this.lastEpochMs = epoch.timeMs;

    const rcv: [number, number, number] = [x[IDX_X]!, x[IDX_Y]!, x[IDX_Z]!];
    // ecefToGeodetic returns radians.
    const [latRad, lonRad, heightM] = ecefToGeodetic(rcv[0], rcv[1], rcv[2]);

    // Sun/Moon-dependent corrections computed once per epoch.
    const epochCtx = corrections?.epochContext?.(epoch.timeMs, rcv) ?? null;

    // ── Pass 1: geometry, iono-free obs, tropo, corrections per satellite ──
    interface Vis {
      prn: string;
      e: [number, number, number]; // LOS unit rcv→sat
      elRad: number;
      azRad: number;
      pIf: number;
      lIf: number;
      satClkM: number;
      range: number;
      tropoFixed: number; // zhd·mh (+ range corrections)
      mw: number;
      /** Gradient partials: mapping × cos/sin azimuth (0 when not estimated). */
      mgN: number;
      mgE: number;
      windupM: number;
      slip: boolean;
      f1: number;
      f2: number;
      sat: [number, number, number];
    }
    const vis: Vis[] = [];
    const pendingCands = new Map<string, { n1: number; n2: number }[]>();
    let repairedNow = 0;
    this.repairedNow.clear();
    if (this.prevEpochMs) {
      const d = epoch.timeMs - this.prevEpochMs;
      if (d > 0 && (!this.stepMs || d < this.stepMs)) this.stepMs = d;
    }
    this.prevEpochMs = epoch.timeMs;
    // Zenith hydrostatic delay is station-level (same for every satellite this
    // epoch); capture it so ZTD = ZHD + ZWD can be reported.
    let epochZhd = 0;
    for (const raw of epoch.obs) {
      if (raw.c1 === 0 || raw.c2 === 0 || raw.l1 === 0 || raw.l2 === 0)
        continue;
      const ob = applySatBiases(source, raw, epoch.timeMs);
      if (!ob) continue;
      const rep = this.repairSlip(ob, epoch.timeMs);
      if (rep.defer) continue; // held out while the wide-lane settles
      const o = rep.o;
      if (rep.repaired) {
        repairedNow++;
        // Continue the MW average as if nothing happened (phases corrected).
        const m = this.mwState.get(o.prn);
        if (m) m.lastEi = ei - 1;
      }
      if (rep.candidates) pendingCands.set(o.prn, rep.candidates);
      const slip = rep.candidates ? false : detectSlip(o, ei);
      if (rep.candidates) {
        // decided after this epoch's update (resolveCandidates)
      } else if (!slip)
        this.rememberForRepair(o, epoch.timeMs, this.mwState.get(o.prn)!.mean);
      else if (!rep.repaired) {
        // A real reset: the ambiguity restarts on these (offset-corrected)
        // phases, so keep applying the offsets; only the geometry-free
        // history restarts.
        const st = this.repairState.get(o.prn);
        if (st) st.gf = [];
        this.rememberForRepair(o, epoch.timeMs, this.mwState.get(o.prn)!.mean);
      }
      const sat = satStateAtEmission(source, o.prn, epoch.timeMs, rcv, o.c1);
      if (!sat) continue;
      const [elRad, azRad] = getAer(
        sat.state.x,
        sat.state.y,
        sat.state.z,
        rcv[0],
        rcv[1],
        rcv[2]
      );
      if (elRad < elevMask) continue;

      const dx = sat.state.x - rcv[0];
      const dy = sat.state.y - rcv[1];
      const dz = sat.state.z - rcv[2];
      const range = Math.hypot(dx, dy, dz);
      const e: [number, number, number] = [dx / range, dy / range, dz / range];

      const { g } = ifCoeffs(o.f1, o.f2);
      const lam1 = C_LIGHT / o.f1;
      const lam2 = C_LIGHT / o.f2;
      if (o.c1 === 0 || o.c2 === 0 || o.l1 === 0 || o.l2 === 0) continue;
      const pIf = g * o.c1 - (g - 1) * o.c2;
      const lIf = g * (o.l1 * lam1) - (g - 1) * (o.l2 * lam2);
      if (!Number.isFinite(pIf) || !Number.isFinite(lIf)) continue;

      const trop =
        (opts.troposphere ?? true)
          ? opts.troposphereModel
            ? opts.troposphereModel.delays(
                epoch.timeMs,
                latRad,
                lonRad,
                heightM,
                elRad,
                azRad
              )
            : {
                ...niellMapping(elRad, latRad, heightM, epoch.timeMs),
                gradient: 0,
              }
          : { zhd: 0, mh: 0, mw: 0, gradient: 0 };
      const { zhd, mh, mw } = trop;
      epochZhd = zhd;

      const geom: SatGeom = {
        prn: o.prn,
        satEcef: [sat.state.x, sat.state.y, sat.state.z],
        rcvEcef: rcv,
        los: e,
        elRad,
        azRad,
        f1: o.f1,
        f2: o.f2,
        band1: o.band1,
        band2: o.band2,
        g,
      };
      const corr = corrections
        ? applyCorrections(corrections, geom, epochCtx)
        : { rangeM: 0, phaseWindupM: 0 };

      vis.push({
        prn: o.prn,
        e,
        elRad,
        azRad,
        pIf,
        lIf,
        satClkM: sat.state.clkM,
        range,
        tropoFixed: zhd * mh + trop.gradient + corr.rangeM,
        mw,
        mgN: grad ? gradientMapping(elRad) * Math.cos(azRad) : 0,
        mgE: grad ? gradientMapping(elRad) * Math.sin(azRad) : 0,
        windupM: corr.phaseWindupM,
        slip,
        f1: o.f1,
        f2: o.f2,
        sat: [sat.state.x, sat.state.y, sat.state.z],
      });
    }

    // No satellite this epoch: the hydrostatic delay is still the
    // station's (zenith, from the same model), not 0.
    if (!vis.length && (opts.troposphere ?? true))
      epochZhd = opts.troposphereModel
        ? opts.troposphereModel.delays(
            epoch.timeMs,
            latRad,
            lonRad,
            heightM,
            Math.PI / 2,
            0
          ).zhd
        : niellMapping(Math.PI / 2, latRad, heightM, epoch.timeMs).zhd;

    // ── Time-differenced carrier-phase slip test (static) ──
    // Between consecutive epochs the iono-free phase changes by the
    // geometric range change (both epochs evaluated at the current receiver
    // position), the satellite clock change, the modelled delay change and
    // the receiver clock change — the last common to every satellite (one
    // oscillator), so it is removed with the median. What is left is phase
    // noise + clock-interpolation error (cm) unless a cycle slip occurred
    // (≥ ~0.1 m even for an equal (1,1) slip that the Melbourne–Wübbena test
    // cannot see). Unlike an innovation test it does not depend on how well
    // the filter's clock is settled within the epoch.
    {
      const dq: { v: Vis; d: number }[] = [];
      for (const v of vis) {
        const prev = tdPrev.get(v.prn);
        const model = -v.satClkM + v.tropoFixed + v.windupM;
        if (prev && prev.ei === ei - 1 && !v.slip) {
          const r0 = Math.hypot(
            prev.sat[0] - rcv[0],
            prev.sat[1] - rcv[1],
            prev.sat[2] - rcv[2]
          );
          dq.push({
            v,
            d: v.lIf - prev.lIf - (v.range - r0) - (model - prev.model),
          });
        }
        tdPrev.set(v.prn, { ei, lIf: v.lIf, sat: v.sat, model });
      }
      if (!kinematic) {
        if (dq.length >= 4) {
          const sorted = dq.map((q) => q.d).sort((a, b) => a - b);
          const med = sorted[Math.floor(sorted.length / 2)]!;
          for (const q of dq)
            if (Math.abs(q.d - med) > TD_SLIP_M) q.v.slip = true;
        }
      } else if (dq.length >= 6) {
        // A moving receiver adds −e·Δr to every satellite's difference: fit
        // [Δr, Δclock] by least squares (carrier-phase velocity), drop the
        // worst satellite while one stands out, then flag the outliers.
        let use = dq;
        for (let iter = 0; iter < 6; iter++) {
          const sol = use.length >= 6 ? tdLsq(use) : null;
          if (!sol) {
            for (const q of dq) q.v.slip = true; // can't tell: reset all
            break;
          }
          let worst = -1;
          let worstR = 0;
          use.forEach((q, k) => {
            const r = Math.abs(tdResidual(q, sol));
            if (r > worstR) {
              worstR = r;
              worst = k;
            }
          });
          if (worstR <= TD_SLIP_M || iter === 5) {
            for (const q of dq)
              if (Math.abs(tdResidual(q, sol)) > TD_SLIP_M) q.v.slip = true;
            break;
          }
          use = use.filter((_, k) => k !== worst);
        }
      } else {
        for (const q of dq) q.v.slip = true;
      }
    }

    // ── Receiver clock: a white-noise state, jointly estimated with
    // position by the EKF (not crudely pre-fixed, which would couple with
    // position through the asymmetric equatorial geometry and bias the
    // horizontal). The variance is reset large every epoch so the filter
    // freely re-estimates it and absorbs the receiver's clock jumps (up to
    // ~ms = hundreds of km) — the S-based outlier gate stays loose while the
    // clock is uncertain, then tightens once it is pinned by the code. On
    // the very first usable epoch the clock is seeded from the median code
    // residual so it starts in range. ──
    // Seed each constellation's clock from its own median code residual on
    // first sighting (a different receiver hardware delay per system — the
    // inter-system bias — so they must not share a clock), and keep its
    // variance reset for free white-noise re-estimation this epoch.
    const bySys = new Map<string, number[]>();
    for (const v of vis) {
      const sys = v.prn[0]!;
      const r = v.pIf - (v.range - v.satClkM + v.tropoFixed + wetSlant(x, v));
      const arr = bySys.get(sys);
      if (arr) arr.push(r);
      else bySys.set(sys, [r]);
    }
    // Gross code outliers: the clock is re-estimated every epoch, so the
    // filter's own gate is loose for the first satellites processed; screen
    // each satellite's code residual against its constellation's median
    // first (the receiver clock cancels), allowing for the current position
    // uncertainty. A screened satellite sits this epoch out.
    const posSigma = Math.sqrt(
      P[IDX_X]![IDX_X]! + P[IDX_Y]![IDX_Y]! + P[IDX_Z]![IDX_Z]!
    );
    const codeGate = CODE_GATE_M + 3 * posSigma;
    const screened = new Set<string>();
    for (const [sys, res] of bySys) {
      if (res.length < 4) continue;
      const med = [...res].sort((a, b) => a - b)[Math.floor(res.length / 2)]!;
      for (const v of vis) {
        if (v.prn[0] !== sys) continue;
        const r = v.pIf - (v.range - v.satClkM + v.tropoFixed + wetSlant(x, v));
        if (Math.abs(r - med) > codeGate) screened.add(v.prn);
      }
    }
    for (const [sys, res] of bySys) {
      const ci = clockOf(sys);
      if (!clockSeeded.has(sys)) {
        res.sort((a, b) => a - b);
        x[ci] = res[Math.floor(res.length / 2)]!;
        clockSeeded.add(sys);
      }
      P[ci]![ci] = CLK_VAR;
    }

    // ── Pass 2: EKF measurement updates ──
    let nSats = 0;
    const live = vis.filter(
      (v) => !screened.has(v.prn) && !pendingCands.has(v.prn)
    );
    /** Geometric range at the CURRENT position estimate: pass 1 evaluated it
     *  at the predicted position, and each sequential update moves the
     *  state — by metres within a kinematic epoch — so linearise about it
     *  (moving the receiver by d changes the range by −e·d). */
    const rangeNow = (v: Vis): number =>
      v.range -
      (v.e[0] * (x[IDX_X]! - rcv[0]) +
        v.e[1] * (x[IDX_Y]! - rcv[1]) +
        v.e[2] * (x[IDX_Z]! - rcv[2]));

    /** Create the ambiguity on first sight, reset it on a slip. */
    const prepAmbiguity = (v: Vis): number => {
      const ci = clockOf(v.prn[0]!);
      const common =
        rangeNow(v) + x[ci]! - v.satClkM + v.tropoFixed + wetSlant(x, v);
      // A flagged/detected slip ends the current arc before re-init.
      if (v.slip) flushArc(v.prn);
      let ai = ambIdx.get(v.prn);
      // Optional soft repair: let a repaired ambiguity move by `softSigmaM`.
      // Default 0 — the strict acceptance (linear ionosphere, near-integer
      // jumps) already keeps wrong integers out, and any bump accumulates
      // under frequent slips (urban: 94 % → 38 % of epochs within 10 cm).
      if (ai !== undefined && !v.slip && this.repairedNow.has(v.prn)) {
        const rc = opts.slipRepair;
        const soft = (rc && rc !== true ? rc.softSigmaM : undefined) ?? 0;
        P[ai]![ai]! += soft * soft;
      }
      if (ai === undefined || v.slip) {
        const bInit = v.lIf - (common + v.windupM);
        if (ai === undefined) {
          ai = growState(bInit, 100 * 100);
        } else {
          x[ai] = bInit;
          for (let j = 0; j < P.length; j++) {
            P[ai]![j] = 0;
            P[j]![ai] = 0;
          }
          P[ai]![ai] = 100 * 100;
        }
        ambIdx.set(v.prn, ai);
      }
      return ai;
    };

    /** Per-satellite outcome this epoch, for `diagnostics`. */
    const codeUsed = new Set<string>();
    const phaseUsed = new Set<string>();
    const reinited = new Set<string>();
    const codeUpdate = (v: Vis): void => {
      const ci = clockOf(v.prn[0]!);
      const common =
        rangeNow(v) + x[ci]! - v.satClkM + v.tropoFixed + wetSlant(x, v);
      const sinEl = Math.max(Math.sin(v.elRad), 0.1);
      const h = new Array<number>(x.length).fill(0);
      h[IDX_X] = -v.e[0];
      h[IDX_Y] = -v.e[1];
      h[IDX_Z] = -v.e[2];
      h[ci] = 1;
      h[IDX_ZWD] = v.mw;
      h[IDX_GN] = v.mgN;
      h[IDX_GE] = v.mgE;
      const innov = v.pIf - common;
      // Loose absolute bound (clock jumps up to ~ms); the S-based reject
      // gate (rejectK) does the real outlier screening once the clock is
      // pinned.
      if (
        Math.abs(innov) < 1e6 &&
        ekfUpdateScalar(x, P, h, innov, (codeSigma / sinEl) ** 2, 4)
      )
        codeUsed.add(v.prn);
    };

    const phaseUpdate = (v: Vis, ai: number): void => {
      const ci = clockOf(v.prn[0]!);
      const sinEl = Math.max(Math.sin(v.elRad), 0.1);
      const rPhase = (phaseSigma / sinEl) ** 2;
      const commonPh =
        rangeNow(v) + x[ci]! - v.satClkM + v.tropoFixed + wetSlant(x, v);
      const innov = v.lIf - (commonPh + v.windupM + x[ai]!);
      // Slips are caught before the updates (MW + time-differenced
      // phase), so a gated-out phase is an outlier, and only a run of them
      // means the ambiguity itself is wrong.
      const reinit = (phaseRejects.get(v.prn) ?? 0) >= 3;
      let used = false;
      if (!reinit) {
        const h = new Array<number>(x.length).fill(0);
        h[IDX_X] = -v.e[0];
        h[IDX_Y] = -v.e[1];
        h[IDX_Z] = -v.e[2];
        h[ci] = 1;
        h[IDX_ZWD] = v.mw;
        h[IDX_GN] = v.mgN;
        h[IDX_GE] = v.mgE;
        h[ai] = 1;
        used = ekfUpdateScalar(x, P, h, innov, rPhase, 4);
      }
      if (used) phaseUsed.add(v.prn);
      if (reinit) {
        reinited.add(v.prn);
        flushArc(v.prn); // undetected slip → close the arc, re-initialise
        x[ai] = v.lIf - (commonPh + v.windupM);
        for (let j = 0; j < P.length; j++) {
          P[ai]![j] = 0;
          P[j]![ai] = 0;
        }
        P[ai]![ai] = 100 * 100;
        phaseRejects.delete(v.prn);
      } else if (used) phaseRejects.delete(v.prn);
      else phaseRejects.set(v.prn, (phaseRejects.get(v.prn) ?? 0) + 1);
    };

    const snapshot = (v: Vis, ai: number): void => {
      // Snapshot the (converged) arc state for PPP-AR.
      const elevDeg = (v.elRad * 180) / Math.PI;
      const mwMean = mwState.get(v.prn)?.mean ?? 0;
      const s = arcSnap.get(v.prn);
      if (s) {
        s.aIF = x[ai]!;
        s.mwCyc = mwMean;
        s.elevSum += elevDeg;
        s.nEpochs++;
        s.endMs = epoch.timeMs;
      } else {
        arcSnap.set(v.prn, {
          aIF: x[ai]!,
          mwCyc: mwMean,
          f1: v.f1,
          f2: v.f2,
          elevSum: elevDeg,
          nEpochs: 1,
          startMs: epoch.timeMs,
          endMs: epoch.timeMs,
        });
      }
      lastSeen.set(v.prn, ei);
      this.lastSeenMs.set(v.prn, epoch.timeMs);
      nSats++;
    };

    if (kinematic) {
      // A fresh position each epoch: let every code observation place it
      // before any phase is tested against it.
      for (const v of live) codeUpdate(v);
      for (const v of live) {
        const ai = prepAmbiguity(v);
        phaseUpdate(v, ai);
        snapshot(v, ai);
      }
    } else {
      for (const v of live) {
        const ai = prepAmbiguity(v);
        codeUpdate(v);
        phaseUpdate(v, ai);
        snapshot(v, ai);
      }
    }

    // GF-blind repairs: pick the candidate whose iono-free phase fits this
    // epoch's solution (from the other satellites); otherwise reset. The
    // candidates differ by ~76 cm, so decide only when the prediction's own
    // σ is far below that. If no satellite of the system updated its clock
    // this epoch (a total outage: all came back blind), compare the held-out
    // satellites with each other instead — a choice common to all of them
    // is absorbed by that clock, so it can't hurt.
    {
      type Pend = {
        prn: string;
        st: {
          tMs: number;
          gf: { t: number; v: number }[];
          dn1: number;
          dn2: number;
        };
        cands: { n1: number; n2: number }[];
        innov0?: number;
        sig?: number;
        dIf?: (c: { n1: number; n2: number }) => number;
      };
      const pend: Pend[] = [];
      for (const [prn, cands] of pendingCands) {
        const p: Pend = { prn, st: this.repairState.get(prn)!, cands };
        pend.push(p);
        const v = vis.find((u) => u.prn === prn);
        const ai = ambIdx.get(prn);
        if (!v || ai === undefined || screened.has(prn)) continue;
        const ci = clockOf(prn[0]!);
        p.innov0 =
          v.lIf -
          (rangeNow(v) +
            x[ci]! -
            v.satClkM +
            v.tropoFixed +
            wetSlant(x, v) +
            v.windupM +
            x[ai]!);
        // Prediction σ without the clock (added below when it's used).
        const idx = [IDX_X, IDX_Y, IDX_Z, IDX_ZWD, ai];
        const h = [-v.e[0], -v.e[1], -v.e[2], v.mw, 1];
        let S = 0;
        for (let i = 0; i < idx.length; i++)
          for (let j = 0; j < idx.length; j++)
            S += h[i]! * h[j]! * P[idx[i]!]![idx[j]!]!;
        p.sig = Math.sqrt(Math.max(S, 0));
        const { g } = ifCoeffs(v.f1, v.f2);
        const l1 = C_LIGHT / v.f1;
        const l2 = C_LIGHT / v.f2;
        p.dIf = (c) => g * l1 * c.n1 - (g - 1) * l2 * c.n2;
      }
      const clockPinned = (sys: string) =>
        [...phaseUsed].filter((q) => q[0] === sys).length >= 2;
      const choose = (p: Pend, ref: number, extraVar: number) => {
        if (p.innov0 == null || p.sig == null || !p.dIf) return null;
        const sig = Math.sqrt(p.sig ** 2 + extraVar);
        if (sig > 0.12) return null;
        const r = p.cands
          .map((c) => ({ c, res: Math.abs(p.innov0! - ref - p.dIf!(c)) }))
          .sort((a, b) => a.res - b.res);
        return r[0]!.res < 0.2 && (r.length < 2 || r[1]!.res > 0.4)
          ? r[0]!.c
          : null;
      };
      for (const p of pend) {
        const sys = p.prn[0]!;
        let best: { n1: number; n2: number } | null = null;
        if (nSats >= 4 && clockPinned(sys)) {
          best = choose(p, 0, P[clockOf(sys)]![clockOf(sys)]!);
        } else {
          const same = pend.filter((q) => q.prn[0] === sys && q.innov0 != null);
          if (same.length >= 3) {
            const med = same.map((q) => q.innov0!).sort((a, b) => a - b)[
              Math.floor(same.length / 2)
            ]!;
            best = choose(p, med, 0);
          }
        }
        const st = p.st;
        st.tMs = epoch.timeMs;
        if (best) {
          st.dn1 += best.n1;
          st.dn2 += best.n2;
          const m = mwState.get(p.prn);
          if (m) m.lastEi = ei; // continue the MW average next epoch
          repairedNow++;
          this.repairedNow.add(p.prn);
        } else {
          st.gf = [];
          mwState.delete(p.prn); // next epoch: a fresh arc (reset)
        }
      }
    }

    // Post-fit phase residuals: re-evaluate every satellite against the
    // epoch's FINAL state (position, per-system clock, ZWD, ambiguity), then
    // project out the receiver clock by removing the per-system mean. The
    // clock is a free per-epoch parameter, so its best estimate is exactly
    // that mean; without this, satellites processed early in the sequential
    // update (before the carrier phase pins the clock) leave a large common
    // offset that has nothing to do with phase precision. Gross outliers
    // (undetected slips) are excluded — this is the honest phase-QC number.
    let sumPhaseResSq = 0;
    let nPhaseRes = 0;
    {
      const bySysRes = new Map<string, number[]>();
      for (const v of vis) {
        const ai = ambIdx.get(v.prn);
        if (ai === undefined) continue;
        const sys = v.prn[0]!;
        const ci = clockOf(sys);
        const commonPh =
          rangeNow(v) + x[ci]! - v.satClkM + v.tropoFixed + wetSlant(x, v);
        const innov = v.lIf - (commonPh + v.windupM + x[ai]!);
        if (Math.abs(innov) >= 0.15) continue; // undetected slip / gross outlier
        const arr = bySysRes.get(sys);
        if (arr) arr.push(innov);
        else bySysRes.set(sys, [innov]);
      }
      for (const res of bySysRes.values()) {
        const mean = res.reduce((a, b) => a + b, 0) / res.length;
        for (const r of res) {
          const d = r - mean;
          sumPhaseResSq += d * d;
          nPhaseRes++;
        }
      }
    }

    let diagnostics: PppEpochDiagnostics | undefined;
    if (opts.diagnostics) {
      const clockM: Record<string, number> = {};
      for (const [sys, ci] of clkIdx) clockM[sys] = x[ci]!;
      // Position covariance rotated to East/North/Up at the epoch's position.
      const sl = Math.sin(latRad),
        cl = Math.cos(latRad),
        so = Math.sin(lonRad),
        co = Math.cos(lonRad);
      const R = [
        [-so, co, 0],
        [-sl * co, -sl * so, cl],
        [cl * co, cl * so, sl],
      ];
      const sigma = R.map((r) => {
        let v = 0;
        for (let i = 0; i < 3; i++)
          for (let j = 0; j < 3; j++) v += r[i]! * P[i]![j]! * r[j]!;
        return Math.sqrt(Math.max(v, 0));
      }) as [number, number, number];
      const raw = vis.map((v) => {
        const ci = clockOf(v.prn[0]!);
        const common =
          rangeNow(v) + x[ci]! - v.satClkM + v.tropoFixed + wetSlant(x, v);
        const ai = ambIdx.get(v.prn);
        return {
          v,
          code: v.pIf - common,
          phase:
            ai === undefined ? null : v.lIf - (common + v.windupM + x[ai]!),
        };
      });
      // Constellation means over the observations that entered the filter
      // (phase: also below the gross-outlier bound used for phaseResRms).
      const mean = (pick: (r: (typeof raw)[number]) => number | null) => {
        const acc = new Map<string, { s: number; n: number }>();
        for (const r of raw) {
          const val = pick(r);
          if (val === null) continue;
          const a = acc.get(r.v.prn[0]!) ?? { s: 0, n: 0 };
          a.s += val;
          a.n++;
          acc.set(r.v.prn[0]!, a);
        }
        return (sys: string) => {
          const a = acc.get(sys);
          return a && a.n ? a.s / a.n : 0;
        };
      };
      const codeMean = mean((r) => (codeUsed.has(r.v.prn) ? r.code : null));
      const phaseMean = mean((r) =>
        phaseUsed.has(r.v.prn) && r.phase !== null && Math.abs(r.phase) < 0.15
          ? r.phase
          : null
      );
      diagnostics = {
        clockM,
        positionSigmaEnu: sigma,
        sats: raw.map((r) => {
          const sys = r.v.prn[0]!;
          return {
            prn: r.v.prn,
            elevDeg: (r.v.elRad * 180) / Math.PI,
            azDeg: ((((r.v.azRad * 180) / Math.PI) % 360) + 360) % 360,
            codeRes: r.code - codeMean(sys),
            phaseRes: r.phase === null ? null : r.phase - phaseMean(sys),
            codeUsed: codeUsed.has(r.v.prn),
            phaseUsed: phaseUsed.has(r.v.prn),
            slip: r.v.slip || reinited.has(r.v.prn),
          };
        }),
      };
    }

    // Drop ambiguities of satellites unseen for > 20 epochs — but keep them
    // through a gap that slip repair could still bridge.
    const repairCfg = opts.slipRepair ?? true;
    const keepMs = repairCfg
      ? ((repairCfg === true ? undefined : repairCfg.maxGapS) ?? 120) * 1000
      : 0;
    for (const [prn, seen] of [...lastSeen]) {
      const seenMs = this.lastSeenMs.get(prn) ?? 0;
      if (ei - seen > 20 && epoch.timeMs - seenMs > keepMs) {
        this.lastSeenMs.delete(prn);
        const idx = ambIdx.get(prn);
        if (idx !== undefined) dropState(idx);
        lastSeen.delete(prn);
        flushArc(prn); // the arc ended when the satellite set
      }
    }

    this.tryFix(epoch.timeMs, vis);
    if (this.lastFix) this.fixedEpochs++;

    const pos: [number, number, number] = [x[IDX_X]!, x[IDX_Y]!, x[IDX_Z]!];
    let enu: [number, number, number] | null = null;
    let error3d: number | null = null;
    if (truth) {
      enu = getEnuDifference(
        pos[0],
        pos[1],
        pos[2],
        truth[0],
        truth[1],
        truth[2]
      );
      error3d = Math.hypot(
        pos[0] - truth[0],
        pos[1] - truth[1],
        pos[2] - truth[2]
      );
      if (error3d < 0.1) {
        this.convergedStreak++;
        if (this.convergedStreak >= 10 && this.convergenceSec == null) {
          this.convergenceSec = (epoch.timeMs - t0) / 1000;
        }
      } else {
        this.convergedStreak = 0;
        this.convergenceSec = null;
      }
    }

    const result: PppEpochResult = {
      timeMs: epoch.timeMs,
      enu,
      error3d,
      position: pos,
      nSats,
      ztdWet: x[IDX_ZWD]!,
      ztdHydrostatic: epochZhd,
      ztdSigma: Math.sqrt(P[IDX_ZWD]![IDX_ZWD]!),
      ...(opts.estimateGradients
        ? {
            gradients: {
              n: x[IDX_GN]!,
              e: x[IDX_GE]!,
              sigmaN: Math.sqrt(P[IDX_GN]![IDX_GN]!),
              sigmaE: Math.sqrt(P[IDX_GE]![IDX_GE]!),
            },
          }
        : {}),
      phaseResRms: nPhaseRes > 0 ? Math.sqrt(sumPhaseResSq / nPhaseRes) : 0,
      posSigma3d: Math.sqrt(
        P[IDX_X]![IDX_X]! + P[IDX_Y]![IDX_Y]! + P[IDX_Z]![IDX_Z]!
      ),
      ...(repairedNow ? { slipsRepaired: repairedNow } : {}),
      nFixed: this.lastFix?.nFixed ?? 0,
      fixedPosition: this.lastFix?.position ?? null,
      ...(diagnostics ? { diagnostics } : {}),
    };
    series.push(result);
    this.ei = ei + 1;
    return result;
  }

  /**
   * PPP-AR. Every `everyS`, resolve the converged ambiguities of the
   * satellites in view (between satellites of one constellation) and, when
   * the fix passes the ratio, success-rate and χ² tests, condition the
   * float position on it ({@link fixPppPosition}). The float filter itself
   * is never constrained — a wrong fix can't contaminate later epochs, and
   * the next attempt starts clean. Between attempts the last fix carries
   * over (static) or is dropped (kinematic).
   */
  private tryFix(
    tMs: number,
    vis: readonly { prn: string; elRad: number; f1: number; f2: number }[]
  ): void {
    const ar = this.opts.ar;
    if (!ar || !this.source.phaseBias) return;
    const cfg = ar === true ? {} : ar;
    if (tMs - this.lastArMs < (cfg.everyS ?? 120) * 1000) {
      if (this.kinematic) this.lastFix = null;
      return;
    }
    this.lastArMs = tMs;
    this.lastFix = null;
    const { x, P, ambIdx, arcSnap, mwState } = this;
    const minArcMs = (cfg.minArcS ?? 600) * 1000;
    const ambiguities: PppFixState['ambiguities'] = [];
    for (const v of vis) {
      const index = ambIdx.get(v.prn);
      const snap = arcSnap.get(v.prn);
      const mw = mwState.get(v.prn);
      if (index === undefined || !snap || !mw) continue;
      if (tMs - snap.startMs < minArcMs || snap.nEpochs < 20) continue;
      ambiguities.push({
        prn: v.prn,
        index,
        aIF: x[index]!,
        mwCyc: mw.mean,
        f1: v.f1,
        f2: v.f2,
        elevDeg: (v.elRad * 180) / Math.PI,
      });
    }
    const fx = fixPppPosition(
      {
        position: [x[IDX_X]!, x[IDX_Y]!, x[IDX_Z]!],
        covariance: P,
        ambiguities,
      },
      NO_FCB,
      {
        ratioThreshold: cfg.ratio ?? 3,
        wlThreshold: cfg.wlThreshold ?? 0.15,
        minSuccessRate: cfg.successRate ?? 0.999,
        minFixed: cfg.minFixed ?? 5,
        maxChi2: cfg.maxChi2 ?? 20,
      }
    );
    if (!fx.fixed) return;
    const covariance = fx.covariance ?? null;
    this.lastFix = {
      position: fx.position,
      covariance,
      nFixed: fx.nFixed,
      ratio: fx.ratio,
    };
    this.lastAccepted = { position: fx.position, covariance, tMs };
    this.firstFixMs ??= tMs;
  }

  /** The session's PPP-AR outcome. A fix from the final attempt is reported
   *  as is. Static sessions whose final attempt failed fall back to the last
   *  accepted fix (a 2-hour session fixed 80 % of the time used to report
   *  float because its last attempt didn't pass), but only while that fix
   *  still agrees with the final float position: an early fix the filter
   *  later moved away from is stale, not "fixed" (2–4 h sessions showed
   *  10–46 cm errors). The final float may sit a few cm from a correct
   *  current fix on short sessions, so the gap test is for fallbacks only. */
  private arSummary(
    finalPos: [number, number, number]
  ): NonNullable<PppSolution['ar']> {
    const { series } = this;
    const ar = this.opts.ar;
    const maxGap =
      (typeof ar === 'object' ? ar.maxFloatGapM : undefined) ?? 0.03;
    const fallback = !this.lastFix;
    const cand = this.lastFix
      ? {
          position: this.lastFix.position,
          covariance: this.lastFix.covariance,
          tMs: series[series.length - 1]?.timeMs ?? null,
        }
      : this.kinematic
        ? null
        : this.lastAccepted;
    const floatGapM = cand
      ? Math.hypot(
          cand.position[0] - finalPos[0],
          cand.position[1] - finalPos[1],
          cand.position[2] - finalPos[2]
        )
      : null;
    const ok = cand !== null && (!fallback || floatGapM! <= maxGap);
    return {
      firstFixSec:
        this.firstFixMs === null || !series.length
          ? null
          : (this.firstFixMs - series[0]!.timeMs) / 1000,
      nFixedEnd: this.lastFix?.nFixed ?? 0,
      position: ok ? cand.position : null,
      positionEpochMs: ok ? cand.tMs : null,
      covariance: ok ? cand.covariance : null,
      floatGapM,
      rejected: cand !== null && !ok ? 'float-gap' : null,
      fixedEpochShare: series.length ? this.fixedEpochs / series.length : 0,
    };
  }

  /** Finalise the session: capture the AR state, flush open arcs, assemble. */
  solution(): PppSolution {
    const { opts, x, P, ambIdx, arcSnap, mwState, arcs, series, truth } = this;
    const flushArc = this.flushArc.bind(this);

    // Capture the final EKF state for ambiguity resolution before flushing the
    // open arcs (arcSnap still holds each active satellite's f1/f2/MW/elevation).
    let finalState: PppFixState | undefined;
    if (opts.exposeState) {
      const ambs: PppFixState['ambiguities'] = [];
      for (const [prn, index] of ambIdx) {
        const s = arcSnap.get(prn);
        if (!s || s.nEpochs < 10) continue;
        ambs.push({
          prn,
          index,
          aIF: x[index]!,
          mwCyc: mwState.get(prn)?.mean ?? s.mwCyc,
          f1: s.f1,
          f2: s.f2,
          elevDeg: s.elevSum / s.nEpochs,
        });
      }
      finalState = {
        position: [x[IDX_X]!, x[IDX_Y]!, x[IDX_Z]!],
        covariance: P.map((row) => row.slice()),
        ambiguities: ambs,
      };
    }

    // Flush the still-open arcs at the end of the run.
    for (const prn of [...arcSnap.keys()]) flushArc(prn);

    const finalPos: [number, number, number] = [
      x[IDX_X]!,
      x[IDX_Y]!,
      x[IDX_Z]!,
    ];
    const geo = ecefToGeodetic(finalPos[0], finalPos[1], finalPos[2]);
    const llh: [number, number, number] = [
      (geo[0] * 180) / Math.PI,
      (geo[1] * 180) / Math.PI,
      geo[2],
    ];
    const finalError3d = truth
      ? Math.hypot(
          finalPos[0] - truth[0],
          finalPos[1] - truth[1],
          finalPos[2] - truth[2]
        )
      : null;

    return {
      position: finalPos,
      llh,
      series,
      ztdWet: x[IDX_ZWD]!,
      ztdHydrostatic: series.length
        ? series[series.length - 1]!.ztdHydrostatic
        : 0,
      epochsUsed: series.length,
      convergenceSec: this.convergenceSec,
      finalError3d,
      arcs,
      finalState,
      ...(opts.ar && this.source.phaseBias
        ? { ar: this.arSummary(finalPos) }
        : {}),
    };
  }
}

/**
 * Static/kinematic float PPP over a whole session — a thin batch wrapper that
 * drives {@link PppEngine} epoch by epoch. Accepts an Sp3File (wrapped as the
 * default source) or any {@link PppEphemerisSource} (e.g. SSR/HAS-fed).
 */
export function solvePpp(
  epochs: PppEpoch[],
  sp3OrSource: Sp3File | PppEphemerisSource,
  opts: PppOptions
): PppSolution {
  const source: PppEphemerisSource =
    'satState' in sp3OrSource
      ? sp3OrSource
      : new Sp3EphemerisSource(sp3OrSource, opts.clk, opts.osb);
  const eng = new PppEngine(opts, source);
  for (const epoch of epochs) eng.process(epoch);
  return eng.solution();
}
