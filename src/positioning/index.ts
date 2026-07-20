/**
 * Single-point positioning (SPP) from pseudoranges and broadcast
 * ephemerides.
 *
 * Weighted iterative least squares with one receiver-clock unknown per
 * constellation (absorbing inter-system time offsets), satellite clock
 * polynomial + relativistic correction, broadcast group delay
 * (TGD/BGD), Sagnac (Earth-rotation) correction, elevation
 * masking/weighting, and a simple tropospheric model. Ionospheric delay is NOT modelled — use the iono-free
 * combination (ionoFree helper) with dual-frequency pseudoranges for
 * metre-level results, or expect ~2–10 m of iono bias on L1-only.
 */

import type { Ephemeris, KeplerEphemeris } from '../rinex/nav';
import { computeSatPosition, computeDop, ecefToAzEl } from '../orbit';
import type { DopValues } from '../orbit';
import { C_LIGHT } from '../constants/gnss';

/* ================================================================== */
/*  Types                                                              */
/* ================================================================== */

export interface SppOptions {
  /** Elevation mask in degrees (applied after the first pass). Default 10. */
  elevationMaskDeg?: number;
  /** Apply the simple tropospheric model. Default true. */
  troposphere?: boolean;
  /** Maximum Gauss-Newton iterations. Default 15. */
  maxIterations?: number;
  /** Convergence threshold on the position update (m). Default 1e-4. */
  convergenceM?: number;
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

/** Simple tropospheric zenith-delay model mapped by elevation (m). */
function tropoDelay(elevationRad: number): number {
  const sinEl = Math.sin(elevationRad);
  return 2.47 / (sinEl + 0.0121);
}

/** Rotate an ECEF position by the Earth rotation during signal travel. */
function sagnac(
  pos: { x: number; y: number; z: number },
  travelTimeS: number
): [number, number, number] {
  const OMEGA_E = 7.2921151467e-5;
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
  } = opts;

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
        let weight = 1;
        const positionSane = x * x + y * y + z * z > 1e12; // > 1000 km
        if (positionSane) {
          const azel = ecefToAzEl(x, y, z, sx, sy, sz);
          elev = azel.el;
          if (iter >= 2 && elev < (elevationMaskDeg * Math.PI) / 180) continue;
          const sinEl = Math.max(Math.sin(elev), 0.1);
          weight = sinEl * sinEl;
        }

        const tropo = troposphere && positionSane ? tropoDelay(elev) : 0;
        const predicted = rho + clk - C_LIGHT * dts + tropo;
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
