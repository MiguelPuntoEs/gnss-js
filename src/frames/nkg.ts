/**
 * ITRF ↔ the Nordic national ETRS89 realisations with the NKG2020
 * transformation (Nordic Geodetic Commission; Häkli et al. 2016 method,
 * NKG2020 parameters): SWEREF 99 (Sweden), EUREF-FIN (Finland), EUREF89
 * (Norway) and ETRS89-DNK (Denmark).
 *
 * Each is fixed at its own epoch. The Fennoscandian crust still rebounds
 * from the last ice sheet (up to ~1 cm/yr vertically, a few mm/yr
 * horizontally relative to stable Eurasia), so a plain ITRF → ETRF Helmert
 * does not land on them: the chain needs an intraplate deformation model.
 * As in PROJ / EPSG:
 *
 *   ITRFxx @ t ─Helmert→ ETRF2014 @ t
 *     ─NKG_RF17vel, t → 2000.0→ NKG_ETRF14 @ 2000.0
 *     ─national step→ national frame @ 2000.0
 *     ─NKG_RF17vel, 2000.0 → frame epoch→ national frame
 *
 * The national step is a 7-parameter Helmert, except for Norway, whose
 * step is a geocentric shift grid (Kartverket's LSC-refined
 * NKG_ETRF14 → EUREF89 grid).
 *
 * The velocity model (E/N/U mm/yr, CC-BY 4.0, NKG) and Norway's shift
 * grid are supplied by the caller — gnss-js ships no grids. PROJ's
 * `eur_nkg_nkgrf17vel.tif` and `no_kv_NKGETRF14_EPSG7922_2000.tif`
 * (cdn.proj.org) hold them; `velocityGridModel` and
 * `geocentricShiftGridModel` wrap such grids. Matches PROJ 9 to well
 * under a millimetre.
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
  return bilinear3(g, g.east, g.north, g.up);
}

/** Geocentric translation (dX, dY, dZ; metres) at a point, or null outside. */
export type GeocentricShiftModel = (
  latDeg: number,
  lonDeg: number
) => V3 | null;

/**
 * A regular latitude/longitude grid of geocentric translations (metres),
 * laid out like `VelocityGrid`.
 */
export interface GeocentricShiftGrid extends Omit<
  VelocityGrid,
  'east' | 'north' | 'up'
> {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  z: ArrayLike<number>;
}

/** Bilinear interpolation in a geocentric shift grid; null outside it. */
export function geocentricShiftGridModel(
  g: GeocentricShiftGrid
): GeocentricShiftModel {
  return bilinear3(g, g.x, g.y, g.z);
}

function bilinear3(
  g: Omit<VelocityGrid, 'east' | 'north' | 'up'>,
  p0: ArrayLike<number>,
  p1: ArrayLike<number>,
  p2: ArrayLike<number>
): (latDeg: number, lonDeg: number) => V3 | null {
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
    return [at(p0), at(p1), at(p2)];
  };
}

/**
 * NKG_ETRF14 → SWEREF 99 at epoch 2000.0 (NKG2020, as in the EPSG/PROJ
 * "NKG_ETRF14 to SWEREF99" operation),
 * Position Vector convention: translations mm, scale ppb, rotations mas.
 */
export const NKG_ETRF14_TO_SWEREF99: Helmert14 = helmert7(
  [30.54, 46.06, -79.44],
  3.002,
  [1.41958, 0.15132, 1.50337]
);

function helmert7(t: V3, d: number, r: V3): Helmert14 {
  return { t, d, r, tDot: [0, 0, 0], dDot: 0, rDot: [0, 0, 0], epoch: 2000.0 };
}

/** The national frames the NKG2020 transformation reaches. */
export type NkgFrame = 'SWEREF 99' | 'EUREF-FIN' | 'EUREF89' | 'ETRS89-DNK';

export interface NkgFrameInfo {
  /** The epoch the frame's coordinates are fixed at. */
  epoch: number;
  /** NKG_ETRF14 → frame at 2000.0; null for Norway (shift grid). */
  helmert: Helmert14 | null;
}

/**
 * Frame epochs and NKG2020 national steps (EPSG/PROJ, NKG "PAR_2020_xx";
 * Position Vector: translations mm, scale ppb, rotations mas).
 */
