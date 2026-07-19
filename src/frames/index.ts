/**
 * Terrestrial reference frame transformations.
 *
 * Time-dependent 14-parameter Helmert transformations between ITRF
 * realizations, the ETRS89 realizations (ETRF2000/2014/2020), and
 * NAD83(2011). All parameters are taken verbatim from authoritative
 * sources — IERS/IGN for ITRF↔ITRF, EPSG registry entries for the
 * rest — never re-derived. Each parameter set cites its source.
 *
 * Conventions: parameters are stored in the IERS "Position Vector"
 * convention (rotations describe the rotation of the position vector,
 * CRS source→target:  Xs = X + T + D·X + R·X  with
 *   R·X = (−R3·y + R2·z,  R3·x − R1·z,  −R2·x + R1·y) ).
 * EPSG entries published in the opposite "Coordinate Frame rotation"
 * convention (NAD83) have their rotations negated at definition time.
 *
 * WGS84 note: the current WGS84 realization (G2296) is aligned to
 * ITRF2020 at the few-cm level; this module treats 'WGS84' as an alias
 * of ITRF2020, which is the standard GNSS practice.
 */

/* ================================================================== */
/*  Types                                                              */
/* ================================================================== */

export type ReferenceFrame =
  | 'ITRF2020'
  | 'ITRF2014'
  | 'ITRF2008'
  | 'ITRF2005'
  | 'ITRF2000'
  | 'ITRF97'
  | 'ITRF96'
  | 'ITRF94'
  | 'ITRF93'
  | 'ITRF92'
  | 'ITRF91'
  | 'ITRF90'
  | 'ITRF89'
  | 'ITRF88'
  | 'ETRF2020'
  | 'ETRF2014'
  | 'ETRF2000'
  | 'NAD83(2011)'
  | 'WGS84';

/**
 * 14-parameter Helmert set (Position Vector convention).
 * Units: translations mm (rates mm/yr), scale ppb (ppb/yr),
 * rotations mas (mas/yr); epoch in decimal years.
 */
export interface Helmert14 {
  t: [number, number, number];
  d: number;
  r: [number, number, number];
  tDot: [number, number, number];
  dDot: number;
  rDot: [number, number, number];
  epoch: number;
}

/* ================================================================== */
/*  Parameter sets (verbatim from sources cited)                       */
/* ================================================================== */

const H = (
  t: [number, number, number],
  d: number,
  r: [number, number, number],
  tDot: [number, number, number],
  dDot: number,
  rDot: [number, number, number],
  epoch: number
): Helmert14 => ({ t, d, r, tDot, dDot, rDot, epoch });

const Z: [number, number, number] = [0, 0, 0];

/**
 * ITRF2020 → ITRFxx, IERS/IGN table (epoch 2015.0):
 * https://itrf.ign.fr/docs/solutions/itrf2020/Transfo-ITRF2020_TRFs.txt
 */
