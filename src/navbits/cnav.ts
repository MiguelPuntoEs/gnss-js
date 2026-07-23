/**
 * GPS CNAV (civil navigation) message decoding: the modernized
 * navigation message broadcast on L2C (IS-GPS-200 §30) and L5
 * (IS-GPS-705 §20 — same 300-bit message structure and field layout).
 *
 * Receiver-independent, like the LNAV decoder in ./index: Septentrio
 * GPSRawL2C/GPSRawL5 and u-blox RXM-SFRBX deliver the same 300-bit
 * messages, so the CRC check, per-type field extraction and the
 * MT10+MT11+MT3x ephemeris assembly live here.
 *
 * RTKLIB demo5 (rtklibexplorer) has no CNAV ephemeris decoder — its
 * decode_gpsrawcnav in src/rcv/septentrio.c is a stub that only reads
 * the message header — so the bit offsets and scale factors below come
 * straight from IS-GPS-200 (Figures 30-1/30-2/30-3, Tables 30-I/30-II
 * and 30-IV), with π fixed at 3.1415926535898 for semicircle
 * conversion like the rest of this module.
 */

import { getBitS, getBitU, GPS_PI } from './index';

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const SEC_PER_WEEK = 7 * 86400;
const HALF_WEEK = 302400;

/** CNAV message preamble (IS-GPS-200 §30.3.3). */
export const CNAV_PREAMBLE = 0x8b;

/** Semi-major axis reference for the MT10 ΔA field (m, IS-GPS-200). */
export const CNAV_A_REF = 26559710;

/** Ω̇ reference for the MT11 ΔΩ̇ field (semicircles/s, IS-GPS-200). */
export const CNAV_OMEGA_DOT_REF = -2.6e-9;

/* ── CRC-24Q ───────────────────────────────────────────────────── */

/**
 * CRC-24Q (polynomial 0x1864CFB, init 0) over the first `bitLen` bits
 * of `buff`, MSB-first — the CRC of IS-GPS-200 §30.3.5 (and RTCM3).
 * Bit-oriented so the 276-bit CNAV data span needs no byte padding.
 */
export function crc24q(buff: Uint8Array, bitLen: number): number {
  let crc = 0;
  for (let i = 0; i < bitLen; i++) {
    crc ^= ((buff[i >> 3]! >> (7 - (i & 7))) & 1) << 23;
    const msb = crc & 0x800000;
    crc = (crc << 1) & 0xffffff;
    if (msb) crc ^= 0x864cfb;
  }
  return crc;
}

/**
 * Check the CRC-24Q of one 300-bit CNAV message (bits 0-275 data,
 * bits 276-299 parity). `msg` must hold at least 38 bytes.
 */
export function cnavCrcOk(msg: Uint8Array): boolean {
  if (msg.length < 38) return false;
  return crc24q(msg, 276) === getBitU(msg, 276, 24);
}

/* ── 33-bit field helpers (getBitU/getBitS are specified ≤ 32) ──── */

function getBitU33(b: Uint8Array, pos: number): number {
  return getBitU(b, pos, 1) * 2 ** 32 + getBitU(b, pos + 1, 32);
}

function getBitS33(b: Uint8Array, pos: number): number {
  const u = getBitU33(b, pos);
  return u < 2 ** 32 ? u : u - 2 ** 33;
}

/* ── Per-type message payloads ─────────────────────────────────── */

/** MT10 (ephemeris 1) fields — IS-GPS-200 Figure 30-1 / Table 30-I. */
interface CnavType10 {
  week: number;
  health: number;
  top: number;
  uraEd: number;
  toe: number;
  deltaA: number;
  aDot: number;
  deltaN0: number;
  deltaN0Dot: number;
  m0: number;
  e: number;
  omega: number;
  integrityFlag: boolean;
  l2cPhasing: boolean;
  /** Transmit time: seconds of week of the start of the NEXT message. */
  tow: number;
}

/** MT11 (ephemeris 2) fields — IS-GPS-200 Figure 30-2 / Table 30-I. */
interface CnavType11 {
  toe: number;
  omega0: number;
  i0: number;
  deltaOmegaDot: number;
  i0Dot: number;
  cis: number;
  cic: number;
  crs: number;
  crc: number;
  cus: number;
  cuc: number;
}

/** Clock block shared by MT30-37 — IS-GPS-200 Figure 30-3. */
interface CnavClock {
  /** Message type (30-37) that carried this clock block. */
  msgType: number;
  top: number;
  uraNed0: number;
  uraNed1: number;
  uraNed2: number;
  toc: number;
  af0: number;
  af1: number;
  af2: number;
  /** MT30 extras, present only when msgType === 30. */
  tgd?: number | null;
  iscL1ca?: number | null;
  iscL2c?: number | null;
  iscL5i5?: number | null;
  iscL5q5?: number | null;
  ionoAlpha?: number[];
  ionoBeta?: number[];
  wnOp?: number;
}

