/**
 * Single-point positioning (SPP) from pseudoranges and broadcast
 * ephemerides.
 *
 * Weighted iterative least squares with one receiver-clock unknown per
 * constellation (absorbing inter-system time offsets), satellite clock
 * polynomial + relativistic correction, broadcast group delay
 * (TGD/BGD), Sagnac (Earth-rotation) correction, elevation
 * masking/weighting, and a Saastamoinen tropospheric model. Ionospheric
 * delay can be modelled from the broadcast Klobuchar coefficients
 * (`iono` option) for single-frequency measurements; for metre-level
 * results prefer the iono-free combination (ionoFree helper) with
 * dual-frequency pseudoranges.
 */

import type { Ephemeris, KeplerEphemeris } from '../rinex/nav';
import { computeSatPosition, computeDop, ecefToAzEl } from '../orbit';
import type { DopValues } from '../orbit';
import { C_LIGHT, OMEGA_E } from '../constants/gnss';
import { ecefToGeodetic } from '../coordinates/ecef';
import { klobucharDelay } from './klobuchar';
import type { KlobucharCoeffs } from './klobuchar';
import { gimSlantIonoDelayL1 } from './gim';
import type { IonexGrid } from '../rinex/ionex';

export { klobucharDelay } from './klobuchar';
export type { KlobucharCoeffs } from './klobuchar';
export { gimSlantIonoDelayL1, gimVerticalTec, IONO_L1_M_PER_TECU } from './gim';

/* ================================================================== */
/*  Types                                                              */
/* ================================================================== */

export interface SppOptions {
  /** Elevation mask in degrees (applied after the first pass). Default 10. */
  elevationMaskDeg?: number;
  /** Apply the Saastamoinen tropospheric model. Default true. */
  troposphere?: boolean;
  /** Maximum Gauss-Newton iterations. Default 15. */
  maxIterations?: number;
  /** Convergence threshold on the position update (m). Default 1e-4. */
  convergenceM?: number;
  /**
   * Broadcast Klobuchar coefficients (RINEX nav header GPSA/GPSB —
   * `NavResult.header.ionoCorrections`). When given, the modelled
   * slant delay is removed from every single-frequency pseudorange,
   * scaled to each system's primary frequency. Omit when feeding
   * iono-free combinations.
   */
  iono?: KlobucharCoeffs;
  /**
   * Global Ionosphere Map (IONEX/GIM, from `parseIonex`). When given it
   * takes precedence over `iono`: the slant delay is read from the map
   * (~80–90% of the true ionosphere vs Klobuchar's ~50%), falling back
   * to `iono` — if also supplied — only where the map has no value for
   * an epoch/cell (a time gap; global maps always cover space). Omit for
   * iono-free input.
   */
  gim?: IonexGrid;
  /**
   * Apply the broadcast group-delay correction (GPS TGD, Galileo
   * BGD E5a/E1, BeiDou TGD1) to the satellite clock. Correct for
   * single-frequency measurements on the primary frequency (C1C/E1/B1I)
   * — the default. Disable when feeding iono-free combinations, whose
   * reference the broadcast clock already matches. Default true.
   */
  tgd?: boolean;
}

export interface SppSolution {
  /** Receiver position, ECEF meters. */
  position: [number, number, number];
  /** Receiver clock bias per constellation (meters). */
  clockBias: Record<string, number>;
  /** PRNs used in the final solution. */
  usedSatellites: string[];
  /** PRNs rejected as outliers (bad ephemeris/measurement). */
  rejectedSatellites: string[];
  /** Post-fit residuals per PRN (m). */
  residuals: Record<string, number>;
  /** Dilution of precision at the solution. */
  dop: DopValues | null;
  iterations: number;
  converged: boolean;
}

/* ================================================================== */
/*  Helpers                                                            */
/* ================================================================== */

const GM_GPS = 3.986005e14;
const F_REL = -4.442807633e-10; // s/√m — IS-GPS-200 relativistic constant

/**
 * Broadcast satellite clock correction in seconds at time `tMs`
 * (GPS-scale epoch milliseconds), including the relativistic
 * eccentricity term for Keplerian systems.
 */
