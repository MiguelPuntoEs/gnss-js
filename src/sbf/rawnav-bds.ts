/**
 * Septentrio SBF raw BeiDou / GLONASS navigation-bit blocks: BDSRaw
 * (4047) carries one 300-bit BeiDou D1/D2 subframe (de-interleaved,
 * parity bits in place, from B1I/B2I/B3I), GLORawCA (4026) one 85-bit
 * GLONASS L1 or L2 C/A navigation string (everything but the time
 * mark).
 *
 * Block layout (mosaic-X5 reference guide §4): after the 8-byte SBF
 * header, TOW u4 + WNc u2, SVID u1, CRCPassed u1, ViterbiCnt u1,
 * Source u1, then FreqNr u1 (GLORawCA) / Reserved u1 (BDSRaw),
 * RxChannel u1, and NAVBits as u4[10] (BDSRaw) / u4[3] (GLORawCA) —
 * the first received bit is the MSB of NAVBits[0], trailing unused
 * bits of the last word to be ignored. RTKLIB demo5 routes the same
 * blocks through decode_cmpraw / decode_glorawcanav
 * (src/rcv/septentrio.c) into decode_bds_d1/d2 / decode_glostr; the
 * frame decoding here is src/navbits/bds.ts and src/navbits/glo.ts.
 *
 * The receiver's own CRCPassed flag is ignored in favor of re-running
 * the BCH(15,11,1) word parity (BDS) / Hamming KX (GLONASS) checks on
 * the transported bits, so `badCrc` counts exactly the messages this
 * library rejected (RTKLIB trusts the flag and checks nothing).
 */

import { BdsAssembler, bdsSubframeParityOk } from '../navbits/bds';
import { GloStringAssembler, testGloString } from '../navbits/glo';
import type { GlonassEphemeris, KeplerEphemeris } from '../rinex/nav';
import { scanSbfFrames, svidToPrn } from './frame';

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const MS_PER_WEEK = 7 * 86400 * 1000;
const TOW_DNU = 4294967295;
const WNC_DNU = 65535;

export interface SbfBdsNavResult {
  /** Assembled BDS D1/D2 ephemerides in stream order, repeats suppressed. */
  ephemerides: KeplerEphemeris[];
  /** Subframes whose BCH(15,11,1) word parity failed (dropped). */
  badCrc: number;
  /** Total BDSRaw blocks seen (with valid SBF framing). */
  messages: number;
}

/**
 * Process one BDSRaw (4047) block at frame offset `b`: extract the
 * 300-bit D1/D2 subframe, run BCH(15,11,1) word parity, and push it to
 * the shared assembler. Returns a fresh ephemeris, or `{ badCrc: true }`
 * on a parity failure. Shared by {@link parseSbfBdsNav} and the one-pass
 * {@link decodeSbfNavigation}.
 */
export function feedBdsBlock(
  view: DataView,
  b: number,
  assembler: BdsAssembler
): { eph?: KeplerEphemeris; badCrc?: boolean } {
  const prn = svidToPrn(view.getUint8(b + 14));
  if (!prn || prn[0] !== 'C') return {};

  // NAVBits u4[10] at +20: first received bit = MSB of NAVBits[0];
  // 300 bits, the low 20 bits of NAVBits[9] to be ignored.
  const sf = new Uint8Array(38);
  for (let k = 0; k < 10; k++) {
    const w = view.getUint32(b + 20 + 4 * k, true);
    sf[4 * k] = w >>> 24;
    if (k < 9) {
      sf[4 * k + 1] = (w >>> 16) & 0xff;
      sf[4 * k + 2] = (w >>> 8) & 0xff;
      sf[4 * k + 3] = w & 0xff;
    } else {
      sf[37] = (w >>> 16) & 0xf0; // bits 296-299; 300-303 unused
    }
  }

  if (!bdsSubframeParityOk(sf)) return { badCrc: true };
  const eph = assembler.push(prn, sf);
  return eph ? { eph } : {};
}

/**
 * Decode every BDSRaw (4047) block in an SBF byte stream and assemble
 * the carried D1/D2 subframes into ephemerides (`system: 'C'`, BDT
 * epochs/weeks, like `parseSbfNav`'s BDSNav records). GEO satellites
 * (PRN 1-5, 59-63) are decoded as D2, MEO/IGSO as D1. Subframes from
 * B1I/B2I/B3I carry the same message and share one assembler per
 * satellite, as in RTKLIB.
 */
