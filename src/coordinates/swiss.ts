/**
 * Switzerland: ETRS89 (CHTRF95) ↔ CH1903+ / LV95 (EPSG:2056), as swisstopo
 * and EPSG define it:
 *
 *   CHTRF95 X, Y, Z ─translation (−674.374, −15.056, −405.346 m)→
 *     CH1903+ on Bessel 1841 ─Swiss oblique Mercator 1995→ E, N (LV95)
 *
 * The projection is EPSG method 9814 (PROJ `somerc`): a conformal double
 * projection onto a sphere, then an oblique cylinder through Bern.
 * CHTRF95 is ETRF89 at epoch 1993.0, so `itrf → ETRF89` reaches it.
 */
import { BESSEL_1841 } from './oblique-stereographic';
import { GRS80_FLATTENING, GRS80_SEMI_MAJOR_AXIS } from './transverse-mercator';

export interface SwissObliqueMercatorParams {
  a: number;
  f: number;
  /** Latitude / longitude of the projection centre (degrees). */
  lat0: number;
  lon0: number;
  k0: number;
  falseEasting: number;
  falseNorthing: number;
}

const D2R = Math.PI / 180;
const FORTPI = Math.PI / 4;

type Ellipsoid = { a: number; f: number };
const GRS80: Ellipsoid = { a: GRS80_SEMI_MAJOR_AXIS, f: GRS80_FLATTENING };

function toEcef(lat: number, lon: number, h: number, { a, f }: Ellipsoid) {
  const e2 = f * (2 - f);
  const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [
    (N + h) * Math.cos(lat) * Math.cos(lon),
    (N + h) * Math.cos(lat) * Math.sin(lon),
    ((1 - e2) * N + h) * Math.sin(lat),
  ] as const;
}

/** Geocentric → latitude/longitude (radians) and height on an ellipsoid. */
function fromEcef(x: number, y: number, z: number, { a, f }: Ellipsoid) {
  const e2 = f * (2 - f);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  let h = 0;
  for (let i = 0; i < 10; i++) {
    const N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    h = p / Math.cos(lat) - N;
    lat = Math.atan2(z, p * (1 - (e2 * N) / (N + h)));
  }
  return { lat, lon: Math.atan2(y, x), h };
}

function constants(p: SwissObliqueMercatorParams) {
  const es = p.f * (2 - p.f);
  const e = Math.sqrt(es);
  const phi0 = p.lat0 * D2R;
  const sp = Math.sin(phi0);
  const cp = Math.cos(phi0) ** 2;
  const c = Math.sqrt(1 + (es * cp * cp) / (1 - es));
  const sinp0 = sp / c;
  const phip0 = Math.asin(sinp0);
  const cosp0 = Math.cos(phip0);
  const K =
    Math.log(Math.tan(FORTPI + 0.5 * phip0)) -
    c *
      (Math.log(Math.tan(FORTPI + 0.5 * phi0)) -
        0.5 * e * Math.log((1 + e * sp) / (1 - e * sp)));
  const kR = (p.k0 * Math.sqrt(1 - es)) / (1 - sp * sp * es);
  return { e, es, c, sinp0, cosp0, K, kR };
}

/** Geodetic (radians) → easting/northing (m), as PROJ's `somerc`. */
export function geodeticToSwissObliqueMercator(
  lat: number,
  lon: number,
  p: SwissObliqueMercatorParams
): { easting: number; northing: number } {
  const { e, c, sinp0, cosp0, K, kR } = constants(p);
  const sp = e * Math.sin(lat);
  const phip =
    2 *
      Math.atan(
        Math.exp(
          c *
            (Math.log(Math.tan(FORTPI + 0.5 * lat)) -
              0.5 * e * Math.log((1 + sp) / (1 - sp))) +
            K
        )
      ) -
    Math.PI / 2;
  const lamp = c * (lon - p.lon0 * D2R);
  const cp = Math.cos(phip);
  const phipp = Math.asin(cosp0 * Math.sin(phip) - sinp0 * cp * Math.cos(lamp));
  const lampp = Math.asin((cp * Math.sin(lamp)) / Math.cos(phipp));
  return {
    easting: p.falseEasting + p.a * kR * lampp,
    northing:
      p.falseNorthing + p.a * kR * Math.log(Math.tan(FORTPI + 0.5 * phipp)),
  };
}

