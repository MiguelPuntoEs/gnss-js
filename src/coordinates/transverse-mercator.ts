/**
 * Gauss conformal (transverse Mercator) projection with Krüger's
 * formulas to n⁴, as published by Lantmäteriet for SWEREF 99 — accurate
 * to well under a millimetre within ±10° of the central meridian, so a
 * single zone can span all of Sweden (SWEREF 99 TM is 15°E ± ~9°). The
 * short series used for UTM elsewhere in this module is only good near
 * its 6° zones.
 *
 * Reference: Lantmäteriet, "Gauss conformal projection (Transverse
 * Mercator) — Krüger's formulas" (2008).
 */

/** An ellipsoid plus a transverse Mercator grid on it. */
export interface TransverseMercatorParams {
  /** Semi-major axis (m). */
  a: number;
  /** Flattening. */
  f: number;
  /** Central meridian (degrees east). */
  lon0: number;
  /** Scale factor on the central meridian. */
  k0: number;
  /** False northing (m). */
  falseNorthing: number;
  /** False easting (m). */
  falseEasting: number;
  /** Latitude of origin (degrees; default 0, the equator). */
  lat0?: number;
}

export const GRS80_SEMI_MAJOR_AXIS = 6378137.0;
export const GRS80_FLATTENING = 1 / 298.257222101;

function series(p: TransverseMercatorParams) {
  const { a, f } = p;
  const e2 = f * (2 - f);
  const n = f / (2 - f);
  const aHat = (a / (1 + n)) * (1 + n ** 2 / 4 + n ** 4 / 64);
  return { e2, n, aHat };
}

/** Conformal latitude of `lat` (radians): Krüger's A–D series. */
function conformalLatitude(lat: number, e2: number): number {
  const A = e2;
  const B = (5 * e2 ** 2 - e2 ** 3) / 6;
  const C = (104 * e2 ** 3 - 45 * e2 ** 4) / 120;
  const D = (1237 * e2 ** 4) / 1260;
  const s2 = Math.sin(lat) ** 2;
  return (
    lat -
    Math.sin(lat) * Math.cos(lat) * (A + B * s2 + C * s2 ** 2 + D * s2 ** 3)
  );
}

function forwardCoefficients(n: number): number[] {
  return [
    n / 2 - (2 * n ** 2) / 3 + (5 * n ** 3) / 16 + (41 * n ** 4) / 180,
    (13 * n ** 2) / 48 - (3 * n ** 3) / 5 + (557 * n ** 4) / 1440,
    (61 * n ** 3) / 240 - (103 * n ** 4) / 140,
    (49561 * n ** 4) / 161280,
  ];
}

/** The latitude of origin on the central meridian, in units of k0·â. */
function originXi(p: TransverseMercatorParams, e2: number, n: number): number {
  if (!p.lat0) return 0;
  const xi = conformalLatitude((p.lat0 * Math.PI) / 180, e2);
  const b = forwardCoefficients(n);
  let x = xi;
  for (let j = 1; j <= 4; j++) x += b[j - 1]! * Math.sin(2 * j * xi);
  return x;
}

/**
 * Geodetic → grid.
 * @param lat Latitude in radians
 * @param lon Longitude in radians
 * @returns northing and easting in metres
 */
