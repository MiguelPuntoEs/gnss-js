/**
 * BeiDou B1I broadcast navigation-message decoding: the D1 message of
 * the MEO/IGSO satellites (ephemeris in subframes 1-3) and the D2
 * message of the GEO satellites (ephemeris in subframe 1, split over
 * pages 1-10).
 *
 * Receiver-independent, like the LNAV/CNAV decoders in this module:
 * Septentrio BDSRaw and u-blox RXM-SFRBX deliver the same 300-bit
 * subframes, so the word-parity check, the D1/D2 frame decoders and
 * the paging assembler live here.
 *
 * `decodeBdsD1Frame` / `decodeBdsD2Frame` are ports of RTKLIB's
 * `decode_bds_d1` / `decode_bds_d2` (demo5 / rtklibexplorer fork,
 * src/rcvraw.c), Copyright (c) 2009-2020 T. Takasu, BSD-2-Clause,
 * cross-checked against the BDS SIS ICD B1I (version 3.0) §5.2/§5.3.
 * Subframes are expected in the de-interleaved 300-bit layout RTKLIB
 * uses (and Septentrio outputs): parity bits in place, each 30-bit
 * word regrouped as [22 data bits][8 parity bits] (word 1:
 * [26 data][4 parity]). Output records mirror `parseNavFile` for
 * RINEX BDS records: epochs and the week stay on the BDT scale, with
 * `tocDate` a naive-BDT calendar Date (see src/sbf/nav.ts).
 */

import type { KeplerEphemeris } from '../rinex/nav';
import { getBitS, getBitU, GPS_PI } from './index';

// BDT calendar epoch (Jan 1 2006 00:00:00 BDT), naive — RINEX BDS nav
// records print BDT calendar dates and parseNavFile keeps them as-is.
// The epoch is week-aligned with the GPS epoch (exactly 1356 weeks).
const BDT_EPOCH_MS = Date.UTC(2006, 0, 1);
const SEC_PER_WEEK = 7 * 86400;
const MS_PER_WEEK = SEC_PER_WEEK * 1000;
const HALF_WEEK = 302400;

const sowOf = (dateMs: number) => (dateMs / 1000) % SEC_PER_WEEK;

/** Bytes per stored 300-bit subframe (RTKLIB layout: 38-byte stride). */
export const BDS_SUBFRAME_BYTES = 38;

/* ── multi-component bit fields (RTKLIB getbitu2/getbits2/...) ──── */

function getBitU2(
  b: Uint8Array,
  p1: number,
  l1: number,
  p2: number,
  l2: number
): number {
  return getBitU(b, p1, l1) * 2 ** l2 + getBitU(b, p2, l2);
}

function getBitS2(
  b: Uint8Array,
  p1: number,
  l1: number,
  p2: number,
  l2: number
): number {
  return getBitS(b, p1, l1) * 2 ** l2 + getBitU(b, p2, l2);
}

function getBitU3(
  b: Uint8Array,
  p1: number,
  l1: number,
  p2: number,
  l2: number,
  p3: number,
  l3: number
): number {
  return (
    getBitU(b, p1, l1) * 2 ** (l2 + l3) +
    getBitU(b, p2, l2) * 2 ** l3 +
    getBitU(b, p3, l3)
  );
}

function getBitS3(
  b: Uint8Array,
  p1: number,
  l1: number,
  p2: number,
  l2: number,
  p3: number,
  l3: number
): number {
  return (
    getBitS(b, p1, l1) * 2 ** (l2 + l3) +
    getBitU(b, p2, l2) * 2 ** l3 +
    getBitU(b, p3, l3)
  );
}

/** Merge a signed high part with an unsigned `n`-bit low part. */
const mergeS = (hi: number, lo: number, n: number) => hi * 2 ** n + lo;

/* ── BCH(15,11,1) word parity ──────────────────────────────────── */

