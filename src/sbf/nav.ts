/**
 * Septentrio SBF decoded navigation and almanac blocks.
 *
 * Nav blocks (GPSNav 5891, GLONav 4004, GALNav 4002, BDSNav 4081,
 * QZSNav 4095) carry the fully decoded broadcast ephemeris; they are
 * mapped onto the same `Ephemeris` union the RINEX nav parser produces,
 * with identical units and conventions (sqrtA in m^1/2, angles in rad,
 * semicircle fields scaled by π, GLONASS tauN with the RINEX sign, BDS
 * epochs/weeks on the BDT scale like a RINEX file).
 *
 * Almanac blocks (GPSAlm 5892, GALAlm 4003, GLOAlm 4005, BDSAlm 4119)
 * are decoded into dedicated types with all per-system relative fields
 * (GPS/BDS δi, Galileo δi and ΔsqrtA) normalized to absolute values.
 *
 * Ported from RTKLIB demo5 (rtklibexplorer), src/rcv/septentrio.c
 * (decode_gpsnav / decode_glonav / decode_galnav / decode_cmpnav /
 * decode_qzssnav / decode_gpsalm / decode_galalm / decode_cmpalm),
 * BSD-2-Clause, and cross-checked field by field against the Septentrio
 * mosaic-X5 reference guide, which also supplies the GLOAlm layout
 * (not decoded by RTKLIB).
 */

import type {
  Ephemeris,
  GlonassEphemeris,
  KeplerEphemeris,
} from '../rinex/nav';
import { getGpsLeap } from '../time/utc';
import { scanSbfFrames, svidToPrn } from './frame';

const PI = Math.PI; // semicircle → rad
const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
// BDT calendar epoch (Jan 1 2006 00:00:00 BDT), naive — RINEX BDS nav
// records print BDT calendar dates and parseNavFile keeps them as-is.
const BDT_EPOCH_MS = Date.UTC(2006, 0, 1);
const SEC_PER_WEEK = 7 * 86400;
const MS_PER_WEEK = SEC_PER_WEEK * 1000;
const F4_DNU = -2e10; // do-not-use value for f4/f8 fields
const U4_DNU = 4294967295;

/**
 * Recover a full week number from a truncated (modulo `mod`) week using
 * a full reference week, picking the candidate nearest the reference.
 * Same fold thresholds as RTKLIB's adjust_WN8/10/12/14, but with the
 * offset applied in the correct direction (RTKLIB demo5 adds the offset
 * it should subtract; both agree in the ubiquitous offset-0 case).
 */
function adjustWeek(refWeek: number, wn: number, mod: number): number {
  let offset = (refWeek % mod) - wn;
  if (offset > mod / 2) offset -= mod;
  if (offset < -(mod / 2 - 1)) offset += mod;
  return refWeek - offset;
}

const gpsMs = (week: number, sec: number) =>
  GPS_EPOCH_MS + week * MS_PER_WEEK + sec * 1000;

const sowOf = (dateMs: number) => (dateMs / 1000) % SEC_PER_WEEK;

/* ================================================================== */
/*  Navigation blocks                                                  */
/* ================================================================== */

export interface SbfNavResult {
  ephemerides: Ephemeris[];
  /** Frames whose CRC failed (corruption indicator). */
  badCrc: number;
}

