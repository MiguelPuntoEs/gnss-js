/**
 * ITRF ↔ SWEREF 99 with the NKG2020 transformation (Nordic Geodetic
 * Commission; Häkli et al. 2016 method, NKG2020 parameters).
 *
 * SWEREF 99 is Sweden's ETRS89 realisation, fixed at epoch 1999.5. The
 * Fennoscandian crust still rebounds from the last ice sheet (up to
 * ~1 cm/yr vertically, a few mm/yr horizontally relative to stable
 * Eurasia), so a plain ITRF → ETRF Helmert does not land on SWEREF 99:
 * the chain needs an intraplate deformation model. As in PROJ / EPSG:
 *
 *   ITRFxx @ t ─Helmert→ ETRF2014 @ t
 *     ─NKG_RF17vel, t → 2000.0→ NKG_ETRF14 @ 2000.0
 *     ─7-parameter Helmert→ SWEREF 99 @ 2000.0
 *     ─NKG_RF17vel, 2000.0 → 1999.5→ SWEREF 99
 *
 * The velocity model is a grid (E/N/U mm/yr, CC-BY 4.0, NKG) the caller
 * supplies — gnss-js ships no grids. PROJ's `eur_nkg_nkgrf17vel.tif`
 * (cdn.proj.org) holds it; `velocityGridModel` wraps any such grid.
 * Matches PROJ 9 to well under a millimetre.
 */
import { ecefToGeodetic } from '../coordinates/ecef';
import {
  applyHelmert,
  transformFrame,
  type Helmert14,
  type ReferenceFrame,
} from './index';

type V3 = [number, number, number];

/** Velocity (east, north, up; mm/yr) at a point, or null outside the model. */
export type VelocityModel = (latDeg: number, lonDeg: number) => V3 | null;

/**
 * A regular latitude/longitude velocity grid, nodes on grid points
 * (PixelIsPoint). Samples are row-major from the north-west node: rows
 * run southward, columns eastward.
 */
export interface VelocityGrid {
  /** Latitude of the first row (degrees). */
  latNorth: number;
  /** Longitude of the first column (degrees east). */
  lonWest: number;
  /** Row spacing (degrees, positive). */
  dLat: number;
  /** Column spacing (degrees). */
  dLon: number;
  rows: number;
  cols: number;
  /** mm/yr */
  east: ArrayLike<number>;
  north: ArrayLike<number>;
  up: ArrayLike<number>;
}

/** Bilinear interpolation in a velocity grid; null outside it. */
export function velocityGridModel(g: VelocityGrid): VelocityModel {
  return (latDeg, lonDeg) => {
    const r = (g.latNorth - latDeg) / g.dLat;
    const c = (lonDeg - g.lonWest) / g.dLon;
    if (!(r >= 0 && c >= 0 && r <= g.rows - 1 && c <= g.cols - 1)) return null;
    const r0 = Math.min(Math.floor(r), g.rows - 2);
    const c0 = Math.min(Math.floor(c), g.cols - 2);
    const fr = r - r0;
    const fc = c - c0;
    const k = r0 * g.cols + c0;
    const at = (a: ArrayLike<number>) =>
      (1 - fr) * ((1 - fc) * a[k]! + fc * a[k + 1]!) +
      fr * ((1 - fc) * a[k + g.cols]! + fc * a[k + g.cols + 1]!);
    return [at(g.east), at(g.north), at(g.up)];
  };
}

/**
 * NKG_ETRF14 → SWEREF 99 at epoch 2000.0 (NKG2020, as in the EPSG/PROJ
 * "NKG_ETRF14 to SWEREF99" operation),
 * Position Vector convention: translations mm, scale ppb, rotations mas.
 */
export const NKG_ETRF14_TO_SWEREF99: Helmert14 = {
  t: [30.54, 46.06, -79.44],
  d: 3.002,
  r: [1.41958, 0.15132, 1.50337],
  tDot: [0, 0, 0],
  dDot: 0,
  rDot: [0, 0, 0],
  epoch: 2000.0,
};

/** Move `xyz` by its model velocity over `years`. */
function deform(xyz: V3, model: VelocityModel, years: number): V3 {
  const [lat, lon] = ecefToGeodetic(...xyz);
  const v = model((lat * 180) / Math.PI, (lon * 180) / Math.PI);
  if (!v) throw new Error('Position outside the NKG deformation model');
  const [e, n, u] = v.map((c) => (c * years) / 1000) as V3;
  const sl = Math.sin(lat);
  const cl = Math.cos(lat);
  const so = Math.sin(lon);
  const co = Math.cos(lon);
  return [
    xyz[0] - so * e - sl * co * n + cl * co * u,
    xyz[1] + co * e - sl * so * n + cl * so * u,
    xyz[2] + cl * n + sl * u,
  ];
}

/** Undo `deform`: the velocity is taken at the (unknown) start point. */
function undeform(xyz: V3, model: VelocityModel, years: number): V3 {
  let p = xyz;
  for (let i = 0; i < 3; i++) {
    const q = deform(p, model, years);
    p = [p[0] + xyz[0] - q[0], p[1] + xyz[1] - q[1], p[2] + xyz[2] - q[2]];
  }
  return p;
}

const SWEREF99_EPOCH = 1999.5;
const NKG_EPOCH = 2000.0;

/**
 * ITRF (any frame `transformFrame` knows, at coordinate epoch `epoch`) →
 * SWEREF 99 geocentric coordinates. Throws outside the velocity model.
 */
export function itrfToSweref99(
  xyz: readonly [number, number, number],
  from: ReferenceFrame,
  epoch: number,
  model: VelocityModel
): V3 {
  const etrf14 = transformFrame(xyz, from, 'ETRF2014', epoch);
  const nkg = deform(etrf14, model, NKG_EPOCH - epoch);
  const sw2000 = applyHelmert(nkg, NKG_ETRF14_TO_SWEREF99, NKG_EPOCH);
  return deform(sw2000, model, SWEREF99_EPOCH - NKG_EPOCH);
}

/** SWEREF 99 → ITRF frame `to` at coordinate epoch `epoch`. */
export function sweref99ToItrf(
  xyz: readonly [number, number, number],
  to: ReferenceFrame,
  epoch: number,
  model: VelocityModel
): V3 {
  const sw2000 = undeform([...xyz], model, SWEREF99_EPOCH - NKG_EPOCH);
  const nkg = applyHelmert(sw2000, NKG_ETRF14_TO_SWEREF99, NKG_EPOCH, true);
  const etrf14 = undeform(nkg, model, NKG_EPOCH - epoch);
  return transformFrame(etrf14, 'ETRF2014', to, epoch);
}