/** Syndrome of one 15-bit BCH(15,11,1) codeword, g(x) = x⁴ + x + 1. */
function bchOk(cw: number): boolean {
  for (let i = 14; i >= 4; i--) {
    if (cw & (1 << i)) cw ^= 0x13 << (i - 4);
  }
  return cw === 0;
}

/**
 * Check the BCH(15,11,1) parity of one 300-bit BDS subframe (BDS ICD
 * §5.1.3). On air every word after the first is two 15-bit BCH
 * codewords interleaved bit by bit; the expected input here is the
 * de-interleaved layout (Septentrio BDSRaw / RTKLIB): word 1 carries
 * one plain codeword in bits 15-29 (bits 0-14 — preamble + reserved —
 * are not parity-protected), and words 2-10 are regrouped as
 * [11+11 data bits][4+4 parity bits].
 *
 * RTKLIB has no BDS word-parity check (its SBF/u-blox paths trust the
 * receiver's CRC flag); this check is this library's addition so that
 * `badCrc` counts exactly the subframes it rejected itself.
 */
export function bdsSubframeParityOk(subframe: Uint8Array): boolean {
  if (subframe.length < BDS_SUBFRAME_BYTES) return false;
  if (!bchOk(getBitU(subframe, 15, 15))) return false;
  for (let w = 1; w < 10; w++) {
    const base = 30 * w;
    const cw1 =
      getBitU(subframe, base, 11) * 16 + getBitU(subframe, base + 22, 4);
    const cw2 =
      getBitU(subframe, base + 11, 11) * 16 + getBitU(subframe, base + 26, 4);
    if (!bchOk(cw1) || !bchOk(cw2)) return false;
  }
  return true;
}

/* ── shared record assembly ────────────────────────────────────── */

export interface DecodeBdsOptions {
  /** RINEX PRN for the output record, e.g. "C06". Defaults to "C00". */
  prn?: string;
}

interface BdsFields {
  week: number; // 13-bit broadcast BDT week (week of the transmit SOW)
  sow: number; // SOW of the first subframe/page (BDT s of week)
  toes: number;
  tocSec: number;
  svh: number;
  tgd1: number;
  af0: number;
  af1: number;
  af2: number;
  crs: number;
  deltaN: number;
  m0: number;
  cuc: number;
  e: number;
  cus: number;
  sqrtA: number;
  cic: number;
  omega0: number;
  cis: number;
  i0: number;
  crc: number;
  omega: number;
  omegaDot: number;
  idot: number;
}

function buildBdsEphemeris(prn: string, f: BdsFields): KeplerEphemeris {
  /* Resolve the toe week against the transmit SOW. Deliberate
   * deviation from RTKLIB demo5, whose decode_bds_d1/d2 fold runs in
   * the wrong direction (inverted relative to its own GPS LNAV fold,
   * so a toe just past a BDT week rollover lands 2 weeks off); the
   * branch only triggers within half a week of a rollover. */
  let week = f.week;
  if (f.toes < f.sow - HALF_WEEK) week++;
  else if (f.toes > f.sow + HALF_WEEK) week--;
  const tocDate = new Date(BDT_EPOCH_MS + week * MS_PER_WEEK + f.tocSec * 1000);

  return {
    system: 'C',
    prn,
    toc: sowOf(tocDate.getTime()),
    tocDate,
    af0: f.af0,
    af1: f.af1,
    af2: f.af2,
    // AODE is not in the ephemeris subframes; RTKLIB derives the RINEX
    // IODE/AODE slot from toc per the BDS ICD update schedule.
    iode: Math.floor(f.tocSec / 720) % 240,
    crs: f.crs,
    deltaN: f.deltaN,
    m0: f.m0,
    cuc: f.cuc,
    e: f.e,
    cus: f.cus,
    sqrtA: f.sqrtA,
    toe: f.toes,
    cic: f.cic,
    omega0: f.omega0,
    cis: f.cis,
    i0: f.i0,
    crc: f.crc,
    omega: f.omega,
    omegaDot: f.omegaDot,
    idot: f.idot,
    week, // RINEX BDS week field is the BDT week of toe
    svHealth: f.svh, // SatH1
    tgd: f.tgd1, // TGD1 (B1) — RINEX slot
  };
}