export function parseSbfBdsNav(data: Uint8Array): SbfBdsNavResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ephemerides: KeplerEphemeris[] = [];
  const assembler = new BdsAssembler();
  let badCrc = 0;
  let messages = 0;

  scanSbfFrames(data, view, (id, b, len) => {
    if (id !== 4047 || len < 60) return;
    messages++;
    const r = feedBdsBlock(view, b, assembler);
    if (r.eph) ephemerides.push(r.eph);
    else if (r.badCrc) badCrc++;
  });

  return { ephemerides, badCrc, messages };
}

export interface SbfGloNavResult {
  /** Assembled GLONASS ephemerides in stream order, repeats suppressed. */
  ephemerides: GlonassEphemeris[];
  /** Strings whose Hamming (KX) check failed (dropped). */
  badCrc: number;
  /** Total GLORawCA blocks seen (with valid SBF framing). */
  messages: number;
}

/**
 * Decode every GLORawCA (4026) block in an SBF byte stream and
 * assemble the carried navigation strings into ephemerides (same
 * conventions as `parseSbfNav`'s GLONav records: UTC `tocDate`, RINEX
 * `tauN` sign, km state vectors, `messageFrameTime` in seconds of the
 * UTC week — here from the broadcast tk, see the oracle notes in
 * test/bdsglo-raw.test.ts). The block's TOW/WNc time stamp resolves
 * the GLONASS day; blocks without one (do-not-use) are skipped, as
 * are SVID-62 blocks (GLONASS satellite with unknown slot number).
 * L1 C/A and L2 C/A strings are identical and share one assembler
 * per slot, as in RTKLIB.
 */
/**
 * Process one GLORawCA (4026) block at frame offset `b`: extract the
 * 85-bit navigation string, run the Hamming (KX) check, and push it to
 * the shared assembler with the block's TOW/WNc-derived day and
 * frequency number. Returns a fresh ephemeris, `{ badCrc: true }` on a
 * Hamming failure, or `{}` when the block has no valid time stamp
 * (do-not-use). Shared by {@link parseSbfGloNav} and the one-pass
 * {@link decodeSbfNavigation}.
 */
export function feedGloBlock(
  view: DataView,
  b: number,
  assembler: GloStringAssembler
): { eph?: GlonassEphemeris; badCrc?: boolean } {
  const prn = svidToPrn(view.getUint8(b + 14));
  if (!prn || prn[0] !== 'R') return {};
  const towMs = view.getUint32(b + 8, true);
  const wnc = view.getUint16(b + 12, true);
  if (towMs === TOW_DNU || wnc === WNC_DNU) return {};

  // NAVBits u4[3] at +20: first received bit = MSB of NAVBits[0];
  // 85 bits, the low 11 bits of NAVBits[2] to be ignored.
  const str = new Uint8Array(11);
  for (let k = 0; k < 3; k++) {
    const w = view.getUint32(b + 20 + 4 * k, true);
    str[4 * k] = w >>> 24;
    if (k < 2) {
      str[4 * k + 1] = (w >>> 16) & 0xff;
      str[4 * k + 2] = (w >>> 8) & 0xff;
      str[4 * k + 3] = w & 0xff;
    } else {
      str[9] = (w >>> 16) & 0xff;
      str[10] = (w >>> 8) & 0xf8; // bits 80-84; 85-95 unused
    }
  }

  if (!testGloString(str)) return { badCrc: true };
  const eph = assembler.push(
    prn,
    str,
    new Date(GPS_EPOCH_MS + wnc * MS_PER_WEEK + towMs),
    view.getUint8(b + 18) - 8 // FreqNr, offset by 8
  );
  return eph ? { eph } : {};
}

export function parseSbfGloNav(data: Uint8Array): SbfGloNavResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ephemerides: GlonassEphemeris[] = [];
  const assembler = new GloStringAssembler();
  let badCrc = 0;
  let messages = 0;

  scanSbfFrames(data, view, (id, b, len) => {
    if (id !== 4026 || len < 32) return;
    messages++;
    const r = feedGloBlock(view, b, assembler);
    if (r.eph) ephemerides.push(r.eph);
    else if (r.badCrc) badCrc++;
  });

  return { ephemerides, badCrc, messages };
}
