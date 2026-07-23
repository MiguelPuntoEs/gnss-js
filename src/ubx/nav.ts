/**
 * u-blox UBX navigation-message decoding: GPS/QZSS LNAV broadcast
 * ephemerides from RXM-SFRBX (class 0x02, id 0x13).
 *
 * Ported from RTKLIB demo5 (rtklibexplorer fork, src/rcv/ublox.c:
 * decode_rxmsfrbx / decode_nav / decode_eph, Copyright (c) 2007-2020
 * T. Takasu, BSD-2-Clause); the subframe fields themselves are decoded
 * by `decodeGpsLnavFrame` (the decode_frame port in src/navbits).
 *
 * On D30* polarity: the receiver has already checked parity and
 * resolved the polarity inversion of the data bits before writing the
 * 30-bit words into the 30 LSBs of each `dwrd`, so — exactly like
 * RTKLIB's decode_nav (`U4(p)>>6`, "24 x 10 bits w/o parity") — the
 * conversion to parity-stripped 24-bit words is a plain 6-bit shift
 * with NO D30* re-inversion. (Verified against the TLM preamble 0x8B
 * at bits 29..22 of word 1 in every GPS/QZSS LNAV message of the
 * reference F9P capture.)
 *
 * Other constellations in RXM-SFRBX (Galileo I/NAV, BDS D1/D2, GLONASS
 * strings, SBAS) and GPS/QZSS CNAV are out of scope and skipped
 * silently. LNAV subframes 4/5 are skipped here except that
 * `parseUbxIonoUtc` (./iono.ts) decodes the subframe-4 page-18
 * iono/UTC parameters through the shared `readLnavSubframe` helper.
 */

import { decodeGpsLnavFrame, getBitU, setBitU } from '../navbits';
import type { Ephemeris, KeplerEphemeris } from '../rinex/nav';
import { ubxFrames, type UbxFrame } from './frame';

/** CNAV message preamble (IS-GPS-200 §30.3.3) — flags L2C messages. */
const PREAMB_CNAV = 0x8b;

export interface UbxNavOptions {
  /**
   * Full GPS week used to resolve the 10-bit broadcast week. When
   * omitted, the week is harvested from the first RXM-RAWX message in
   * the same stream (u-blox raw logs carry both); a stream with
   * neither yields no ephemerides — the system clock is never used.
   */
  refWeek?: number;
}

export interface UbxNavResult {
  /** Broadcast ephemerides in stream order, duplicates suppressed. */
  ephemerides: Ephemeris[];
  /**
   * Subframes rejected for inconsistency: an out-of-range subframe ID
   * in the HOW word, or a complete subframe-1/2/3 set whose
   * IODC/IODE cross-check failed (mixed issues of data).
   */
  badParity: number;
}

/** Per-satellite LNAV subframe accumulator (subframes 1–3, 30 B each). */
interface SubframeBuffer {
  buf: Uint8Array;
  /** Bitmask of buffered subframes: bit (id − 1) set once id was seen. */
  have: number;
}

/** One parity-stripped GPS/QZSS LNAV subframe from an RXM-SFRBX frame. */
export interface LnavSubframe {
  /** RINEX PRN, e.g. "G07" or "J02". */
  prn: string;
  gnssId: number;
  svId: number;
  /** Ten 24-bit data words (parity dropped), packed MSB-first. */
  buff: Uint8Array;
  /** Subframe ID from the HOW word — NOT validated (0–7 possible). */
  id: number;
}

/**
 * Extract the GPS/QZSS LNAV subframe carried by one RXM-SFRBX frame,
 * or null when the frame is not a decodable LNAV broadcast (other
 * constellations, QZSS L1S, CNAV, short payloads). Shared by
 * `parseUbxNav` (ephemerides) and `parseUbxIonoUtc` (subframe 4).
 */