export function satClockCorrection(eph: Ephemeris, tMs: number): number {
  if (eph.system === 'R' || eph.system === 'S') {
    // Both parse paths already store the clock-bias term (−τ_n) in
    // `tauN`: RINEX keeps the raw SV-clock field (= −τ_n per the spec),
    // and the RTCM path negates raw τ_n to match. So the correction is
    // +tauN + gammaN·dt — using −tauN put GLONASS tens of km out and
    // got every GLONASS satellite rejected by the SPP outlier filter.
    const dt = (tMs - eph.tocDate.getTime()) / 1000;
    return eph.tauN + eph.gammaN * dt;
  }
  const k = eph as KeplerEphemeris;
  const dt = (tMs - k.tocDate.getTime()) / 1000;
  const poly = k.af0 + k.af1 * dt + k.af2 * dt * dt;

  // Relativistic correction needs the eccentric anomaly at t
  const a = k.sqrtA * k.sqrtA;
  const n = Math.sqrt(GM_GPS / (a * a * a)) + k.deltaN;
  const tk = dt; // toc≈toe for broadcast eph; adequate for the E solve
  const Mk = k.m0 + n * tk;
  let Ek = Mk;
  for (let i = 0; i < 8; i++) {
    Ek = Mk + k.e * Math.sin(Ek);
  }
  const rel = F_REL * k.e * k.sqrtA * Math.sin(Ek);
  return poly + rel;
}

/**
 * Ionosphere-free pseudorange combination of two frequencies (Hz).
 * Removes the first-order ionospheric delay.
 */
export function ionoFree(
  p1: number,
  p2: number,
  f1: number,
  f2: number
): number {
  const g = (f1 * f1) / (f1 * f1 - f2 * f2);
  return g * p1 - (g - 1) * p2;
}

const GPS_EPOCH_MS_SPP = Date.UTC(1980, 0, 6);

// Primary single-frequency signal per system, for scaling the L1
// Klobuchar delay by (f_L1/f)². GLONASS uses the nominal G1 centre.
const PRIMARY_FREQ_HZ: Record<string, number> = {
  G: 1575.42e6,
  E: 1575.42e6,
  J: 1575.42e6,
  S: 1575.42e6,
  C: 1561.098e6,
  R: 1602.0e6,
};
const F_L1 = 1575.42e6;

/**
 * Saastamoinen tropospheric delay (m) with a standard atmosphere,
 * mapped by 1/sin(el).
 *
 * Matches RTKLIB's `tropmodel` (relative humidity 0.7) so single-point
 * results stay directly comparable with the rnx2rtkp oracle. Unlike a
 * fixed zenith value, the hydrostatic term is pressure- (i.e. station
 * height-) and latitude-dependent and the wet term is modelled
 * separately — which is what removes the residual vertical bias a
 * constant zenith delay leaves behind.
 */
function tropoDelay(
  elevationRad: number,
  latRad: number,
  heightM: number
): number {
  if (elevationRad <= 0) return 0;
  // Clamp to the model's valid band (sea level … 10 km), as RTKLIB does.
  const h = heightM < 0 ? 0 : heightM > 1e4 ? 1e4 : heightM;
  const humi = 0.7; // relative humidity assumed absent live met data
  const pres = 1013.25 * Math.pow(1 - 2.2557e-5 * h, 5.2568);
  const temp = 15.0 - 6.5e-3 * h + 273.16; // K, 15 °C at sea level
  const e = 6.108 * humi * Math.exp((17.15 * temp - 4684.0) / (temp - 38.45));
  const zhd =
    (0.0022768 * pres) /
    (1 - 0.00266 * Math.cos(2 * latRad) - 0.00028 * (h / 1e3));
  const zwd = 0.002277 * (1255.0 / temp + 0.05) * e;
  return (zhd + zwd) / Math.sin(elevationRad);
}

/** Rotate an ECEF position by the Earth rotation during signal travel. */
function sagnac(
  pos: { x: number; y: number; z: number },
  travelTimeS: number
): [number, number, number] {
  const theta = OMEGA_E * travelTimeS;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [pos.x * c + pos.y * s, -pos.x * s + pos.y * c, pos.z];
}

/** Solve the normal equations A·x = b by Gaussian elimination. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(M[pivot]![col]!) < 1e-12) return null; // singular
    [M[col], M[pivot]] = [M[pivot]!, M[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / M[col]![col]!;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  return M.map((row, i) => row[n]! / M[i]![i]!);
}

/* ================================================================== */
/*  Solver                                                             */
/* ================================================================== */

/**
 * Solve receiver position from one epoch of pseudoranges.
 *
 * @param pseudoranges PRN → pseudorange in meters (single frequency, or
 *   an iono-free combination built with `ionoFree`).
 * @param ephemerides PRN → broadcast ephemeris (from `parseNavFile` or
 *   the RTCM decoder via `ephInfoToEphemeris`).
 * @param timeMs Receiver epoch in GPS-scale milliseconds (RINEX epoch
 *   time as produced by the parser).
 */