/** GPSNav (5891) / QZSNav (4095) — identical layout, LNAV fields. */
export function decodeGpsQzsNav(
  view: DataView,
  b: number,
  sys: 'G' | 'J'
): KeplerEphemeris | null {
  const svid = view.getUint8(b + 14);
  const prn = sys === 'G' ? svid : svid - 180;
  const max = sys === 'G' ? 32 : 10;
  if (prn < 1 || prn > max) return null;
  const wnc = view.getUint16(b + 12, true);

  const tgdRaw = view.getFloat32(b + 28, true);
  const tocs = view.getUint32(b + 32, true);
  const toes = view.getUint32(b + 88, true);
  const wnToc = adjustWeek(wnc, view.getUint16(b + 136, true), 1024);
  const tocDate = new Date(gpsMs(wnToc, tocs));

  return {
    system: sys,
    prn: `${sys}${String(prn).padStart(2, '0')}`,
    toc: sowOf(tocDate.getTime()),
    tocDate,
    af0: view.getFloat32(b + 44, true),
    af1: view.getFloat32(b + 40, true),
    af2: view.getFloat32(b + 36, true),
    iode: view.getUint8(b + 24),
    crs: view.getFloat32(b + 48, true),
    deltaN: view.getFloat32(b + 52, true) * PI,
    m0: view.getFloat64(b + 56, true) * PI,
    cuc: view.getFloat32(b + 64, true),
    e: view.getFloat64(b + 68, true),
    cus: view.getFloat32(b + 76, true),
    sqrtA: view.getFloat64(b + 80, true),
    toe: toes,
    cic: view.getFloat32(b + 92, true),
    omega0: view.getFloat64(b + 96, true) * PI,
    cis: view.getFloat32(b + 104, true),
    i0: view.getFloat64(b + 108, true) * PI,
    crc: view.getFloat32(b + 116, true),
    omega: view.getFloat64(b + 120, true) * PI,
    omegaDot: view.getFloat32(b + 128, true) * PI,
    idot: view.getFloat32(b + 132, true) * PI,
    // RINEX "GPS week to go with toe": RTKLIB writes WNc for GPS and
    // the week of toc for QZSS — mirrored here so records compare
    // 1:1 against convbin output. wnToe is still used for `toe` above.
    week: sys === 'G' ? wnc : wnToc,
    svHealth: view.getUint8(b + 20),
    tgd: tgdRaw !== F4_DNU ? tgdRaw : 0,
  };
}

/** GALNav (4002) — INAV (source 2) or FNAV (source 16). */
export function decodeGalNav(
  view: DataView,
  b: number
): KeplerEphemeris | null {
  const prn = view.getUint8(b + 14) - 70;
  if (prn < 1 || prn > 36) return null;
  const source = view.getUint8(b + 15);
  if (source !== 2 && source !== 16) return null;
  const wnc = view.getUint16(b + 12, true);

  const toes = view.getUint32(b + 100, true);
  const tocs = view.getUint32(b + 104, true);
  const wnToc = adjustWeek(wnc, view.getUint16(b + 126, true), 4096);
  const tocDate = new Date(gpsMs(wnToc, tocs));

  // Health_OSSOL → RINEX Galileo SVH bit layout (E1B DVS/HS in bits
  // 0-2, E5a in 3-5, E5b in 6-8), only where flagged valid.
  const health = view.getUint16(b + 130, true);
  let svh = 0;
  if (health & 0x001) svh |= (health >> 1) & 7;
  if (health & 0x010) svh |= ((health >> 5) & 7) << 6;
  if (health & 0x100) svh |= ((health >> 9) & 7) << 3;

  const bgdE5a = view.getFloat32(b + 136, true);

  return {
    system: 'E',
    prn: `E${String(prn).padStart(2, '0')}`,
    toc: sowOf(tocDate.getTime()),
    tocDate,
    af0: view.getFloat64(b + 116, true),
    af1: view.getFloat32(b + 112, true),
    af2: view.getFloat32(b + 108, true),
    iode: view.getUint16(b + 128, true), // IODnav
    crs: view.getFloat32(b + 88, true),
    deltaN: view.getFloat32(b + 72, true) * PI,
    m0: view.getFloat64(b + 24, true) * PI,
    cuc: view.getFloat32(b + 76, true),
    e: view.getFloat64(b + 32, true),
    cus: view.getFloat32(b + 80, true),
    sqrtA: view.getFloat64(b + 16, true),
    toe: toes,
    cic: view.getFloat32(b + 92, true),
    omega0: view.getFloat64(b + 56, true) * PI,
    cis: view.getFloat32(b + 96, true),
    i0: view.getFloat64(b + 40, true) * PI,
    crc: view.getFloat32(b + 84, true),
    omega: view.getFloat64(b + 48, true) * PI,
    omegaDot: view.getFloat32(b + 64, true) * PI,
    idot: view.getFloat32(b + 68, true) * PI,
    week: wnc, // RINEX GAL week is GPS-aligned and continuous
    svHealth: svh,
    tgd: bgdE5a !== F4_DNU ? bgdE5a : 0, // BGD E5a/E1 (RINEX slot)
  };
}