export function readLnavSubframe(
  view: DataView,
  f: UbxFrame
): LnavSubframe | null {
  const p = f.payload;
  if (p.length < 8) return null;
  const gnssId = p[0]!;
  const svId = p[1]!;

  let prn: string;
  if (gnssId === 0 && svId >= 1 && svId <= 32) {
    prn = `G${String(svId).padStart(2, '0')}`;
  } else if (gnssId === 5 && svId >= 1 && svId <= 10) {
    // QZSS L1S is delivered as a 44-byte SFRBX payload (RTKLIB:
    // raw->len==52) and carries an SBAS-format message — skip.
    if (p.length === 44) return null;
    prn = `J${String(svId).padStart(2, '0')}`;
  } else {
    return null; // other constellations: out of scope, skip silently
  }

  // GPS/QZSS LNAV needs the full 10 words (RTKLIB len check).
  if (p.length < 8 + 40) return null;
  const base = f.payloadStart + 8;

  // CNAV (L2C/L5) shares the message class; its 32-bit packing puts
  // the 0x8B preamble in the top byte of the first word.
  if (view.getUint32(base, true) >>> 24 === PREAMB_CNAV) return null;

  // 30-bit LNAV words in the 30 LSBs of each dwrd, polarity already
  // resolved by the receiver: drop the 6 parity bits, keep 24 data
  // bits per word (RTKLIB decode_nav — no D30* re-inversion needed).
  const buff = new Uint8Array(30);
  for (let k = 0; k < 10; k++) {
    const dwrd = view.getUint32(base + 4 * k, true);
    setBitU(buff, 24 * k, 24, (dwrd >>> 6) & 0xffffff);
  }

  return { prn, gnssId, svId, buff, id: getBitU(buff, 43, 3) };
}

/**
 * Decode every GPS/QZSS LNAV ephemeris broadcast in a UBX byte stream
 * (RXM-SFRBX). Subframes 1–3 are assembled per satellite; a frame is
 * decoded when subframe 3 arrives with 1 and 2 buffered (RTKLIB
 * decode_nav), and repeated broadcasts of an unchanged ephemeris are
 * suppressed by issue of data and clock epoch like `parseNovatelNav`.
 */
export function parseUbxNav(
  data: Uint8Array,
  opts: UbxNavOptions = {}
): UbxNavResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ephemerides: Ephemeris[] = [];
  let badParity = 0;

  // Pre-pass: reference week from the first RXM-RAWX in the stream.
  let refWeek = opts.refWeek;
  if (refWeek === undefined) {
    for (const f of ubxFrames(data)) {
      if (f.msgClass === 0x02 && f.msgId === 0x15 && f.payload.length >= 16) {
        const week = view.getUint16(f.payloadStart + 8, true);
        if (week > 0) {
          refWeek = week;
          break;
        }
      }
    }
  }
  // No week reference at all: the 10-bit LNAV week cannot be resolved
  // without guessing (and the system clock is out of bounds here).
  if (refWeek === undefined) return { ephemerides, badParity };

  const subframes = new Map<number, SubframeBuffer>();
  const last = new Map<string, KeplerEphemeris>();

  for (const f of ubxFrames(data)) {
    if (f.msgClass !== 0x02 || f.msgId !== 0x13) continue;
    const lnav = readLnavSubframe(view, f);
    if (!lnav) continue;
    const { prn, gnssId, svId, buff, id } = lnav;

    if (id < 1 || id > 5) {
      badParity++;
      continue;
    }
    if (id > 3) continue; // subframes 4/5: handled by parseUbxIonoUtc

    const key = gnssId * 256 + svId;
    let sf = subframes.get(key);
    if (!sf) {
      sf = { buf: new Uint8Array(90), have: 0 };
      subframes.set(key, sf);
    }
    sf.buf.set(buff, (id - 1) * 30);
    sf.have |= 1 << (id - 1);

    // Decode on subframe 3 (RTKLIB decode_nav), once 1 and 2 are in.
    if (id !== 3 || sf.have !== 0b111) continue;
    const eph = decodeGpsLnavFrame(sf.buf, { prn, refWeek });
    if (!eph) {
      badParity++; // IODC/IODE mismatch across the buffered subframes
      continue;
    }
    const prev = last.get(prn);
    if (
      prev &&
      prev.iode === eph.iode &&
      prev.tocDate.getTime() === eph.tocDate.getTime()
    ) {
      continue; // unchanged issue of data
    }
    last.set(prn, eph);
    ephemerides.push(eph);
  }

  return { ephemerides, badParity };
}