function decodeType10(b: Uint8Array, tow: number): CnavType10 {
  return {
    tow,
    week: getBitU(b, 38, 13),
    health: getBitU(b, 51, 3),
    top: getBitU(b, 54, 11) * 300,
    uraEd: getBitS(b, 65, 5),
    toe: getBitU(b, 70, 11) * 300,
    deltaA: getBitS(b, 81, 26) * 2 ** -9,
    aDot: getBitS(b, 107, 25) * 2 ** -21,
    deltaN0: getBitS(b, 132, 17) * 2 ** -44 * GPS_PI,
    deltaN0Dot: getBitS(b, 149, 23) * 2 ** -57 * GPS_PI,
    m0: getBitS33(b, 172) * 2 ** -32 * GPS_PI,
    e: getBitU33(b, 205) * 2 ** -34,
    omega: getBitS33(b, 238) * 2 ** -32 * GPS_PI,
    integrityFlag: getBitU(b, 271, 1) === 1,
    l2cPhasing: getBitU(b, 272, 1) === 1,
  };
}

function decodeType11(b: Uint8Array): CnavType11 {
  return {
    toe: getBitU(b, 38, 11) * 300,
    omega0: getBitS33(b, 49) * 2 ** -32 * GPS_PI,
    i0: getBitS33(b, 82) * 2 ** -32 * GPS_PI,
    deltaOmegaDot: getBitS(b, 115, 17) * 2 ** -44 * GPS_PI,
    i0Dot: getBitS(b, 132, 15) * 2 ** -44 * GPS_PI,
    cis: getBitS(b, 147, 16) * 2 ** -30,
    cic: getBitS(b, 163, 16) * 2 ** -30,
    crs: getBitS(b, 179, 24) * 2 ** -8,
    crc: getBitS(b, 203, 24) * 2 ** -8,
    cus: getBitS(b, 227, 21) * 2 ** -30,
    cuc: getBitS(b, 248, 21) * 2 ** -30,
  };
}

/** 13-bit TGD/ISC: the pattern 1000000000000 (−4096) means "not available". */
const isc = (b: Uint8Array, pos: number): number | null => {
  const raw = getBitS(b, pos, 13);
  return raw === -4096 ? null : raw * 2 ** -35;
};

function decodeClock(b: Uint8Array, msgType: number): CnavClock {
  const clock: CnavClock = {
    msgType,
    top: getBitU(b, 38, 11) * 300,
    uraNed0: getBitS(b, 49, 5),
    uraNed1: getBitU(b, 54, 3),
    uraNed2: getBitU(b, 57, 3),
    toc: getBitU(b, 60, 11) * 300,
    af0: getBitS(b, 71, 26) * 2 ** -35,
    af1: getBitS(b, 97, 20) * 2 ** -48,
    af2: getBitS(b, 117, 10) * 2 ** -60,
  };
  if (msgType === 30) {
    clock.tgd = isc(b, 127);
    clock.iscL1ca = isc(b, 140);
    clock.iscL2c = isc(b, 153);
    clock.iscL5i5 = isc(b, 166);
    clock.iscL5q5 = isc(b, 179);
    clock.ionoAlpha = [
      getBitS(b, 192, 8) * 2 ** -30,
      getBitS(b, 200, 8) * 2 ** -27,
      getBitS(b, 208, 8) * 2 ** -24,
      getBitS(b, 216, 8) * 2 ** -24,
    ];
    clock.ionoBeta = [
      getBitS(b, 224, 8) * 2 ** 11,
      getBitS(b, 232, 8) * 2 ** 14,
      getBitS(b, 240, 8) * 2 ** 16,
      getBitS(b, 248, 8) * 2 ** 16,
    ];
    clock.wnOp = getBitU(b, 256, 8);
  }
  return clock;
}

/* ── Assembled ephemeris ───────────────────────────────────────── */

/**
 * A complete GPS CNAV ephemeris + clock data set assembled from one
 * MT10, one MT11 and one MT3x message (IS-GPS-200 §30.3.3.1: the three
 * message types together carry the CEI data set; toe/toc equality
 * marks messages of the same set).
 *
 * Units are SI/radians: semicircle fields are scaled by GPS_PI, the
 * MT10 ΔA reference (26 559 710 m) and the MT11 Ω̇ reference
 * (−2.6×10⁻⁹ semicircles/s) are folded into `a` and `omegaDot`, with
 * the raw deltas also kept. Epoch Dates are GPS-scale (repo
 * convention: GPS seconds mapped onto the JS epoch without leap
 * seconds), and `toe`/`toc` are seconds of `week`/`weekToc`.
 */