const FROM_ITRF2020: Partial<Record<ReferenceFrame, Helmert14>> = {
  ITRF2014: H([-1.4, -0.9, 1.4], -0.42, Z, [0.0, -0.1, 0.2], 0, Z, 2015.0),
  ITRF2008: H([0.2, 1.0, 3.3], -0.29, Z, [0.0, -0.1, 0.1], 0.03, Z, 2015.0),
  ITRF2005: H([2.7, 0.1, -1.4], 0.65, Z, [0.3, -0.1, 0.1], 0.03, Z, 2015.0),
  ITRF2000: H([-0.2, 0.8, -34.2], 2.25, Z, [0.1, 0.0, -1.7], 0.11, Z, 2015.0),
  ITRF97: H(
    [6.5, -3.9, -77.9],
    3.98,
    [0, 0, 0.36],
    [0.1, -0.6, -3.1],
    0.12,
    [0, 0, 0.02],
    2015.0
  ),
  ITRF96: H(
    [6.5, -3.9, -77.9],
    3.98,
    [0, 0, 0.36],
    [0.1, -0.6, -3.1],
    0.12,
    [0, 0, 0.02],
    2015.0
  ),
  ITRF94: H(
    [6.5, -3.9, -77.9],
    3.98,
    [0, 0, 0.36],
    [0.1, -0.6, -3.1],
    0.12,
    [0, 0, 0.02],
    2015.0
  ),
  ITRF93: H(
    [-65.8, 1.9, -71.3],
    4.47,
    [-3.36, -4.33, 0.75],
    [-2.8, -0.2, -2.3],
    0.12,
    [-0.11, -0.19, 0.07],
    2015.0
  ),
  ITRF92: H(
    [14.5, -1.9, -85.9],
    3.27,
    [0, 0, 0.36],
    [0.1, -0.6, -3.1],
    0.12,
    [0, 0, 0.02],
    2015.0
  ),
  ITRF91: H(
    [26.5, 12.1, -91.9],
    4.67,
    [0, 0, 0.36],
    [0.1, -0.6, -3.1],
    0.12,
    [0, 0, 0.02],
    2015.0
  ),
  ITRF90: H(
    [24.5, 8.1, -107.9],
    4.97,
    [0, 0, 0.36],
    [0.1, -0.6, -3.1],
    0.12,
    [0, 0, 0.02],
    2015.0
  ),
  ITRF89: H(
    [29.5, 32.1, -145.9],
    8.37,
    [0, 0, 0.36],
    [0.1, -0.6, -3.1],
    0.12,
    [0, 0, 0.02],
    2015.0
  ),
  ITRF88: H(
    [24.5, -3.9, -169.9],
    11.47,
    [0.1, 0, 0.36],
    [0.1, -0.6, -3.1],
    0.12,
    [0, 0, 0.02],
    2015.0
  ),
  /** ITRF2020 → ETRF2020, EPSG:10572 (epoch-1989 variant) */
  ETRF2020: H(Z, 0, Z, Z, 0, [0.086, 0.519, -0.753], 1989.0),
};

/** ITRF2014 → ETRF2014, EPSG:8366 */
const ITRF2014_TO_ETRF2014 = H(Z, 0, Z, Z, 0, [0.085, 0.531, -0.77], 1989.0);

/** ITRF2014 → ETRF2000, EPSG:8405 */
const ITRF2014_TO_ETRF2000 = H(
  [54.7, 52.2, -74.1],
  2.12,
  [1.701, 10.29, -16.632],
  [0.1, 0.1, -1.9],
  0.11,
  [0.081, 0.49, -0.792],
  2010.0
);

/**
 * ITRF2014 → NAD83(2011), EPSG:8970. Published in the Coordinate Frame
 * rotation convention — rotations negated here to Position Vector.
 * (Translations given in metres in the registry; stored as mm.)
 */
const ITRF2014_TO_NAD83_2011 = H(
  [1005.3, -1909.21, -541.57],
  0.36891,
  [-26.78138, 0.42027, -10.93206],
  [0.79, -0.6, -1.44],
  -0.07201,
  [-0.06667, 0.75744, 0.05133],
  2010.0
);

/* ================================================================== */
/*  Helmert application                                                */
/* ================================================================== */

const MAS_TO_RAD = Math.PI / (180 * 3600 * 1000);

/**
 * Apply a time-dependent Helmert transformation (Position Vector
 * convention) to geocentric coordinates, evaluated at `epoch`
 * (decimal years). Pass `inverse` to go target → source.
 */
export function applyHelmert(
  xyz: readonly [number, number, number],
  p: Helmert14,
  epoch: number,
  inverse = false
): [number, number, number] {
  const dt = epoch - p.epoch;
  const sign = inverse ? -1 : 1;
  const tx = (sign * (p.t[0] + p.tDot[0] * dt)) / 1000;
  const ty = (sign * (p.t[1] + p.tDot[1] * dt)) / 1000;
  const tz = (sign * (p.t[2] + p.tDot[2] * dt)) / 1000;
  const d = sign * (p.d + p.dDot * dt) * 1e-9;
  const rx = sign * (p.r[0] + p.rDot[0] * dt) * MAS_TO_RAD;
  const ry = sign * (p.r[1] + p.rDot[1] * dt) * MAS_TO_RAD;
  const rz = sign * (p.r[2] + p.rDot[2] * dt) * MAS_TO_RAD;

  const [x, y, z] = xyz;
  return [
    x + tx + d * x - rz * y + ry * z,
    y + ty + rz * x + d * y - rx * z,
    z + tz - ry * x + rx * y + d * z,
  ];
}

