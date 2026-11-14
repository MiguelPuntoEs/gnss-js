/**
 * ANTEX phase-centre application for PPP: satellite and receiver antenna
 * PCO (offset) + PCV (elevation-dependent variation), ionosphere-free
 * combined, with the nominal yaw-steering satellite attitude used to
 * rotate the satellite PCO from the body frame into ECEF.
 */

import type { AntexFile, AntennaEntry, FrequencyData } from '../antex/index';

export interface AntennaOffset {
  /** IF-combined PCO (m): satellite → body-frame [X,Y,Z]; receiver →
   *  [North, East, Up], ANTEX's order (not ENU — swap before adding to an
   *  ENU antenna delta). */
  pco: [number, number, number];
  /** IF-combined no-azimuth PCV samples (m) over zenith/nadir angle. */
  pcvZen1Deg: number;
  pcvDzenDeg: number;
  pcvNoazi: number[];
  /** Azimuth step (deg) of `pcvAzi`; absent/0 = no azimuth dependence. */
  pcvDaziDeg?: number;
  /** IF-combined azimuth-dependent PCV (m): rows = azimuth 0…360 by
   *  `pcvDaziDeg`, columns = the zenith angles of `pcvNoazi`. When present
   *  it replaces `pcvNoazi` (ANTEX: the full pattern). */
  pcvAzi?: number[][];
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
  // parseAntex normalises VALID FROM/UNTIL to "YYYY-MM-DD HH:MM"; raw
  // ANTEX fields read "YYYY MM DD HH MM SS.S". Accept both.
  const p = s
    .trim()
    .split(/[\s:-]+/)
    .map(Number);
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

/** A pattern value, with a missing one (ANTEX 2.0 blank, NaN) as 0. */
const pv = (v: number | undefined) =>
  v !== undefined && Number.isFinite(v) ? v : 0;

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
    pcvNoazi[i] = (g * pv(fA.pcvNoazi[i]) - (g - 1) * pv(fB.pcvNoazi[i])) * mm;
  }
  const rows = Math.min(fA.pcv.length, fB.pcv.length);
  const pcvAzi = rows
    ? Array.from({ length: rows }, (_, r) => {
        const a = fA.pcv[r]!;
        const b = fB.pcv[r]!;
        const n = Math.min(a.length, b.length, nz);
        return Array.from(
          { length: n },
          (_, i) => (g * pv(a[i]) - (g - 1) * pv(b[i])) * mm
        );
      })
    : undefined;
  return {
    pco,
    pcvZen1Deg: 0,
    pcvDzenDeg: 0,
    pcvNoazi,
    ...(pcvAzi ? { pcvAzi } : {}),
  };
}

export interface PppAntennaBuildOptions {
  /**
   * Receiver antennas calibrated for GPS only, used on another
   * constellation: 'gps-bands' (default, as RTKLIB) takes the GPS L1/L2
   * patterns as the two bands and combines them with that constellation's
   * frequencies; 'gps-if' uses the GPS L1/L2 ionosphere-free phase centre
   * unchanged — the combination the calibration describes.
   */
  missingBands?: 'gps-bands' | 'gps-if';
}

export function buildPppAntenna(
  antex: AntexFile,
  options: PppAntennaBuildOptions = {}
): PppAntennaModel {
  // Index satellites by PRN (multiple validity windows) and receivers by type.
  const sats = new Map<string, AntennaEntry[]>();
  const rcvs = new Map<string, AntennaEntry>();
  for (const a of antex.antennas) {
    if (a.isSatellite) {
      const list = sats.get(a.serialNo) ?? [];
      list.push(a);
      sats.set(a.serialNo, list);
    } else if (
      !rcvs.has(a.type) ||
      (!a.serialNo && rcvs.get(a.type)!.serialNo)
    ) {
      // The type mean (blank serial number) over individual calibrations.
      rcvs.set(a.type, a);
    }
  }

  const withZen = (entry: AntennaEntry, off: AntennaOffset): AntennaOffset => {
    const { pcvAzi, ...rest } = off;
    return {
      ...rest,
      pcvZen1Deg: entry.zen1,
      pcvDzenDeg: entry.dzen,
      ...(pcvAzi && entry.dazi > 0 ? { pcvAzi, pcvDaziDeg: entry.dazi } : {}),
    };
  };

  return {
    satOffset(prn, dateMs, band1, band2, f1, f2) {
      const list = sats.get(prn);
      if (!list) return null;
      // The entry whose validity window contains the date; outside every
      // window (ANTEX not yet updated for a PRN's new spacecraft, or a
      // retired PRN) the nearest window's.
      let entry: AntennaEntry | undefined;
      let bestDist = Infinity;
      for (const e of list) {
        const from = parseAntexTime(e.validFrom) ?? -Infinity;
        const until = parseAntexTime(e.validUntil) ?? Infinity;
        if (dateMs >= from && dateMs <= until) {
          entry = e;
          break;
        }
        const dist = dateMs < from ? from - dateMs : dateMs - until;
        if (dist < bestDist) {
          bestDist = dist;
          entry = e;
        }
      }
      if (!entry) return null;
      // A band the entry lacks (e.g. a new signal before the ANTEX has it):
      // the satellite's other calibrated band, so a known satellite always
      // gets its offset (null means "satellite unknown", which PPP drops).
      const any = entry.frequencies[0];
      const a = freqOf(entry, band1) ?? freqOf(entry, band2) ?? any;
      const b = freqOf(entry, band2) ?? freqOf(entry, band1) ?? any;
      if (!a || !b) return null;
      return withZen(entry, combineIf(a, b, f1, f2));
    },
    rcvOffset(antType, band1, band2, f1, f2) {
      // Exact type + radome, else the same antenna without a radome (IGS
      // practice when a radome combination is uncalibrated).
      const entry =
        rcvs.get(antType) ??
        rcvs.get(antType.substring(0, 16).padEnd(16, ' ') + 'NONE');
      if (!entry) return null;
      let a = freqOf(entry, band1);
      let b = freqOf(entry, band2);
      // Calibrations for Galileo/BeiDou bands are missing for many antennas:
      // fall back to GPS L1/L2, as RTKLIB does.
      let fa = f1;
      let fb = f2;
      if (!a || !b) {
        a = freqOf(entry, 'G01');
        b = freqOf(entry, 'G02');
        if (options.missingBands === 'gps-if') {
          fa = 1575.42e6;
          fb = 1227.6e6;
        }
      }
      if (!a || !b) return null;
      return withZen(entry, combineIf(a, b, fa, fb));
    },
  };
}

