/**
 * Galileo broadcast navigation-message decoding: I/NAV (E1-B / E5b-I,
 * Galileo OS SIS ICD §4.3) and F/NAV (E5a-I, §4.2).
 *
 * Receiver-independent, like the LNAV/CNAV decoders in this module:
 * Septentrio GALRawINAV/GALRawFNAV and u-blox RXM-SFRBX deliver the
 * same pages, so the CRC-24Q checks, per-word/page field extraction
 * and the word-type-1-5 / page-type-1-4 ephemeris assembly live here.
 *
 * `decodeGalInavWords` and `decodeGalFnavPages` are ports of RTKLIB's
 * `decode_gal_inav` / `decode_gal_fnav` (demo5 / rtklibexplorer fork,
 * src/rcvraw.c, Copyright (c) 2007-2020 T. Takasu, BSD-2-Clause); the
 * page-to-word assembly mirrors `decode_galrawinav` /
 * `decode_galrawfnav` in src/rcv/septentrio.c. Both were cross-checked
 * against the OS SIS ICD (Tables 39-44 for I/NAV, 27-31 for F/NAV).
 * Deviations from RTKLIB:
 * - the page CRC-24Q is verified here (`galInavPageCrcOk` /
 *   `galFnavPageCrcOk`); RTKLIB trusts the receiver's CRC flag,
 * - only word types 1-5 / page types 1-4 are buffered (RTKLIB also
 *   stores I/NAV word 0/6 and F/NAV pages 5/6 for iono/UTC decoding),
 * - repeats of an unchanged data set (same IODNav/toe/toc) are
 *   suppressed in the assembler, where RTKLIB dedups in the receiver
 *   layer against its per-satellite ephemeris slot.
 *
 * Output records mirror `parseNavFile` for RINEX Galileo records:
 * semicircle fields scaled by GPS_PI, `iode` = IODNav, `week` the
 * GPS-aligned continuous week (GST week + 1024), GPS-scale `tocDate`,
 * and `tgd` = BGD E5a/E1 (the first RINEX BGD slot) for both message
 * types. The clock set (af0-2, toc) is the one of the carrying
 * message: E1B/E5b for I/NAV, E1B/E5a for F/NAV — the RINEX
 * I/NAV-vs-F/NAV record distinction.
 */

import type { KeplerEphemeris } from '../rinex/nav';
import { crc24q } from './cnav';
import { getBitS, getBitU, GPS_PI } from './index';

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const SEC_PER_WEEK = 7 * 86400;
const HALF_WEEK = 302400;

/** GST week 0 = GPS week 1024 (OS SIS ICD §5.1.2): GAL → GPS week. */
export const GST_GPS_WEEK_OFFSET = 1024;

/* ── Page CRC-24Q checks ───────────────────────────────────────── */

/**
 * Check the CRC-24Q of one I/NAV nominal page pair, delivered as the
 * 234-bit even+odd concatenation (even part first, its 6 tail bits
 * removed — the Septentrio GALRawINAV transport). The CRC spans the
 * 196 bits Even/Odd..Data(1/2) + Even/Odd..Spare (OS SIS ICD
 * §4.3.2.4) — contiguous bits 0-195 here — with the parity at bits
 * 196-219. `page` must hold at least 28 bytes.
 */
export function galInavPageCrcOk(page: Uint8Array): boolean {
  if (page.length < 28) return false;
  return crc24q(page, 196) === getBitU(page, 196, 24);
}

/**
 * Check the CRC-24Q of one 244-bit F/NAV page (sync stripped): the CRC
 * spans page type + navigation data (bits 0-213, OS SIS ICD §4.2.2),
 * with the parity at bits 214-237. `page` must hold at least 30 bytes.
 */
export function galFnavPageCrcOk(page: Uint8Array): boolean {
  if (page.length < 30) return false;
  return crc24q(page, 214) === getBitU(page, 214, 24);
}

/* ── Shared helpers ────────────────────────────────────────────── */

