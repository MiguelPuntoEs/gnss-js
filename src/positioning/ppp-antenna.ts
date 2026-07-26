/**
 * ANTEX phase-centre application for PPP: satellite and receiver antenna
 * PCO (offset) + PCV (elevation-dependent variation), ionosphere-free
 * combined, with the nominal yaw-steering satellite attitude used to
 * rotate the satellite PCO from the body frame into ECEF.
 */

import type { AntexFile, AntennaEntry, FrequencyData } from '../antex/index';

export interface AntennaOffset {
  /** IF-combined PCO (m): satellite → body-frame [X,Y,Z]; receiver → ENU. */
  pco: [number, number, number];
  /** IF-combined no-azimuth PCV samples (m) over zenith/nadir angle. */
  pcvZen1Deg: number;
  pcvDzenDeg: number;
  pcvNoazi: number[];
}

export interface PppAntennaModel {
  satOffset(
    prn: string,
    dateMs: number,
    band1: string,
    band2: string,
    f1: number,
    f2: number
  ): AntennaOffset | null;
  rcvOffset(
    antType: string,
    band1: string,
    band2: string,
    f1: number,
    f2: number
  ): AntennaOffset | null;
}

/** Parse an ANTEX validity timestamp ("YYYY MM DD HH MM SS.sss") to ms. */
function parseAntexTime(s: string): number | null {
  const p = s.trim().split(/\s+/).map(Number);
  if (p.length < 3 || p.some((v) => Number.isNaN(v))) return null;
  return Date.UTC(
    p[0]!,
    (p[1]! || 1) - 1,
    p[2]! || 1,
    p[3] ?? 0,
    p[4] ?? 0,
    Math.floor(p[5] ?? 0)
  );
}

function freqOf(entry: AntennaEntry, code: string): FrequencyData | undefined {
  return entry.frequencies.find((f) => f.frequency === code);
}

/** IF-combine two antenna frequencies into PCO (m) + no-azi PCV (m). */
function combineIf(
  fA: FrequencyData,
  fB: FrequencyData,
  f1: number,
  f2: number
): AntennaOffset {
  const g = (f1 * f1) / (f1 * f1 - f2 * f2);
  const mm = 1e-3;
  const pco: [number, number, number] = [
    (g * fA.pcoN - (g - 1) * fB.pcoN) * mm,
    (g * fA.pcoE - (g - 1) * fB.pcoE) * mm,
    (g * fA.pcoU - (g - 1) * fB.pcoU) * mm,
  ];
  const nz = Math.min(fA.pcvNoazi.length, fB.pcvNoazi.length);
  const pcvNoazi = new Array<number>(nz);
  for (let i = 0; i < nz; i++) {
    pcvNoazi[i] = (g * fA.pcvNoazi[i]! - (g - 1) * fB.pcvNoazi[i]!) * mm;
  }
  return { pco, pcvZen1Deg: 0, pcvDzenDeg: 0, pcvNoazi };
}

export function buildPppAntenna(antex: AntexFile): PppAntennaModel {
  // Index satellites by PRN (multiple validity windows) and receivers by type.
  const sats = new Map<string, AntennaEntry[]>();
  const rcvs = new Map<string, AntennaEntry>();
  for (const a of antex.antennas) {
    if (a.isSatellite) {
      const list = sats.get(a.serialNo) ?? [];
      list.push(a);
      sats.set(a.serialNo, list);
    } else if (!rcvs.has(a.type)) {
      rcvs.set(a.type, a);
    }
  }

  const withZen = (entry: AntennaEntry, off: AntennaOffset): AntennaOffset => ({
    ...off,
    pcvZen1Deg: entry.zen1,
    pcvDzenDeg: entry.dzen,
  });

  return {
    satOffset(prn, dateMs, band1, band2, f1, f2) {
      const list = sats.get(prn);
      if (!list) return null;
      const entry = list.find((e) => {
        const from = parseAntexTime(e.validFrom);
        const until = parseAntexTime(e.validUntil);
        return (
          (from == null || dateMs >= from) && (until == null || dateMs <= until)
        );
      });
      if (!entry) return null;
      const a = freqOf(entry, band1);
      const b = freqOf(entry, band2);
      if (!a || !b) return null;
      return withZen(entry, combineIf(a, b, f1, f2));
    },
    rcvOffset(antType, band1, band2, f1, f2) {
      const entry = rcvs.get(antType);
      if (!entry) return null;
      const a = freqOf(entry, band1);
      const b = freqOf(entry, band2);
      if (!a || !b) return null;
      return withZen(entry, combineIf(a, b, f1, f2));
    },
  };
}

/* ================================================================== */
/*  Geometry helpers                                                   */
/* ================================================================== */