/**
 * A model whose *satellite* antennas come from `satellites` (for the PRNs it
 * calibrates) and everything else from `base`. Precise clocks absorb the
 * satellite phase-centre model they were estimated with, so PPP has to
 * apply the same one: ESA's MGEX products, for instance, use their own
 * BeiDou offsets (ESA14_2018: BeiDou-3 z-offsets 0.4–0.5 m larger than
 * igs20's), and from 2025 the whole ESA23 model. `systems` limits the
 * override to some constellations (letters, e.g. "C"); default all.
 */
export function withSatelliteAntennas(
  base: PppAntennaModel,
  satellites: PppAntennaModel,
  systems?: string
): PppAntennaModel {
  return {
    satOffset(prn, dateMs, band1, band2, f1, f2) {
      const own =
        !systems || systems.includes(prn[0]!)
          ? satellites.satOffset(prn, dateMs, band1, band2, f1, f2)
          : null;
      return own ?? base.satOffset(prn, dateMs, band1, band2, f1, f2);
    },
    rcvOffset: (...a) => base.rcvOffset(...a),
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

/** Linear interpolation along one zenith row. */
function interpRow(
  row: readonly number[],
  zen1: number,
  dzen: number,
  angleDeg: number
): number {
  const x = (angleDeg - zen1) / dzen;
  if (x <= 0) return row[0]!;
  if (x >= row.length - 1) return row[row.length - 1]!;
  const i = Math.floor(x);
  const t = x - i;
  return row[i]! * (1 - t) + row[i + 1]! * t;
}

/**
 * Interpolate the PCV (m) at a zenith/nadir angle (deg) — and, when the
 * offset carries an azimuth grid and `azimuthDeg` is given, bilinearly in
 * azimuth too (north = 0°, clockwise, as ANTEX).
 */
export function interpPcv(
  off: AntennaOffset,
  angleDeg: number,
  azimuthDeg?: number
): number {
  const { pcvZen1Deg, pcvDzenDeg, pcvNoazi, pcvAzi, pcvDaziDeg } = off;
  if (pcvDzenDeg <= 0) return 0;
  if (
    azimuthDeg !== undefined &&
    pcvAzi &&
    pcvAzi.length >= 2 &&
    pcvDaziDeg &&
    pcvDaziDeg > 0
  ) {
    const az = ((azimuthDeg % 360) + 360) % 360;
    const y = Math.min(az / pcvDaziDeg, pcvAzi.length - 1);
    const j = Math.min(Math.floor(y), pcvAzi.length - 2);
    const u = y - j;
    const a = interpRow(pcvAzi[j]!, pcvZen1Deg, pcvDzenDeg, angleDeg);
    const b = interpRow(pcvAzi[j + 1]!, pcvZen1Deg, pcvDzenDeg, angleDeg);
    return a * (1 - u) + b * u;
  }
  if (pcvNoazi.length < 2) return 0;
  return interpRow(pcvNoazi, pcvZen1Deg, pcvDzenDeg, angleDeg);
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
  // Receiver dipole: x = North, y = West (RTKLIB windupcorr):
  // dR = x − k(k·x) + k × y.
  const north = enuToEcef([0, 1, 0], latRad, lonRad);
  const west = enuToEcef([-1, 0, 0], latRad, lonRad);
  const kdotn = dot(k, north);
  const kcrossW = cross(k, west);
  const dR: [number, number, number] = [
    north[0] - k[0] * kdotn + kcrossW[0],
    north[1] - k[1] * kdotn + kcrossW[1],
    north[2] - k[2] * kdotn + kcrossW[2],
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
