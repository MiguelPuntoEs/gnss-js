/**
 * NORAD general-perturbation element sets: TLE and OMM parsing, and the
 * glue from SGP4's TEME output to the Earth-fixed frame and this
 * library's time convention.
 *
 * Time: element epochs are UTC. Everywhere else in gnss-js an epoch in
 * milliseconds is the GPS clock face (GPS time written as if it were
 * UTC — the RINEX convention), so the helpers here take GPS-scale
 * milliseconds and remove the leap seconds themselves.
 */

import { ecefToGeodetic } from '../coordinates/ecef';
import { getGpsLeap } from '../time/utc';
import {
  gstime,
  jdFromUnixMs,
  julianDate,
  sgp4,
  sgp4Init,
  type GpElements,
  type Sgp4Satrec,
} from './sgp4';
import type { AllPositionsData, SatPoint, SatPosition } from './index';

const TWO_PI = 2 * Math.PI;
/** Earth rotation rate used with GMST-82 (rad/s). */
const OMEGA_EARTH = 7.292115146706979e-5;

/* ------------------------------------------------------------------ */
/*  TLE                                                                */
/* ------------------------------------------------------------------ */

/** Alpha-5: catalogue numbers ≥ 100 000 carry a letter in column 3
 *  (A = 10 … Z = 33, skipping I and O). */
function parseCatalogNumber(field: string): number {
  const f = field.trim();
  const c = f.charAt(0);
  if (/[A-HJ-NP-Z]/.test(c)) {
    let v = c.charCodeAt(0) - 55; // A → 10
    if (c > 'I') v -= 1;
    if (c > 'O') v -= 1;
    return v * 10000 + parseInt(f.slice(1), 10);
  }
  return parseInt(f, 10);
}

/** Inverse of parseCatalogNumber — the 5-character TLE field. */
export function formatCatalogNumber(norad: number): string {
  if (norad < 100000) return String(norad).padStart(5, '0');
  const lead = Math.floor(norad / 10000);
  let code = lead + 55;
  if (code >= 'I'.charCodeAt(0)) code += 1;
  if (code >= 'O'.charCodeAt(0)) code += 1;
  return String.fromCharCode(code) + String(norad % 10000).padStart(4, '0');
}

/** "12345-3" style assumed-decimal exponent field → number. */
function parseExpField(field: string): number {
  const f = field.trim();
  if (!f) return 0;
  const m = /^([+-]?)(\d+)([+-]\d)$/.exec(f.replace(/\s/g, ''));
  if (!m) return parseFloat(f) || 0;
  const mant = parseFloat(`0.${m[2]}`);
  return (m[1] === '-' ? -1 : 1) * mant * Math.pow(10, parseInt(m[3]!, 10));
}

/** TLE line checksum: digits sum, '-' counts 1, modulo 10. */
export function tleChecksum(line: string): number {
  let sum = 0;
  for (let i = 0; i < 68 && i < line.length; i++) {
    const c = line.charAt(i);
    if (c >= '0' && c <= '9') sum += c.charCodeAt(0) - 48;
    else if (c === '-') sum += 1;
  }
  return sum % 10;
}

/** Epoch year (2 digits) + fractional day of year → split Julian date. */
function epochFromYearDay(
  yy: number,
  doy: number
): { jd: number; jdFrac: number } {
  const year = yy < 57 ? yy + 2000 : yy + 1900;
  // Julian date of Jan 0.0 of `year`, then add the fractional day
  const jan0 = julianDate(year, 1, 1, 0, 0, 0).jd - 1;
  const whole = Math.floor(doy);
  return { jd: jan0 + whole, jdFrac: doy - whole };
}

export interface TleParseIssue {
  line: number;
  message: string;
}

/**
 * Parse one or more element sets in 2-line or 3-line (name + 2 lines)
 * form. Lines that don't belong to a set are skipped; malformed sets and
 * checksum mismatches are reported in `issues` (a bad checksum still
 * yields the set — many hand-edited files carry stale checksums).
 */
