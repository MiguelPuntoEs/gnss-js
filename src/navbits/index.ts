/**
 * GNSS broadcast navigation-bit decoding.
 *
 * This module holds receiver-independent decoders for raw navigation
 * bits: several receiver formats (NovAtel RAWEPHEM, u-blox RXM-SFRBX,
 * Septentrio GPSRawCA, ...) deliver the same broadcast frames, so the
 * bit-extraction helpers and frame decoders live here rather than in
 * any single receiver module.
 *
 * `decodeGpsLnavFrame` is a port of RTKLIB's GPS LNAV ephemeris
 * decoder `decode_frame` (demo5 / rtklibexplorer fork: decode_frame_eph
 * in src/rcvraw.c, bit helpers in src/rtkcmn.c), Copyright (c)
 * 2007-2020 T. Takasu, BSD-2-Clause. Scale factors follow IS-GPS-200
 * (which fixes π = 3.1415926535898 for semicircle conversion).
 */

import type { KeplerEphemeris } from '../rinex/nav';

/** π as fixed by IS-GPS-200 for semicircle → radian conversion. */
export const GPS_PI = 3.1415926535898;

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const SEC_PER_WEEK = 7 * 86400;

/**
 * Extract `len` (≤ 32) bits as an unsigned integer, MSB first.
 * `pos` is the bit offset from the start of `buff`.
 */
export function getBitU(buff: Uint8Array, pos: number, len: number): number {
  let bits = 0;
  for (let i = pos; i < pos + len; i++) {
    bits = bits * 2 + ((buff[i >> 3]! >> (7 - (i & 7))) & 1);
  }
  return bits;
}

/** Extract `len` (≤ 32) bits as a two's-complement signed integer. */
export function getBitS(buff: Uint8Array, pos: number, len: number): number {
  const bits = getBitU(buff, pos, len);
  if (len <= 0 || bits < 2 ** (len - 1)) return bits;
  return bits - 2 ** len;
}

/** Write `len` (≤ 32) bits of an unsigned integer, MSB first. */
export function setBitU(
  buff: Uint8Array,
  pos: number,
  len: number,
  data: number
): void {
  let mask = 2 ** (len - 1);
  for (let i = pos; i < pos + len; i++, mask /= 2) {
    if (data >= mask) {
      buff[i >> 3]! |= 1 << (7 - (i & 7));
      data -= mask;
    } else {
      buff[i >> 3]! &= ~(1 << (7 - (i & 7)));
    }
  }
}

/** Write `len` (≤ 32) bits of a two's-complement signed integer. */
export function setBitS(
  buff: Uint8Array,
  pos: number,
  len: number,
  data: number
): void {
  setBitU(buff, pos, len, data < 0 ? data + 2 ** len : data);
}

export interface DecodeLnavOptions {
  /** RINEX PRN for the output record, e.g. "G11". Defaults to "G00". */
  prn?: string;
  /**
   * Full (non-rolled-over) GPS week used to resolve the 10-bit
   * broadcast week — e.g. the reference week a receiver stamps on the
   * message. Defaults to the week of the current system time.
   */
  refWeek?: number;
}

/**
 * Result of feeding one GPS/QZSS LNAV subframe to a {@link GpsLnavAssembler}:
 * `incomplete` (buffered, waiting for the 1/2/3 set), `eph` (a fresh
 * ephemeris completed), `duplicate` (a re-broadcast of the last issue of
 * data, suppressed), `decodeFailed` (subframe 3 completed a set but the
 * IODC/IODE cross-check rejected it — a mixed-issue frame), or `skipped`
 * (a subframe-ID outside 1–3, e.g. 4/5).
 */
export type LnavPush =
  | { kind: 'incomplete' | 'duplicate' | 'decodeFailed' | 'skipped' }
  | { kind: 'eph'; eph: KeplerEphemeris };

/**
 * Assembles GPS/QZSS LNAV subframes 1–3 into ephemerides, one buffer per
 * satellite, suppressing re-broadcasts of an unchanged issue of data —
 * the shared core behind both `parseUbxNav` (RXM-SFRBX) and the SBF
 * GPSRawCA decoder. Input subframes are parity-stripped: ten 24-bit data
 * words packed MSB-first into 30 bytes (the `(word >>> 6) & 0xffffff`
 * form both u-blox and Septentrio deliver). Decode fires on subframe 3
 * once 1 and 2 are buffered (RTKLIB decode_nav).
 */
export class GpsLnavAssembler {
  private readonly buffers = new Map<
    string,
    { buf: Uint8Array; have: number }
  >();
  private readonly last = new Map<string, KeplerEphemeris>();

  /** Subframe ID (1–5) from the HOW word of a parity-stripped subframe. */
  static subframeId(subframe: Uint8Array): number {
    return getBitU(subframe, 43, 3);
  }

  /**
   * Push one parity-stripped 30-byte LNAV subframe for `prn`, resolving
   * the 10-bit week against `refWeek`. See {@link LnavPush} for outcomes.
   */
  push(prn: string, subframe: Uint8Array, refWeek: number): LnavPush {
    const id = GpsLnavAssembler.subframeId(subframe);
    if (id < 1 || id > 3) return { kind: 'skipped' };

    let sf = this.buffers.get(prn);
    if (!sf) {
      sf = { buf: new Uint8Array(90), have: 0 };
      this.buffers.set(prn, sf);
    }
    sf.buf.set(subframe, (id - 1) * 30);
    sf.have |= 1 << (id - 1);

    if (id !== 3 || sf.have !== 0b111) return { kind: 'incomplete' };

    const eph = decodeGpsLnavFrame(sf.buf, { prn, refWeek });
    if (!eph) return { kind: 'decodeFailed' };

    const prev = this.last.get(prn);
    if (
      prev &&
      prev.iode === eph.iode &&
      prev.tocDate.getTime() === eph.tocDate.getTime()
    ) {
      return { kind: 'duplicate' };
    }
    this.last.set(prn, eph);
    return { kind: 'eph', eph };
  }
}

