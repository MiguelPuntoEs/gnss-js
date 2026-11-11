/**
 * OSTN15 / OSGM15: ETRS89 ↔ OSGB36 National Grid (EPSG:27700) and
 * orthometric heights (ODN and the island datums) in Great Britain, as
 * Ordnance Survey defines them ("Transformations and OSGM15 user guide"):
 *
 *   ETRS89 φ, λ ─TM on GRS80 with National Grid parameters→ x, y
 *     e = x + se,  n = y + sn,  H = h − sg
 *
 * with se, sn, sg bilinear in a 1 km grid (701 × 1251 nodes, 0–700 km E,
 * 0–1250 km N) and the height datum from the nearest-quadrant flag. The
 * inverse iterates to 0.1 mm. Matches OS's test points to the millimetre.
 *
 * ETRS89 here is OS Net v2009, an ETRF97 realisation: `itrfToOsgb` goes
 * through ETRF97. The grid (BSD licence, © Ordnance Survey) is supplied by
 * the caller as a node lookup — gnss-js ships no grids.
 */
import { ecefToGeodetic, geodeticToEcef } from '../coordinates/ecef';
import {
  GRS80_FLATTENING,
  GRS80_SEMI_MAJOR_AXIS,
  type TransverseMercatorParams,
} from '../coordinates/transverse-mercator';
import { transformFrame, type ReferenceFrame } from './index';

/**
 * One OSTN15/OSGM15 node by index (east km 0–700, north km 0–1250):
 * [se, sn, sg] in metres and the height datum flag; null if not available.
 */
export type OstnGrid = (
  east: number,
  north: number
) => readonly [number, number, number, number] | null;

/** ETRS89 projected with the National Grid's parameters, on GRS80. */
export const OSTN15_ETRS89_GRID: TransverseMercatorParams = {
  a: GRS80_SEMI_MAJOR_AXIS,
  f: GRS80_FLATTENING,
  lat0: 49,
  lon0: -2,
  k0: 0.9996012717,
  falseEasting: 400000,
  falseNorthing: -100000,
};

/** OSGM15 height datum flags (16: outside the transformation). */
export const OSGM15_DATUMS: Readonly<Record<number, string>> = {
  1: 'Newlyn (ODN)',
  2: 'St Marys',
  3: 'Douglas02',
  4: 'Stornoway15',
  6: 'Lerwick',
  7: 'Newlyn (Orkney)',
  15: 'Newlyn Offshore',
};

/** The frame OS Net v2009 (and so OSTN15) realises ETRS89 in. */
export const OSTN15_ETRS89: ReferenceFrame = 'ETRF97';

const D2R = Math.PI / 180;

/*
 * OSTN15 is defined with Ordnance Survey's own transverse Mercator series
 * (guide, annexe C), not an exact projection: at the far west of the grid
 * the two differ by ~1 mm, so use OS's to reproduce OS's results.
 */
function osMeridian(phi: number, p: TransverseMercatorParams) {
  const a = p.a;
  const b = a * (1 - p.f);
  const n = (a - b) / (a + b);
  const phi0 = (p.lat0 ?? 0) * D2R;
  const d = phi - phi0;
  const s = phi + phi0;
  return (
    b *
    p.k0 *
    ((1 + n + (5 / 4) * n ** 2 + (5 / 4) * n ** 3) * d -
      (3 * n + 3 * n ** 2 + (21 / 8) * n ** 3) * Math.sin(d) * Math.cos(s) +
      ((15 / 8) * n ** 2 + (15 / 8) * n ** 3) *
        Math.sin(2 * d) *
        Math.cos(2 * s) -
      (35 / 24) * n ** 3 * Math.sin(3 * d) * Math.cos(3 * s))
  );
}

