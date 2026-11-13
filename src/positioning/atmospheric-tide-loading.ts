/**
 * S1/S2 atmospheric pressure tide loading (IERS Conventions 2010, 7.1.3):
 * the diurnal and semidiurnal air-pressure tides of Ray & Ponte (2003)
 * load the crust — up to ~1.5 mm vertically in the tropics (S2), a few
 * tenths of a mm in Europe; horizontals ~10× smaller. The station
 * displacement is, per component (eq. 19),
 *   d = A1 cos(ω1 T) + B1 sin(ω1 T) + A2 cos(ω2 T) + B2 sin(ω2 T),
 * T = UT1 in days, ω1 = 1 and ω2 = 2 cycles/day (UTC stands in for UT1).
 *
 * Coefficients come from a gridded convolution such as the VMF Data Server
 * (TU Wien) `s1_s2_s3_cm_noib_grid.dat` (CM frame, no inverted barometer;
 * CC BY 4.0, based on ECMWF data): see {@link parseAtmTideGrid}. S3 (from
 * the same file) is carried too; it is ≤ 0.05 mm.
 */
import { getGpsLeap } from '../time/utc';

/** Cos/sin amplitudes (m) of one tide, [Up, East, North]. */
export interface AtmTideHarmonic {
  cos: [number, number, number];
  sin: [number, number, number];
}

/** One station's coefficients: S1, S2 (and optionally S3). */
export interface AtmTideCoefficients {
  s1: AtmTideHarmonic;
  s2: AtmTideHarmonic;
  s3?: AtmTideHarmonic;
}

/** Displacement [East, North, Up] (m) at a GPS-scale instant. */
export function atmosphericTideEnu(
  c: AtmTideCoefficients,
  timeMs: number
): [number, number, number] {
  const utc = timeMs - getGpsLeap(new Date(timeMs)) * 1000;
  const frac = (((utc / 86_400_000) % 1) + 1) % 1; // day fraction (UT1≈UTC)
  const w = 2 * Math.PI * frac;
  const out: [number, number, number] = [0, 0, 0];
  const add = (h: AtmTideHarmonic | undefined, n: number) => {
    if (!h) return;
    const cs = Math.cos(n * w);
    const sn = Math.sin(n * w);
    // h is [U, E, N]; output is [E, N, U].
    out[0] += h.cos[1] * cs + h.sin[1] * sn;
    out[1] += h.cos[2] * cs + h.sin[2] * sn;
    out[2] += h.cos[0] * cs + h.sin[0] * sn;
  };
  add(c.s1, 1);
  add(c.s2, 2);
  add(c.s3, 3);
  return out;
}

/** A regular lat/lon grid of S1/S2/S3 coefficients. */
export interface AtmTideGrid {
  /** Latitude of the first row (deg), step (deg, signed), rows. */
  lat0: number;
  dLat: number;
  nLat: number;
  lon0: number;
  dLon: number;
  nLon: number;
  /** [(i·nLon + j)·18 + k] in mm; k = comp·6 + tide·2 + (cos 0 | sin 1),
   *  comp U E N, tide S1 S2 S3. */
  values: Float32Array;
}

/**
 * Parse the VMF Data Server tidal APL grid (`lat lon` then 18 values in mm:
 * Up, East, North blocks of S1cos S1sin S2cos S2sin S3cos S3sin). The
 * column order was established from the file itself — the vertical block
 * is the one constant across longitude at the poles, and the CM−CE
 * difference (a pure translation) projects onto the second block as East
 * and the third as North.
 */
export function parseAtmTideGrid(text: string): AtmTideGrid {
  const rows: number[][] = [];
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length !== 20) continue;
    const v = f.map(Number);
    if (v.every(Number.isFinite)) rows.push(v);
  }
  if (rows.length < 4) throw new Error('atmospheric tide grid: no data');
  // A global grid, latitude rows north → south, longitudes 0–360°; an
  // excerpt keeps the global indexing and leaves the absent nodes NaN.
  const gap = (xs: number[]) => {
    const u = [...new Set(xs)].sort((a, b) => a - b);
    let g = Infinity;
    for (let i = 1; i < u.length; i++) g = Math.min(g, u[i]! - u[i - 1]!);
    return Number.isFinite(g) ? g : 1;
  };
  const step = gap(rows.map((r) => r[0]!));
  const dLon = gap(rows.map((r) => r[1]!));
  const maxLat = Math.max(...rows.map((r) => r[0]!));
  const lat0 = 90 - ((((90 - maxLat) % step) + step) % step);
  const dLat = -step;
  const nLat = Math.floor((lat0 + 90) / step + 1e-9) + 1;
  const lon0 = ((rows[0]![1]! % dLon) + dLon) % dLon;
  const nLon = Math.round(360 / dLon);
  const values = new Float32Array(nLat * nLon * 18).fill(NaN);
  for (const r of rows) {
    const i = Math.round((r[0]! - lat0) / dLat);
    const j = ((Math.round((r[1]! - lon0) / dLon) % nLon) + nLon) % nLon;
    if (i < 0 || i >= nLat) continue;
    for (let k = 0; k < 18; k++) values[(i * nLon + j) * 18 + k] = r[2 + k]!;
  }
  return { lat0, dLat, nLat, lon0, dLon, nLon, values };
}

/** Bilinear interpolation of the grid → coefficients (m) at a point (deg). */
export function atmTideAt(
  g: AtmTideGrid,
  latDeg: number,
  lonDeg: number
): AtmTideCoefficients {
  const fi = Math.max(0, Math.min(g.nLat - 1, (latDeg - g.lat0) / g.dLat));
  let fj = (lonDeg - g.lon0) / g.dLon;
  fj = ((fj % g.nLon) + g.nLon) % g.nLon;
  const i0 = Math.min(g.nLat - 2, Math.floor(fi));
  const j0 = Math.floor(fj);
  const j1 = (j0 + 1) % g.nLon;
  const di = fi - i0;
  const dj = fj - j0;
  const v = (i: number, j: number, k: number) =>
    g.values[(i * g.nLon + j) * 18 + k]!;
  const at = (k: number) =>
    1e-3 *
    ((1 - di) * ((1 - dj) * v(i0, j0, k) + dj * v(i0, j1, k)) +
      di * ((1 - dj) * v(i0 + 1, j0, k) + dj * v(i0 + 1, j1, k)));
  const harm = (tide: number): AtmTideHarmonic => ({
    cos: [at(tide * 2), at(6 + tide * 2), at(12 + tide * 2)],
    sin: [at(tide * 2 + 1), at(6 + tide * 2 + 1), at(12 + tide * 2 + 1)],
  });
  return { s1: harm(0), s2: harm(1), s3: harm(2) };
}