export function parseTle(text: string): {
  sets: GpElements[];
  issues: TleParseIssue[];
} {
  const lines = text.split(/\r?\n/);
  const sets: GpElements[] = [];
  const issues: TleParseIssue[] = [];
  let pendingName: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const l1 = lines[i]!.replace(/\s+$/, '');
    if (!l1) continue;
    if (l1.startsWith('1 ') && lines[i + 1]?.startsWith('2 ')) {
      const l2 = lines[i + 1]!.replace(/\s+$/, '');
      try {
        const el = parseTleLines(l1, l2, pendingName);
        if (l1.length >= 69 && tleChecksum(l1) !== +l1.charAt(68))
          issues.push({ line: i + 1, message: 'line 1 checksum mismatch' });
        if (l2.length >= 69 && tleChecksum(l2) !== +l2.charAt(68))
          issues.push({ line: i + 2, message: 'line 2 checksum mismatch' });
        sets.push(el);
      } catch (e) {
        issues.push({ line: i + 1, message: (e as Error).message });
      }
      pendingName = undefined;
      i++;
      continue;
    }
    if (l1.startsWith('#')) continue;
    // anything else is a candidate name line ("0 NAME" in some sources)
    pendingName = l1.replace(/^0 /, '').trim() || undefined;
  }
  return { sets, issues };
}

/** Parse a single TLE (two data lines, optional name). Throws on malformed input. */
export function parseTleLines(
  line1: string,
  line2: string,
  name?: string
): GpElements {
  if (line1.length < 64 || line2.length < 63)
    throw new Error('TLE line too short');
  const norad = parseCatalogNumber(line1.slice(2, 7));
  if (!Number.isFinite(norad)) throw new Error('bad catalogue number');
  const n2 = parseCatalogNumber(line2.slice(2, 7));
  if (n2 !== norad) throw new Error('catalogue numbers of line 1 and 2 differ');

  const yy = parseInt(line1.slice(18, 20), 10);
  const doy = parseFloat(line1.slice(20, 32));
  if (!Number.isFinite(yy) || !Number.isFinite(doy))
    throw new Error('bad epoch');
  const { jd, jdFrac } = epochFromYearDay(yy, doy);

  const ndot = parseFloat(line1.slice(33, 43).replace(/\s/g, '')) || 0;
  const nddot = parseExpField(line1.slice(44, 52));
  const bstar = parseExpField(line1.slice(53, 61));

  const num = (a: number, b: number): number => {
    const v = parseFloat(line2.slice(a, b));
    if (!Number.isFinite(v))
      throw new Error(`bad field at columns ${a + 1}–${b}`);
    return v;
  };
  const inclination = num(8, 16);
  const raan = num(17, 25);
  const eccentricity = parseFloat(`0.${line2.slice(26, 33).trim()}`);
  const argPerigee = num(34, 42);
  const meanAnomaly = num(43, 51);
  const meanMotion = num(52, 63);
  const revAtEpoch = parseInt(line2.slice(63, 68), 10);
  const elementSetNo = parseInt(line1.slice(64, 68), 10);

  return {
    norad,
    name: name || undefined,
    intlDesignator: line1.slice(9, 17).trim() || undefined,
    epochJd: jd,
    epochJdFrac: jdFrac,
    meanMotion,
    eccentricity,
    inclination,
    raan,
    argPerigee,
    meanAnomaly,
    bstar,
    meanMotionDot: ndot,
    meanMotionDdot: nddot,
    elementSetNo: Number.isFinite(elementSetNo) ? elementSetNo : undefined,
    revAtEpoch: Number.isFinite(revAtEpoch) ? revAtEpoch : undefined,
    classification: line1.charAt(7).trim() || undefined,
  };
}

/* ------------------------------------------------------------------ */
/*  OMM (CCSDS Orbit Mean-elements Message), JSON form                 */
/* ------------------------------------------------------------------ */

