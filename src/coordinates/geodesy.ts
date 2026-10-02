import {
  WGS84_SEMI_MAJOR_AXIS,
  WGS84_SEMI_MINOR_AXIS,
  WGS84_FLATTENING,
  WGS84_ECCENTRICITY_SQUARED,
} from '../constants/wgs84';

/**
 * Vincenty's inverse formula — orthodromic (great-circle) distance,
 * initial bearing, and final bearing on the WGS84 ellipsoid.
 * All angles in radians.
 * @returns { distance (m), initialBearing (rad), finalBearing (rad),
 *   converged } — `converged` is false for near-antipodal pairs, where the
 *   iteration fails and a spherical approximation is returned instead
 *   (distance good to ~0.5 %, bearings unreliable).
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
  const U1 = Math.atan((1 - WGS84_FLATTENING) * Math.tan(lat1));
  const U2 = Math.atan((1 - WGS84_FLATTENING) * Math.tan(lat2));
  const sinU1 = Math.sin(U1),
    cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2),
    cosU2 = Math.cos(U2);

  let lambda = lon2 - lon1;
  let lambdaPrev: number;
  let sinSigma: number, cosSigma: number, sigma: number;
  let sinAlpha: number, cos2Alpha: number, cos2SigmaM: number;
  let C: number;

  let iter = 0;
  do {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);

    sinSigma = Math.sqrt(
      (cosU2 * sinLambda) ** 2 +
        (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2
    );

    if (sinSigma === 0) {
      return {
        distance: 0,
        initialBearing: 0,
        finalBearing: 0,
        converged: true,
      };
    }

    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);

    sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cos2Alpha = 1 - sinAlpha ** 2;

    cos2SigmaM =
      cos2Alpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cos2Alpha : 0;

    C =
      (WGS84_FLATTENING / 16) *
      cos2Alpha *
      (4 + WGS84_FLATTENING * (4 - 3 * cos2Alpha));
    lambdaPrev = lambda;
    lambda =
      lon2 -
      lon1 +
      (1 - C) *
        WGS84_FLATTENING *
        sinAlpha *
        (sigma +
          C *
            sinSigma *
            (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
  } while (Math.abs(lambda - lambdaPrev) > 1e-12 && ++iter < 200);

  if (iter >= 200) {
    // Antipodal or near-antipodal: Vincenty fails to converge.
    // Fall back to spherical great-circle approximation.
    const cosLat1 = Math.cos(lat1),
      sinLat1 = Math.sin(lat1);
    const cosLat2 = Math.cos(lat2),
      sinLat2 = Math.sin(lat2);
    const dLon = lon2 - lon1;
    sigma = Math.acos(
      Math.min(
        1,
        Math.max(-1, sinLat1 * sinLat2 + cosLat1 * cosLat2 * Math.cos(dLon))
      )
    );
    // Use mean radius for distance when Vincenty won't converge
    const distance = WGS84_SEMI_MAJOR_AXIS * sigma;
    const ib = Math.atan2(
      cosLat2 * Math.sin(dLon),
      cosLat1 * sinLat2 - sinLat1 * cosLat2 * Math.cos(dLon)
    );
    const fb = Math.atan2(
      cosLat1 * Math.sin(-dLon),
      -sinLat1 * cosLat2 + cosLat1 * sinLat2 * Math.cos(-dLon)
    );
    return { distance, initialBearing: ib, finalBearing: fb, converged: false };
  }

  const uSq =
    (cos2Alpha! * (WGS84_SEMI_MAJOR_AXIS ** 2 - WGS84_SEMI_MINOR_AXIS ** 2)) /
    WGS84_SEMI_MINOR_AXIS ** 2;
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    B *
    sinSigma! *
    (cos2SigmaM! +
      (B / 4) *
        (cosSigma! * (-1 + 2 * cos2SigmaM! ** 2) -
          (B / 6) *
            cos2SigmaM! *
            (-3 + 4 * sinSigma! ** 2) *
            (-3 + 4 * cos2SigmaM! ** 2)));

  const distance = WGS84_SEMI_MINOR_AXIS * A * (sigma! - deltaSigma);

  // Bearings
  const sinLambda = Math.sin(lambda);
  const cosLambda = Math.cos(lambda);

  const initialBearing = Math.atan2(
    cosU2 * sinLambda,
    cosU1 * sinU2 - sinU1 * cosU2 * cosLambda
  );
  const finalBearing = Math.atan2(
    cosU1 * sinLambda,
    -sinU1 * cosU2 + cosU1 * sinU2 * cosLambda
  );

  return { distance, initialBearing, finalBearing, converged: true };
}

/**
 * Vincenty's direct formula — the point reached from (lat1, lon1) after
 * `distance` metres along the geodesic leaving at `bearing` (radians,
 * clockwise from north) on the WGS84 ellipsoid.
 * @returns [lat, lon] in radians, lon wrapped to (-π, π]
 */
export function vincentyDirect(
  lat1: number,
  lon1: number,
  bearing: number,
  distance: number
): [number, number] {
  const a = WGS84_SEMI_MAJOR_AXIS,
    b = WGS84_SEMI_MINOR_AXIS,
    f = WGS84_FLATTENING;
  const sinA1 = Math.sin(bearing),
    cosA1 = Math.cos(bearing);
  const tanU1 = (1 - f) * Math.tan(lat1);
  const cosU1 = 1 / Math.sqrt(1 + tanU1 ** 2),
    sinU1 = tanU1 * cosU1;
  const sigma1 = Math.atan2(tanU1, cosA1);
  const sinAlpha = cosU1 * sinA1;
  const cos2Alpha = 1 - sinAlpha ** 2;
  const uSq = (cos2Alpha * (a ** 2 - b ** 2)) / b ** 2;
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));

  let sigma = distance / (b * A);
  let sigmaPrev: number;
  let cos2SigmaM: number, sinSigma: number, cosSigma: number;
  let iter = 0;
  do {
    cos2SigmaM = Math.cos(2 * sigma1 + sigma);
    sinSigma = Math.sin(sigma);
    cosSigma = Math.cos(sigma);
    const deltaSigma =
      B *
      sinSigma *
      (cos2SigmaM +
        (B / 4) *
          (cosSigma * (-1 + 2 * cos2SigmaM ** 2) -
            (B / 6) *
              cos2SigmaM *
              (-3 + 4 * sinSigma ** 2) *
              (-3 + 4 * cos2SigmaM ** 2)));
    sigmaPrev = sigma;
    sigma = distance / (b * A) + deltaSigma;
  } while (Math.abs(sigma - sigmaPrev) > 1e-12 && ++iter < 200);

  const tmp = sinU1 * sinSigma - cosU1 * cosSigma * cosA1;
  const lat2 = Math.atan2(
    sinU1 * cosSigma + cosU1 * sinSigma * cosA1,
    (1 - f) * Math.sqrt(sinAlpha ** 2 + tmp ** 2)
  );
  const lambda = Math.atan2(
    sinSigma * sinA1,
    cosU1 * cosSigma - sinU1 * sinSigma * cosA1
  );
  const C = (f / 16) * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
  const L =
    lambda -
    (1 - C) *
      f *
      sinAlpha *
      (sigma +
        C *
          sinSigma *
          (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
  let lon2 = lon1 + L;
  lon2 = Math.atan2(Math.sin(lon2), Math.cos(lon2));
  return [lat2, lon2];
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
