/**
 * Slant ionospheric delay from a Global Ionosphere Map (IONEX/GIM).
 *
 * A GIM gives vertical TEC on an hourly lat/lon grid (see
 * {@link parseIonex}). For single-frequency positioning this is a much
 * stronger correction than the broadcast Klobuchar model — GIMs capture
 * ~80–90% of the true ionosphere versus Klobuchar's ~50% — so feeding
 * `solveSpp` a GIM (the `gim` option) collapses most of the residual
 * height bias a single-frequency solution otherwise carries.
 *
 * The evaluation is the standard thin-shell recipe: pierce the shell at
 * {@link H_ION}, interpolate vertical TEC there (bilinear in space,
 * linear in time), map to slant with the obliquity factor, and convert
 * TEC → L1 group delay. The result is the delay on GPS L1; `solveSpp`
 * scales it to each system's primary frequency by (f_L1/f)².
 */

import type { IonexGrid } from '../rinex/ionex';

const R_E = 6371e3;
/** Thin-shell height used by IGS GIMs (m). */
const H_ION = 450e3;
const F_L1 = 1575.42e6;
/**
 * L1 group delay per unit slant TEC: 40.3 · 10¹⁶ / f_L1² (m per TECU).
 * 40.3 m·Hz²/(el/m²), one TECU = 10¹⁶ el/m². ≈ 0.1624 m/TECU.
 */
export const IONO_L1_M_PER_TECU = (40.3e16 / (F_L1 * F_L1)) as number;

/** Bilinear interpolation of one hourly TEC map at (latDeg, lonDeg). */
function tecAtMap(
  grid: IonexGrid,
  mapIdx: number,
  latDeg: number,
  lonDeg: number
): number {
  const m = grid.maps[mapIdx]!;
  const { lats, lons } = grid;
  const w = lons.length;
  const fi =
    ((latDeg - lats[0]!) / (lats[lats.length - 1]! - lats[0]!)) *
    (lats.length - 1);
  const fj = ((lonDeg - lons[0]!) / (lons[w - 1]! - lons[0]!)) * (w - 1);
  const i0 = Math.max(0, Math.min(lats.length - 2, Math.floor(fi)));
  const j0 = Math.max(0, Math.min(w - 2, Math.floor(fj)));
  const di = Math.max(0, Math.min(1, fi - i0));
  const dj = Math.max(0, Math.min(1, fj - j0));
  return (
    m[i0 * w + j0]! * (1 - di) * (1 - dj) +
    m[i0 * w + j0 + 1]! * (1 - di) * dj +
    m[(i0 + 1) * w + j0]! * di * (1 - dj) +
    m[(i0 + 1) * w + j0 + 1]! * di * dj
  );
}

/**
 * Space- and time-interpolated vertical TEC (TECU) at `timeMs`, or null
 * outside the map's time span or where the grid marks no value.
 *
 * IGS GIMs are global, so spatial coverage is total; a pierce point is
 * bilinearly interpolated and clamped to the nearest edge cell rather
 * than rejected. Null therefore signals a time gap or a no-value cell,
 * not an out-of-area position.
 */
export function gimVerticalTec(
  grid: IonexGrid,
  timeMs: number,
  latDeg: number,
  lonDeg: number
): number | null {
  const e = grid.epochs;
  if (e.length === 0 || timeMs < e[0]! || timeMs > e[e.length - 1]!) return null;
  let i = 0;
  while (i < e.length - 2 && e[i + 1]! <= timeMs) i++;
  const span = e[i + 1]! - e[i]!;
  const f = span > 0 ? (timeMs - e[i]!) / span : 0;
  const a = tecAtMap(grid, i, latDeg, lonDeg);
  const b = tecAtMap(grid, i + 1, latDeg, lonDeg);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a * (1 - f) + b * f;
}

/**
 * Slant ionospheric group delay on GPS L1 (m) from a GIM, or null when
 * the pierce point falls outside the map's coverage in space or time.
 *
 * @param grid   Parsed IONEX grid ({@link parseIonex}).
 * @param latRad Receiver geodetic latitude (radians).
 * @param lonRad Receiver geodetic longitude (radians).
 * @param azRad  Satellite azimuth (radians).
 * @param elRad  Satellite elevation (radians).
 * @param timeMs Epoch (ms). GIM epochs are UTC; a GPS-scale time differs
 *   by leap seconds (~18 s), negligible against hourly maps.
 */
export function gimSlantIonoDelayL1(
  grid: IonexGrid,
  latRad: number,
  lonRad: number,
  azRad: number,
  elRad: number,
  timeMs: number
): number | null {
  if (elRad <= 0) return null;
  // Thin-shell pierce point and obliquity (slant) mapping factor.
  const sinZp = (R_E / (R_E + H_ION)) * Math.cos(elRad);
  const mapping = 1 / Math.sqrt(1 - sinZp * sinZp);
  const psi = Math.PI / 2 - elRad - Math.asin(sinZp); // earth-centred angle
  const latI = Math.asin(
    Math.sin(latRad) * Math.cos(psi) +
      Math.cos(latRad) * Math.sin(psi) * Math.cos(azRad)
  );
  const lonI =
    lonRad + Math.asin((Math.sin(psi) * Math.sin(azRad)) / Math.cos(latI));
  const latDeg = (latI * 180) / Math.PI;
  const lonDeg = (((((lonI * 180) / Math.PI + 540) % 360) + 360) % 360) - 180;

  const vtec = gimVerticalTec(grid, timeMs, latDeg, lonDeg);
  if (vtec === null) return null;
  return IONO_L1_M_PER_TECU * vtec * mapping;
}
