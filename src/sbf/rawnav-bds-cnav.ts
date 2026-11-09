/**
 * Septentrio SBF raw BeiDou-3 navigation blocks — BDSRawB1C (4218),
 * BDSRawB2a (4219) and BDSRawB2b (4242) — into B-CNAV1/2/3 ephemerides.
 *
 * Block layout: after the 8-byte SBF header, TOW u4 + WNc u2, SVID u1,
 * then CRCPassed u1 (B1C: CRCSF2 u1 + CRCSF3 u1), Source/Reserved
 * bytes, RxChannel u1, and NAVBits as u4 words at +20 — the first bit
 * is the MSB of NAVBits[0], each u4 little-endian in the stream. The
 * receiver has already run the LDPC decoding; the positions inside
 * NAVBits were established on TU Delft DLF500 captures (every message
 * passes CRC-24Q at these offsets) and the decoded fields match DLR's
 * BRD400DLR RINEX 4 records:
 *
 *  - B1C (u4[57]): subframe 1 as its 72 raw BCH symbols, then
 *    subframe 2's 600 decoded bits at bit 72 and subframe 3's 264 at
 *    bit 1272 — each at the start of its 1200/528-symbol slot.
 *  - B2a (u4[18]): the 288-bit message from the PRN (no preamble).
 *  - B2b (u4[31]): PRN (6) + reserved (6), then the 486-bit message.
 *
 * The receiver's CRC flags are ignored in favor of re-checking CRC-24Q,
 * so `badCrc` counts exactly what this library rejected.
 */

import {
  BdsCnav1Assembler,
  BdsCnav2Assembler,
  BdsCnav3Assembler,
  bdsCnav1Sf2CrcOk,
  bdsCnav1Sf3CrcOk,
  bdsCnav2CrcOk,
  bdsCnav3CrcOk,
  type BdsCnavEphemeris,
} from '../navbits/bds-cnav';
import { scanSbfFrames, svidToPrn } from './frame';

export type { BdsCnavEphemeris } from '../navbits/bds-cnav';

/** GPS − BDT (s), constant since the BDT epoch. */
const GPS_BDT_OFFSET = 14;
/** B-CNAV1 frame length (s). The block time stamps the frame's end. */
const B1C_FRAME_S = 18;
const TOW_DNU = 4294967295;

/** Per-signal assemblers, one instance shared by a whole scan. */
export interface BdsCnavAssemblers {
  b1c: BdsCnav1Assembler;
  b2a: BdsCnav2Assembler;
  b2b: BdsCnav3Assembler;
}

export function newBdsCnavAssemblers(): BdsCnavAssemblers {
  return {
    b1c: new BdsCnav1Assembler(),
    b2a: new BdsCnav2Assembler(),
    b2b: new BdsCnav3Assembler(),
  };
}

/** Copy `nBits` of NAVBits (u4 words at `wordsAt`) from bit `start`. */
function navBits(
  view: DataView,
  wordsAt: number,
  start: number,
  nBits: number
): Uint8Array {
  const out = new Uint8Array(Math.ceil(nBits / 8));
  for (let i = 0; i < nBits; i++) {
    const p = start + i;
    const w = view.getUint32(wordsAt + 4 * (p >>> 5), true);
    if ((w >>> (31 - (p & 31))) & 1) out[i >> 3]! |= 0x80 >> (i & 7);
  }
  return out;
}

/** Minimum block length per ID (header + NAVBits). */
const MIN_LEN: Record<number, number> = { 4218: 248, 4219: 92, 4242: 144 };

/**
 * Process one BDSRawB1C/B2a/B2b block at frame offset `b`. Returns a
 * fresh ephemeris, or `{ badCrc: true }` when the message (for B1C:
 * subframe 2) failed CRC-24Q. Shared by {@link parseSbfBdsCnav} and the
 * one-pass `decodeSbfNavigation`.
 */
export function feedBdsCnavBlock(
  view: DataView,
  b: number,
  id: number,
  len: number,
  asm: BdsCnavAssemblers
): { eph?: BdsCnavEphemeris; badCrc?: boolean } {
  if (len < (MIN_LEN[id] ?? Infinity)) return {};
  const prnStr = svidToPrn(view.getUint8(b + 14));
  if (!prnStr || prnStr[0] !== 'C') return {};
  const prn = Number(prnStr.slice(1));
  const words = b + 20;

  if (id === 4218) {
    const towMs = view.getUint32(b + 8, true);
    if (towMs === TOW_DNU) return {};
    const sf2 = navBits(view, words, 72, 600);
    const sf3 = navBits(view, words, 1272, 264);
    const sf2Ok = bdsCnav1Sf2CrcOk(sf2);
    const bdt = (towMs / 1000 - GPS_BDT_OFFSET + 604800) % 604800;
    const tTm = (Math.floor(bdt) - B1C_FRAME_S + 604800) % 604800;
    const eph = asm.b1c.push(
      prn,
      sf2Ok ? sf2 : null,
      bdsCnav1Sf3CrcOk(sf3) ? sf3 : null,
      tTm
    );
    if (!sf2Ok) return { badCrc: true };
    return eph ? { eph } : {};
  }
  if (id === 4219) {
    const msg = navBits(view, words, 0, 288);
    if (!bdsCnav2CrcOk(msg)) return { badCrc: true };
    const eph = asm.b2a.push(msg);
    return eph ? { eph } : {};
  }
  if (id === 4242) {
    const msg = navBits(view, words, 12, 486);
    if (!bdsCnav3CrcOk(msg)) return { badCrc: true };
    const eph = asm.b2b.push(prn, msg);
    return eph ? { eph } : {};
  }
  return {};
}

export interface SbfBdsCnavResult {
  /** Assembled B-CNAV1/2/3 ephemerides in stream order, repeats suppressed. */
  ephemerides: BdsCnavEphemeris[];
  /** Messages whose CRC-24Q check failed (dropped). */
  badCrc: number;
  /** Total BDSRawB1C/B2a/B2b blocks seen (with valid SBF framing). */
  messages: number;
}

/**
 * Decode every BDSRawB1C/B2a/B2b block in an SBF byte stream into
 * BeiDou-3 B-CNAV ephemerides (RINEX 4 CNV1/CNV2/CNV3).
 */
export function parseSbfBdsCnav(data: Uint8Array): SbfBdsCnavResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const asm = newBdsCnavAssemblers();
  const ephemerides: BdsCnavEphemeris[] = [];
  let badCrc = 0;
  let messages = 0;
  scanSbfFrames(data, view, (id, b, len) => {
    if (id !== 4218 && id !== 4219 && id !== 4242) return;
    messages++;
    const r = feedBdsCnavBlock(view, b, id, len, asm);
    if (r.eph) ephemerides.push(r.eph);
    else if (r.badCrc) badCrc++;
  });
  return { ephemerides, badCrc, messages };
}