function gpsDate(week: number, sec: number): Date {
  return new Date(GPS_EPOCH_MS + (week * SEC_PER_WEEK + sec) * 1000);
}

/**
 * Resolve the GST week against toe like RTKLIB: the SIS week belongs
 * to the transmit time (tow); move it so toe falls within a half week.
 */
function weekOfToe(week: number, tow: number, toe: number): number {
  if (toe - tow > HALF_WEEK) return week - 1;
  if (toe - tow < -HALF_WEEK) return week + 1;
  return week;
}

const two = (n: number) => String(n).padStart(2, '0');

/* ── I/NAV word decoding (word types 1-5) ──────────────────────── */

/**
 * Decode Galileo I/NAV word types 1-5 into a Keplerian ephemeris.
 *
 * `words` holds the 128-bit nav words at 16 bytes per word type
 * (word type k at bytes 16k-16k+15, ≥ 96 bytes) — RTKLIB's
 * `decode_gal_inav` buffer layout, which `GalInavAssembler` fills from
 * received pages. Returns `null` when the word types are not 1-5,
 * the IODNav of words 1-4 disagree (mixed-issue buffer) or the word-4
 * SVID is out of range. `svHealth` packs the word-5 E5b/E1B health
 * bits in the RINEX Galileo layout (E1B DVS/HS in bits 0-2, E5b in
 * 6-8) and `tgd` is BGD E5a/E1; BGD E5b/E1 (the second RINEX slot) is
 * not part of the record.
 */
export function decodeGalInavWords(words: Uint8Array): KeplerEphemeris | null {
  if (words.length < 96) return null;
  const b = words;

  /* word type 1 */
  let i = 128;
  const type1 = getBitU(b, i, 6);
  i += 6;
  const iodNav1 = getBitU(b, i, 10);
  i += 10;
  const toes = getBitU(b, i, 14) * 60.0;
  i += 14;
  const m0 = getBitS(b, i, 32) * 2 ** -31 * GPS_PI;
  i += 32;
  const e = getBitU(b, i, 32) * 2 ** -33;
  i += 32;
  const sqrtA = getBitU(b, i, 32) * 2 ** -19;

  /* word type 2 */
  i = 128 * 2;
  const type2 = getBitU(b, i, 6);
  i += 6;
  const iodNav2 = getBitU(b, i, 10);
  i += 10;
  const omega0 = getBitS(b, i, 32) * 2 ** -31 * GPS_PI;
  i += 32;
  const i0 = getBitS(b, i, 32) * 2 ** -31 * GPS_PI;
  i += 32;
  const omega = getBitS(b, i, 32) * 2 ** -31 * GPS_PI;
  i += 32;
  const idot = getBitS(b, i, 14) * 2 ** -43 * GPS_PI;

  /* word type 3 */
  i = 128 * 3;
  const type3 = getBitU(b, i, 6);
  i += 6;
  const iodNav3 = getBitU(b, i, 10);
  i += 10;
  const omegaDot = getBitS(b, i, 24) * 2 ** -43 * GPS_PI;
  i += 24;
  const deltaN = getBitS(b, i, 16) * 2 ** -43 * GPS_PI;
  i += 16;
  const cuc = getBitS(b, i, 16) * 2 ** -29;
  i += 16;
  const cus = getBitS(b, i, 16) * 2 ** -29;
  i += 16;
  const crc = getBitS(b, i, 16) * 2 ** -5;
  i += 16;
  const crs = getBitS(b, i, 16) * 2 ** -5;
  // + SISA(E1,E5b) index (8 bits): no KeplerEphemeris slot

  /* word type 4 */
  i = 128 * 4;
  const type4 = getBitU(b, i, 6);
  i += 6;
  const iodNav4 = getBitU(b, i, 10);
  i += 10;
  const svid = getBitU(b, i, 6);
  i += 6;
  const cic = getBitS(b, i, 16) * 2 ** -29;
  i += 16;
  const cis = getBitS(b, i, 16) * 2 ** -29;
  i += 16;
  const tocs = getBitU(b, i, 14) * 60.0;
  i += 14;
  const af0 = getBitS(b, i, 31) * 2 ** -34;
  i += 31;
  const af1 = getBitS(b, i, 21) * 2 ** -46;
  i += 21;
  const af2 = getBitS(b, i, 6) * 2 ** -59;

  /* word type 5 */
  i = 128 * 5;
  const type5 = getBitU(b, i, 6);
  i += 6 + 11 + 11 + 14 + 5; // a_i0-2 + iono disturbance flags
  const bgdE5a = getBitS(b, i, 10) * 2 ** -32; // BGD E5a/E1
  i += 10;
  i += 10; // BGD E5b/E1 — no KeplerEphemeris slot
  const e5bHs = getBitU(b, i, 2);
  i += 2;
  const e1bHs = getBitU(b, i, 2);
  i += 2;
  const e5bDvs = getBitU(b, i, 1);
  i += 1;
  const e1bDvs = getBitU(b, i, 1);
  i += 1;
  const gstWeek = getBitU(b, i, 12);
  i += 12;
  const tow = getBitU(b, i, 20);

  if (type1 !== 1 || type2 !== 2 || type3 !== 3 || type4 !== 4 || type5 !== 5)
    return null;
  if (iodNav1 !== iodNav2 || iodNav1 !== iodNav3 || iodNav1 !== iodNav4)
    return null;
  if (svid < 1 || svid > 36) return null;

  const week = weekOfToe(gstWeek, tow, toes) + GST_GPS_WEEK_OFFSET;
  const tocDate = gpsDate(week, tocs);

  return {
    system: 'E',
    prn: `E${two(svid)}`,
    toc: (tocDate.getTime() / 1000) % SEC_PER_WEEK,
    tocDate,
    af0,
    af1,
    af2,
    iode: iodNav1,
    crs,
    deltaN,
    m0,
    cuc,
    e,
    cus,
    sqrtA,
    toe: toes,
    cic,
    omega0,
    cis,
    i0,
    crc,
    omega,
    omegaDot,
    idot,
    week,
    svHealth: (e5bHs << 7) | (e5bDvs << 6) | (e1bHs << 1) | e1bDvs,
    tgd: bgdE5a,
  };
}

