/**
 * RDNAPTRANS™2018: ETRS89 ↔ RD (Amersfoort / RD New) and NAP heights, the
 * official Dutch transformation (NSGI), implementation variant 2 as in
 * PROJ/EPSG:
 *
 *   ETRS89 (ETRF2000) φ, λ ─rdtrans2018 shift (inverse)→ Amersfoort φ, λ
 *     ─oblique stereographic (Bessel)→ RD x, y
 *   NAP H = h − N, N from the NLGEO2018 quasi-geoid at the ETRS89 φ, λ
 *
 * The rdtrans2018 offsets (arc-seconds, latitude and east longitude) are
 * defined at Amersfoort positions, so ETRS89 → RD iterates. Grids are
 * supplied by the caller — gnss-js ships none. PROJ's CDN holds both
 * (`nl_nsgi_rdtrans2018.tif`, `nl_nsgi_nlgeo2018.tif`, CC0/CC-BY from
 * NSGI); `latLonGridModel` wraps them. Matches NSGI's certified
 * coordinates (Z001) to well under a millimetre.
 */
import { ecefToGeodetic, geodeticToEcef } from '../coordinates/ecef';
import {
  RD_NEW,
  geodeticToObliqueStereographic,
  obliqueStereographicToGeodetic,
} from '../coordinates/oblique-stereographic';
import { transformFrame, type ReferenceFrame } from './index';

/**
 * A regular latitude/longitude grid with any number of value planes,
 * nodes on grid points (PixelIsPoint), row-major from the north-west node.
 */
export interface LatLonGrid {
  latNorth: number;
  lonWest: number;
  /** Row / column spacing (degrees, positive). */
  dLat: number;
  dLon: number;
  rows: number;
  cols: number;
  planes: readonly ArrayLike<number>[];
}

/** Values interpolated at a point (degrees), or null outside the grid. */
export type LatLonGridModel = (
  latDeg: number,
  lonDeg: number
) => number[] | null;

/**
 * Bilinear interpolation over grids tried in order — list a nested
 * (finer) grid before its parent, as NTv2 does.
 */
export function latLonGridModel(...grids: LatLonGrid[]): LatLonGridModel {
  return (latDeg, lonDeg) => {
    for (const g of grids) {
      const r = (g.latNorth - latDeg) / g.dLat;
      const c = (lonDeg - g.lonWest) / g.dLon;
      if (!(r >= 0 && c >= 0 && r <= g.rows - 1 && c <= g.cols - 1)) continue;
      const r0 = Math.min(Math.floor(r), g.rows - 2);
      const c0 = Math.min(Math.floor(c), g.cols - 2);
      const fr = r - r0;
      const fc = c - c0;
      const k = r0 * g.cols + c0;
      return g.planes.map(
        (a) =>
          (1 - fr) * ((1 - fc) * a[k]! + fc * a[k + 1]!) +
          fr * ((1 - fc) * a[k + g.cols]! + fc * a[k + g.cols + 1]!)
      );
    }
    return null;
  };
}

export interface RdnapGrids {
  /** rdtrans2018: [Δφ, Δλ] arc-seconds (east positive) at Amersfoort φ, λ. */
  rdtrans: LatLonGridModel;
  /** NLGEO2018: [N] metres at ETRS89 φ, λ. */
  nlgeo: LatLonGridModel;
}

/** The frame RDNAPTRANS2018 takes as ETRS89. */
export const RDNAP_ETRS89: ReferenceFrame = 'ETRF2000';

function shift(latDeg: number, lonDeg: number, grids: RdnapGrids) {
  const d = grids.rdtrans(latDeg, lonDeg);
  if (!d) throw new Error('Position outside the RDNAPTRANS2018 grid');
  return [d[0]! / 3600, d[1]! / 3600] as const;
}

export interface Rdnap {
  /** RD x (easting) and y (northing), metres. */
  x: number;
  y: number;
  /** NAP height (m); null outside the quasi-geoid. */
  H: number | null;
}

/** ETRS89 (ETRF2000) latitude/longitude (degrees) and height → RD and NAP. */
export function etrs89ToRdnap(
  latDeg: number,
  lonDeg: number,
  h: number,
  grids: RdnapGrids
): Rdnap {
  // Amersfoort = ETRS89 − offset(Amersfoort): fixed point.
  let lat = latDeg;
  let lon = lonDeg;
  for (let i = 0; i < 10; i++) {
    const [dLat, dLon] = shift(lat, lon, grids);
    const nLat = latDeg - dLat;
    const nLon = lonDeg - dLon;
    const done = Math.abs(nLat - lat) + Math.abs(nLon - lon) < 1e-12;
    lat = nLat;
    lon = nLon;
    if (done) break;
  }
  const g = geodeticToObliqueStereographic(
    (lat * Math.PI) / 180,
    (lon * Math.PI) / 180,
    RD_NEW
  );
  const N = grids.nlgeo(latDeg, lonDeg);
  return { x: g.easting, y: g.northing, H: N ? h - N[0]! : null };
}

/** RD x, y and NAP H → ETRS89 (ETRF2000) latitude/longitude (degrees), h. */
export function rdnapToEtrs89(
  x: number,
  y: number,
  H: number | null,
  grids: RdnapGrids
): { latDeg: number; lonDeg: number; h: number | null } {
  const a = obliqueStereographicToGeodetic(x, y, RD_NEW);
  const latA = (a.lat * 180) / Math.PI;
  const lonA = (a.lon * 180) / Math.PI;
  const [dLat, dLon] = shift(latA, lonA, grids);
  const latDeg = latA + dLat;
  const lonDeg = lonA + dLon;
  const N = H === null ? null : grids.nlgeo(latDeg, lonDeg);
  return { latDeg, lonDeg, h: N ? H! + N[0]! : null };
}

/** Geocentric coordinates in `from` at coordinate epoch `epoch` → RD/NAP. */
export function itrfToRdnap(
  xyz: readonly [number, number, number],
  from: ReferenceFrame,
  epoch: number,
  grids: RdnapGrids
): Rdnap {
  const etrs = transformFrame(xyz, from, RDNAP_ETRS89, epoch);
  const [lat, lon, h] = ecefToGeodetic(...etrs);
  return etrs89ToRdnap((lat * 180) / Math.PI, (lon * 180) / Math.PI, h, grids);
}

/**
 * RD/NAP → geocentric coordinates in `to` at coordinate epoch `epoch`.
 * Throws if the NAP height can't be converted (outside the quasi-geoid).
 */
export function rdnapToItrf(
  x: number,
  y: number,
  H: number,
  to: ReferenceFrame,
  epoch: number,
  grids: RdnapGrids
): [number, number, number] {
  const e = rdnapToEtrs89(x, y, H, grids);
  if (e.h === null) throw new Error('Position outside the NLGEO2018 grid');
  const etrs = geodeticToEcef(
    (e.latDeg * Math.PI) / 180,
    (e.lonDeg * Math.PI) / 180,
    e.h
  );
  return transformFrame(etrs, RDNAP_ETRS89, to, epoch);
}
