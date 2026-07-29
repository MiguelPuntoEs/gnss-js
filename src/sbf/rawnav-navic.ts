/**
 * Septentrio SBF NAVICRaw (4093) blocks: each carries one 292-bit NavIC L5/S
 * SPS subframe. Subframes 1 & 2 are assembled per satellite into a Keplerian
 * ephemeris by the shared {@link NavicAssembler}.
 *
 * Block layout (mosaic-X5 reference guide §4): after the 8-byte SBF header,
 * TOW u4 + WNc u2 (full GPS week), SVID u1, CRCPassed u1, ViterbiCnt u1,
 * Source u1, FreqNr u1, RxChannel u1, then NAVBits as u4[10] — the first
 * received bit is the MSB of NAVBits[0] (each u4 little-endian in the stream,
 * message bits MSB-first within the word). Only the first 292 bits are used.
 *
 * The receiver's own CRCPassed flag is ignored in favour of re-running CRC-24Q
 * on the transported bits, so `badCrc` counts exactly what this library rejects.
 */

import { NavicAssembler, navicSubframeCrcOk } from '../navbits/navic';
import type { KeplerEphemeris } from '../rinex/nav';
import { scanSbfFrames, svidToPrn } from './frame';

const WNC_DNU = 65535;

export interface SbfNavicResult {
  /** Assembled NavIC ephemerides in stream order, repeats suppressed. */
  ephemerides: KeplerEphemeris[];
  /** Subframes whose CRC-24Q check failed (dropped). */
  badCrc: number;
  /** Total NAVICRaw blocks seen (with valid SBF framing). */
  messages: number;
}

/** Extract the 292-bit NavIC subframe (MSB-first) from a NAVICRaw block. */
export function extractSbfNavicSubframe(view: DataView, b: number): Uint8Array {
  const sf = new Uint8Array(40);
  for (let k = 0; k < 10; k++) {
    const w = view.getUint32(b + 20 + 4 * k, true);
    sf[4 * k] = w >>> 24;
    sf[4 * k + 1] = (w >>> 16) & 0xff;
    sf[4 * k + 2] = (w >>> 8) & 0xff;
    sf[4 * k + 3] = w & 0xff;
  }
  return sf;
}

/**
 * Process one NAVICRaw (4093) block at frame offset `b`: map SVID → NavIC PRN,
 * extract + CRC-24Q gate the subframe, and push it to the shared assembler
 * with the block's full WNc week. Returns a fresh ephemeris, `{ badCrc: true }`
 * on a failed CRC, or `{}`. Shared by {@link parseSbfNavic} and the one-pass
 * {@link decodeSbfNavigation}.
 */
export function feedNavicBlock(
  view: DataView,
  b: number,
  assembler: NavicAssembler
): { eph?: KeplerEphemeris; badCrc?: boolean } {
  const prn = svidToPrn(view.getUint8(b + 14));
  if (!prn || prn[0] !== 'I') return {};
  const wnc = view.getUint16(b + 12, true);
  if (wnc === WNC_DNU) return {};

  const sf = extractSbfNavicSubframe(view, b);
  if (!navicSubframeCrcOk(sf)) return { badCrc: true };

  const eph = assembler.push(prn, sf, wnc);
  return eph ? { eph } : {};
}

/**
 * Decode every NAVICRaw (4093) block in an SBF byte stream and assemble the
 * carried subframes into NavIC ephemerides (`system` 'I').
 */
export function parseSbfNavic(data: Uint8Array): SbfNavicResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ephemerides: KeplerEphemeris[] = [];
  const assembler = new NavicAssembler();
  let badCrc = 0;
  let messages = 0;

  scanSbfFrames(data, view, (id, b, len) => {
    if (id !== 4093 || len < 60) return;
    messages++;
    const r = feedNavicBlock(view, b, assembler);
    if (r.eph) ephemerides.push(r.eph);
    else if (r.badCrc) badCrc++;
  });

  return { ephemerides, badCrc, messages };
}