/* ── F/NAV page decoding (page types 1-4) ──────────────────────── */

/**
 * Decode Galileo F/NAV page types 1-4 into a Keplerian ephemeris.
 *
 * `pages` holds the 244-bit pages at 31 bytes per page type (page
 * type k at bytes 31(k−1), ≥ 124 bytes) — RTKLIB's `decode_gal_fnav`
 * buffer layout, which `GalFnavAssembler` fills. Returns `null` when
 * the page types are not 1-4, the IODNav disagree or the page-1 SVID
 * is out of range. `svHealth` packs the page-1 E5a health bits in the
 * RINEX layout (E5a DVS/HS in bits 3-5) and `tgd` is BGD E5a/E1 (the
 * only BGD F/NAV broadcasts).
 */
export function decodeGalFnavPages(pages: Uint8Array): KeplerEphemeris | null {
  if (pages.length < 124) return null;
  const b = pages;

  /* page type 1 */
  let i = 0;
  const type1 = getBitU(b, i, 6);
  i += 6;
  const svid = getBitU(b, i, 6);
  i += 6;
  const iodNav1 = getBitU(b, i, 10);
  i += 10;
  const tocs = getBitU(b, i, 14) * 60.0;
  i += 14;
  const af0 = getBitS(b, i, 31) * 2 ** -34;
  i += 31;
  const af1 = getBitS(b, i, 21) * 2 ** -46;
  i += 21;
  const af2 = getBitS(b, i, 6) * 2 ** -59;
  i += 6;
  i += 8 + 11 + 11 + 14 + 5; // SISA(E1,E5a) + a_i0-2 + iono flags
  const bgdE5a = getBitS(b, i, 10) * 2 ** -32; // BGD E5a/E1
  i += 10;
  const e5aHs = getBitU(b, i, 2);
  i += 2;
  const gstWeek = getBitU(b, i, 12);
  i += 12;
  const tow = getBitU(b, i, 20);
  i += 20;
  const e5aDvs = getBitU(b, i, 1);

  /* page type 2 */
  i = 31 * 8;
  const type2 = getBitU(b, i, 6);
  i += 6;
  const iodNav2 = getBitU(b, i, 10);
  i += 10;
  const m0 = getBitS(b, i, 32) * 2 ** -31 * GPS_PI;
  i += 32;
  const omegaDot = getBitS(b, i, 24) * 2 ** -43 * GPS_PI;
  i += 24;
  const e = getBitU(b, i, 32) * 2 ** -33;
  i += 32;
  const sqrtA = getBitU(b, i, 32) * 2 ** -19;
  i += 32;
  const omega0 = getBitS(b, i, 32) * 2 ** -31 * GPS_PI;
  i += 32;
  const idot = getBitS(b, i, 14) * 2 ** -43 * GPS_PI;

  /* page type 3 */
  i = 62 * 8;
  const type3 = getBitU(b, i, 6);
  i += 6;
  const iodNav3 = getBitU(b, i, 10);
  i += 10;
  const i0 = getBitS(b, i, 32) * 2 ** -31 * GPS_PI;
  i += 32;
  const omega = getBitS(b, i, 32) * 2 ** -31 * GPS_PI;
  i += 32;
  const deltaN = getBitS(b, i, 16) * 2 ** -43 * GPS_PI;
  i += 16;
  const cuc = getBitS(b, i, 16) * 2 ** -29;
  i += 16;
  const cus = getBitS(b, i, 16) * 2 ** -29;
  i += 16;
  const crc = getBitS(b, i, 16) * 2 ** -5;
  i += 16;
  const crs = getBitS(b, i, 16) * 2 ** -5;
  i += 16;
  const toes = getBitU(b, i, 14) * 60.0;

  /* page type 4 */
  i = 93 * 8;
  const type4 = getBitU(b, i, 6);
  i += 6;
  const iodNav4 = getBitU(b, i, 10);
  i += 10;
  const cic = getBitS(b, i, 16) * 2 ** -29;
  i += 16;
  const cis = getBitS(b, i, 16) * 2 ** -29;

  if (type1 !== 1 || type2 !== 2 || type3 !== 3 || type4 !== 4) return null;
  if (iodNav1 !== iodNav2 || iodNav1 !== iodNav3 || iodNav1 !== iodNav4)
    return null;
  if (svid < 1 || svid > 36) return null;

  const week = weekOfToe(gstWeek, tow, toes) + GST_GPS_WEEK_OFFSET;
  const tocDate = gpsDate(week, tocs);

  return {
    system: 'E',
    prn: `E${two(svid)}`,
    toc: (tocDate.getTime() / 1000) % SEC_PER_WEEK,
    tocDate,
    af0,
    af1,
    af2,
    iode: iodNav1,
    crs,
    deltaN,
    m0,
    cuc,
    e,
    cus,
    sqrtA,
    toe: toes,
    cic,
    omega0,
    cis,
    i0,
    crc,
    omega,
    omegaDot,
    idot,
    week,
    svHealth: (e5aHs << 4) | (e5aDvs << 3),
    tgd: bgdE5a,
  };
}