/* ── D1 (MEO/IGSO) ─────────────────────────────────────────────── */

/**
 * Decode a BeiDou D1 ephemeris from subframes 1-3 (RTKLIB
 * `decode_bds_d1`). Input: subframes at 38-byte strides — bytes 0-37
 * subframe 1, 38-75 subframe 2, 76-113 subframe 3 — each one 300-bit
 * de-interleaved subframe with parity bits in place.
 *
 * Returns `null` when the FraID sequence is not 1/2/3, the SOWs are
 * not 6 s apart (mixed-issue frame), or toc ≠ toe (the D1 ephemeris
 * consistency rule).
 */
export function decodeBdsD1Frame(
  subframes: Uint8Array,
  opts: DecodeBdsOptions = {}
): KeplerEphemeris | null {
  if (subframes.length < 3 * BDS_SUBFRAME_BYTES) return null;
  const b = subframes;

  /* subframe 1 */
  let i = 8 * 38 * 0;
  const frn1 = getBitU(b, i + 15, 3);
  const sow1 = getBitU2(b, i + 18, 8, i + 30, 12);
  const svh = getBitU(b, i + 42, 1); // SatH1
  // i+43,5: AODC — not part of the emitted record
  // i+48,4: URA index — not part of the emitted record
  const week = getBitU(b, i + 60, 13); // week in BDT
  const tocSec = getBitU2(b, i + 73, 9, i + 90, 8) * 8.0;
  const tgd1 = getBitS(b, i + 98, 10) * 0.1 * 1e-9;
  // i+108,4 / i+120,6: TGD2 (B2) — not stored (single-tgd record)
  const af2 = getBitS(b, i + 214, 11) * 2 ** -66;
  const af0 = getBitS2(b, i + 225, 7, i + 240, 17) * 2 ** -33;
  const af1 = getBitS2(b, i + 257, 5, i + 270, 17) * 2 ** -50;

  /* subframe 2 */
  i = 8 * 38 * 1;
  const frn2 = getBitU(b, i + 15, 3);
  const sow2 = getBitU2(b, i + 18, 8, i + 30, 12);
  const deltaN = getBitS2(b, i + 42, 10, i + 60, 6) * 2 ** -43 * GPS_PI;
  const cuc = getBitS2(b, i + 66, 16, i + 90, 2) * 2 ** -31;
  const m0 = getBitS2(b, i + 92, 20, i + 120, 12) * 2 ** -31 * GPS_PI;
  const e = getBitU2(b, i + 132, 10, i + 150, 22) * 2 ** -33;
  const cus = getBitS(b, i + 180, 18) * 2 ** -31;
  const crc = getBitS2(b, i + 198, 4, i + 210, 14) * 2 ** -6;
  const crs = getBitS2(b, i + 224, 8, i + 240, 10) * 2 ** -6;
  const sqrtA = getBitU2(b, i + 250, 12, i + 270, 20) * 2 ** -19;
  const toe1 = getBitU(b, i + 290, 2); // TOE 2-MSB

  /* subframe 3 */
  i = 8 * 38 * 2;
  const frn3 = getBitU(b, i + 15, 3);
  const sow3 = getBitU2(b, i + 18, 8, i + 30, 12);
  const toe2 = getBitU2(b, i + 42, 10, i + 60, 5); // TOE 15-LSB
  const i0 = getBitS2(b, i + 65, 17, i + 90, 15) * 2 ** -31 * GPS_PI;
  const cic = getBitS2(b, i + 105, 7, i + 120, 11) * 2 ** -31;
  const omegaDot = getBitS2(b, i + 131, 11, i + 150, 13) * 2 ** -43 * GPS_PI;
  const cis = getBitS2(b, i + 163, 9, i + 180, 9) * 2 ** -31;
  const idot = getBitS2(b, i + 189, 13, i + 210, 1) * 2 ** -43 * GPS_PI;
  const omega0 = getBitS2(b, i + 211, 21, i + 240, 11) * 2 ** -31 * GPS_PI;
  const omega = getBitS2(b, i + 251, 11, i + 270, 21) * 2 ** -31 * GPS_PI;
  const toes = (toe1 * 2 ** 15 + toe2) * 8.0;

  /* consistency of subframe IDs, SOWs and toe/toc (RTKLIB) */
  if (frn1 !== 1 || frn2 !== 2 || frn3 !== 3) return null;
  if (sow2 !== sow1 + 6 || sow3 !== sow2 + 6) return null;
  if (tocSec !== toes) return null;

  return buildBdsEphemeris(opts.prn ?? 'C00', {
    week,
    sow: sow1,
    toes,
    tocSec,
    svh,
    tgd1,
    af0,
    af1,
    af2,
    crs,
    deltaN,
    m0,
    cuc,
    e,
    cus,
    sqrtA,
    cic,
    omega0,
    cis,
    i0,
    crc,
    omega,
    omegaDot,
    idot,
  });
}

