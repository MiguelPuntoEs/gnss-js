import {
  WGS84_SEMI_MAJOR_AXIS,
  WGS84_FLATTENING,
  WGS84_ECCENTRICITY_SQUARED,
} from '../constants/wgs84';
import { geodesicDirect, geodesicInverse } from './karney';

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;

/**
 * Geodesic (orthodromic) distance, initial bearing and final bearing on
 * the WGS84 ellipsoid between two points. All angles in radians.
 *
 * Solved with Karney's algorithm (see ./karney), accurate to ~15 nm
 * everywhere — nearly antipodal points included, where Vincenty's
 * iteration (used up to 2.31) failed by up to tens of kilometres. The
 * name is kept for compatibility.
 * @returns { distance (m), initialBearing (rad), finalBearing (rad),
 *   converged } — `converged` is always true now; kept for compatibility.
 */
export function vincenty(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): {
  distance: number;
  initialBearing: number;
  finalBearing: number;
  converged: boolean;
} {
  const g = geodesicInverse(lat1 * R2D, lon1 * R2D, lat2 * R2D, lon2 * R2D);
  return {
    distance: g.s12,
    initialBearing: g.azi1 * D2R,
    finalBearing: g.azi2 * D2R,
    converged: true,
  };
}

/**
 * Direct geodesic problem — the point reached from (lat1, lon1) after
 * `distance` metres along the geodesic leaving at `bearing` (radians,
 * clockwise from north) on the WGS84 ellipsoid. Solved with Karney's
 * algorithm (see ./karney); the name is kept for compatibility.
 * @returns [lat, lon] in radians, lon wrapped to (-π, π]
 */
export function vincentyDirect(
  lat1: number,
  lon1: number,
  bearing: number,
  distance: number
): [number, number] {
  const d = geodesicDirect(lat1 * R2D, lon1 * R2D, bearing * R2D, distance);
  return [d.lat2 * D2R, d.lon2 * D2R];
}

/**
 * Meridian arc length from the equator to geodetic latitude `lat` (radians)
 * on WGS84, via the rectifying latitude (Helmert series in n, sub-mm).
 */
export function meridianArc(lat: number): number {
  const n = WGS84_FLATTENING / (2 - WGS84_FLATTENING);
  const n2 = n * n,
    n3 = n2 * n,
    n4 = n3 * n;
  const mu =
    lat +
    ((-3 * n) / 2 + (9 * n3) / 16) * Math.sin(2 * lat) +
    ((15 * n2) / 16 - (15 * n4) / 32) * Math.sin(4 * lat) +
    ((-35 * n3) / 48) * Math.sin(6 * lat) +
    ((315 * n4) / 512) * Math.sin(8 * lat);
  return (WGS84_SEMI_MAJOR_AXIS / (1 + n)) * (1 + n2 / 4 + n4 / 64) * mu;
}

/**
 * Loxodromic (rhumb line) distance and constant bearing on the WGS84 ellipsoid.
 * Uses the ellipsoidal rhumb-line formula with isometric latitudes.
 * All angles in radians.
 * @param lat1 Start latitude (rad)
 * @param lon1 Start longitude (rad)
 * @param lat2 End latitude (rad)
 * @param lon2 End longitude (rad)
 * @returns {distance: meters, bearing: radians}
 */
export function rhumbLine(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): { distance: number; bearing: number } {
  let dLon = lon2 - lon1;

  // Isometric latitude on the ellipsoid (clamped to avoid log(0)/log(∞) at poles)
  const MAX_LAT = Math.PI / 2 - 1e-10;
  const isometricLat = (lat: number) => {
    const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
    const sinLat = Math.sin(clampedLat);
    const e = Math.sqrt(WGS84_ECCENTRICITY_SQUARED);
    return Math.log(
      Math.tan(Math.PI / 4 + clampedLat / 2) *
        ((1 - e * sinLat) / (1 + e * sinLat)) ** (e / 2)
    );
  };

  const psi1 = isometricLat(lat1);
  const psi2 = isometricLat(lat2);
  const dPsi = psi2 - psi1;

  // Wrap longitude difference to [-PI, PI]
  if (Math.abs(dLon) > Math.PI) {
    dLon = dLon > 0 ? -(2 * Math.PI - dLon) : 2 * Math.PI + dLon;
  }

  const bearing = Math.atan2(dLon, dPsi);

  // Exact on the ellipsoid: s = sqrt(ΔM² + (q·Δλ)²) with q = ΔM/Δψ (the
  // meridian arc per unit isometric latitude). For a near E–W line the
  // ratio of two tiny differences loses precision, so use its limit
  // dM/dψ = N·cosφ (the parallel's radius) at the mid-latitude; below
  // |Δψ| = 1e-6 (~6 m of latitude) the two agree to < 1e-9 relative.
  const dM = meridianArc(lat2) - meridianArc(lat1);
  let q: number;
  if (Math.abs(dPsi) > 1e-6) {
    q = dM / dPsi;
  } else {
    const latM = (lat1 + lat2) / 2;
    q =
      (WGS84_SEMI_MAJOR_AXIS * Math.cos(latM)) /
      Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED * Math.sin(latM) ** 2);
  }
  const distance = Math.sqrt(dM ** 2 + (q * dLon) ** 2);

  return { distance, bearing };
}

/**
 * 3D Euclidean (straight-line, through-the-earth) distance between two ECEF positions.
 * @returns Distance in meters
 */
export function euclidean3D(
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number
): number {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2 + (z2 - z1) ** 2);
}

/**
 * Midpoint of the geodesic (shortest path on the WGS84 ellipsoid) between
 * two points: half the Vincenty distance along the initial bearing.
 * @returns [lat, lon] in radians
 */
export function greatCircleMidpoint(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): [number, number] {
  const { distance, initialBearing } = vincenty(lat1, lon1, lat2, lon2);
  if (distance === 0) return [lat1, lon1];
  return vincentyDirect(lat1, lon1, initialBearing, distance / 2);
}

/**
 * Geometric horizon distance from a given height above the ellipsoid.
 * Uses the simple geometric formula with refraction coefficient k = 0.13 (standard atmosphere).
 * @param heightMeters Height above ellipsoid in meters
 * @returns Distance in meters
 */
export function horizonDistance(heightMeters: number): number {
  if (heightMeters <= 0) return 0;
  const k = 0.13; // standard atmospheric refraction coefficient
  const R = WGS84_SEMI_MAJOR_AXIS;
  // Effective Earth radius accounting for refraction
  const Re = R / (1 - k);
  return Math.sqrt(2 * Re * heightMeters + heightMeters ** 2);
}