/* ── Streaming assemblers ──────────────────────────────────────── */

interface SatWords {
  words: Uint8Array;
  lastKey?: string;
}

const dedupKey = (eph: KeplerEphemeris) =>
  `${eph.iode}:${eph.toe}:${eph.tocDate.getTime()}`;

/**
 * Streaming assembler for I/NAV ephemerides: feed nominal page pairs
 * (CRC-valid — see `galInavPageCrcOk`) in received order; a
 * `KeplerEphemeris` is returned whenever a satellite's buffered word
 * types 1-5 first form a consistent data set, with unchanged repeats
 * (same IODNav/toe/toc, RTKLIB's dedup) suppressed. Pages from
 * different carriers (E1-B, E5b-I) fill the same per-satellite buffer,
 * as in RTKLIB — the two channels broadcast the same words.
 */
export class GalInavAssembler {
  private sats = new Map<number, SatWords>();

  /**
   * Push one I/NAV page pair for satellite `prn` (1-36): the 234-bit
   * even+odd concatenation, even part first with its 6 tail bits
   * removed, bit 0 = the even part's Even/Odd bit (≥ 17 bytes).
   * Returns the newly completed ephemeris, or null. Pages that are
   * not an even/odd nominal pair, alert pages and word types outside
   * 1-5 are ignored.
   */
  push(prn: number, page: Uint8Array): KeplerEphemeris | null {
    if (prn < 1 || prn > 36 || page.length < 17) return null;
    // Even/Odd flags of the two parts (ICD §4.3.2.3: 0 = even, 1 = odd)
    if (getBitU(page, 0, 1) !== 0 || getBitU(page, 114, 1) !== 1) return null;
    // Page Type flags: 1 marks an alert page (no nav words)
    if (getBitU(page, 1, 1) === 1 || getBitU(page, 115, 1) === 1) return null;

    const type = getBitU(page, 2, 6);
    if (type < 1 || type > 5) return null;

    let sat = this.sats.get(prn);
    if (!sat) {
      sat = { words: new Uint8Array(96) };
      this.sats.set(prn, sat);
    }

    // Reassemble the 128-bit word: 112 data bits from the even part
    // (after Even/Odd + Page Type) + the odd part's first 16 data bits.
    for (let k = 0; k < 14; k++)
      sat.words[type * 16 + k] = getBitU(page, 2 + 8 * k, 8);
    sat.words[type * 16 + 14] = getBitU(page, 116, 8);
    sat.words[type * 16 + 15] = getBitU(page, 124, 8);

    if (type !== 5) return null;
    const eph = decodeGalInavWords(sat.words);
    if (!eph || eph.prn !== `E${two(prn)}`) return null;

    const key = dedupKey(eph);
    if (key === sat.lastKey) return null;
    sat.lastKey = key;
    return eph;
  }
}

