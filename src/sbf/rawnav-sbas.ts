/**
 * Septentrio SBF GEORawL1 (4020): one 250-bit SBAS L1 C/A message per
 * block. Message type 9 carries the GEO satellite's navigation (state
 * vector), decoded by the shared `decodeSbasGeoNav` (src/navbits/sbas.ts),
 * the same decoder the u-blox RXM-SFRBX path uses.
 *
 * Block layout (mosaic-X5 reference guide §4): after the 8-byte SBF
 * header, TOW u4 + WNc u2, SVID u1, CRCPassed u1, ViterbiCnt u1,
 * Source u1, FreqNr u1, RxChannel u1, then NAVBits as u4[8] — the first
 * received bit is the MSB of NAVBits[0] (each u4 little-endian in the
 * stream, message bits MSB-first within the word). The 250-bit message
 * occupies the first 250 of the 256 bits; the trailing 6 are padding.
 *
 * As with the other SBF raw paths, the receiver's own CRCPassed flag is
 * ignored in favour of re-running CRC-24Q on the transported bits, so a
 * failed check is reported as `badCrc`.
 *
 * GEORawL5 (4021) is deliberately not routed here: it carries the DFMC
 * L5 SBAS message set (MT 32/34/35/…), a different format from the L1
 * message type 9 this decoder understands.
 */
import { decodeSbasGeoNav, sbasCrcOk } from '../navbits/sbas';
import type { GlonassEphemeris } from '../rinex/nav';
import { scanSbfFrames, svidToPrn } from './frame';

/**
 * Process one GEORawL1 block at frame offset `b`: extract the 250-bit
 * SBAS L1 message, CRC-24Q gate it, and decode a GEO ephemeris if it is
 * message type 9. Returns the ephemeris, `{ badCrc: true }` on a failed
 * CRC, or `{}` for any other (non–type-9) message.
 */
export function feedGeoBlock(
  view: DataView,
  b: number,
  onSbasMessage?: (
    msg: Uint8Array,
    prn: number,
    week: number,
    tow: number
  ) => void
): { eph?: GlonassEphemeris; badCrc?: boolean } {
  const tow = view.getUint32(b + 8, true); // ms of GPS week
  const wnc = view.getUint16(b + 12, true); // full GPS week
  const svid = view.getUint8(b + 14);
  const prnStr = svidToPrn(svid); // e.g. "S23" (SBAS PRN-100)
  if (!prnStr || prnStr[0] !== 'S') return {};

  // NAVBits u4[8] at +20: first received bit = MSB of NAVBits[0].
  const msg = new Uint8Array(32);
  for (let k = 0; k < 8; k++) {
    const w = view.getUint32(b + 20 + 4 * k, true);
    msg[4 * k] = w >>> 24;
    msg[4 * k + 1] = (w >>> 16) & 0xff;
    msg[4 * k + 2] = (w >>> 8) & 0xff;
    msg[4 * k + 3] = w & 0xff;
  }

  if (!sbasCrcOk(msg)) return { badCrc: true };
  const prn = Number(prnStr.slice(1)) + 100; // "S23" → 123 (SBAS PRN)
  onSbasMessage?.(msg, prn, wnc, tow / 1000);
  const eph = decodeSbasGeoNav(msg, prn, wnc, tow / 1000);
  return eph ? { eph } : {};
}

export interface SbfGeoNavResult {
  /** SBAS GEO ephemerides in stream order, unchanged repeats suppressed. */
  ephemerides: GlonassEphemeris[];
  /** GEORawL1 messages whose CRC-24Q check failed (dropped). */
  badCrc: number;
  /** Total GEORawL1 blocks seen (with valid SBF framing). */
  messages: number;
}

/**
 * Decode every GEORawL1 block in an SBF byte stream into SBAS GEO
 * ephemerides (message type 9), de-duping unchanged rebroadcasts by
 * (PRN, time-of-clock). The one-pass {@link decodeSbfNavigation} routes
 * the same blocks through {@link feedGeoBlock}; this standalone parser
 * mirrors the per-constellation `parseSbf*` helpers.
 */
export function parseSbfGeoNav(
  data: Uint8Array,
  opts: {
    onSbasMessage?: (
      msg: Uint8Array,
      prn: number,
      week: number,
      tow: number
    ) => void;
  } = {}
): SbfGeoNavResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ephemerides: GlonassEphemeris[] = [];
  const seen = new Set<string>();
  let badCrc = 0;
  let messages = 0;

  scanSbfFrames(data, view, (id, b, len) => {
    if (id !== 4020 || len < 52) return;
    messages++;
    const r = feedGeoBlock(view, b, opts.onSbasMessage);
    if (r.eph) {
      const key = `${r.eph.prn}|${r.eph.tocDate.getTime()}`;
      if (!seen.has(key)) {
        seen.add(key);
        ephemerides.push(r.eph);
      }
    } else if (r.badCrc) {
      badCrc++;
    }
  });

  return { ephemerides, badCrc, messages };
}
