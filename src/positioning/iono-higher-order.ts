/**
 * Higher-order ionospheric delay — what the ionosphere-free combination
 * leaves behind (Bassiri & Hajj 1993; Fritsche et al. 2005;
 * Hernández-Pajares et al. 2007, "HP07"). With the refractive index
 * expanded to 1/f⁴, the carrier phase and code on frequency f carry
 *
 *   L = ρ … − q/f² − s/(2f³) − r/(3f⁴)      P = ρ … + q/f² + s/f³ + r/f⁴
 *
 *   q = 40.3 STEC,
 *   s = 7527 c ∫ N B cos θ dl  ≈ 7527 c (B·k̂) STEC   (B at the pierce point),
 *   r = 2437 ∫ N² dl          ≈ 2437 η Nmax STEC     (η = 0.66),
 *
 * θ the angle between the geomagnetic field and the propagation direction
 * k̂ (satellite → receiver); B in tesla, STEC in electrons/m². The first
 * order cancels in the ionosphere-free combination; the second (mm to cm on
 * a single frequency, ≈ 0–5 mm iono-free) and third (≈ 10× smaller) do
 * not. STEC comes from a Global Ionosphere Map (thin shell at 450 km), B
 * from IGRF-14 at the pierce point, Nmax from VTEC by the HP07 linear
 * relation Nmax = (20 − 6)·10¹² / ((4.55 − 1)·10¹⁸) · (VTEC − 4.55·10¹⁸)
 * + 20·10¹² m⁻³.
 *
 * Ray bending (the geometric excess path, 1/f⁴, a few mm on L1 only at low
 * elevation and high TEC; sub-mm iono-free) is not modelled.
 */
import type { IonexGrid } from '../rinex/ionex';
import { gimVerticalTec } from './gim';
import { igrfField } from './igrf';

const C = 299792458;
const R_E = 6371e3;
const H_ION = 450e3;
const TECU = 1e16;
const ETA = 0.66;

/** Second- and third-order coefficients s (m·Hz³), r (m·Hz⁴) for a ray. */
export interface HigherOrderIonoTerms {
  s: number;
  r: number;
  /** Slant TEC used (TECU) and B·k̂ at the pierce point (nT). */
  stecTecu: number;
  bParallelNt: number;
}

/** Pierce point (rad) of the 450 km shell and the slant obliquity. */
function piercePoint(
  latRad: number,
  lonRad: number,
  azRad: number,
  elRad: number
): { lat: number; lon: number; mapping: number } {
  const sinZp = (R_E / (R_E + H_ION)) * Math.cos(elRad);
  const mapping = 1 / Math.sqrt(1 - sinZp * sinZp);
  const psi = Math.PI / 2 - elRad - Math.asin(sinZp);
  const lat = Math.asin(
    Math.sin(latRad) * Math.cos(psi) +
      Math.cos(latRad) * Math.sin(psi) * Math.cos(azRad)
  );
  const lon =
    lonRad + Math.asin((Math.sin(psi) * Math.sin(azRad)) / Math.cos(lat));
  return { lat, lon, mapping };
}

/**
 * HP07 coefficients for one ray from STEC (TECU), the field B (ECEF, nT) at
 * the pierce point, the unit line of sight receiver → satellite and the
 * vertical TEC there (TECU, for Nmax).
 */
export function higherOrderIonoCoefficients(
  stecTecu: number,
  bEcefNt: readonly [number, number, number],
  losRcvToSat: readonly [number, number, number],
  vtecTecu: number
): HigherOrderIonoTerms {
  // Propagation direction k̂ = satellite → receiver = −LOS.
  const bPar = -(
    bEcefNt[0] * losRcvToSat[0] +
    bEcefNt[1] * losRcvToSat[1] +
    bEcefNt[2] * losRcvToSat[2]
  );
  const stec = stecTecu * TECU;
  const s = 7527 * C * bPar * 1e-9 * stec;
  const vtec = vtecTecu * TECU;
  const nMax = Math.max(
    0,
    (((20 - 6) * 1e12) / ((4.55 - 1) * 1e18)) * (vtec - 4.55e18) + 20e12
  );
  const r = 2437 * ETA * nMax * stec;
  return { s, r, stecTecu, bParallelNt: bPar };
}

/**
 * The higher-order terms for one satellite from a GIM + IGRF-14, or null
 * where the map has no value (time gap) or below the horizon.
 */
export function higherOrderIonoFromGim(
  gim: IonexGrid,
  timeMs: number,
  latRad: number,
  lonRad: number,
  azRad: number,
  elRad: number,
  losRcvToSat: readonly [number, number, number]
): HigherOrderIonoTerms | null {
  if (elRad <= 0) return null;
  const ipp = piercePoint(latRad, lonRad, azRad, elRad);
  const latDeg = (ipp.lat * 180) / Math.PI;
  const lonDeg =
    (((((ipp.lon * 180) / Math.PI + 540) % 360) + 360) % 360) - 180;
  const vtec = gimVerticalTec(gim, timeMs, latDeg, lonDeg);
  if (vtec === null) return null;
  const b = igrfField(ipp.lat, ipp.lon, H_ION, timeMs).ecef;
  return higherOrderIonoCoefficients(vtec * ipp.mapping, b, losRcvToSat, vtec);
}

/**
 * Delay (m) the higher-order terms leave in the ionosphere-free code and
 * phase of bands f1, f2 (Hz) — add to the modelled code / phase. With
 * `thirdOrder: false` only the second order.
 */
export function higherOrderIonoIonoFree(
  t: HigherOrderIonoTerms,
  f1: number,
  f2: number,
  thirdOrder = true
): { code: number; phase: number } {
  const r = thirdOrder ? t.r : 0;
  const code = (f: number) => t.s / f ** 3 + r / f ** 4;
  const phase = (f: number) => -t.s / (2 * f ** 3) - r / (3 * f ** 4);
  const a = f1 * f1;
  const b = f2 * f2;
  const comb = (x1: number, x2: number) => (a * x1 - b * x2) / (a - b);
  return {
    code: comb(code(f1), code(f2)),
    phase: comb(phase(f1), phase(f2)),
  };
}