/* ── D2 (GEO) ──────────────────────────────────────────────────── */

/**
 * Decode a BeiDou D2 ephemeris from subframe 1, pages 1-10 (RTKLIB
 * `decode_bds_d2`). Input: pages at 38-byte strides — bytes 0-37
 * page 1, ..., 342-379 page 10 — each one 300-bit de-interleaved
 * subframe with parity bits in place. Page 2 (SatH2/iono) is unused.
 *
 * Returns `null` when the page-number sequence is not 1..10, the SOWs
 * do not chain (page 3 = page 1 + 6 s, then 3 s steps), or toc ≠ toe.
 */
export function decodeBdsD2Frame(
  pages: Uint8Array,
  opts: DecodeBdsOptions = {}
): KeplerEphemeris | null {
  if (pages.length < 10 * BDS_SUBFRAME_BYTES) return null;
  const b = pages;

  /* page 1 */
  let i = 8 * 38 * 0;
  const pgn1 = getBitU(b, i + 42, 4);
  const sow1 = getBitU2(b, i + 18, 8, i + 30, 12);
  const svh = getBitU(b, i + 46, 1); // SatH1
  // i+47,5: AODC, i+60,4: URA index — not part of the emitted record
  const week = getBitU(b, i + 64, 13); // week in BDT
  const tocSec = getBitU2(b, i + 77, 5, i + 90, 12) * 8.0;
  const tgd1 = getBitS(b, i + 102, 10) * 0.1 * 1e-9;
  // i+120,10: TGD2 (B2) — not stored (single-tgd record)

  /* page 3 */
  i = 8 * 38 * 2;
  const pgn3 = getBitU(b, i + 42, 4);
  const sow3 = getBitU2(b, i + 18, 8, i + 30, 12);
  const af0 = getBitS2(b, i + 100, 12, i + 120, 12) * 2 ** -33;
  const af1p3 = getBitS(b, i + 132, 4);

  /* page 4 */
  i = 8 * 38 * 3;
  const pgn4 = getBitU(b, i + 42, 4);
  const sow4 = getBitU2(b, i + 18, 8, i + 30, 12);
  const af1p4 = getBitU2(b, i + 46, 6, i + 60, 12);
  const af2 = getBitS2(b, i + 72, 10, i + 90, 1) * 2 ** -66;
  const deltaN = getBitS(b, i + 96, 16) * 2 ** -43 * GPS_PI;
  const cucp4 = getBitS(b, i + 120, 14);

  /* page 5 */
  i = 8 * 38 * 4;
  const pgn5 = getBitU(b, i + 42, 4);
  const sow5 = getBitU2(b, i + 18, 8, i + 30, 12);
  const cucp5 = getBitU(b, i + 46, 4);
  const m0 = getBitS3(b, i + 50, 2, i + 60, 22, i + 90, 8) * 2 ** -31 * GPS_PI;
  const cus = getBitS2(b, i + 98, 14, i + 120, 4) * 2 ** -31;
  const ep5 = getBitS(b, i + 124, 10);

  /* page 6 */
  i = 8 * 38 * 5;
  const pgn6 = getBitU(b, i + 42, 4);
  const sow6 = getBitU2(b, i + 18, 8, i + 30, 12);
  const ep6 = getBitU2(b, i + 46, 6, i + 60, 16);
  const sqrtA = getBitU3(b, i + 76, 6, i + 90, 22, i + 120, 4) * 2 ** -19;
  const cicp6 = getBitS(b, i + 124, 10);

  /* page 7 */
  i = 8 * 38 * 6;
  const pgn7 = getBitU(b, i + 42, 4);
  const sow7 = getBitU2(b, i + 18, 8, i + 30, 12);
  const cicp7 = getBitU2(b, i + 46, 6, i + 60, 2);
  const cis = getBitS(b, i + 62, 18) * 2 ** -31;
  const toes = getBitU2(b, i + 80, 2, i + 90, 15) * 8.0;
  const i0p7 = getBitS2(b, i + 105, 7, i + 120, 14);

  /* page 8 */
  i = 8 * 38 * 7;
  const pgn8 = getBitU(b, i + 42, 4);
  const sow8 = getBitU2(b, i + 18, 8, i + 30, 12);
  const i0p8 = getBitU2(b, i + 46, 6, i + 60, 5);
  const crc = getBitS2(b, i + 65, 17, i + 90, 1) * 2 ** -6;
  const crs = getBitS(b, i + 91, 18) * 2 ** -6;
  const omegaDotP8 = getBitS2(b, i + 109, 3, i + 120, 16);

  /* page 9 */
  i = 8 * 38 * 8;
  const pgn9 = getBitU(b, i + 42, 4);
  const sow9 = getBitU2(b, i + 18, 8, i + 30, 12);
  const omegaDotP9 = getBitU(b, i + 46, 5);
  const omega0 =
    getBitS3(b, i + 51, 1, i + 60, 22, i + 90, 9) * 2 ** -31 * GPS_PI;
  const omegaP9 = getBitS2(b, i + 99, 13, i + 120, 14);

  /* page 10 */
  i = 8 * 38 * 9;
  const pgn10 = getBitU(b, i + 42, 4);
  const sow10 = getBitU2(b, i + 18, 8, i + 30, 12);
  const omegaP10 = getBitU(b, i + 46, 5);
  const idot = getBitS2(b, i + 51, 1, i + 60, 13) * 2 ** -43 * GPS_PI;

  /* consistency of page numbers, SOWs and toe/toc (RTKLIB) */
  if (
    pgn1 !== 1 ||
    pgn3 !== 3 ||
    pgn4 !== 4 ||
    pgn5 !== 5 ||
    pgn6 !== 6 ||
    pgn7 !== 7 ||
    pgn8 !== 8 ||
    pgn9 !== 9 ||
    pgn10 !== 10
  ) {
    return null;
  }
  if (
    sow3 !== sow1 + 6 ||
    sow4 !== sow3 + 3 ||
    sow5 !== sow4 + 3 ||
    sow6 !== sow5 + 3 ||
    sow7 !== sow6 + 3 ||
    sow8 !== sow7 + 3 ||
    sow9 !== sow8 + 3 ||
    sow10 !== sow9 + 3
  ) {
    return null;
  }
  if (tocSec !== toes) return null;

  return buildBdsEphemeris(opts.prn ?? 'C00', {
    week,
    sow: sow1,
    toes,
    tocSec,
    svh,
    tgd1,
    af0,
    af1: mergeS(af1p3, af1p4, 18) * 2 ** -50,
    af2,
    crs,
    deltaN,
    m0,
    cuc: mergeS(cucp4, cucp5, 4) * 2 ** -31,
    e: mergeS(ep5, ep6, 22) * 2 ** -33,
    cus,
    sqrtA,
    cic: mergeS(cicp6, cicp7, 8) * 2 ** -31,
    omega0,
    cis,
    i0: mergeS(i0p7, i0p8, 11) * 2 ** -31 * GPS_PI,
    crc,
    omega: mergeS(omegaP9, omegaP10, 5) * 2 ** -31 * GPS_PI,
    omegaDot: mergeS(omegaDotP8, omegaDotP9, 5) * 2 ** -43 * GPS_PI,
    idot,
  });
}