/** The OMM keyword set CelesTrak and Space-Track serve as JSON. */
export interface OmmRecord {
  OBJECT_NAME?: string;
  OBJECT_ID?: string;
  EPOCH: string;
  MEAN_MOTION: number | string;
  ECCENTRICITY: number | string;
  INCLINATION: number | string;
  RA_OF_ASC_NODE: number | string;
  ARG_OF_PERICENTER: number | string;
  MEAN_ANOMALY: number | string;
  NORAD_CAT_ID: number | string;
  BSTAR?: number | string;
  MEAN_MOTION_DOT?: number | string;
  MEAN_MOTION_DDOT?: number | string;
  ELEMENT_SET_NO?: number | string;
  REV_AT_EPOCH?: number | string;
  CLASSIFICATION_TYPE?: string;
}

/** ISO-8601 UTC epoch → split Julian date, keeping sub-millisecond digits. */
export function isoEpochToJd(iso: string): { jd: number; jdFrac: number } {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)Z?$/.exec(
      iso.trim()
    );
  if (!m) throw new Error(`bad OMM epoch "${iso}"`);
  return julianDate(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, parseFloat(m[6]!));
}

/** One OMM record (JSON keyword form) → elements. */
export function ommToElements(rec: OmmRecord): GpElements {
  const n = (v: number | string | undefined): number =>
    v === undefined || v === '' ? 0 : Number(v);
  const { jd, jdFrac } = isoEpochToJd(rec.EPOCH);
  return {
    norad: n(rec.NORAD_CAT_ID),
    name: rec.OBJECT_NAME?.trim() || undefined,
    intlDesignator: rec.OBJECT_ID || undefined,
    epochJd: jd,
    epochJdFrac: jdFrac,
    meanMotion: n(rec.MEAN_MOTION),
    eccentricity: n(rec.ECCENTRICITY),
    inclination: n(rec.INCLINATION),
    raan: n(rec.RA_OF_ASC_NODE),
    argPerigee: n(rec.ARG_OF_PERICENTER),
    meanAnomaly: n(rec.MEAN_ANOMALY),
    bstar: n(rec.BSTAR),
    meanMotionDot: n(rec.MEAN_MOTION_DOT),
    meanMotionDdot: n(rec.MEAN_MOTION_DDOT),
    elementSetNo:
      rec.ELEMENT_SET_NO !== undefined ? n(rec.ELEMENT_SET_NO) : undefined,
    revAtEpoch:
      rec.REV_AT_EPOCH !== undefined ? n(rec.REV_AT_EPOCH) : undefined,
    classification: rec.CLASSIFICATION_TYPE,
  };
}

/** Parse an OMM JSON document (array or single record). */
export function parseOmmJson(json: string | unknown): GpElements[] {
  const data = typeof json === 'string' ? (JSON.parse(json) as unknown) : json;
  const arr = Array.isArray(data) ? data : [data];
  return arr.map((r) => ommToElements(r as OmmRecord));
}

/**
 * Parse whatever element-set text a user pastes or drops: OMM JSON, or
 * 2/3-line TLEs.
 */
export function parseElementSets(text: string): {
  sets: GpElements[];
  issues: TleParseIssue[];
} {
  const t = text.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      return { sets: parseOmmJson(t), issues: [] };
    } catch (e) {
      return { sets: [], issues: [{ line: 1, message: (e as Error).message }] };
    }
  }
  return parseTle(t);
}

/* ------------------------------------------------------------------ */
/*  Epoch helpers                                                      */
/* ------------------------------------------------------------------ */

/** Element epoch as a UTC Date. */
export function elementEpochUtc(el: GpElements): Date {
  return new Date(
    Math.round((el.epochJd - 2440587.5 + el.epochJdFrac) * 86400000)
  );
}

/** Element-set age in days at a GPS-scale epoch (ms). */
export function elementAgeDays(el: GpElements, gpsMs: number): number {
  const utcMs = gpsMs - getGpsLeap(new Date(gpsMs)) * 1000;
  return jdFromUnixMs(utcMs) - (el.epochJd + el.epochJdFrac);
}