export function geodeticToTransverseMercator(
  lat: number,
  lon: number,
  p: TransverseMercatorParams
): { northing: number; easting: number } {
  const { e2, n, aHat } = series(p);
  const b = forwardCoefficients(n);
  const latC = conformalLatitude(lat, e2);
  const dLon0 = lon - (p.lon0 * Math.PI) / 180;
  const dLon = Math.atan2(Math.sin(dLon0), Math.cos(dLon0));
  const xi = Math.atan2(Math.tan(latC), Math.cos(dLon));
  const eta = Math.atanh(Math.cos(latC) * Math.sin(dLon));

  let x = xi;
  let y = eta;
  for (let j = 1; j <= 4; j++) {
    const bj = b[j - 1]!;
    x += bj * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    y += bj * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  return {
    northing: p.k0 * aHat * (x - originXi(p, e2, n)) + p.falseNorthing,
    easting: p.k0 * aHat * y + p.falseEasting,
  };
}

/**
 * Grid → geodetic.
 * @returns latitude and longitude in radians
 */
export function transverseMercatorToGeodetic(
  northing: number,
  easting: number,
  p: TransverseMercatorParams
): { lat: number; lon: number } {
  const { e2, n, aHat } = series(p);
  const As = e2 + e2 ** 2 + e2 ** 3 + e2 ** 4;
  const Bs = -(7 * e2 ** 2 + 17 * e2 ** 3 + 30 * e2 ** 4) / 6;
  const Cs = (224 * e2 ** 3 + 889 * e2 ** 4) / 120;
  const Ds = -(4279 * e2 ** 4) / 1260;
  const d = [
    n / 2 - (2 * n ** 2) / 3 + (37 * n ** 3) / 96 - n ** 4 / 360,
    n ** 2 / 48 + n ** 3 / 15 - (437 * n ** 4) / 1440,
    (17 * n ** 3) / 480 - (37 * n ** 4) / 840,
    (4397 * n ** 4) / 161280,
  ];

  const xi = (northing - p.falseNorthing) / (p.k0 * aHat) + originXi(p, e2, n);
  const eta = (easting - p.falseEasting) / (p.k0 * aHat);
  let xiP = xi;
  let etaP = eta;
  for (let j = 1; j <= 4; j++) {
    const dj = d[j - 1]!;
    xiP -= dj * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= dj * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const latC = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  const dLon = Math.atan2(Math.sinh(etaP), Math.cos(xiP));
  const s2 = Math.sin(latC) ** 2;
  const lat =
    latC +
    Math.sin(latC) *
      Math.cos(latC) *
      (As + Bs * s2 + Cs * s2 ** 2 + Ds * s2 ** 3);
  return { lat, lon: (p.lon0 * Math.PI) / 180 + dLon };
}

/** A named, EPSG-registered transverse Mercator grid. */
export interface GridProjection extends TransverseMercatorParams {
  /** Official name, e.g. "SWEREF 99 TM", "TM35FIN", "NTM zone 10". */
  name: string;
  epsg: number;
}

/** A named SWEREF 99 projection (EPSG:3006–3018). */
export type Sweref99Projection = GridProjection;

const swerefZone = (
  name: string,
  epsg: number,
  lon0: number,
  k0: number,
  falseEasting: number
): Sweref99Projection => ({
  name,
  epsg,
  a: GRS80_SEMI_MAJOR_AXIS,
  f: GRS80_FLATTENING,
  lon0,
  k0,
  falseNorthing: 0,
  falseEasting,
});

/** SWEREF 99 TM — Sweden's national grid (EPSG:3006). */
export const SWEREF99_TM = swerefZone('SWEREF 99 TM', 3006, 15, 0.9996, 500000);

/**
 * The 12 SWEREF 99 local projection zones (scale 1, false easting 150 km)
 * used for detailed surveying, ordered west → east. Which zone applies is
 * decided per municipality, not by nearest meridian.
 */
export const SWEREF99_LOCAL_ZONES: readonly Sweref99Projection[] = [
  swerefZone('SWEREF 99 12 00', 3007, 12, 1, 150000),
  swerefZone('SWEREF 99 13 30', 3008, 13.5, 1, 150000),
  swerefZone('SWEREF 99 14 15', 3012, 14.25, 1, 150000),
  swerefZone('SWEREF 99 15 00', 3009, 15, 1, 150000),
  swerefZone('SWEREF 99 15 45', 3013, 15.75, 1, 150000),
  swerefZone('SWEREF 99 16 30', 3010, 16.5, 1, 150000),
  swerefZone('SWEREF 99 17 15', 3014, 17.25, 1, 150000),
  swerefZone('SWEREF 99 18 00', 3011, 18, 1, 150000),
  swerefZone('SWEREF 99 18 45', 3015, 18.75, 1, 150000),
  swerefZone('SWEREF 99 20 15', 3016, 20.25, 1, 150000),
  swerefZone('SWEREF 99 21 45', 3017, 21.75, 1, 150000),
  swerefZone('SWEREF 99 23 15', 3018, 23.25, 1, 150000),
];

/** The zone whose central meridian is nearest to `lonDeg`. */
export function nearestZone<P extends TransverseMercatorParams>(
  zones: readonly P[],
  lonDeg: number
): P {
  let best = zones[0]!;
  for (const z of zones)
    if (Math.abs(z.lon0 - lonDeg) < Math.abs(best.lon0 - lonDeg)) best = z;
  return best;
}

/** The local zone whose central meridian is nearest to `lonDeg`. */
export function nearestSweref99LocalZone(lonDeg: number): Sweref99Projection {
  return nearestZone(SWEREF99_LOCAL_ZONES, lonDeg);
}