/** BDSNav (4081) — D1/D2. Weeks and epochs kept on the BDT scale. */
export function decodeBdsNav(
  view: DataView,
  b: number
): KeplerEphemeris | null {
  const prn = svidToPrn(view.getUint8(b + 14));
  if (!prn || prn[0] !== 'C') return null;
  // WNc is a GPS week; BDS week = GPS week − 1356 (BDT = GPST − 14 s)
  const bdsWeekRef = view.getUint16(b + 12, true) - 1356;

  const tgd1 = view.getFloat32(b + 24, true);
  const tocs = view.getUint32(b + 32, true); // BDT seconds of week
  const toes = view.getUint32(b + 88, true); // BDT seconds of week
  const wnToc = adjustWeek(bdsWeekRef, view.getUint16(b + 136, true), 8192);
  const wnToe = adjustWeek(bdsWeekRef, view.getUint16(b + 138, true), 8192);
  // RINEX prints BDS nav epochs as BDT calendar dates; parseNavFile
  // keeps that calendar in tocDate, so build the same (naive BDT) Date.
  const tocDate = new Date(BDT_EPOCH_MS + wnToc * MS_PER_WEEK + tocs * 1000);

  return {
    system: 'C',
    prn,
    toc: sowOf(tocDate.getTime()),
    tocDate,
    af0: view.getFloat32(b + 44, true),
    af1: view.getFloat32(b + 40, true),
    af2: view.getFloat32(b + 36, true),
    iode: view.getUint8(b + 21), // AODE
    crs: view.getFloat32(b + 48, true),
    deltaN: view.getFloat32(b + 52, true) * PI,
    m0: view.getFloat64(b + 56, true) * PI,
    cuc: view.getFloat32(b + 64, true),
    e: view.getFloat64(b + 68, true),
    cus: view.getFloat32(b + 76, true),
    sqrtA: view.getFloat64(b + 80, true),
    toe: toes,
    cic: view.getFloat32(b + 92, true),
    omega0: view.getFloat64(b + 96, true) * PI,
    cis: view.getFloat32(b + 104, true),
    i0: view.getFloat64(b + 108, true) * PI,
    crc: view.getFloat32(b + 116, true),
    omega: view.getFloat64(b + 120, true) * PI,
    omegaDot: view.getFloat32(b + 128, true) * PI,
    idot: view.getFloat32(b + 132, true) * PI,
    week: wnToe, // RINEX BDS week field is the BDT week
    svHealth: view.getUint8(b + 19), // SatH1
    tgd: tgd1 !== F4_DNU ? tgd1 : 0, // TGD1 B1/B3 (RINEX slot)
  };
}

/** GLONav (4004) — PZ-90 state vector. */
export function decodeGloNav(
  view: DataView,
  b: number
): GlonassEphemeris | null {
  const prn = svidToPrn(view.getUint8(b + 14));
  if (!prn || prn[0] !== 'R') return null;
  const wnc = view.getUint16(b + 12, true);

  const toes = view.getUint32(b + 76, true); // GPS time frame
  const wnToe = adjustWeek(wnc, view.getUint16(b + 80, true), 1024);
  const toeGpsMs = gpsMs(wnToe, toes);
  // RINEX GLONASS epochs are UTC: strip the GPS-UTC leap seconds.
  const leapMs = getGpsLeap(new Date(toeGpsMs)) * 1000;
  const tocDate = new Date(toeGpsMs - leapMs);

  // Message frame time: seconds of the UTC week of the block time
  // stamp (this is what convbin puts in the RINEX tof field).
  const tofGpsMs = gpsMs(wnc, 0) + view.getUint32(b + 8, true);
  const tofLeapMs = getGpsLeap(new Date(tofGpsMs)) * 1000;
  const messageFrameTime =
    ((tofGpsMs - tofLeapMs - GPS_EPOCH_MS) / 1000) % SEC_PER_WEEK;

  return {
    system: 'R',
    prn,
    tocDate,
    // RINEX stores −τn as the clock bias; SBF carries τn (ICD sign)
    tauN: -view.getFloat32(b + 68, true),
    gammaN: view.getFloat32(b + 64, true),
    messageFrameTime,
    x: view.getFloat64(b + 16, true), // SBF unit is km, like RINEX
    xDot: view.getFloat32(b + 40, true),
    xAcc: view.getFloat32(b + 52, true),
    y: view.getFloat64(b + 24, true),
    yDot: view.getFloat32(b + 44, true),
    yAcc: view.getFloat32(b + 56, true),
    z: view.getFloat64(b + 32, true),
    zDot: view.getFloat32(b + 48, true),
    zAcc: view.getFloat32(b + 60, true),
    // MSB of the 3-bit Bn word — the unhealthy flag RINEX carries
    health: view.getUint8(b + 85) >> 2,
    freqNum: view.getUint8(b + 15) - 8,
  };
}