function cross(
  a: [number, number, number],
  b: [number, number, number]
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function norm(a: [number, number, number]): [number, number, number] {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
}
function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Nominal yaw-steering satellite body frame in ECEF.
 * z toward Earth, y along the solar-panel axis, x completing (sun side).
 */
export function satBodyFrame(
  satEcef: [number, number, number],
  sunEcef: [number, number, number]
): {
  x: [number, number, number];
  y: [number, number, number];
  z: [number, number, number];
} {
  const z = norm([-satEcef[0], -satEcef[1], -satEcef[2]]);
  const eSun = norm([
    sunEcef[0] - satEcef[0],
    sunEcef[1] - satEcef[1],
    sunEcef[2] - satEcef[2],
  ]);
  const y = norm(cross(z, eSun));
  const x = norm(cross(y, z));
  return { x, y, z };
}

/** Rotate a body-frame PCO [X,Y,Z] into ECEF via the satellite body frame. */
export function satPcoToEcef(
  pcoBody: [number, number, number],
  frame: {
    x: [number, number, number];
    y: [number, number, number];
    z: [number, number, number];
  }
): [number, number, number] {
  return [
    pcoBody[0] * frame.x[0] + pcoBody[1] * frame.y[0] + pcoBody[2] * frame.z[0],
    pcoBody[0] * frame.x[1] + pcoBody[1] * frame.y[1] + pcoBody[2] * frame.z[1],
    pcoBody[0] * frame.x[2] + pcoBody[1] * frame.y[2] + pcoBody[2] * frame.z[2],
  ];
}

/** Rotate a receiver ENU vector into ECEF at a geodetic lat/lon (rad). */
export function enuToEcef(
  enu: [number, number, number],
  latRad: number,
  lonRad: number
): [number, number, number] {
  const sl = Math.sin(latRad);
  const cl = Math.cos(latRad);
  const so = Math.sin(lonRad);
  const co = Math.cos(lonRad);
  const [e, n, u] = enu;
  return [
    -so * e - sl * co * n + cl * co * u,
    co * e - sl * so * n + cl * so * u,
    cl * n + sl * u,
  ];
}

/** Interpolate a no-azimuth PCV (m) at a zenith/nadir angle (deg). */
export function interpPcv(off: AntennaOffset, angleDeg: number): number {
  const { pcvZen1Deg, pcvDzenDeg, pcvNoazi } = off;
  if (pcvDzenDeg <= 0 || pcvNoazi.length < 2) return 0;
  const x = (angleDeg - pcvZen1Deg) / pcvDzenDeg;
  if (x <= 0) return pcvNoazi[0]!;
  if (x >= pcvNoazi.length - 1) return pcvNoazi[pcvNoazi.length - 1]!;
  const i = Math.floor(x);
  const t = x - i;
  return pcvNoazi[i]! * (1 - t) + pcvNoazi[i + 1]! * t;
}

export { dot as vdot, norm as vnorm, cross as vcross };

/**
 * Carrier-phase wind-up (cycles, unwrapped), Wu et al. (1993). For a static
 * receiver the receiver dipole contribution is constant (absorbed by the
 * ambiguity); the variation comes from the satellite yaw. `state` carries
 * the accumulated (continuous) value per satellite.
 */
export function phaseWindup(
  prn: string,
  losRcvToSat: [number, number, number],
  satFrame: {
    x: [number, number, number];
    y: [number, number, number];
    z: [number, number, number];
  },
  latRad: number,
  lonRad: number,
  state: Map<string, number>
): number {
  const k: [number, number, number] = [
    -losRcvToSat[0],
    -losRcvToSat[1],
    -losRcvToSat[2],
  ]; // satellite → receiver
  const kx = satFrame.x;
  const ky = satFrame.y;
  const kdotx = dot(k, kx);
  const kcrossY = cross(k, ky);
  const dS: [number, number, number] = [
    kx[0] - k[0] * kdotx - kcrossY[0],
    kx[1] - k[1] * kdotx - kcrossY[1],
    kx[2] - k[2] * kdotx - kcrossY[2],
  ];
  // Receiver dipole from local North (x) and East (y).
  const north = enuToEcef([0, 1, 0], latRad, lonRad);
  const east = enuToEcef([1, 0, 0], latRad, lonRad);
  const kdotn = dot(k, north);
  const kcrossE = cross(k, east);
  const dR: [number, number, number] = [
    north[0] - k[0] * kdotn + kcrossE[0],
    north[1] - k[1] * kdotn + kcrossE[1],
    north[2] - k[2] * kdotn + kcrossE[2],
  ];
  const nS = Math.hypot(dS[0], dS[1], dS[2]) || 1;
  const nR = Math.hypot(dR[0], dR[1], dR[2]) || 1;
  let cosPhi = dot(dS, dR) / (nS * nR);
  cosPhi = Math.max(-1, Math.min(1, cosPhi));
  const zeta = cross(dS, dR);
  const sign = dot(k, zeta) >= 0 ? 1 : -1;
  const dphi = (sign * Math.acos(cosPhi)) / (2 * Math.PI); // cycles
  const prev = state.get(prn);
  const wu = prev == null ? dphi : dphi + Math.round(prev - dphi);
  state.set(prn, wu);
  return wu;
}