/* ------------------------------------------------------------------ */
/*  TEME → ECEF                                                        */
/* ------------------------------------------------------------------ */

/**
 * Rotate a TEME state (km, km/s) to the Earth-fixed frame (pseudo-Earth-
 * fixed: GMST-82 about z, polar motion ignored — ≤ 15 m, far below the
 * accuracy of a mean element set).
 * @param jdUt1 Julian date (UT1 ≈ UTC at this accuracy)
 */
export function temeToEcef(
  r: readonly [number, number, number],
  v: readonly [number, number, number],
  jdUt1: number
): { r: [number, number, number]; v: [number, number, number] } {
  const g = gstime(jdUt1);
  const c = Math.cos(g);
  const s = Math.sin(g);
  const rx = c * r[0] + s * r[1];
  const ry = -s * r[0] + c * r[1];
  const rz = r[2];
  // v_ecef = R·v_teme − ω × r_ecef
  const vx = c * v[0] + s * v[1] + OMEGA_EARTH * ry;
  const vy = -s * v[0] + c * v[1] - OMEGA_EARTH * rx;
  return { r: [rx, ry, rz], v: [vx, vy, v[2]] };
}

/** A propagator ready to evaluate at any epoch. */
export interface TleSatellite {
  elements: GpElements;
  satrec: Sgp4Satrec;
  /** Label used as the series key — PRN when known, else "NORAD 12345". */
  id: string;
}

/** Initialise a set for propagation. */
export function tleSatellite(el: GpElements, id?: string): TleSatellite {
  return {
    elements: el,
    satrec: sgp4Init(el),
    id: id ?? `NORAD ${el.norad}`,
  };
}

/**
 * Earth-fixed position (m) and velocity (m/s) at a GPS-scale epoch, or
 * null when SGP4 fails there (decayed, eccentricity out of range).
 */
export function tlePositionEcef(
  sat: TleSatellite,
  gpsMs: number
): SatPosition | null {
  const utcMs = gpsMs - getGpsLeap(new Date(gpsMs)) * 1000;
  const sr = sat.satrec;
  const tsince =
    (utcMs / 86400000 + 2440587.5 - sr.jdsatepoch - sr.jdsatepochF) * 1440;
  const res = sgp4(sr, tsince);
  if (!res || res.error) return null;
  const e = temeToEcef(res.r, res.v, jdFromUnixMs(utcMs));
  return {
    prn: sat.id,
    x: e.r[0] * 1000,
    y: e.r[1] * 1000,
    z: e.r[2] * 1000,
    vx: e.v[0] * 1000,
    vy: e.v[1] * 1000,
    vz: e.v[2] * 1000,
  };
}

/**
 * Tracks for many satellites over a time grid, in the same shape as the
 * broadcast-ephemeris `computeAllPositions` — so `computeVisibilityFromPositions`,
 * ground tracks and sky plots work unchanged.
 * @param times GPS-scale epochs (ms)
 * @param rxPos Receiver ECEF (m) for az/el; omit for ground tracks only
 */
export function computeTlePositions(
  sats: TleSatellite[],
  times: number[],
  rxPos?: [number, number, number]
): AllPositionsData {
  const prns = sats.map((s) => s.id);
  const positions: Record<string, (SatPoint | null)[]> = {};
  let sinLat = 0,
    cosLat = 1,
    sinLon = 0,
    cosLon = 1;
  const hasRx = !!rxPos && (rxPos[0] !== 0 || rxPos[1] !== 0 || rxPos[2] !== 0);
  if (hasRx) {
    const [la, lo] = ecefToGeodetic(rxPos[0], rxPos[1], rxPos[2]);
    sinLat = Math.sin(la);
    cosLat = Math.cos(la);
    sinLon = Math.sin(lo);
    cosLon = Math.cos(lo);
  }
  for (const sat of sats) {
    const series: (SatPoint | null)[] = new Array(times.length);
    for (let k = 0; k < times.length; k++) {
      const p = tlePositionEcef(sat, times[k]!);
      if (!p) {
        series[k] = null;
        continue;
      }
      const [lat, lon] = ecefToGeodetic(p.x, p.y, p.z);
      let az = 0,
        el = 0;
      if (hasRx) {
        const dx = p.x - rxPos[0];
        const dy = p.y - rxPos[1];
        const dz = p.z - rxPos[2];
        const east = -sinLon * dx + cosLon * dy;
        const north =
          -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz;
        const up = cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz;
        az = (Math.atan2(east, north) + TWO_PI) % TWO_PI;
        el = Math.atan2(up, Math.hypot(east, north));
      }
      series[k] = { lat, lon, az, el };
    }
    positions[sat.id] = series;
  }
  return { prns, times, positions };
}