/**
 * Decode every GPSNav/GLONav/GALNav/BDSNav/QZSNav block in an SBF byte
 * stream into the RINEX-parser `Ephemeris` union. Every block is
 * emitted (no issue-of-data dedup); other block types are skipped.
 */
export function parseSbfNav(data: Uint8Array): SbfNavResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ephemerides: Ephemeris[] = [];

  const badCrc = scanSbfFrames(data, view, (id, b, len) => {
    let eph: Ephemeris | null = null;
    if (id === 5891 && len >= 140) eph = decodeGpsQzsNav(view, b, 'G');
    else if (id === 4095 && len >= 140) eph = decodeGpsQzsNav(view, b, 'J');
    else if (id === 4002 && len >= 149) eph = decodeGalNav(view, b);
    else if (id === 4081 && len >= 140) eph = decodeBdsNav(view, b);
    else if (id === 4004 && len >= 96) eph = decodeGloNav(view, b);
    if (eph) ephemerides.push(eph);
  });

  return { ephemerides, badCrc };
}

/* ================================================================== */
/*  Almanac blocks                                                     */
/* ================================================================== */

/**
 * GPS / Galileo / BeiDou almanac, normalized to ABSOLUTE Keplerian
 * elements (units matching `KeplerEphemeris`: sqrtA in m^1/2, angles
 * in rad, rates in rad/s) so a Kepler propagator can consume the
 * record directly with all correction terms at zero.
 *
 * Normalizations applied per system:
 * - GPS (`G`): the SIS δi (relative to 0.3 semicircles) is folded in —
 *   `i0OrDeltaI` = 0.3π + δi·π. `weekAlm` is the full GPS week
 *   (8-bit SIS week disambiguated against the receiver week).
 * - Galileo (`E`): the SIS ΔsqrtA (relative to √29 600 000 m^1/2) and
 *   δi (relative to 56°) are folded in — `sqrtA` and `i0OrDeltaI` are
 *   absolute. `weekAlm` is the full GPS-aligned week (2-bit SIS week
 *   disambiguated). `health` is the raw SBF bit field: bit 0 set ⇒
 *   bits 1-2 are the L1-B HS, bit 3 set ⇒ bits 4-5 E5b HS, bit 6 set
 *   ⇒ bits 7-8 E5a HS (0 = healthy).
 * - BeiDou (`C`): δi is relative to 0.3 semicircles for MEO/IGSO and
 *   to 0 for GEO satellites (PRN 1-5 and 59-63) per the BDS ICD; the
 *   reference is folded in. `weekAlm` is the full BDS week (add 1356
 *   for the GPS week) and `toaSec` is BDT seconds of week
 *   (BDT = GPST − 14 s). `health` is the 9-bit SIS health word.
 */