export function solveSpp(
  pseudoranges: Map<string, number>,
  ephemerides: Map<string, Ephemeris>,
  timeMs: number,
  opts: SppOptions = {}
): SppSolution | null {
  const {
    elevationMaskDeg = 10,
    troposphere = true,
    maxIterations = 15,
    convergenceM = 1e-4,
    tgd = true,
    iono,
    gim,
  } = opts;
  const gpsTow = ((timeMs - GPS_EPOCH_MS_SPP) / 1000) % 604800;

  const all = [...pseudoranges.keys()].filter((p) => ephemerides.has(p));
  const minSats = (list: string[]) => 3 + new Set(list.map((p) => p[0]!)).size;
  if (all.length < minSats(all)) return null;

  interface Inner {
    x: number;
    y: number;
    z: number;
    clock: Map<string, number>;
    residuals: Record<string, number>;
    iterations: number;
    converged: boolean;
  }

  const gaussNewton = (prns: string[]): Inner | null => {
    const systems = [...new Set(prns.map((p) => p[0]!))].sort();
    const dim = 3 + systems.length;
    const sysIndex = new Map(systems.map((s, i) => [s, 3 + i]));
    let x = 0;
    let y = 0;
    let z = 0;
    const clock = new Map<string, number>(systems.map((s) => [s, 0]));
    const residuals: Record<string, number> = {};
    let iterations = 0;
    let converged = false;

    for (let iter = 0; iter < maxIterations; iter++) {
      iterations = iter + 1;
      const HtH: number[][] = Array.from({ length: dim }, () =>
        new Array<number>(dim).fill(0)
      );
      const Htv = new Array<number>(dim).fill(0);
      let rows = 0;
      for (const k of Object.keys(residuals)) delete residuals[k];

      const positionSaneIter = x * x + y * y + z * z > 1e12; // > 1000 km
      const [rxLat, rxLon, rxHgt] = positionSaneIter
        ? ecefToGeodetic(x, y, z)
        : [0, 0, 0];

      for (const prn of prns) {
        const psr = pseudoranges.get(prn)!;
        const eph = ephemerides.get(prn)!;
        const sys = prn[0]!;
        const clk = clock.get(sys)!;

        // Transmission time: receiver epoch minus travel time, further
        // corrected by the satellite clock offset (up to ~1 ms → metres
        // of along-track satellite motion).
        const tTx = timeMs - (psr / C_LIGHT) * 1000;
        const dtsClock = satClockCorrection(eph, tTx);
        const sat = computeSatPosition(eph, tTx - dtsClock * 1000);
        if (!Number.isFinite(sat.x)) continue;
        // Group delay is a measurement (code) bias, not a clock offset:
        // it enters the pseudorange model but not the transmission time.
        const isKepler = eph.system !== 'R' && eph.system !== 'S';
        const dts =
          dtsClock - (tgd && isKepler ? (eph as KeplerEphemeris).tgd : 0);

        const travel = Math.hypot(sat.x - x, sat.y - y, sat.z - z) / C_LIGHT;
        const [sx, sy, sz] = sagnac(sat, travel);

        const rho = Math.hypot(sx - x, sy - y, sz - z);
        const ux = (x - sx) / rho;
        const uy = (y - sy) / rho;
        const uz = (z - sz) / rho;

        let elev = Math.PI / 2;
        let azim = 0;
        let weight = 1;
        const positionSane = positionSaneIter;
        if (positionSane) {
          const azel = ecefToAzEl(x, y, z, sx, sy, sz);
          elev = azel.el;
          azim = azel.az;
          if (iter >= 2 && elev < (elevationMaskDeg * Math.PI) / 180) continue;
          const sinEl = Math.max(Math.sin(elev), 0.1);
          weight = sinEl * sinEl;
        }

        const tropo =
          troposphere && positionSane ? tropoDelay(elev, rxLat, rxHgt) : 0;
        let ionoM = 0;
        if ((gim || iono) && positionSane) {
          // L1 slant delay from the GIM (preferred), else broadcast
          // Klobuchar; the GIM returns null only in a time gap / no-value
          // cell, in which case Klobuchar backfills when supplied.
          let l1M: number | null = null;
          if (gim)
            l1M = gimSlantIonoDelayL1(gim, rxLat, rxLon, azim, elev, timeMs);
          if (l1M === null && iono) {
            l1M =
              C_LIGHT * klobucharDelay(iono, rxLat, rxLon, azim, elev, gpsTow);
          }
          if (l1M !== null) {
            const f = PRIMARY_FREQ_HZ[sys] ?? F_L1;
            ionoM = l1M * ((F_L1 / f) * (F_L1 / f));
          }
        }
        const predicted = rho + clk - C_LIGHT * dts + tropo + ionoM;
        const v = psr - predicted;

        const h = new Array<number>(dim).fill(0);
        h[0] = ux;
        h[1] = uy;
        h[2] = uz;
        h[sysIndex.get(sys)!] = 1;

        for (let i = 0; i < dim; i++) {
          for (let j = 0; j < dim; j++) HtH[i]![j]! += weight * h[i]! * h[j]!;
          Htv[i]! += weight * h[i]! * v;
        }
        residuals[prn] = v;
        rows++;
      }

      if (rows < dim) return null;
      const dx = solveLinear(HtH, Htv);
      if (!dx) return null;

      x += dx[0]!;
      y += dx[1]!;
      z += dx[2]!;
      for (const s of systems)
        clock.set(s, clock.get(s)! + dx[sysIndex.get(s)!]!);

      if (Math.hypot(dx[0]!, dx[1]!, dx[2]!) < convergenceM) {
        converged = true;
        break;
      }
    }
    return { x, y, z, clock, residuals, iterations, converged };
  };

  // Outer robust loop: solve, drop the single worst residual, re-solve.
  // Sequential worst-first rejection stays reliable even when a large
  // fraction of satellites carry unusable broadcast ephemerides (a real
  // occurrence — see the GLONASS RINEX-nav issue), where MAD-style
  // screening breaks down because the solution itself is dragged.
  const REJECT_THRESHOLD_M = 50;
  let candidates = all;
  const rejected: string[] = [];
  let inner: Inner | null = null;
  for (let round = 0; round <= all.length; round++) {
    inner = gaussNewton(candidates);
    if (!inner) return null;
    const vals = Object.entries(inner.residuals);
    let worst: string | null = null;
    let worstAbs = REJECT_THRESHOLD_M;
    for (const [prn, v] of vals) {
      if (Math.abs(v) > worstAbs) {
        worstAbs = Math.abs(v);
        worst = prn;
      }
    }
    if (!worst) break;
    const remaining = candidates.filter((p) => p !== worst);
    if (remaining.length < minSats(remaining)) break;
    rejected.push(worst);
    candidates = remaining;
  }
  if (!inner) return null;

  const { x, y, z, clock, residuals, iterations, converged } = inner;

  // Final DOP + used-satellite list at the solution
  const used: string[] = [];
  const azels: { az: number; el: number }[] = [];
  for (const prn of candidates) {
    if (!(prn in residuals)) continue;
    const eph = ephemerides.get(prn)!;
    const sat = computeSatPosition(eph, timeMs);
    if (!Number.isFinite(sat.x)) continue;
    const azel = ecefToAzEl(x, y, z, sat.x, sat.y, sat.z);
    if (azel.el >= (elevationMaskDeg * Math.PI) / 180) {
      used.push(prn);
      azels.push(azel);
    }
  }

  return {
    position: [x, y, z],
    clockBias: Object.fromEntries(clock),
    usedSatellites: used,
    rejectedSatellites: rejected,
    residuals,
    dop: computeDop(azels),
    iterations,
    converged,
  };
}