/* ── Streaming assembler ───────────────────────────────────────── */

/** GEO satellites broadcast D2; MEO/IGSO broadcast D1 (per PRN). */
export function isBdsGeoPrn(prn: number): boolean {
  return prn < 6 || prn > 58;
}

interface BdsSatState {
  buf: Uint8Array;
  lastKey?: string;
}

/**
 * Streaming assembler for BeiDou D1/D2 ephemerides: feed 300-bit
 * subframes (parity-checked — see `bdsSubframeParityOk`) in received
 * order; a `KeplerEphemeris` is returned whenever a satellite's
 * buffered subframes first form a consistent frame — D1 on subframe 3
 * (subframes 1-3 with chained SOWs), D2 on subframe 1 page 10 (pages
 * 1-10) — with unchanged repeats of the same toe suppressed, the same
 * flow as RTKLIB's decode_cmpraw (src/rcv/septentrio.c).
 */
export class BdsAssembler {
  private sats = new Map<string, BdsSatState>();

  /**
   * Push one 300-bit subframe (38+ bytes, bit 0 = first bit of the
   * preamble) for the satellite `prn` ("C06"). Returns the newly
   * completed ephemeris, or null.
   */
  push(prn: string, subframe: Uint8Array): KeplerEphemeris | null {
    if (subframe.length < BDS_SUBFRAME_BYTES) return null;
    const num = parseInt(prn.slice(1), 10);
    if (!Number.isFinite(num) || num < 1 || num > 63) return null;
    const id = getBitU(subframe, 15, 3);
    if (id < 1 || id > 5) return null;

    let sat = this.sats.get(prn);
    if (!sat) {
      sat = { buf: new Uint8Array(10 * BDS_SUBFRAME_BYTES) };
      this.sats.set(prn, sat);
    }

    let eph: KeplerEphemeris | null = null;
    if (!isBdsGeoPrn(num)) {
      /* D1: subframes 1-5 at 38-byte strides, decode on subframe 3 */
      sat.buf.set(subframe.subarray(0, BDS_SUBFRAME_BYTES), (id - 1) * 38);
      if (id === 3) eph = decodeBdsD1Frame(sat.buf, { prn });
    } else {
      /* D2: subframe 1 pages 1-10 at 38-byte strides */
      if (id !== 1) return null;
      const pgn = getBitU(subframe, 42, 4);
      if (pgn < 1 || pgn > 10) return null;
      sat.buf.set(subframe.subarray(0, BDS_SUBFRAME_BYTES), (pgn - 1) * 38);
      if (pgn === 10) eph = decodeBdsD2Frame(sat.buf, { prn });
    }
    if (!eph) return null;

    /* suppress unchanged rebroadcasts (RTKLIB dedups BDS raw by toe) */
    const key = `${eph.week}:${eph.toe}`;
    if (key === sat.lastKey) return null;
    sat.lastKey = key;
    return eph;
  }
}