/**
 * Decode GPS LNAV subframes 1–3 into a Keplerian ephemeris.
 *
 * Input is the parity-stripped frame exactly as NovAtel RAWEPHEM (and
 * u-blox after parity removal) delivers it: three subframes of ten
 * 24-bit data words each, packed MSB-first into 30 bytes per subframe
 * (90 bytes total, subframe 1 first).
 *
 * Returns `null` when the subframe IDs are not 1/2/3 or the IODE/IODC
 * consistency check fails (mixed-issue frame). Field units and epoch
 * conventions mirror `parseNavFile` for RINEX LNAV records: radians,
 * seconds, GPS-scale `tocDate`, `svHealth` from the 6 SV-health bits,
 * and `tgd` in seconds (the reserved value −128 maps to 0).
 */
export function decodeGpsLnavFrame(
  subframes: Uint8Array,
  opts: DecodeLnavOptions = {}
): KeplerEphemeris | null {
  if (subframes.length < 90) return null;
  const b = subframes;

  /* subframe 1 (bit 0 = first bit of the TLM word data; word 1 = 24 bits) */
  let i = 24;
  const tow1 = getBitU(b, i, 17) * 6.0;
  i += 17 + 2;
  const id1 = getBitU(b, i, 3);
  i += 3 + 2;
  const week10 = getBitU(b, i, 10);
  i += 10;
  i += 2; // codes on L2
  i += 4; // URA index
  const svHealth = getBitU(b, i, 6);
  i += 6;
  const iodc0 = getBitU(b, i, 2);
  i += 2;
  i += 1 + 87; // L2 P data flag + reserved
  const tgdRaw = getBitS(b, i, 8);
  i += 8;
  const iodc1 = getBitU(b, i, 8);
  i += 8;
  const tocSec = getBitU(b, i, 16) * 16.0;
  i += 16;
  const af2 = getBitS(b, i, 8) * 2 ** -55;
  i += 8;
  const af1 = getBitS(b, i, 16) * 2 ** -43;
  i += 16;
  const af0 = getBitS(b, i, 22) * 2 ** -31;

  /* subframe 2 */
  i = 240 + 24;
  i += 17 + 2; // TOW
  const id2 = getBitU(b, i, 3);
  i += 3 + 2;
  const iode = getBitU(b, i, 8);
  i += 8;
  const crs = getBitS(b, i, 16) * 2 ** -5;
  i += 16;
  const deltaN = getBitS(b, i, 16) * 2 ** -43 * GPS_PI;
  i += 16;
  const m0 = getBitS(b, i, 32) * 2 ** -31 * GPS_PI;
  i += 32;
  const cuc = getBitS(b, i, 16) * 2 ** -29;
  i += 16;
  const e = getBitU(b, i, 32) * 2 ** -33;
  i += 32;
  const cus = getBitS(b, i, 16) * 2 ** -29;
  i += 16;
  const sqrtA = getBitU(b, i, 32) * 2 ** -19;
  i += 32;
  const toes = getBitU(b, i, 16) * 16.0;

  /* subframe 3 */
  i = 480 + 24;
  i += 17 + 2; // TOW
  const id3 = getBitU(b, i, 3);
  i += 3 + 2;
  const cic = getBitS(b, i, 16) * 2 ** -29;
  i += 16;
  const omega0 = getBitS(b, i, 32) * 2 ** -31 * GPS_PI;
  i += 32;
  const cis = getBitS(b, i, 16) * 2 ** -29;
  i += 16;
  const i0 = getBitS(b, i, 32) * 2 ** -31 * GPS_PI;
  i += 32;
  const crc = getBitS(b, i, 16) * 2 ** -5;
  i += 16;
  const omega = getBitS(b, i, 32) * 2 ** -31 * GPS_PI;
  i += 32;
  const omegaDot = getBitS(b, i, 24) * 2 ** -43 * GPS_PI;
  i += 24;
  const iode3 = getBitU(b, i, 8);
  i += 8;
  const idot = getBitS(b, i, 14) * 2 ** -43 * GPS_PI;

  const iodc = iodc0 * 256 + iodc1;

  /* subframe-ID and issue-of-data consistency (RTKLIB decode_frame) */
  if (id1 !== 1 || id2 !== 2 || id3 !== 3) return null;
  if (iode3 !== iode || iode !== (iodc & 0xff)) return null;

  /* resolve the 10-bit week against the reference week */
  const ref =
    opts.refWeek ??
    Math.floor((Date.now() - GPS_EPOCH_MS) / 1000 / SEC_PER_WEEK);
  let week = week10 + 1024 * Math.round((ref - week10) / 1024);
  if (toes < tow1 - 302400.0) week++;
  else if (toes > tow1 + 302400.0) week--;

  const prn = opts.prn ?? 'G00';
  const tocDate = new Date(
    GPS_EPOCH_MS + (week * SEC_PER_WEEK + tocSec) * 1000
  );

  return {
    system: prn[0] === 'J' ? 'J' : 'G',
    prn,
    tocDate,
    // Same seconds-of-week convention as parseNavFile (rinex/nav.ts).
    toc: (tocDate.getTime() / 1000) % SEC_PER_WEEK,
    af0,
    af1,
    af2,
    iode,
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
    svHealth,
    tgd: tgdRaw === -128 ? 0.0 : tgdRaw * 2 ** -31, // IS-GPS-200: -128 reserved
  };
}