/**
 * Streaming assembler for F/NAV ephemerides: feed 244-bit pages
 * (CRC-valid — see `galFnavPageCrcOk`) in received order; a
 * `KeplerEphemeris` is returned whenever a satellite's buffered page
 * types 1-4 first form a consistent data set, with unchanged repeats
 * suppressed like the I/NAV assembler.
 */
export class GalFnavAssembler {
  private sats = new Map<number, SatWords>();

  /**
   * Push one F/NAV page for satellite `prn` (1-36): 244 bits with the
   * sync field stripped, bit 0 = first page-type bit (≥ 31 bytes).
   * Returns the newly completed ephemeris, or null. Dummy pages
   * (type 63) and page types outside 1-4 are ignored.
   */
  push(prn: number, page: Uint8Array): KeplerEphemeris | null {
    if (prn < 1 || prn > 36 || page.length < 31) return null;
    const type = getBitU(page, 0, 6);
    if (type < 1 || type > 4) return null; // incl. type 63: dummy page

    let sat = this.sats.get(prn);
    if (!sat) {
      sat = { words: new Uint8Array(124) };
      this.sats.set(prn, sat);
    }
    sat.words.set(page.subarray(0, 31), (type - 1) * 31);

    if (type !== 4) return null;
    const eph = decodeGalFnavPages(sat.words);
    if (!eph || eph.prn !== `E${two(prn)}`) return null;

    const key = dedupKey(eph);
    if (key === sat.lastKey) return null;
    sat.lastKey = key;
    return eph;
  }
}