export interface SbfKeplerAlmanac {
  system: 'G' | 'E' | 'C';
  /** Satellite PRN, e.g. "G14". */
  prn: string;
  /** Full almanac reference week (see per-system notes above). */
  weekAlm: number;
  /** Almanac reference time of week in seconds (system time scale). */
  toaSec: number;
  /** Square root of semi-major axis in m^(1/2), absolute. */
  sqrtA: number;
  /** Eccentricity (dimensionless). */
  e: number;
  /** Inclination at reference time in rad, absolute (normalized). */
  i0OrDeltaI: number;
  /** Longitude of ascending node at the weekly epoch in rad. */
  omega0: number;
  /** Argument of perigee in rad. */
  omega: number;
  /** Mean anomaly at reference time in rad. */
  m0: number;
  /** Rate of right ascension in rad/s. */
  omegaDot: number;
  /** SV clock bias in seconds. */
  af0: number;
  /** SV clock drift in s/s. */
  af1: number;
  /** Health word, 0 = healthy (see per-system notes above). */
  health: number;
}

/**
 * GLONASS almanac (GLONASS ICD orbital parameters). Semicircle fields
 * are converted to radians; everything else keeps the ICD units.
 */
export interface SbfGlonassAlmanac {
  system: 'R';
  /** Satellite slot, e.g. "R05". */
  prn: string;
  /** Frequency channel number HnA (−7…+6). */
  freqNr: number;
  /** Full GPS week of the almanac reference time. */
  weekAlm: number;
  /** Almanac reference time of week in seconds, GPS time frame. */
  toaSec: number;
  /** εnA: orbit eccentricity. */
  epsilon: number;
  /** λnA: longitude of first ascending node in rad. */
  lambda: number;
  /** tλnA: time of first ascending node passage in s of day. */
  tLambda: number;
  /** ΔinA: inclination correction to 63° in rad. */
  deltaI: number;
  /** ωnA: argument of perigee in rad. */
  omega: number;
  /** ΔTnA: correction to the mean Draconian period (s / orbit). */
  deltaT: number;
  /** dΔTnA: rate of change of ΔT (s / orbit²). */
  deltaTDot: number;
  /** τnA: coarse satellite clock correction in s. */
  tau: number;
  /** CnA general health flag: 1 = healthy. */
  health: number;
  /** NA: calendar day number within the 4-year period. */
  nDay: number;
  /** N4: 4-year interval number since 1996. */
  n4: number;
}

export type SbfAlmanac = SbfKeplerAlmanac | SbfGlonassAlmanac;

export interface SbfAlmanacResult {
  almanacs: SbfAlmanac[];
  /** Frames whose CRC failed (corruption indicator). */
  badCrc: number;
}

// Galileo almanac nominal values (Galileo OS SIS ICD §5.1.10)
const GAL_SQRT_A_NOMINAL = Math.sqrt(29600000); // m^1/2
const GAL_I_NOMINAL = (56 / 180) * PI; // rad
// GPS/BDS almanac reference inclination: 0.3 semicircles
const I_REF_03 = 0.3 * PI;

/** GPSAlm (5892) / GALAlm (4003) — same field order, different PRN slot. */
function decodeGpsGalAlm(
  view: DataView,
  b: number,
  sys: 'G' | 'E'
): SbfKeplerAlmanac | null {
  const wnc = view.getUint16(b + 12, true);
  const toa = view.getUint32(b + 20, true);
  if (toa === U4_DNU) return null;

  let prn: number;
  let weekAlm: number;
  let i0: number;
  let sqrtA = view.getFloat32(b + 32, true);
  let health: number;
  if (sys === 'G') {
    prn = view.getUint8(b + 14);
    if (prn < 1 || prn > 32) return null;
    weekAlm = adjustWeek(wnc, view.getUint8(b + 56), 256); // 8-bit SIS week
    i0 = I_REF_03 + view.getFloat32(b + 24, true) * PI;
    health = view.getUint8(b + 58); // 8-bit almanac-page health
  } else {
    prn = view.getUint8(b + 57) - 70; // SVID_A: subject of the almanac
    if (prn < 1 || prn > 36) return null;
    weekAlm = adjustWeek(wnc, view.getUint8(b + 56), 4); // 2-bit IODa week
    i0 = GAL_I_NOMINAL + view.getFloat32(b + 24, true) * PI;
    sqrtA += GAL_SQRT_A_NOMINAL; // SIS value is relative to nominal
    health = view.getUint16(b + 58, true);
  }

  return {
    system: sys,
    prn: `${sys}${String(prn).padStart(2, '0')}`,
    weekAlm,
    toaSec: toa,
    sqrtA,
    e: view.getFloat32(b + 16, true),
    i0OrDeltaI: i0,
    omega0: view.getFloat32(b + 36, true) * PI,
    omega: view.getFloat32(b + 40, true) * PI,
    m0: view.getFloat32(b + 44, true) * PI,
    omegaDot: view.getFloat32(b + 28, true) * PI,
    af0: view.getFloat32(b + 52, true),
    af1: view.getFloat32(b + 48, true),
    health,
  };
}

