/**
 * Oblique stereographic projection, EPSG method 9809 ("double"
 * stereographic: Gauss conformal sphere, then stereographic), as in IOGP
 * Guidance Note 7-2 §3.3.1 and PROJ's `sterea`. Used by the Dutch RD grid
 * (EPSG:28992) on the Bessel 1841 ellipsoid.
 */

export interface ObliqueStereographicParams {
  /** Semi-major axis (m). */
  a: number;
  /** Flattening. */
  f: number;
  /** Latitude / longitude of natural origin (degrees). */
  lat0: number;
  lon0: number;
  /** Scale factor at the origin. */
  k0: number;
  falseEasting: number;
  falseNorthing: number;
}

const D2R = Math.PI / 180;

function constants(p: ObliqueStereographicParams) {
  const e2 = p.f * (2 - p.f);
  const e = Math.sqrt(e2);
  const phi0 = p.lat0 * D2R;
  const s0 = Math.sin(phi0);
  const rho0 = (p.a * (1 - e2)) / (1 - e2 * s0 * s0) ** 1.5;
  const nu0 = p.a / Math.sqrt(1 - e2 * s0 * s0);
  const R = Math.sqrt(rho0 * nu0);
  const n = Math.sqrt(1 + (e2 * Math.cos(phi0) ** 4) / (1 - e2));
  const S1 = (1 + s0) / (1 - s0);
  const S2 = (1 - e * s0) / (1 + e * s0);
  const w1 = (S1 * S2 ** e) ** n;
  const sinChi00 = (w1 - 1) / (w1 + 1);
  const c = ((n + s0) * (1 - sinChi00)) / ((n - s0) * (1 + sinChi00));
  const w2 = c * w1;
  const chi0 = Math.asin((w2 - 1) / (w2 + 1));
  return { e, e2, R, n, c, chi0 };
}

/**
 * Geodetic → grid.
 * @param lat Latitude in radians
 * @param lon Longitude in radians
 */
export function geodeticToObliqueStereographic(
  lat: number,
  lon: number,
  p: ObliqueStereographicParams
): { easting: number; northing: number } {
  const { e, R, n, c, chi0 } = constants(p);
  const dLambda = n * (lon - p.lon0 * D2R);
  const s = Math.sin(lat);
  const Sa = (1 + s) / (1 - s);
  const Sb = (1 - e * s) / (1 + e * s);
  const w = c * (Sa * Sb ** e) ** n;
  const chi = Math.asin((w - 1) / (w + 1));
  const B =
    1 +
    Math.sin(chi) * Math.sin(chi0) +
    Math.cos(chi) * Math.cos(chi0) * Math.cos(dLambda);
  const k = 2 * R * p.k0;
  return {
    easting: p.falseEasting + (k * Math.cos(chi) * Math.sin(dLambda)) / B,
    northing:
      p.falseNorthing +
      (k *
        (Math.sin(chi) * Math.cos(chi0) -
          Math.cos(chi) * Math.sin(chi0) * Math.cos(dLambda))) /
        B,
  };
}

/**
 * Grid → geodetic.
 * @returns latitude and longitude in radians
 */
export function obliqueStereographicToGeodetic(
  easting: number,
  northing: number,
  p: ObliqueStereographicParams
): { lat: number; lon: number } {
  const { e, e2, R, n, c, chi0 } = constants(p);
  const k = 2 * R * p.k0;
  const dE = easting - p.falseEasting;
  const dN = northing - p.falseNorthing;
  const g = k * Math.tan(Math.PI / 4 - chi0 / 2);
  const h = 2 * k * Math.tan(chi0) + g;
  const i = Math.atan(dE / (h + dN));
  const j = Math.atan(dE / (g - dN)) - i;
  const chi = chi0 + 2 * Math.atan((dN - dE * Math.tan(j / 2)) / k);
  const dLambda = j + 2 * i;
  const lon = p.lon0 * D2R + dLambda / n;
  const psi =
    (0.5 * Math.log((1 + Math.sin(chi)) / (c * (1 - Math.sin(chi))))) / n;
  let phi = 2 * Math.atan(Math.exp(psi)) - Math.PI / 2;
  for (let it = 0; it < 20; it++) {
    const s = Math.sin(phi);
    const psiI = Math.log(
      Math.tan(phi / 2 + Math.PI / 4) * ((1 - e * s) / (1 + e * s)) ** (e / 2)
    );
    const next =
      phi - ((psiI - psi) * Math.cos(phi) * (1 - e2 * s * s)) / (1 - e2);
    if (Math.abs(next - phi) < 1e-14) {
      phi = next;
      break;
    }
    phi = next;
  }
  return { lat: phi, lon };
}

/** Bessel 1841 (Amersfoort datum). */
export const BESSEL_1841 = { a: 6377397.155, f: 1 / 299.1528128 };

/**
 * Amersfoort / RD New (EPSG:28992), the Dutch Rijksdriehoeksstelsel:
 * origin at the Onze Lieve Vrouwetoren in Amersfoort, false origin
 * 155 km west / 463 km south. Coordinates are on the Amersfoort (Bessel)
 * datum: reach them from ETRS89 with RDNAPTRANS (`frames/rdnap`).
 */
export const RD_NEW: ObliqueStereographicParams & {
  name: string;
  epsg: number;
} = {
  name: 'RD New',
  epsg: 28992,
  ...BESSEL_1841,
  lat0: 52 + 9 / 60 + 22.178 / 3600, // 52°09′22.178″
  lon0: 5 + 23 / 60 + 15.5 / 3600, // 5°23′15.5″
  k0: 0.9999079,
  falseEasting: 155000,
  falseNorthing: 463000,
};
