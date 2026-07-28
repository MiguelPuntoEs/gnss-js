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
  /** Expose the final EKF state (position + ambiguities + covariance) in the
   * solution for ambiguity-resolved positioning. Default false. */
  exposeState?: boolean;
  /** High-rate precise satellite clocks (RINEX CLOCK, typically 30 s). When
   * given, satellite clock offsets come from this by linear interpolation
   * instead of the SP3 5-minute clocks — the dominant PPP accuracy term.
   * Satellites/epochs absent from the CLK fall back to the SP3 clock. */
  clk?: ClkFile;
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
  /** RMS of post-fit phase residuals this epoch (m). */
  phaseResRms: number;
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

function matVec(P: number[][], h: number[]): number[] {
  const n = P.length;
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const Pi = P[i]!;
    for (let j = 0; j < n; j++) s += Pi[j]! * h[j]!;
    out[i] = s;
  }
  return out;
}

/**
 * Sequential (scalar) EKF measurement update — process one measurement at
 * a time; avoids inverting the innovation matrix and stays numerically
 * stable with a freely-varying receiver clock and many ambiguities.
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
  const Ph = matVec(P, h); // P·hᵀ  (n)
  let hPh = 0;
  for (let i = 0; i < n; i++) hPh += h[i]! * Ph[i]!;
  const s = hPh + r;
  if (s <= 0) return false;
  if (rejectK > 0 && innovation * innovation > rejectK * rejectK * s) {
    return false; // outlier — skip
  }
  // Kalman gain K = P·hᵀ / s
  const K = Ph.map((v) => v / s);
  // State update x += K·innovation
  for (let i = 0; i < n; i++) x[i]! += K[i]! * innovation;
  // Covariance Joseph-free form P = (I − K·h)·P, symmetrised.
  // P_new = P − K·(hᵀP) = P − K·(Ph)ᵀ  (since P symmetric, hᵀP = (P·hᵀ)ᵀ = Ph)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      P[i]![j]! -= K[i]! * Ph[j]!;
    }
  }
  // Force symmetry to curb round-off.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const m = 0.5 * (P[i]![j]! + P[j]![i]!);
      P[i]![j]! = m;
      P[j]![i]! = m;
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
}

/** Default source: SP3 orbits + clocks, with optional high-rate CLK. Velocity
 *  is a central finite difference (±0.5 s); the clock prefers the high-rate CLK
 *  and falls back to the SP3 5-minute clock — matching the original solver. */
