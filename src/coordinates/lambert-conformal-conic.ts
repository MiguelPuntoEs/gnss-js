/**
 * Lambert conformal conic with two standard parallels, EPSG method 9802
 * (IOGP Guidance Note 7-2 §3.2.1.1, as PROJ's `lcc`). Used by France's
 * Lambert-93 and the nine conic conformal zones CC42–CC50 on RGF93
 * (ETRS89, GRS80).
 */
import { GRS80_FLATTENING, GRS80_SEMI_MAJOR_AXIS } from './transverse-mercator';

export interface LambertConformalConicParams {
  /** Semi-major axis (m). */
  a: number;
  /** Flattening. */
  f: number;
  /** Latitude of false origin (degrees). */
  lat0: number;
  /** Longitude of false origin (degrees). */
  lon0: number;
  /** First and second standard parallels (degrees). */
  lat1: number;
  lat2: number;
  falseEasting: number;
  falseNorthing: number;
}

const D2R = Math.PI / 180;

function constants(p: LambertConformalConicParams) {
  const e2 = p.f * (2 - p.f);
  const e = Math.sqrt(e2);
  const m = (phi: number) =>
    Math.cos(phi) / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const t = (phi: number) =>
    Math.tan(Math.PI / 4 - phi / 2) /
    ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2);
  const phi1 = p.lat1 * D2R;
  const phi2 = p.lat2 * D2R;
  const n =
    phi1 === phi2
      ? Math.sin(phi1)
      : (Math.log(m(phi1)) - Math.log(m(phi2))) /
        (Math.log(t(phi1)) - Math.log(t(phi2)));
  const F = m(phi1) / (n * t(phi1) ** n);
  const rF = p.a * F * t(p.lat0 * D2R) ** n;
  return { e, n, F, rF, t };
}

/**
 * Geodetic → grid.
 * @param lat Latitude in radians
 * @param lon Longitude in radians
 */
export function geodeticToLambertConformalConic(
  lat: number,
  lon: number,
  p: LambertConformalConicParams
): { easting: number; northing: number } {
  const { n, F, rF, t } = constants(p);
  const r = p.a * F * t(lat) ** n;
  const theta = n * (lon - p.lon0 * D2R);
  return {
    easting: p.falseEasting + r * Math.sin(theta),
    northing: p.falseNorthing + rF - r * Math.cos(theta),
  };
}

/**
 * Grid → geodetic.
 * @returns latitude and longitude in radians
 */
export function lambertConformalConicToGeodetic(
  easting: number,
  northing: number,
  p: LambertConformalConicParams
): { lat: number; lon: number } {
  const { e, n, F, rF } = constants(p);
  const dE = easting - p.falseEasting;
  const dN = rF - (northing - p.falseNorthing);
  const s = Math.sign(n);
  const r = s * Math.hypot(dE, dN);
  const theta = Math.atan2(s * dE, s * dN);
  const tt = (r / (p.a * F)) ** (1 / n);
  let phi = Math.PI / 2 - 2 * Math.atan(tt);
  for (let i = 0; i < 20; i++) {
    const es = e * Math.sin(phi);
    const next =
      Math.PI / 2 - 2 * Math.atan(tt * ((1 - es) / (1 + es)) ** (e / 2));
    const done = Math.abs(next - phi) < 1e-14;
    phi = next;
    if (done) break;
  }
  return { lat: phi, lon: theta / n + p.lon0 * D2R };
}

/** A named, EPSG-registered Lambert conformal conic grid. */
export interface ConicProjection extends LambertConformalConicParams {
  name: string;
  epsg: number;
}

/** Lambert-93 (EPSG:2154), France's national grid on RGF93. */
export const LAMBERT_93: ConicProjection = {
  name: 'Lambert-93',
  epsg: 2154,
  a: GRS80_SEMI_MAJOR_AXIS,
  f: GRS80_FLATTENING,
  lat0: 46.5,
  lon0: 3,
  lat1: 49,
  lat2: 44,
  falseEasting: 700000,
  falseNorthing: 6600000,
};

/**
 * The conic conformal zones CC42–CC50 (EPSG:3942–3950): one per degree of
 * latitude, standard parallels ±0.75° around it, for large-scale work.
 */
export const FRANCE_CC_ZONES: readonly ConicProjection[] = Array.from(
  { length: 9 },
  (_, k) => {
    const z = 42 + k;
    return {
      name: `CC${z}`,
      epsg: 3900 + z,
      a: GRS80_SEMI_MAJOR_AXIS,
      f: GRS80_FLATTENING,
      lat0: z,
      lon0: 3,
      lat1: z - 0.75,
      lat2: z + 0.75,
      falseEasting: 1700000,
      falseNorthing: (z - 41) * 1000000 + 200000,
    };
  }
);

/** The CC zone for a latitude: the nearest whole degree, 42–50. */
export function franceCcZone(latDeg: number): ConicProjection {
  const z = Math.min(50, Math.max(42, Math.round(latDeg)));
  return FRANCE_CC_ZONES[z - 42]!;
}
