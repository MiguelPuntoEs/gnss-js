import {
  WGS84_SEMI_MAJOR_AXIS,
  WGS84_ECCENTRICITY_SQUARED,
} from '../constants/wgs84';

/**
 * Clamp value to [-1, 1] to prevent NaN from asin/acos rounding errors.
 * @param x Value to clamp
 * @returns Clamped value in [-1, 1]
 */
export function clampUnit(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}

/**
 * Convert geodetic coordinates to ECEF (Earth-Centered, Earth-Fixed).
 * @param lat Latitude in radians
 * @param lon Longitude in radians
 * @param h Ellipsoidal height in meters
 * @returns [X, Y, Z] in meters
 */
export function geodeticToEcef(
  lat: number,
  lon: number,
  h: number
): [number, number, number] {
  const N =
    WGS84_SEMI_MAJOR_AXIS /
    Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED * Math.sin(lat) ** 2);

  const x = (N + h) * Math.cos(lat) * Math.cos(lon);
  const y = (N + h) * Math.cos(lat) * Math.sin(lon);
  const z = ((1 - WGS84_ECCENTRICITY_SQUARED) * N + h) * Math.sin(lat);

  return [x, y, z];
}

/**
 * Convert ECEF coordinates to geodetic (iterative Bowring method).
 * @param x X in meters
 * @param y Y in meters
 * @param z Z in meters
 * @returns [lat (rad), lon (rad), height (m)]
 */
export function ecefToGeodetic(
  x: number,
  y: number,
  z: number
): [number, number, number] {
  const lon = Math.atan2(y, x);
  const p = Math.sqrt(x * x + y * y);

  // Near-polar singularity: p ≈ 0 causes division issues in the standard iteration
  if (p < 1e-10) {
    const b = WGS84_SEMI_MAJOR_AXIS * Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED);
    const lat = z >= 0 ? Math.PI / 2 : -Math.PI / 2;
    const alt = Math.abs(z) - b;
    return [lat, lon, alt];
  }

  // Iterative Bowring method
  let lat = Math.atan2(z, p * (1 - WGS84_ECCENTRICITY_SQUARED));
  let N: number;
  for (let i = 0; i < 10; i++) {
    const sinLat = Math.sin(lat);
    N =
      WGS84_SEMI_MAJOR_AXIS /
      Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED * sinLat * sinLat);
    const prevLat = lat;
    lat = Math.atan2(z + WGS84_ECCENTRICITY_SQUARED * N * sinLat, p);
    if (Math.abs(lat - prevLat) < 1e-15) break;
  }
  const sinLat = Math.sin(lat);
  N =
    WGS84_SEMI_MAJOR_AXIS /
    Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED * sinLat * sinLat);
  const alt = p / Math.cos(lat) - N;

  return [lat, lon, alt];
}

/**
 * Compute ENU (East, North, Up) difference between a point and a reference in ECEF.
 * @param x Target X in meters (ECEF)
 * @param y Target Y in meters (ECEF)
 * @param z Target Z in meters (ECEF)
 * @param xRef Reference X in meters (ECEF)
 * @param yRef Reference Y in meters (ECEF)
 * @param zRef Reference Z in meters (ECEF)
 * @returns [deltaE, deltaN, deltaU] in meters
 */
export function getEnuDifference(
  x: number,
  y: number,
  z: number,
  xRef: number,
  yRef: number,
  zRef: number
): [number, number, number] {
  const [latRef, lonRef] = ecefToGeodetic(xRef, yRef, zRef);

  const deltaX = x - xRef;
  const deltaY = y - yRef;
  const deltaZ = z - zRef;

  const deltaE = -Math.sin(lonRef) * deltaX + Math.cos(lonRef) * deltaY;
  const deltaN =
    -Math.cos(lonRef) * Math.sin(latRef) * deltaX -
    Math.sin(lonRef) * Math.sin(latRef) * deltaY +
    Math.cos(latRef) * deltaZ;
  const deltaU =
    Math.cos(lonRef) * Math.cos(latRef) * deltaX +
    Math.sin(lonRef) * Math.cos(latRef) * deltaY +
    Math.sin(latRef) * deltaZ;

  return [deltaE, deltaN, deltaU];
}

/**
 * Compute Azimuth, Elevation, and Range from a reference point to a target in ECEF.
 * @returns [elevation (rad), azimuth (rad), slant range (m)]
 */
export function getAer(
  x: number,
  y: number,
  z: number,
  xRef: number,
  yRef: number,
  zRef: number
): [number, number, number] {
  const slant = Math.sqrt((x - xRef) ** 2 + (y - yRef) ** 2 + (z - zRef) ** 2);

  if (!slant) return [0, 0, 0];

  const [deltaE, deltaN, deltaU] = getEnuDifference(x, y, z, xRef, yRef, zRef);

  const elevation = Math.asin(clampUnit(deltaU / slant));
  const azimuth = Math.atan2(deltaE, deltaN);

  return [elevation, azimuth, slant];
}