export class Sp3EphemerisSource implements PppEphemerisSource {
  constructor(
    private readonly sp3: Sp3File,
    private readonly clk?: ClkFile
  ) {}
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
 */
function satStateAtEmission(
  source: PppEphemerisSource,
  prn: string,
  recvTimeMs: number,
  rcv: [number, number, number]
): { state: SatState; travelS: number } | null {
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
const NBASE = 4; // position(3) + zenith wet delay(1)
// Per-constellation receiver clocks (absorbing the inter-system bias) and
// float ambiguities are appended dynamically after the base states.
const CLK_VAR = 1e10; // white-noise clock variance reset each epoch (σ≈100 km)
const POS_VAR = 60 * 60; // kinematic white-noise position variance (σ = 60 m)

export function solvePpp(
  epochs: PppEpoch[],
  sp3OrSource: Sp3File | PppEphemerisSource,
  opts: PppOptions
): PppSolution {
  // Precise satellite state comes from a source: an SP3/CLK file (the default,
  // wrapped here so existing callers pass an Sp3File unchanged) or any
  // PppEphemerisSource — e.g. an SSR/HAS-fed one for real-time PPP.
  const source: PppEphemerisSource =
    'satState' in sp3OrSource
      ? sp3OrSource
      : new Sp3EphemerisSource(sp3OrSource, opts.clk);
  const elevMask = ((opts.elevationMaskDeg ?? 10) * Math.PI) / 180;
  const codeSigma = opts.codeSigma ?? 3.0;
  const phaseSigma = opts.phaseSigma ?? 0.01;
  const ztdQ = opts.ztdProcessNoise ?? 1e-8;
  const kinematic = opts.mode === 'kinematic';
  const corrections = opts.corrections;

  // State vector and covariance. Position is estimated absolutely (metres).
  const x: number[] = [
    opts.aprioriPos[0],
    opts.aprioriPos[1],
    opts.aprioriPos[2],
    0.1, // zenith wet delay (m) a priori
  ];
  const P: number[][] = [];
  for (let i = 0; i < NBASE; i++) {
    P.push(new Array<number>(NBASE).fill(0));
  }
  P[IDX_X]![IDX_X] = 100 * 100; // 100 m a priori position σ
  P[IDX_Y]![IDX_Y] = 100 * 100;
  P[IDX_Z]![IDX_Z] = 100 * 100;
  P[IDX_ZWD]![IDX_ZWD] = 0.5 * 0.5;

  // Per-constellation receiver clock state indices, and float ambiguities.
  const clkIdx = new Map<string, number>();
  const clockSeeded = new Set<string>();
  const ambIdx = new Map<string, number>();
  const lastSeen = new Map<string, number>();

  // Per-arc float-ambiguity collector for PPP-AR. Snapshotted each epoch a
  // satellite is used and flushed to `arcs` when the arc ends (slip, drop, or
  // end of run) so the recorded aIF is the arc's converged value.
  const arcs: PppArc[] = [];
  const arcSnap = new Map<
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
  >();
  const flushArc = (prn: string, minEpochs = 10) => {
    const s = arcSnap.get(prn);
    arcSnap.delete(prn);
    if (!s || s.nEpochs < minEpochs) return;
    arcs.push({
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
  };
  // Melbourne–Wübbena running mean per satellite for cycle-slip detection
  // (ionosphere-free + geometry-free, so it does not drift with the
  // ionosphere — unlike a geometry-free test, which is unusable at
  // equatorial stations).
  const mwState = new Map<
    string,
    { mean: number; n: number; lastEi: number }
  >();

  /** Detect a cycle slip via the Melbourne–Wübbena wide-lane ambiguity. */
  const detectSlip = (o: PppSatObs, ei: number): boolean => {
    const lamW = C_LIGHT / (o.f1 - o.f2);
    const lw = o.l1 - o.l2; // wide-lane phase (cycles)
    const pn = (o.f1 * o.c1 + o.f2 * o.c2) / (o.f1 + o.f2); // narrow-lane code (m)
    const mw = lw - pn / lamW; // wide-lane ambiguity (cycles)
    const st = mwState.get(o.prn);
    let slip = o.slip;
    if (!st || ei - st.lastEi > 2)
      slip = true; // new arc / gap
    else if (Math.abs(mw - st.mean) > 4) slip = true; // > 4 WL cycles jump
    if (slip) mwState.set(o.prn, { mean: mw, n: 1, lastEi: ei });
    else {
      const n = st!.n + 1;
      mwState.set(o.prn, {
        mean: st!.mean + (mw - st!.mean) / Math.min(n, 100),
        n,
        lastEi: ei,
      });
    }
    return slip;
  };

  const growState = (initVal: number, initVar: number): number => {
    const idx = x.length;
    x.push(initVal);
    for (const row of P) row.push(0);
    P.push(new Array<number>(x.length).fill(0));
    P[idx]![idx] = initVar;
    return idx;
  };

  const dropState = (idx: number) => {
    x.splice(idx, 1);
    P.splice(idx, 1);
    for (const row of P) row.splice(idx, 1);
    // Reindex ambiguities AND clocks above the dropped slot.
    for (const [prn, i] of ambIdx) {
      if (i === idx) ambIdx.delete(prn);
      else if (i > idx) ambIdx.set(prn, i - 1);
    }
    for (const [sys, i] of clkIdx) {
      if (i > idx) clkIdx.set(sys, i - 1);
    }
  };

  /** State index of a constellation's receiver clock, creating it lazily. */
  const clockOf = (sys: string): number => {
    let i = clkIdx.get(sys);
    if (i === undefined) {
      i = growState(0, CLK_VAR);
      clkIdx.set(sys, i);
    }
    return i;
  };
  const series: PppEpochResult[] = [];
  const truth = opts.groundTruth;
  const t0 = epochs[0]?.timeMs ?? 0;
  let convergenceSec: number | null = null;
  let convergedStreak = 0;

  for (let ei = 0; ei < epochs.length; ei++) {
    const epoch = epochs[ei]!;

    // ── Time update ──
    // Position: static holds it constant (no process noise). Kinematic treats
    // it as white noise (RTKLIB PMODE_PPP_KINEMA) — after the first epoch,
    // decorrelate the position states and reset their variance so the rover is
    // re-estimated from this epoch's measurements; epoch-to-epoch continuity
    // still lives in the persisting carrier-ambiguity states.
    if (kinematic && ei > 0) {
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

    const rcv: [number, number, number] = [x[IDX_X]!, x[IDX_Y]!, x[IDX_Z]!];
    const [latDeg, , heightM] = ecefToGeodetic(rcv[0], rcv[1], rcv[2]);
    const latRad = (latDeg * Math.PI) / 180;

    // Sun/Moon-dependent corrections computed once per epoch.
    const epochCtx = corrections?.epochContext?.(epoch.timeMs, rcv) ?? null;

    // ── Pass 1: geometry, iono-free obs, tropo, corrections per satellite ──
    interface Vis {
      prn: string;
      e: [number, number, number]; // LOS unit rcv→sat
      elRad: number;
      pIf: number;
      lIf: number;
      satClkM: number;
      range: number;
      tropoFixed: number; // zhd·mh (+ range corrections)
      mw: number;
      windupM: number;
      slip: boolean;
      f1: number;
      f2: number;
    }
    const vis: Vis[] = [];
    // Zenith hydrostatic delay is station-level (same for every satellite this
    // epoch); capture it so ZTD = ZHD + ZWD can be reported.
    let epochZhd = 0;
    for (const o of epoch.obs) {
      if (o.c1 === 0 || o.c2 === 0 || o.l1 === 0 || o.l2 === 0) continue;
      const slip = detectSlip(o, ei);
      const sat = satStateAtEmission(source, o.prn, epoch.timeMs, rcv);
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
          ? niellMapping(elRad, latRad, heightM, epoch.timeMs)
          : { zhd: 0, mh: 0, mw: 0 };
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
        pIf,
        lIf,
        satClkM: sat.state.clkM,
        range,
        tropoFixed: zhd * mh + corr.rangeM,
        mw,
        windupM: corr.phaseWindupM,
        slip,
        f1: o.f1,
        f2: o.f2,
      });
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
    const zwd0 = x[IDX_ZWD]!;
    // Seed each constellation's clock from its own median code residual on
    // first sighting (a different receiver hardware delay per system — the
    // inter-system bias — so they must not share a clock), and keep its
    // variance reset for free white-noise re-estimation this epoch.
    const bySys = new Map<string, number[]>();
    for (const v of vis) {
      const sys = v.prn[0]!;
      const r = v.pIf - (v.range - v.satClkM + v.tropoFixed + zwd0 * v.mw);
      const arr = bySys.get(sys);
      if (arr) arr.push(r);
      else bySys.set(sys, [r]);
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
    for (const v of vis) {
      const ci = clockOf(v.prn[0]!);
      const common = v.range + x[ci]! - v.satClkM + v.tropoFixed + zwd0 * v.mw;

      // A flagged/detected slip ends the current arc before re-init.
      if (v.slip) flushArc(v.prn);

      // Ambiguity state — create/reset on first sight or cycle slip.
      let ai = ambIdx.get(v.prn);
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

      const n = x.length;
      const sinEl = Math.max(Math.sin(v.elRad), 0.1);
      const rCode = (codeSigma / sinEl) ** 2;
      const rPhase = (phaseSigma / sinEl) ** 2;

      // Code update (with gross-outlier gate).
      {
        const h = new Array<number>(n).fill(0);
        h[IDX_X] = -v.e[0];
        h[IDX_Y] = -v.e[1];
        h[IDX_Z] = -v.e[2];
        h[ci] = 1;
        h[IDX_ZWD] = v.mw;
        const innov = v.pIf - common;
        // Loose absolute bound (clock jumps up to ~ms); the S-based reject
        // gate (rejectK) does the real outlier screening once the clock is
        // pinned.
        if (Math.abs(innov) < 1e6) ekfUpdateScalar(x, P, h, innov, rCode, 4);
      }
      // Phase update (recompute the common term after the code update moved
      // the state), including the ambiguity partial.
      {
        const commonPh =
          v.range + x[ci]! - v.satClkM + v.tropoFixed + x[IDX_ZWD]! * v.mw;
        const innov = v.lIf - (commonPh + v.windupM + x[ai]!);
        // A large phase innovation on a converged filter is an undetected
        // cycle slip → re-initialise this ambiguity rather than corrupt the
        // state; small innovations get a normal (gated) update.
        if (Math.abs(innov) > 0.15) {
          flushArc(v.prn); // undetected slip → close the arc, re-initialise
          x[ai] = v.lIf - (commonPh + v.windupM);
          for (let j = 0; j < P.length; j++) {
            P[ai]![j] = 0;
            P[j]![ai] = 0;
          }
          P[ai]![ai] = 100 * 100;
        } else {
          const h = new Array<number>(n).fill(0);
          h[IDX_X] = -v.e[0];
          h[IDX_Y] = -v.e[1];
          h[IDX_Z] = -v.e[2];
          h[ci] = 1;
          h[IDX_ZWD] = v.mw;
          h[ai] = 1;
          ekfUpdateScalar(x, P, h, innov, rPhase, 4);
        }
      }

      // Snapshot the (converged) arc state for PPP-AR.
      {
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
      }

      lastSeen.set(v.prn, ei);
      nSats++;
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
          v.range + x[ci]! - v.satClkM + v.tropoFixed + x[IDX_ZWD]! * v.mw;
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

    // Drop ambiguities of satellites unseen for > 20 epochs.
    for (const [prn, seen] of [...lastSeen]) {
      if (ei - seen > 20) {
        const idx = ambIdx.get(prn);
        if (idx !== undefined) dropState(idx);
        lastSeen.delete(prn);
        flushArc(prn); // the arc ended when the satellite set
      }
    }

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
        convergedStreak++;
        if (convergedStreak >= 10 && convergenceSec == null) {
          convergenceSec = (epoch.timeMs - t0) / 1000;
        }
      } else {
        convergedStreak = 0;
        convergenceSec = null;
      }
    }

    series.push({
      timeMs: epoch.timeMs,
      enu,
      error3d,
      position: pos,
      nSats,
      ztdWet: x[IDX_ZWD]!,
      ztdHydrostatic: epochZhd,
      phaseResRms: nPhaseRes > 0 ? Math.sqrt(sumPhaseResSq / nPhaseRes) : 0,
    });
  }

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

  const finalPos: [number, number, number] = [x[IDX_X]!, x[IDX_Y]!, x[IDX_Z]!];
  const llh = ecefToGeodetic(finalPos[0], finalPos[1], finalPos[2]);
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
    epochsUsed: epochs.length,
    convergenceSec,
    finalError3d,
    arcs,
    finalState,
  };
}