export { solveDgnss, RtkFloatEngine, toRtkEpoch } from './rtk';
export type {
  RtkMeasurement,
  RtkEpochMeasurements,
  RawObservation,
  EphemerisSource,
  DgnssOptions,
  DgnssSolution,
  RtkFloatOptions,
  RtkFloatSolution,
} from './rtk';

export { lambdaSearch, lambdaReduction } from './lambda';
export type { LambdaResult } from './lambda';

export { solvePpp } from './ppp';
export type {
  PppSatObs,
  PppEpoch,
  PppOptions,
  PppEpochResult,
  PppSolution,
  PppArc,
} from './ppp';
export { niellMapping } from './ppp-tropo';
export type { TropoMapping } from './ppp-tropo';
export { createPppCorrections } from './ppp-corrections';
export type {
  SatGeom,
  PppEpochContext,
  CorrectionResult,
  PppCorrections,
  PppCorrectionConfig,
} from './ppp-corrections';
export { buildPppAntenna } from './ppp-antenna';
export type { PppAntennaModel, AntennaOffset } from './ppp-antenna';
export { sunEcef, moonEcef, solidEarthTide, gmst } from './ppp-astro';
export { resolvePppAmbiguities, wlWavelength, nlWavelength } from './ppp-ar';
export type { ArSat, ArOptions, ArResult, ArFixedSat } from './ppp-ar';
export {
  estimateWidelaneFcb,
  estimateNarrowlaneFcb,
  extractWidelaneArcs,
} from './ppp-fcb';
export type {
  WlArc,
  WlObs,
  WlFcbOptions,
  WlFcbResult,
  NlArc,
  NlFcbResult,
} from './ppp-fcb';
