/**
 * Septentrio SBF GALRawCNAV (4024) blocks: one 492-bit Galileo E6-B
 * C/NAV page per block (after deinterleaving and Viterbi decoding),
 * feeding the receiver-independent HAS decoder in ../navbits/has.
 *
 * Block layout (mosaic-X5 reference guide §4.2): after the 8-byte SBF
 * header, TOW u4 (ms) + WNc u2, SVID u1, CRCPassed u1, ViterbiCnt u1,
 * Source u1, FreqNr u1, RxChannel u1, then NAVBits as u4[16] — the
 * first received bit is the MSB of NAVBits[0] (each u4 little-endian
 * in the stream, page bits MSB-first within the word), the unused 20
 * bits of NAVBits[15] to be ignored.
 *
 * RTKLIB demo5 (rtklibexplorer) has no C/NAV decoder — GALRawCNAV is
 * not handled by src/rcv/septentrio.c at all — so the block layout
 * comes from the reference guide directly, and the page handling was
 * cross-checked against FGI's HASlib reference decoder
 * (github.com/nlsfi/HASlib, EUPL-1.2, galileo_has_decoder/sbf_reading.py).
 *
 * The receiver's own CRCPassed flag is ignored in favor of re-running
 * CRC-24Q on the transported page, so `pagesBadCrc` counts exactly the
 * pages this library rejected.
 */

import { HasAssembler, type HasMessage, hasPageCrcOk } from '../navbits/has';
import { scanSbfFrames } from './frame';

export type { HasMessage } from '../navbits/has';

/** A HAS message tagged with the SBF time stamp that completed it. */
export interface SbfHasMessage extends HasMessage {
  /** Receiver time of week (s) of the completing GALRawCNAV block. */
  tow: number;
  /** Receiver week number (GPS weeks, no rollover) of that block. */
  wnc: number;
}

export interface SbfHasResult {
  /** Completed HAS messages in stream order. */
  messages: SbfHasMessage[];
  /** GALRawCNAV blocks seen (with valid SBF framing and length). */
  pagesSeen: number;
  /** Pages dropped for a failed CRC-24Q re-check. */
  pagesBadCrc: number;
  /** Dummy pages (idle filler, no HAS content). */
  pagesDummy: number;
  /** Non-dummy HAS pages fed to the assembler. */
  pagesHas: number;
}

/**
 * Decode every GALRawCNAV block in an SBF byte stream and assemble the
 * carried HAS pages — network-wide, across all satellites — into HAS
 * messages. Pages must be fed as captured (chronological order) for
 * the message-generation bookkeeping to work.
 */
export function parseSbfHas(data: Uint8Array): SbfHasResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const assembler = new HasAssembler();
  const messages: SbfHasMessage[] = [];
  let pagesSeen = 0;
  let pagesBadCrc = 0;

  scanSbfFrames(data, view, (id, b, len) => {
    if (id !== 4024 || len < 84) return;
    pagesSeen++;

    // NAVBits u4[16] at +20: first received bit = MSB of NAVBits[0].
    const page = new Uint8Array(64);
    for (let k = 0; k < 16; k++) {
      const w = view.getUint32(b + 20 + 4 * k, true);
      page[4 * k] = w >>> 24;
      page[4 * k + 1] = (w >>> 16) & 0xff;
      page[4 * k + 2] = (w >>> 8) & 0xff;
      page[4 * k + 3] = w & 0xff;
    }

    if (!hasPageCrcOk(page)) {
      pagesBadCrc++;
      return;
    }
    const tow = view.getUint32(b + 8, true) / 1000;
    const msg = assembler.push(page, tow);
    if (msg) messages.push({ ...msg, tow, wnc: view.getUint16(b + 12, true) });
  });

  return {
    messages,
    pagesSeen,
    pagesBadCrc,
    pagesDummy: assembler.stats.dummyPages,
    pagesHas: assembler.stats.pages,
  };
}