/** Easting/northing (m) → geodetic (radians). */
export function swissObliqueMercatorToGeodetic(
  easting: number,
  northing: number,
  p: SwissObliqueMercatorParams
): { lat: number; lon: number } {
  const { e, es, c, sinp0, cosp0, K, kR } = constants(p);
  const x = (easting - p.falseEasting) / p.a;
  const y = (northing - p.falseNorthing) / p.a;
  const phipp = 2 * (Math.atan(Math.exp(y / kR)) - FORTPI);
  const lampp = x / kR;
  const cp = Math.cos(phipp);
  const phip = Math.asin(
    cosp0 * Math.sin(phipp) + sinp0 * cp * Math.cos(lampp)
  );
  const lamp = Math.asin((cp * Math.sin(lampp)) / Math.cos(phip));
  const con = (K - Math.log(Math.tan(FORTPI + 0.5 * phip))) / c;
  let phi = phip;
  for (let i = 0; i < 20; i++) {
    const esp = e * Math.sin(phi);
    const delp =
      ((con +
        Math.log(Math.tan(FORTPI + 0.5 * phi)) -
        0.5 * e * Math.log((1 + esp) / (1 - esp))) *
        (1 - esp * esp) *
        Math.cos(phi)) /
      (1 - es);
    phi -= delp;
    if (Math.abs(delp) < 1e-14) break;
  }
  return { lat: phi, lon: p.lon0 * D2R + lamp / c };
}

/** CH1903+ / LV95 (EPSG:2056): origin Bern, E 2 600 000, N 1 200 000. */
export const LV95: SwissObliqueMercatorParams & {
  name: string;
  epsg: number;
} = {
  name: 'CH1903+ / LV95',
  epsg: 2056,
  ...BESSEL_1841,
  lat0: 46 + 57 / 60 + 8.66 / 3600,
  lon0: 7 + 26 / 60 + 22.5 / 3600,
  k0: 1,
  falseEasting: 2600000,
  falseNorthing: 1200000,
};

/** CHTRF95 (ETRS89) → CH1903+ geocentric translation, EPSG:1647 inverse (m). */
const CH1903P_SHIFT = [-674.374, -15.056, -405.346] as const;

/**
 * ETRS89 (CHTRF95) latitude/longitude (degrees) and ellipsoidal height →
 * LV95 easting/northing. The shift is geocentric, so the height matters
 * (~1 mm per 10 m in the horizontal); as PROJ, the point keeps its height
 * through the shift. Heights above sea level come from CHGeo2004 instead.
 */
export function etrs89ToLv95(
  latDeg: number,
  lonDeg: number,
  h: number
): { easting: number; northing: number } {
  const [x, y, z] = toEcef(latDeg * D2R, lonDeg * D2R, h, GRS80);
  const b = fromEcef(
    x + CH1903P_SHIFT[0],
    y + CH1903P_SHIFT[1],
    z + CH1903P_SHIFT[2],
    BESSEL_1841
  );
  return geodeticToSwissObliqueMercator(b.lat, b.lon, LV95);
}

/**
 * LV95 easting/northing → ETRS89 (CHTRF95) latitude/longitude (degrees),
 * for a point at ellipsoidal height `h` (ETRS89): the exact inverse of
 * `etrs89ToLv95` (the Bessel height is iterated, which PROJ's inverse
 * skips at a cost of ~1 mm).
 */
export function lv95ToEtrs89(
  easting: number,
  northing: number,
  h: number
): { latDeg: number; lonDeg: number } {
  const g = swissObliqueMercatorToGeodetic(easting, northing, LV95);
  let hB = h;
  let r = { lat: 0, lon: 0, h: 0 };
  for (let i = 0; i < 3; i++) {
    const [x, y, z] = toEcef(g.lat, g.lon, hB, BESSEL_1841);
    r = fromEcef(
      x - CH1903P_SHIFT[0],
      y - CH1903P_SHIFT[1],
      z - CH1903P_SHIFT[2],
      GRS80
    );
    // Height on Bessel of the ETRS89 point at height h.
    hB += h - r.h;
  }
  return { latDeg: r.lat / D2R, lonDeg: r.lon / D2R };
}