/* ================================================================== */
/*  Frame graph                                                        */
/* ================================================================== */

interface Edge {
  from: ReferenceFrame;
  to: ReferenceFrame;
  p: Helmert14;
}

const EDGES: Edge[] = [
  ...Object.entries(FROM_ITRF2020).map(([to, p]) => ({
    from: 'ITRF2020' as ReferenceFrame,
    to: to as ReferenceFrame,
    p: p!,
  })),
  { from: 'ITRF2014', to: 'ETRF2014', p: ITRF2014_TO_ETRF2014 },
  { from: 'ITRF2014', to: 'ETRF2000', p: ITRF2014_TO_ETRF2000 },
  { from: 'ITRF2014', to: 'NAD83(2011)', p: ITRF2014_TO_NAD83_2011 },
];

/** Frames supported by transformFrame (WGS84 is an ITRF2020 alias). */
export const REFERENCE_FRAMES: ReferenceFrame[] = [
  'WGS84',
  'ITRF2020',
  'ITRF2014',
  'ITRF2008',
  'ITRF2005',
  'ITRF2000',
  'ITRF97',
  'ITRF96',
  'ITRF94',
  'ITRF93',
  'ITRF92',
  'ITRF91',
  'ITRF90',
  'ITRF89',
  'ITRF88',
  'ETRF2020',
  'ETRF2014',
  'ETRF2000',
  'NAD83(2011)',
];

function resolveAlias(f: ReferenceFrame): ReferenceFrame {
  return f === 'WGS84' ? 'ITRF2020' : f;
}

/** BFS over the (tiny) edge graph; returns the edge path with directions. */
function findPath(
  from: ReferenceFrame,
  to: ReferenceFrame
): { edge: Edge; inverse: boolean }[] | null {
  if (from === to) return [];
  const queue: ReferenceFrame[] = [from];
  const cameFrom = new Map<
    ReferenceFrame,
    { prev: ReferenceFrame; edge: Edge; inverse: boolean }
  >();
  const seen = new Set<ReferenceFrame>([from]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const edge of EDGES) {
      let next: ReferenceFrame | null = null;
      let inverse = false;
      if (edge.from === cur) {
        next = edge.to;
      } else if (edge.to === cur) {
        next = edge.from;
        inverse = true;
      }
      if (next === null || seen.has(next)) continue;
      seen.add(next);
      cameFrom.set(next, { prev: cur, edge, inverse });
      if (next === to) {
        const path: { edge: Edge; inverse: boolean }[] = [];
        let node = to;
        while (node !== from) {
          const step = cameFrom.get(node)!;
          path.unshift({ edge: step.edge, inverse: step.inverse });
          node = step.prev;
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/**
 * Transform geocentric coordinates between reference frames at a given
 * coordinate epoch (decimal years, e.g. 2010.5).
 *
 * The epoch is the epoch of the coordinates themselves — the same
 * physical location is expressed in both frames at that instant; no
 * intra-plate velocity propagation is applied.
 */
export function transformFrame(
  xyz: readonly [number, number, number],
  from: ReferenceFrame,
  to: ReferenceFrame,
  epoch: number
): [number, number, number] {
  const src = resolveAlias(from);
  const dst = resolveAlias(to);
  const path = findPath(src, dst);
  if (!path) {
    throw new Error(`No transformation path from ${from} to ${to}`);
  }
  let out: [number, number, number] = [xyz[0], xyz[1], xyz[2]];
  for (const { edge, inverse } of path) {
    out = applyHelmert(out, edge.p, epoch, inverse);
  }
  return out;
}

/** Convert a Date to the decimal-year epoch used by transformFrame. */
export function dateToEpoch(date: Date): number {
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  return year + (date.getTime() - start) / (end - start);
}