/** BDSAlm (4119). */
function decodeBdsAlm(view: DataView, b: number): SbfKeplerAlmanac | null {
  const prnStr = svidToPrn(view.getUint8(b + 14));
  if (!prnStr || prnStr[0] !== 'C') return null;
  const prn = parseInt(prnStr.slice(1), 10);
  const toa = view.getUint32(b + 16, true);
  if (toa === U4_DNU) return null;
  const bdsWeekRef = view.getUint16(b + 12, true) - 1356;
  // BDS GEO almanacs reference inclination 0; MEO/IGSO reference 0.3π
  const geo = prn <= 5 || prn >= 59;
  return {
    system: 'C',
    prn: prnStr,
    weekAlm: adjustWeek(bdsWeekRef, view.getUint8(b + 15), 256),
    toaSec: toa,
    sqrtA: view.getFloat32(b + 20, true),
    e: view.getFloat32(b + 24, true),
    i0OrDeltaI: (geo ? 0 : I_REF_03) + view.getFloat32(b + 44, true) * PI,
    omega0: view.getFloat32(b + 36, true) * PI,
    omega: view.getFloat32(b + 28, true) * PI,
    m0: view.getFloat32(b + 32, true) * PI,
    omegaDot: view.getFloat32(b + 40, true) * PI,
    af0: view.getFloat32(b + 48, true),
    af1: view.getFloat32(b + 52, true),
    health: view.getUint16(b + 56, true),
  };
}

/** GLOAlm (4005) — layout from the mosaic-X5 reference guide. */
function decodeGloAlm(view: DataView, b: number): SbfGlonassAlmanac | null {
  const prn = svidToPrn(view.getUint8(b + 14));
  if (!prn || prn[0] !== 'R') return null;
  const wnc = view.getUint16(b + 12, true);
  const toa = view.getUint32(b + 20, true); // GPS time frame
  if (toa === U4_DNU) return null;
  return {
    system: 'R',
    prn,
    freqNr: view.getUint8(b + 15) - 8,
    weekAlm: adjustWeek(wnc, view.getUint8(b + 52), 256),
    toaSec: toa,
    epsilon: view.getFloat32(b + 16, true),
    deltaI: view.getFloat32(b + 24, true) * PI,
    lambda: view.getFloat32(b + 28, true) * PI,
    tLambda: view.getFloat32(b + 32, true),
    omega: view.getFloat32(b + 36, true) * PI,
    deltaT: view.getFloat32(b + 40, true),
    deltaTDot: view.getFloat32(b + 44, true),
    tau: view.getFloat32(b + 48, true),
    health: view.getUint8(b + 53),
    nDay: view.getUint16(b + 54, true),
    n4: view.getUint8(b + 57),
  };
}

/**
 * Decode every GPSAlm/GALAlm/GLOAlm/BDSAlm block in an SBF byte
 * stream. Every block is emitted in stream order; other block types
 * are skipped.
 */
export function parseSbfAlmanac(data: Uint8Array): SbfAlmanacResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const almanacs: SbfAlmanac[] = [];

  const badCrc = scanSbfFrames(data, view, (id, b, len) => {
    let alm: SbfAlmanac | null = null;
    if (id === 5892 && len >= 60) alm = decodeGpsGalAlm(view, b, 'G');
    else if (id === 4003 && len >= 61) alm = decodeGpsGalAlm(view, b, 'E');
    else if (id === 4119 && len >= 60) alm = decodeBdsAlm(view, b);
    else if (id === 4005 && len >= 60) alm = decodeGloAlm(view, b);
    if (alm) almanacs.push(alm);
  });

  return { almanacs, badCrc };
}