function osRadii(phi: number, p: TransverseMercatorParams) {
  const e2 = p.f * (2 - p.f);
  const s2 = Math.sin(phi) ** 2;
  const nu = (p.a * p.k0) / Math.sqrt(1 - e2 * s2);
  const rho = (p.a * p.k0 * (1 - e2)) / (1 - e2 * s2) ** 1.5;
  return { nu, rho, eta2: nu / rho - 1 };
}

/** OS annexe C: φ, λ (radians) → easting, northing. */
function osTmForward(
  phi: number,
  lambda: number,
  p: TransverseMercatorParams
): { easting: number; northing: number } {
  const { nu, rho, eta2 } = osRadii(phi, p);
  const sn = Math.sin(phi);
  const c = Math.cos(phi);
  const t2 = Math.tan(phi) ** 2;
  const P = lambda - p.lon0 * D2R;
  const I = osMeridian(phi, p) + p.falseNorthing;
  const II = (nu / 2) * sn * c;
  const III = (nu / 24) * sn * c ** 3 * (5 - t2 + 9 * eta2);
  const IIIA = (nu / 720) * sn * c ** 5 * (61 - 58 * t2 + t2 ** 2);
  const IV = nu * c;
  const V = (nu / 6) * c ** 3 * (nu / rho - t2);
  const VI =
    (nu / 120) * c ** 5 * (5 - 18 * t2 + t2 ** 2 + 14 * eta2 - 58 * t2 * eta2);
  return {
    northing: I + II * P ** 2 + III * P ** 4 + IIIA * P ** 6,
    easting: p.falseEasting + IV * P + V * P ** 3 + VI * P ** 5,
  };
}

/** OS annexe C: easting, northing → φ, λ (radians). */
function osTmInverse(
  easting: number,
  northing: number,
  p: TransverseMercatorParams
): { lat: number; lon: number } {
  let phi = (p.lat0 ?? 0) * D2R;
  let M = 0;
  do {
    phi += (northing - p.falseNorthing - M) / (p.a * p.k0);
    M = osMeridian(phi, p);
  } while (Math.abs(northing - p.falseNorthing - M) >= 1e-5);
  const { nu, rho, eta2 } = osRadii(phi, p);
  const t = Math.tan(phi);
  const sec = 1 / Math.cos(phi);
  const VII = t / (2 * rho * nu);
  const VIII =
    (t / (24 * rho * nu ** 3)) * (5 + 3 * t ** 2 + eta2 - 9 * t ** 2 * eta2);
  const IX = (t / (720 * rho * nu ** 5)) * (61 + 90 * t ** 2 + 45 * t ** 4);
  const X = sec / nu;
  const XI = (sec / (6 * nu ** 3)) * (nu / rho + 2 * t ** 2);
  const XII = (sec / (120 * nu ** 5)) * (5 + 28 * t ** 2 + 24 * t ** 4);
  const XIIA =
    (sec / (5040 * nu ** 7)) *
    (61 + 662 * t ** 2 + 1320 * t ** 4 + 720 * t ** 6);
  const E = easting - p.falseEasting;
  return {
    lat: phi - VII * E ** 2 + VIII * E ** 4 - IX * E ** 6,
    lon: p.lon0 * D2R + X * E - XI * E ** 3 + XII * E ** 5 - XIIA * E ** 7,
  };
}

function shifts(x: number, y: number, grid: OstnGrid) {
  const i = Math.floor(x / 1000);
  const j = Math.floor(y / 1000);
  const c = [grid(i, j), grid(i + 1, j), grid(i + 1, j + 1), grid(i, j + 1)];
  if (c.some((n) => !n)) throw new Error('Position outside OSTN15');
  const [n0, n1, n2, n3] = c as NonNullable<(typeof c)[number]>[];
  const t = (x - i * 1000) / 1000;
  const u = (y - j * 1000) / 1000;
  const w = [(1 - t) * (1 - u), t * (1 - u), t * u, (1 - t) * u];
  const at = (k: number) =>
    w[0]! * n0![k]! + w[1]! * n1![k]! + w[2]! * n2![k]! + w[3]! * n3![k]!;
  const f = [n0![3], n1![3], n2![3], n3![3]];
  const flag = f.every((v) => v === f[0])
    ? f[0]!
    : t <= 0.5 && u <= 0.5
      ? f[0]!
      : t > 0.5 && u <= 0.5
        ? f[1]!
        : t > 0.5 && u > 0.5
          ? f[2]!
          : f[3]!;
  return { se: at(0), sn: at(1), sg: at(2), flag };
}