export interface CnavEphemeris {
  system: 'G';
  /** RINEX PRN, e.g. "G07". */
  prn: string;
  /** Full GPS week from the MT10 WN field (13 bits, no rollover). */
  week: number;
  /** L1/L2/L5 signal-health bits from MT10 (bit 2 = L1, 0 = L5). */
  health: number;
  /** Elevation-dependent (ED) URA index, signed (MT10). */
  uraEd: number;
  /** Non-elevation-dependent URA indices: bias/drift/drift-rate (MT3x). */
  uraNed0: number;
  uraNed1: number;
  uraNed2: number;
  /** Data-predict time of week in s (MT10). */
  top: number;
  /** Time of ephemeris in seconds of the GPS week of `toeDate`. */
  toe: number;
  /** Time of ephemeris as a GPS-scale Date. */
  toeDate: Date;
  /** Semi-major axis at toe in m (reference + ΔA). */
  a: number;
  /** MT10 ΔA: semi-major axis difference from 26 559 710 m, in m. */
  deltaA: number;
  /** Rate of semi-major axis in m/s. */
  aDot: number;
  /** Mean motion difference from computed value in rad/s. */
  deltaN0: number;
  /** Rate of the mean motion difference in rad/s². */
  deltaN0Dot: number;
  /** Mean anomaly at reference time in rad. */
  m0: number;
  /** Eccentricity (dimensionless). */
  e: number;
  /** Argument of perigee in rad. */
  omega: number;
  /** Longitude of ascending node at the weekly epoch in rad. */
  omega0: number;
  /** Inclination at reference time in rad. */
  i0: number;
  /** Rate of right ascension in rad/s (reference Ω̇ + ΔΩ̇). */
  omegaDot: number;
  /** MT11 ΔΩ̇: delta from −2.6×10⁻⁹ semicircles/s, in rad/s. */
  deltaOmegaDot: number;
  /** Rate of inclination in rad/s. */
  i0Dot: number;
  /** Harmonic correction terms (rad / m). */
  cis: number;
  cic: number;
  crs: number;
  crc: number;
  cus: number;
  cuc: number;
  /** Clock epoch in seconds of the GPS week of `tocDate`. */
  toc: number;
  /** Clock epoch as a GPS-scale Date. */
  tocDate: Date;
  /** SV clock bias (s), drift (s/s), drift rate (s/s²). */
  af0: number;
  af1: number;
  af2: number;
  /** Message type (30-37) that supplied the clock block. */
  clockMsgType: number;
  /** L1 C/A group delay in s (MT30), null when unavailable/not seen. */
  tgd: number | null;
  /** Inter-signal corrections in s (MT30), null when unavailable. */
  iscL1ca: number | null;
  iscL2c: number | null;
  iscL5i5: number | null;
  iscL5q5: number | null;
  /** Klobuchar iono coefficients from MT30, when one was seen. */
  ionoAlpha?: number[];
  ionoBeta?: number[];
  /** Data-predict week from MT30 (WN_OP, 8 bits, unresolved). */
  wnOp?: number;
  /** Integrity-status and L2C-phasing flags from MT10. */
  integrityFlag: boolean;
  l2cPhasing: boolean;
  /** Transmit time of the MT10 message (s of week, start of next msg). */
  tow: number;
}

/** Resolve `sec` (s of week) near the transmit time (week, towSec). */
function resolveWeek(week: number, towSec: number, sec: number): number {
  if (sec < towSec - HALF_WEEK) return week + 1;
  if (sec > towSec + HALF_WEEK) return week - 1;
  return week;
}

function gpsDate(week: number, sec: number): Date {
  return new Date(GPS_EPOCH_MS + (week * SEC_PER_WEEK + sec) * 1000);
}

interface SatState {
  t10?: CnavType10;
  t11?: CnavType11;
  clock?: CnavClock;
  /** MT30 extras outlive clock blocks from other 3x types. */
  extras?: CnavClock;
  lastKey?: string;
}

/**
 * Streaming assembler for CNAV ephemerides: feed 300-bit messages
 * (CRC-valid — see `cnavCrcOk`) in received order; a `CnavEphemeris`
 * is returned whenever a satellite's buffered MT10 + MT11 + MT3x
 * first form a consistent data set (MT10.toe == MT11.toe == MT3x.toc,
 * the CNAV consistency rule of IS-GPS-200 §30.3.4.4), with unchanged
 * repeats of the same set suppressed.
 */
export class CnavAssembler {
  private sats = new Map<number, SatState>();

