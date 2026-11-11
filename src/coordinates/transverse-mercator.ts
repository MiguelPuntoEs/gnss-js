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
  const A = e2;
  const B = (5 * e2 ** 2 - e2 ** 3) / 6;
  const C = (104 * e2 ** 3 - 45 * e2 ** 4) / 120;
  const D = (1237 * e2 ** 4) / 1260;
  const b = [
    n / 2 - (2 * n ** 2) / 3 + (5 * n ** 3) / 16 + (41 * n ** 4) / 180,
    (13 * n ** 2) / 48 - (3 * n ** 3) / 5 + (557 * n ** 4) / 1440,
    (61 * n ** 3) / 240 - (103 * n ** 4) / 140,
    (49561 * n ** 4) / 161280,
  ];

  const s2 = Math.sin(lat) ** 2;
  const latC =
    lat -
    Math.sin(lat) * Math.cos(lat) * (A + B * s2 + C * s2 ** 2 + D * s2 ** 3);
  const dLon = lon - (p.lon0 * Math.PI) / 180;
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
    northing: p.k0 * aHat * x + p.falseNorthing,
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

  const xi = (northing - p.falseNorthing) / (p.k0 * aHat);
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

/** A named SWEREF 99 projection (EPSG:3006–3018). */
export interface Sweref99Projection extends TransverseMercatorParams {
  /** Lantmäteriet name, e.g. "SWEREF 99 TM", "SWEREF 99 18 00". */
  name: string;
  epsg: number;
}

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

/** The local zone whose central meridian is nearest to `lonDeg`. */
export function nearestSweref99LocalZone(lonDeg: number): Sweref99Projection {
  let best = SWEREF99_LOCAL_ZONES[0]!;
  for (const z of SWEREF99_LOCAL_ZONES)
    if (Math.abs(z.lon0 - lonDeg) < Math.abs(best.lon0 - lonDeg)) best = z;
  return best;
}
