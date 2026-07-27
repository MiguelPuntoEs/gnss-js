/**
 * Septentrio SBF raw GPS / QZSS LNAV navigation-bit blocks: GPSRawCA
 * (4017) and QZSRawL1CA (4066) each carry one 300-bit L1 C/A (LNAV)
 * subframe. Subframes 1–3 are assembled per satellite into a Keplerian
 * ephemeris by the shared {@link GpsLnavAssembler} (also behind
 * `parseUbxNav`).
 *
 * Block layout (mosaic-X5 / AsteRx reference guide §4.2.2): after the
 * 8-byte SBF header, TOW u4 + WNc u2 (a full GPS week — no rollover to
 * resolve), SVID u1, CRCPassed u1, ViterbiCnt u1, Source u1, FreqNr u1,
 * RxChannel u1, then NAVBits as u4[10]. Each 32-bit word holds the 24
 * source data bits d_n (already polarity-corrected for D30*) in bits
 * 6–29 with the first received bit as the MSB — so extraction is the
 * same `(word >>> 6) & 0xffffff` u-blox delivers, and the two share
 * {@link GpsLnavAssembler}. Bits 0–5 are the parity bits (unused here:
 * the receiver has already parity-checked, flagged by CRCPassed).
 */

import { GpsLnavAssembler, setBitU } from '../navbits';
import type { KeplerEphemeris } from '../rinex/nav';
import { scanSbfFrames, svidToPrn } from './frame';

const WNC_DNU = 65535;

export interface SbfGpsNavResult {
  /** Assembled GPS/QZSS LNAV ephemerides in stream order, repeats suppressed. */
  ephemerides: KeplerEphemeris[];
  /** Completed 1/2/3 sets rejected by the IODC/IODE cross-check (dropped). */
  badParity: number;
  /** Total GPSRawCA/QZSRawL1CA blocks seen (with valid SBF framing). */
  messages: number;
}

/**
 * Extract the parity-stripped 30-byte LNAV subframe (ten 24-bit data
 * words, MSB-first) from a GPSRawCA/QZSRawL1CA block at frame offset `b`.
 */
export function extractSbfLnavSubframe(view: DataView, b: number): Uint8Array {
  const sf = new Uint8Array(30);
  for (let k = 0; k < 10; k++) {
    const w = view.getUint32(b + 20 + 4 * k, true);
    setBitU(sf, 24 * k, 24, (w >>> 6) & 0xffffff);
  }
  return sf;
}

/**
 * Process one GPSRawCA (4017) / QZSRawL1CA (4066) block at frame offset
 * `b`: skip subframes the receiver flagged bad (CRCPassed ≠ 1), extract
 * the LNAV subframe, and push it to the shared assembler with the
 * block's full WNc week. Returns a fresh ephemeris, `{ badParity: true }`
 * when a completed 1/2/3 set failed the IODC/IODE cross-check, or `{}`.
 * Shared by {@link parseSbfGpsNav} and the one-pass
 * {@link decodeSbfNavigation}.
 */
export function feedGpsLnavBlock(
  view: DataView,
  b: number,
  assembler: GpsLnavAssembler
): { eph?: KeplerEphemeris; badParity?: boolean } {
  const prn = svidToPrn(view.getUint8(b + 14));
  if (!prn || (prn[0] !== 'G' && prn[0] !== 'J')) return {};
  if (view.getUint8(b + 15) !== 1) return {}; // CRCPassed: skip bad subframes
  const wnc = view.getUint16(b + 12, true);
  if (wnc === WNC_DNU) return {};

  const r = assembler.push(prn, extractSbfLnavSubframe(view, b), wnc);
  if (r.kind === 'eph') return { eph: r.eph };
  if (r.kind === 'decodeFailed') return { badParity: true };
  return {};
}

/**
 * Decode every GPSRawCA (4017) / QZSRawL1CA (4066) block in an SBF byte
 * stream and assemble the carried LNAV subframes into ephemerides
 * (`system` 'G'/'J', same fields and conventions as `parseSbfNav`'s
 * GPSNav/QZSNav records). Only subframes the receiver marked
 * CRC/parity-valid (CRCPassed = 1) are used; the block's full WNc week
 * resolves the 10-bit broadcast week directly.
 */
export function parseSbfGpsNav(data: Uint8Array): SbfGpsNavResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ephemerides: KeplerEphemeris[] = [];
  const assembler = new GpsLnavAssembler();
  let badParity = 0;
  let messages = 0;

  scanSbfFrames(data, view, (id, b, len) => {
    if ((id !== 4017 && id !== 4066) || len < 60) return;
    messages++;
    const r = feedGpsLnavBlock(view, b, assembler);
    if (r.eph) ephemerides.push(r.eph);
    else if (r.badParity) badParity++;
  });

  return { ephemerides, badParity, messages };
}
