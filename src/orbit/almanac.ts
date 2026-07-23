/**
 * Almanac orbit propagation for GPS/Galileo/BeiDou Kepler almanacs
 * (SbfKeplerAlmanac — absolute elements as normalized by the SBF
 * decoder) — the planner-facing counterpart of `keplerPosition`.
 *
 * Differences from the ephemeris path, both deliberate:
 *  - the time offset from the almanac epoch is NOT folded into the
 *    ±302 400 s half-week window: almanacs are meant to be propagated
 *    days ahead, and the fold would silently wrap a Tuesday query
 *    onto the previous Friday;
 *  - no harmonic corrections, Δn or IDOT exist in an almanac — the
 *    resulting positions are almanac-class (km-level), which is the
 *    contract: visibility/elevation planning, not ranging.
 *
 * IS-GPS-200 §20.3.3.5.2.1 (almanac user algorithm), Galileo OS ICD
 * §5.1.10, BDS ICD §5.2.4.15 — the same Kepler solution with the
 * per-system GM/rotation conventions used by `keplerPosition`, and
 * the BDS-GEO doubly-rotated frame per the BDS ICD.
 */

import { OMEGA_E } from '../constants/gnss';
import type { SbfKeplerAlmanac } from '../sbf/nav';

const GM_GPS = 3.986005e14;
const GM_GAL = 3.986004418e14;
const GM_BDS = 3.986004418e14;

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const BDT_EPOCH_MS = Date.UTC(2006, 0, 1);
const WEEK_MS = 604800_000;
/** BDT = GPST − 14 s. */
const BDT_MINUS_GPST_MS = 14_000;

/** BDS GEO PRN slots per the BDS ICD (C01–C05, C59–C63). */
const BDS_GEO_PRNS = new Set([1, 2, 3, 4, 5, 59, 60, 61, 62, 63]);

export interface AlmanacPosition {
  prn: string;
  /** ECEF position in metres (WGS84/GTRF/CGCS2000 per system). */
  x: number;
  y: number;
  z: number;
  /** SV clock offset at t in seconds (af0 + af1·Δt). */
  clockBias: number;
}

/** GPS-scale epoch ms of the almanac reference time. */
export function almanacEpochMs(alm: SbfKeplerAlmanac): number {
  if (alm.system === 'C') {
    return (
      BDT_EPOCH_MS +
      alm.weekAlm * WEEK_MS +
      alm.toaSec * 1000 +
      BDT_MINUS_GPST_MS
    );
  }
  // GPS and Galileo almanac weeks are GPS-aligned (decoder-normalized).
  return GPS_EPOCH_MS + alm.weekAlm * WEEK_MS + alm.toaSec * 1000;
}

/**
 * Propagate a Kepler almanac to `timeMs` (GPS-scale epoch ms, the
 * repo-wide convention). Valid for offsets of several days around the
 * almanac epoch; accuracy degrades gracefully (km → tens of km over
 * a week, per the almanac design).
 */
export function almanacSatPosition(
  alm: SbfKeplerAlmanac,
  timeMs: number
): AlmanacPosition {
  const GM = alm.system === 'E' ? GM_GAL : alm.system === 'C' ? GM_BDS : GM_GPS;
  const a = alm.sqrtA * alm.sqrtA;
  const n0 = Math.sqrt(GM / (a * a * a));

  // Unfolded time from the almanac reference epoch (seconds).
  const tk = (timeMs - almanacEpochMs(alm)) / 1000;

  // Kepler solution (no Δn, no harmonics in an almanac)
  const Mk = alm.m0 + n0 * tk;
  let Ek = Mk;
  for (let i = 0; i < 12; i++) {
    const dE = (Mk - (Ek - alm.e * Math.sin(Ek))) / (1 - alm.e * Math.cos(Ek));
    Ek += dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  const sinE = Math.sin(Ek);
  const cosE = Math.cos(Ek);
  const vk = Math.atan2(Math.sqrt(1 - alm.e * alm.e) * sinE, cosE - alm.e);

  const uk = vk + alm.omega;
  const rk = a * (1 - alm.e * cosE);
  const ik = alm.i0OrDeltaI;

  const xp = rk * Math.cos(uk);
  const yp = rk * Math.sin(uk);

  const clockBias = alm.af0 + alm.af1 * tk;

  const isGeo =
    alm.system === 'C' && BDS_GEO_PRNS.has(Number(alm.prn.slice(1)));

  if (isGeo) {
    // BDS GEO: node without Earth rotation, then Rz(ΩE·tk)·Rx(−5°).
    const omegak = alm.omega0 + alm.omegaDot * tk - OMEGA_E * alm.toaSec;
    const cosO = Math.cos(omegak);
    const sinO = Math.sin(omegak);
    const cosI = Math.cos(ik);
    const sinI = Math.sin(ik);
    const xg = xp * cosO - yp * cosI * sinO;
    const yg = xp * sinO + yp * cosI * cosO;
    const zg = yp * sinI;
    const phi = OMEGA_E * tk;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    const COS5 = Math.cos((-5 * Math.PI) / 180);
    const SIN5 = Math.sin((-5 * Math.PI) / 180);
    return {
      prn: alm.prn,
      x: xg * cosPhi + yg * sinPhi * COS5 + zg * sinPhi * SIN5,
      y: -xg * sinPhi + yg * cosPhi * COS5 + zg * cosPhi * SIN5,
      z: -yg * SIN5 + zg * COS5,
      clockBias,
    };
  }

  // MEO/IGSO: Earth rotation folded into the node. The reference-time
  // term uses the system-scale seconds of week (BDT sow for BeiDou),
  // matching the ephemeris path's convention.
  const omegak =
    alm.omega0 + (alm.omegaDot - OMEGA_E) * tk - OMEGA_E * alm.toaSec;
  const cosO = Math.cos(omegak);
  const sinO = Math.sin(omegak);
  const cosI = Math.cos(ik);
  const sinI = Math.sin(ik);

  return {
    prn: alm.prn,
    x: xp * cosO - yp * cosI * sinO,
    y: xp * sinO + yp * cosI * cosO,
    z: yp * sinI,
    clockBias,
  };
}