export interface Osgb {
  /** National Grid easting / northing (m). */
  easting: number;
  northing: number;
  /** Orthometric height (m) above `datum`. */
  H: number;
  /** OSGM15 height datum, e.g. "Newlyn (ODN)". */
  datum: string;
  /** The raw OSGM15 datum flag. */
  datumFlag: number;
}

/** ETRS89 latitude/longitude (degrees) and height → National Grid + height. */
export function etrs89ToOsgb(
  latDeg: number,
  lonDeg: number,
  h: number,
  grid: OstnGrid
): Osgb {
  const p = osTmForward(latDeg * D2R, lonDeg * D2R, OSTN15_ETRS89_GRID);
  const s = shifts(p.easting, p.northing, grid);
  if (s.flag === 16) throw new Error('Position outside OSTN15');
  return {
    easting: p.easting + s.se,
    northing: p.northing + s.sn,
    H: h - s.sg,
    datum: OSGM15_DATUMS[s.flag] ?? `datum ${s.flag}`,
    datumFlag: s.flag,
  };
}

/** National Grid easting/northing (+ height) → ETRS89 latitude/longitude. */
export function osgbToEtrs89(
  easting: number,
  northing: number,
  H: number | null,
  grid: OstnGrid
): { latDeg: number; lonDeg: number; h: number | null } {
  let s = shifts(easting, northing, grid);
  let x = easting - s.se;
  let y = northing - s.sn;
  for (let i = 0; i < 20; i++) {
    const next = shifts(x, y, grid);
    const done =
      Math.abs(next.se - s.se) <= 1e-4 && Math.abs(next.sn - s.sn) <= 1e-4;
    s = next;
    x = easting - s.se;
    y = northing - s.sn;
    if (done) break;
  }
  if (s.flag === 16) throw new Error('Position outside OSTN15');
  const g = osTmInverse(x, y, OSTN15_ETRS89_GRID);
  return {
    latDeg: g.lat / D2R,
    lonDeg: g.lon / D2R,
    h: H === null ? null : H + s.sg,
  };
}

/**
 * ETRS89 easting/northing on the OSTN15 projection for a position — which
 * 1 km cell, and so which part of the grid, a transformation will read.
 */
export function ostn15GridPosition(
  latDeg: number,
  lonDeg: number
): { x: number; y: number } {
  const p = osTmForward(latDeg * D2R, lonDeg * D2R, OSTN15_ETRS89_GRID);
  return { x: p.easting, y: p.northing };
}

/** Geocentric coordinates in `from` at `epoch` → National Grid + height. */
export function itrfToOsgb(
  xyz: readonly [number, number, number],
  from: ReferenceFrame,
  epoch: number,
  grid: OstnGrid
): Osgb {
  const etrs = transformFrame(xyz, from, OSTN15_ETRS89, epoch);
  const [lat, lon, h] = ecefToGeodetic(...etrs);
  return etrs89ToOsgb(lat / D2R, lon / D2R, h, grid);
}

/** National Grid + height → geocentric coordinates in `to` at `epoch`. */
export function osgbToItrf(
  easting: number,
  northing: number,
  H: number,
  to: ReferenceFrame,
  epoch: number,
  grid: OstnGrid
): [number, number, number] {
  const e = osgbToEtrs89(easting, northing, H, grid);
  const etrs = geodeticToEcef(e.latDeg * D2R, e.lonDeg * D2R, e.h!);
  return transformFrame(etrs, OSTN15_ETRS89, to, epoch);
}