/* ------------------------------------------------------------------ */
/*  NORAD ↔ PRN association                                            */
/* ------------------------------------------------------------------ */

/**
 * The PRN a CelesTrak-style object name carries, as a RINEX satellite id:
 * "GPS BIIR-5  (PRN 22)" → G22, "BEIDOU-3 M1 (C19)" → C19,
 * "QZS-2 (QZSS/PRN 194)" → J02, "SES-5 (EGNOS/PRN 136)" → S36.
 * Galileo, GLONASS and NavIC names carry no PRN: null (use
 * `matchElementsToPrns`).
 */
export function prnFromObjectName(name: string | undefined): string | null {
  if (!name) return null;
  let m = /\(PRN (\d{1,2})\)/.exec(name);
  if (m && /^GPS\b/.test(name)) return `G${m[1]!.padStart(2, '0')}`;
  m = /\(C(\d{2})\)/.exec(name);
  if (m && /BEIDOU/.test(name)) return `C${m[1]}`;
  m = /\(QZSS\/PRN (\d{3})\)/.exec(name);
  if (m) return `J${String(+m[1]! - 192).padStart(2, '0')}`;
  m =
    /\((?:WAAS|EGNOS|GAGAN|SDCM|MSAS|BDSBAS|KASS|SOUTHPAN|SPAN)\/PRN (\d{3})\)/.exec(
      name
    );
  if (m) return `S${String(+m[1]! - 100).padStart(2, '0')}`;
  return null;
}

export interface PrnMatch {
  norad: number;
  prn: string;
  /** TLE-to-reference distance at the matching epoch, km. */
  distanceKm: number;
}

/**
 * Associate element sets with PRNs geometrically: propagate every set to
 * one epoch and pair it with the nearest reference position (broadcast
 * ephemeris, SP3…). A mean element set is good to a few km while
 * satellites of the same plane are thousands of km apart, so the pairing
 * is unambiguous — and, unlike name tables, it follows PRN and slot
 * reassignments by itself.
 *
 * Greedy one-to-one by increasing distance; pairs farther than
 * `maxKm` (default 100) are left unmatched.
 * @param refPositions PRN → ECEF metres at `gpsMs`
 */
export function matchElementsToPrns(
  sats: TleSatellite[],
  refPositions: ReadonlyMap<string, readonly [number, number, number]>,
  gpsMs: number,
  maxKm = 100
): PrnMatch[] {
  const cands: PrnMatch[] = [];
  for (const sat of sats) {
    const p = tlePositionEcef(sat, gpsMs);
    if (!p) continue;
    for (const [prn, r] of refPositions) {
      const d = Math.hypot(p.x - r[0], p.y - r[1], p.z - r[2]) / 1000;
      if (d <= maxKm)
        cands.push({ norad: sat.elements.norad, prn, distanceKm: d });
    }
  }
  cands.sort((a, b) => a.distanceKm - b.distanceKm);
  const usedSat = new Set<number>();
  const usedPrn = new Set<string>();
  const out: PrnMatch[] = [];
  for (const c of cands) {
    if (usedSat.has(c.norad) || usedPrn.has(c.prn)) continue;
    usedSat.add(c.norad);
    usedPrn.add(c.prn);
    out.push(c);
  }
  return out;
}
