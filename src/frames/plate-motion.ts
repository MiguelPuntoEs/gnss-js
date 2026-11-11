/**
 * Plate motion: moving ITRF2020 coordinates from one epoch to another.
 *
 * A point on the ground moves in ITRF with its tectonic plate — a few
 * centimetres a year. `transformFrame` changes the frame at one epoch;
 * this module changes the epoch within ITRF2020, with either a velocity
 * the caller knows (a station's SINEX VELX/Y/Z, a campaign estimate) or
 * one predicted by the ITRF2020 plate motion model.
 *
 * ITRF2020-PMM: Altamimi, Métivier, Rebischung, Collilieux, Chanard &
 * Barnéoud (2023), "ITRF2020 Plate Motion Model", GRL 50,
 * doi:10.1029/2023GL106373 — rotation poles of 13 plates fitted to 518
 * ITRF2020 sites away from boundaries and deforming zones (0.25 mm/yr
 * WRMS), plus an origin rate bias (ORB) that users are told to add to the
 * horizontal velocities. Values as published in PROJ's `data/ITRF2020`
 * (Table 1 and 2 of the paper; PROJ gives the poles in arcsec/yr). The
 * model's vertical velocities are meaningless (its poles rotate the
 * plate rigidly), so velocities here are horizontal only.
 *
 * A rigid plate does not describe a deforming zone (plate boundaries,
 * Tibet, Japan, the Andes, California) or an earthquake. Which plate a
 * point is on is the caller's call; gnss-js ships no plate boundaries.
 */
import { ecefToGeodetic } from '../coordinates/ecef';

type V3 = [number, number, number];

/** The 13 plates of ITRF2020-PMM. */
export type PmmPlate =
  | 'AMUR'
  | 'ANTA'
  | 'ARAB'
  | 'AUST'
  | 'CARB'
  | 'EURA'
  | 'INDI'
  | 'NAZC'
  | 'NOAM'
  | 'NUBI'
  | 'PCFC'
  | 'SOAM'
  | 'SOMA';

export interface PmmPole {
  name: string;
  /** Rotation rate ω (x, y, z), mas/yr, Position Vector convention. */
  omega: V3;
}

/** ITRF2020-PMM rotation poles (Altamimi et al. 2023, Table 1). */
export const ITRF2020_PMM: Readonly<Record<PmmPlate, PmmPole>> = {
  AMUR: { name: 'Amurian', omega: [-0.131, -0.551, 0.837] },
  ANTA: { name: 'Antarctic', omega: [-0.269, -0.312, 0.678] },
  ARAB: { name: 'Arabian', omega: [1.129, -0.146, 1.438] },
  AUST: { name: 'Australian', omega: [1.487, 1.175, 1.223] },
  CARB: { name: 'Caribbean', omega: [0.207, -1.422, 0.726] },
  EURA: { name: 'Eurasian', omega: [-0.085, -0.519, 0.753] },
  INDI: { name: 'Indian', omega: [1.137, 0.013, 1.444] },
  NAZC: { name: 'Nazca', omega: [-0.327, -1.561, 1.605] },
  NOAM: { name: 'North American', omega: [0.045, -0.666, -0.098] },
  NUBI: { name: 'Nubian', omega: [0.09, -0.585, 0.717] },
  PCFC: { name: 'Pacific', omega: [-0.404, 1.021, -2.154] },
  SOAM: { name: 'South American', omega: [-0.261, -0.282, -0.157] },
  SOMA: { name: 'Somalian', omega: [-0.081, -0.719, 0.864] },
};

/** ITRF2020-PMM origin rate bias (x, y, z), mm/yr (Table 2). */
export const ITRF2020_PMM_ORB: Readonly<V3> = [0.37, 0.35, 0.74];

const MAS_TO_RAD = Math.PI / (180 * 3600 * 1000);

/**
 * Horizontal ITRF2020 velocity (ECEF, m/yr) of a point at `xyz` riding
 * `plate` rigidly: ω × X plus the origin rate bias, with the vertical
 * (local up) component removed.
 */
export function plateVelocity(xyz: readonly number[], plate: PmmPlate): V3 {
  const [x, y, z] = xyz as V3;
  const [wx, wy, wz] = ITRF2020_PMM[plate].omega.map(
    (w) => w * MAS_TO_RAD
  ) as V3;
  const orb = ITRF2020_PMM_ORB.map((o) => o / 1000);
  const v: V3 = [
    wy * z - wz * y + orb[0]!,
    wz * x - wx * z + orb[1]!,
    wx * y - wy * x + orb[2]!,
  ];
  const [lat, lon] = ecefToGeodetic(x, y, z);
  const up: V3 = [
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat),
  ];
  const vu = v[0] * up[0] + v[1] * up[1] + v[2] * up[2];
  return [v[0] - vu * up[0], v[1] - vu * up[1], v[2] - vu * up[2]];
}

/**
 * Move a position from one epoch to another (decimal years) with a
 * constant velocity (ECEF, m/yr), both in the same frame — ITRF2020 for
 * `plateVelocity`. Linear: no earthquakes, no post-seismic decay.
 */
export function propagatePosition(
  xyz: readonly number[],
  velocity: readonly number[],
  fromEpoch: number,
  toEpoch: number
): V3 {
  const dt = toEpoch - fromEpoch;
  return [
    xyz[0]! + velocity[0]! * dt,
    xyz[1]! + velocity[1]! * dt,
    xyz[2]! + velocity[2]! * dt,
  ];
}