  /**
   * Push one 300-bit CNAV message (38+ bytes, bit 0 = first bit of
   * the preamble). Returns the newly completed ephemeris, or null.
   * Messages that are not MT10/MT11/MT30-37, or whose preamble/PRN
   * are out of range, are ignored.
   */
  push(msg: Uint8Array): CnavEphemeris | null {
    if (msg.length < 38 || getBitU(msg, 0, 8) !== CNAV_PREAMBLE) return null;
    const prn = getBitU(msg, 8, 6);
    if (prn < 1 || prn > 32) return null;
    const type = getBitU(msg, 14, 6);
    const tow = getBitU(msg, 20, 17) * 6;

    let sat = this.sats.get(prn);
    if (!sat) {
      sat = {};
      this.sats.set(prn, sat);
    }

    if (type === 10) sat.t10 = decodeType10(msg, tow);
    else if (type === 11) sat.t11 = decodeType11(msg);
    else if (type >= 30 && type <= 37) {
      sat.clock = decodeClock(msg, type);
      if (type === 30) sat.extras = sat.clock;
    } else return null;

    return this.tryEmit(prn, sat);
  }

  private tryEmit(prn: number, sat: SatState): CnavEphemeris | null {
    const { t10, t11, clock, extras } = sat;
    if (!t10 || !t11 || !clock) return null;
    // Same-data-set rule: toe (MT10) == toe (MT11) == toc (MT3x).
    if (t10.toe !== t11.toe || clock.toc !== t10.toe) return null;

    const key = `${t10.week}:${t10.toe}:${clock.af0}:${clock.af1}`;
    if (key === sat.lastKey) return null;
    sat.lastKey = key;

    const weekToe = resolveWeek(t10.week, t10.tow, t10.toe);
    const a = CNAV_A_REF + t10.deltaA;

    return {
      system: 'G',
      prn: `G${String(prn).padStart(2, '0')}`,
      week: t10.week,
      health: t10.health,
      uraEd: t10.uraEd,
      uraNed0: clock.uraNed0,
      uraNed1: clock.uraNed1,
      uraNed2: clock.uraNed2,
      top: t10.top,
      toe: t10.toe,
      toeDate: gpsDate(weekToe, t10.toe),
      a,
      deltaA: t10.deltaA,
      aDot: t10.aDot,
      deltaN0: t10.deltaN0,
      deltaN0Dot: t10.deltaN0Dot,
      m0: t10.m0,
      e: t10.e,
      omega: t10.omega,
      omega0: t11.omega0,
      i0: t11.i0,
      omegaDot: CNAV_OMEGA_DOT_REF * GPS_PI + t11.deltaOmegaDot,
      deltaOmegaDot: t11.deltaOmegaDot,
      i0Dot: t11.i0Dot,
      cis: t11.cis,
      cic: t11.cic,
      crs: t11.crs,
      crc: t11.crc,
      cus: t11.cus,
      cuc: t11.cuc,
      toc: clock.toc,
      tocDate: gpsDate(weekToe, clock.toc),
      af0: clock.af0,
      af1: clock.af1,
      af2: clock.af2,
      clockMsgType: clock.msgType,
      tgd: extras?.tgd ?? null,
      iscL1ca: extras?.iscL1ca ?? null,
      iscL2c: extras?.iscL2c ?? null,
      iscL5i5: extras?.iscL5i5 ?? null,
      iscL5q5: extras?.iscL5q5 ?? null,
      ...(extras?.ionoAlpha && { ionoAlpha: extras.ionoAlpha }),
      ...(extras?.ionoBeta && { ionoBeta: extras.ionoBeta }),
      ...(extras?.wnOp !== undefined && { wnOp: extras.wnOp }),
      integrityFlag: t10.integrityFlag,
      l2cPhasing: t10.l2cPhasing,
      tow: t10.tow,
    };
  }
}

export interface CnavAssembleResult {
  /** Assembled ephemerides in stream order, repeats suppressed. */
  ephemerides: CnavEphemeris[];
  /** Messages whose CRC-24Q check failed (not fed to the assembler). */
  badCrc: number;
  /** Total messages examined. */
  messages: number;
}

/**
 * Assemble CNAV ephemerides from a sequence of raw 300-bit messages:
 * each message is CRC-checked (failures counted and dropped) and fed
 * to a `CnavAssembler` in order.
 */
export function assembleCnavEphemeris(
  messages: Iterable<Uint8Array>
): CnavAssembleResult {
  const assembler = new CnavAssembler();
  const ephemerides: CnavEphemeris[] = [];
  let badCrc = 0;
  let count = 0;
  for (const msg of messages) {
    count++;
    if (!cnavCrcOk(msg)) {
      badCrc++;
      continue;
    }
    const eph = assembler.push(msg);
    if (eph) ephemerides.push(eph);
  }
  return { ephemerides, badCrc, messages: count };
}