export const NKG_FRAMES: Record<NkgFrame, NkgFrameInfo> = {
  'SWEREF 99': { epoch: 1999.5, helmert: NKG_ETRF14_TO_SWEREF99 },
  'EUREF-FIN': {
    epoch: 1997.0,
    helmert: helmert7(
      [156.51, -109.93, -109.35],
      5.29,
      [-3.12861, -3.78935, 4.03512]
    ),
  },
  // NKG_ETRF14 → EUREF89 is Kartverket's geocentric shift grid
  // (EPSG:10811), not a Helmert.
  EUREF89: { epoch: 1995.0, helmert: null },
  'ETRS89-DNK': {
    epoch: 2015.829,
    helmert: helmert7(
      [668.18, 44.53, -450.49],
      -3.136,
      [3.12883, -23.73423, 4.42969]
    ),
  },
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

/** Undo a position-dependent step `f`: fixed-point on the start point. */
function invert(xyz: V3, f: (p: V3) => V3): V3 {
  let p = xyz;
  for (let i = 0; i < 4; i++) {
    const q = f(p);
    p = [p[0] + xyz[0] - q[0], p[1] + xyz[1] - q[1], p[2] + xyz[2] - q[2]];
  }
  return p;
}

/** Add the grid's geocentric shift, taken at the input point. */
function shift(xyz: V3, grid: GeocentricShiftModel): V3 {
  const [lat, lon] = ecefToGeodetic(...xyz);
  const d = grid((lat * 180) / Math.PI, (lon * 180) / Math.PI);
  if (!d) throw new Error('Position outside the Norwegian shift grid');
  return [xyz[0] + d[0], xyz[1] + d[1], xyz[2] + d[2]];
}

/** Grids the NKG2020 chain needs; `norway` only for EUREF89. */
export interface NkgModels {
  velocity: VelocityModel;
  norway?: GeocentricShiftModel;
}

function nationalStep(frame: NkgFrame, models: NkgModels) {
  const { helmert } = NKG_FRAMES[frame];
  if (helmert)
    return {
      forward: (p: V3) => applyHelmert(p, helmert, NKG_EPOCH),
      inverse: (p: V3) => applyHelmert(p, helmert, NKG_EPOCH, true),
    };
  const grid = models.norway;
  if (!grid) throw new Error(`${frame} needs the Norwegian shift grid`);
  return {
    forward: (p: V3) => shift(p, grid),
    inverse: (p: V3) => invert(p, (q) => shift(q, grid)),
  };
}

const NKG_EPOCH = 2000.0;

/**
 * ITRF (any frame `transformFrame` knows, at coordinate epoch `epoch`) →
 * a Nordic national frame, geocentric. Throws outside the models.
 */
export function itrfToNkg(
  xyz: readonly [number, number, number],
  from: ReferenceFrame,
  epoch: number,
  to: NkgFrame,
  models: NkgModels
): V3 {
  const v = models.velocity;
  const etrf14 = transformFrame(xyz, from, 'ETRF2014', epoch);
  const nkg = deform(etrf14, v, NKG_EPOCH - epoch);
  const n2000 = nationalStep(to, models).forward(nkg);
  return deform(n2000, v, NKG_FRAMES[to].epoch - NKG_EPOCH);
}

/** A Nordic national frame → ITRF frame `to` at coordinate epoch `epoch`. */
export function nkgToItrf(
  xyz: readonly [number, number, number],
  from: NkgFrame,
  to: ReferenceFrame,
  epoch: number,
  models: NkgModels
): V3 {
  const v = models.velocity;
  const n2000 = invert([...xyz], (p) =>
    deform(p, v, NKG_FRAMES[from].epoch - NKG_EPOCH)
  );
  const nkg = nationalStep(from, models).inverse(n2000);
  const etrf14 = invert(nkg, (p) => deform(p, v, NKG_EPOCH - epoch));
  return transformFrame(etrf14, 'ETRF2014', to, epoch);
}

/**
 * ITRF → SWEREF 99 geocentric coordinates. Throws outside the velocity
 * model. Same as `itrfToNkg(…, 'SWEREF 99', { velocity: model })`.
 */
export function itrfToSweref99(
  xyz: readonly [number, number, number],
  from: ReferenceFrame,
  epoch: number,
  model: VelocityModel
): V3 {
  return itrfToNkg(xyz, from, epoch, 'SWEREF 99', { velocity: model });
}

/** SWEREF 99 → ITRF frame `to` at coordinate epoch `epoch`. */
export function sweref99ToItrf(
  xyz: readonly [number, number, number],
  to: ReferenceFrame,
  epoch: number,
  model: VelocityModel
): V3 {
  return nkgToItrf(xyz, 'SWEREF 99', to, epoch, { velocity: model });
}
