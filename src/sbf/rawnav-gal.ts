/**
 * Septentrio SBF raw Galileo navigation-page blocks: GALRawINAV (4023)
 * carries one I/NAV nominal page pair (234 bits: the 114-bit even part
 * — tail removed — concatenated with the 120-bit odd part) and
 * GALRawFNAV (4022) one 244-bit F/NAV page (sync stripped).
 *
 * Block layout (mosaic-X5 reference guide §4): after the 8-byte SBF
 * header, TOW u4 + WNc u2, SVID u1, CRCPassed u1, ViterbiCnt u1,
 * Source u1 (bits 0-4: signal type per §4.1.10; INAV bit 5: even/odd
 * parts from different carriers), FreqNr u1, RxChannel u1, then
 * NAVBits as u4[8] — the first received bit is the MSB of NAVBits[0]
 * (each u4 little-endian in the stream, page bits MSB-first within
 * the word), the unused bits of NAVBits[7] to be ignored. Mirrors
 * RTKLIB demo5's decode_galrawinav / decode_galrawfnav
 * (src/rcv/septentrio.c), with the word/page assembly and field
 * decoding in `src/navbits/gal.ts`.
 *
 * The receiver's own CRCPassed flag is ignored in favor of re-running
 * CRC-24Q on the transported bits, so `badCrc` counts exactly the
 * pages this library rejected.
 */

import {
  GalFnavAssembler,
  GalInavAssembler,
  galFnavPageCrcOk,
  galInavPageCrcOk,
} from '../navbits/gal';
import type { KeplerEphemeris } from '../rinex/nav';
import { scanSbfFrames, svidToPrn } from './frame';

/**
 * A Galileo ephemeris tagged with the message type it was decoded
 * from — the same I/NAV / F/NAV data-source distinction RTKLIB keeps
 * in per-set ephemeris slots (and `parseNovatelNav` in its
 * "E##:inav"/"E##:fnav" dedup keys): the two sets share the orbit but
 * carry different clock sets (E1B/E5b vs E1B/E5a).
 */
export interface SbfGalEphemeris extends KeplerEphemeris {
  source: 'inav' | 'fnav';
}

export interface SbfGalNavResult {
  /** Assembled ephemerides in stream order, repeats suppressed. */
  ephemerides: SbfGalEphemeris[];
  /** Raw pages whose CRC-24Q check failed (dropped). */
  badCrc: number;
  /** Total GALRawINAV/GALRawFNAV blocks seen (with valid SBF framing). */
  messages: number;
}

/** SBF signal-type numbers (mosaic-X5 refguide §4.1.10). */
const INAV_SOURCES = [17, 21, 22]; // E1BC, E5b, E5 AltBOC
const FNAV_SOURCES = [20, 22]; // E5a, E5 AltBOC

/** I/NAV + F/NAV assemblers, one pair shared by a whole scan. */
export interface GalAssemblers {
  inav: GalInavAssembler;
  fnav: GalFnavAssembler;
}

export function newGalAssemblers(): GalAssemblers {
  return { inav: new GalInavAssembler(), fnav: new GalFnavAssembler() };
}

/**
 * Process one GALRawINAV (4023) / GALRawFNAV (4022) block at frame
 * offset `b`: extract the page, apply the per-message-type source and
 * CRC-24Q gates, and push it to the matching assembler. Returns a fresh
 * ephemeris, or `{ badCrc: true }` when the CRC failed. Shared by
 * {@link parseSbfGalNav} and the one-pass {@link decodeSbfNavigation}.
 */
export function feedGalBlock(
  data: Uint8Array,
  view: DataView,
  b: number,
  id: number,
  asm: GalAssemblers
): { eph?: SbfGalEphemeris; badCrc?: boolean } {
  const prnStr = svidToPrn(data[b + 14]!);
  if (!prnStr || prnStr[0] !== 'E') return {};
  const prn = parseInt(prnStr.slice(1), 10);
  const source = data[b + 17]! & 0x1f;

  // NAVBits u4[8] at +20: first received bit = MSB of NAVBits[0].
  const page = new Uint8Array(32);
  for (let k = 0; k < 8; k++) {
    const w = view.getUint32(b + 20 + 4 * k, true);
    page[4 * k] = w >>> 24;
    page[4 * k + 1] = (w >>> 16) & 0xff;
    page[4 * k + 2] = (w >>> 8) & 0xff;
    page[4 * k + 3] = w & 0xff;
  }

  let eph: KeplerEphemeris | null;
  let src: 'inav' | 'fnav';
  if (id === 4023) {
    src = 'inav';
    if (!INAV_SOURCES.includes(source)) return {};
    // Nominal even+odd pair expected before the CRC span applies.
    if (getBitU2(page, 0) !== 0 || getBitU2(page, 114) !== 1) return {};
    if (!galInavPageCrcOk(page)) return { badCrc: true };
    eph = asm.inav.push(prn, page);
  } else {
    src = 'fnav';
    if (!FNAV_SOURCES.includes(source)) return {};
    if (isFnavDummy(page)) return {}; // dummy page: different CRC span
    if (!galFnavPageCrcOk(page)) return { badCrc: true };
    eph = asm.fnav.push(prn, page);
  }
  return eph ? { eph: { ...eph, source: src } } : {};
}

/**
 * Decode every GALRawINAV/GALRawFNAV block in an SBF byte stream and
 * assemble the carried pages into ephemerides — I/NAV and F/NAV
 * independently (one assembler each), so a data set complete on both
 * message types yields one record per type; each record's `source`
 * property names its message type.
 */
export function parseSbfGalNav(data: Uint8Array): SbfGalNavResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ephemerides: SbfGalEphemeris[] = [];
  const asm = newGalAssemblers();
  let badCrc = 0;
  let messages = 0;

  scanSbfFrames(data, view, (id, b, len) => {
    if ((id !== 4022 && id !== 4023) || len < 52) return;
    messages++;
    const r = feedGalBlock(data, view, b, id, asm);
    if (r.eph) ephemerides.push(r.eph);
    else if (r.badCrc) badCrc++;
  });

  return { ephemerides, badCrc, messages };
}

/** Single-bit read (avoids importing the full bit helpers here). */
function getBitU2(buff: Uint8Array, pos: number): number {
  return (buff[pos >> 3]! >> (7 - (pos & 7))) & 1;
}

/** F/NAV page type 63 = dummy page (OS SIS ICD §4.2.4.6). */
function isFnavDummy(page: Uint8Array): boolean {
  return page[0]! >> 2 === 63;
}
