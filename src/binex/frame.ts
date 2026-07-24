/**
 * BINEX (BINary EXchange) framing, shared by the observation and
 * navigation decoders.
 *
 * A forward-readable record is: a 1-byte sync that encodes byte order and
 * checksum model, a record ID (ubnxi), a message length (ubnxi), the
 * message body, then a trailing checksum whose width depends on the
 * covered-byte count. Sync bytes (ref [1] §"Format Details"):
 *
 *   0xC2  little-endian, regular  CRC (forward)
 *   0xE2  big-endian,    regular  CRC (forward)
 *   0xC8  little-endian, enhanced CRC (forward)
 *   0xE8  big-endian,    enhanced CRC (forward)
 *
 * The reverse-readable variants (0xD2/0xF2/0xD8/0xF8 leading and
 * 0xB4/0xB0/0xE4/0xE0 terminating) are NOT decoded here (deferred).
 *
 * Checksum widths over the covered bytes N = recordID + lengthField +
 * body (regular model): N ≤ 127 → 1-byte XOR; 128–4095 → CRC16
 * (x^16+x^12+x^5+1, i.e. poly 0x1021 MSB-first, init 0); 4096–1048575 →
 * CRC32 (poly 0x04C11DB7 MSB-first); ≥ 1048576 → 16-byte MD5. Enhanced
 * model shifts every threshold up one step (CRC16 from 0 bytes, no XOR).
 * The 16-byte MD5 case is not implemented (records that large do not
 * occur in GNSS obs/eph streams); such a record is treated as bad.
 *
 * ubnxi (1–4 byte unsigned) and the field layouts are ported from RTKLIB
 * demo5/2.4.3 src/rcv/binex.c (getbnxi, decode_bnx, Copyright (c)
 * 2013-2018 T. Takasu, BSD-2-Clause) and cross-checked against the
 * EarthScope/UNAVCO BINEX definition [1].
 *
 * [1] UNAVCO/EarthScope, BINEX: Binary exchange format
 *     (http://binex.unavco.org/binex.html).
 */

/* ── CRC16-CCITT (poly 0x1021, init 0, MSB-first) ──────────────── */
const CRC16_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n << 8;
    for (let k = 0; k < 8; k++)
      c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    t[n] = c;
  }
  return t;
})();

/** BINEX 2-byte CRC (x^16+x^12+x^5+1), init 0, MSB-first. */
export function binexCrc16(
  data: Uint8Array,
  start: number,
  end: number
): number {
  let crc = 0;
  for (let i = start; i < end; i++)
    crc = ((crc << 8) ^ CRC16_TABLE[((crc >> 8) ^ data[i]!) & 0xff]!) & 0xffff;
  return crc;
}

/* ── CRC32 (poly 0x04C11DB7, init 0, MSB-first) ────────────────── */
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n << 24;
    for (let k = 0; k < 8; k++)
      c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * BINEX 4-byte CRC (poly 0x04C11DB7), init 0, MSB-first. Not exercised
 * by any known fixture (obs/eph records use XOR-8 or CRC16); implemented
 * to spec but fixture-unverified.
 */
export function binexCrc32(
  data: Uint8Array,
  start: number,
  end: number
): number {
  let crc = 0;
  for (let i = start; i < end; i++)
    crc = ((crc << 8) ^ CRC32_TABLE[((crc >>> 24) ^ data[i]!) & 0xff]!) >>> 0;
  return crc >>> 0;
}

/** 8-bit XOR checksum of `data[start, end)`. */
export function binexCsum8(
  data: Uint8Array,
  start: number,
  end: number
): number {
  let cs = 0;
  for (let i = start; i < end; i++) cs ^= data[i]!;
  return cs & 0xff;
}

/**
 * Decode a BINEX ubnxi (1–4 byte unsigned integer, MSB-first) at
 * `data[pos]`. The first up-to-three bytes contribute their low 7 bits
 * with the high bit as a continuation flag; a fourth byte (reached only
 * when the first three all continue) contributes all 8 bits. Returns the
 * value and the number of bytes consumed (1–4). Ported from RTKLIB
 * getbnxi.
 */
export function getBnxi(
  data: Uint8Array,
  pos: number
): { value: number; size: number } {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const b = data[pos + i] ?? 0;
    value = value * 128 + (b & 0x7f);
    if (!(b & 0x80)) return { value, size: i + 1 };
  }
  value = value * 256 + (data[pos + 3] ?? 0);
  return { value, size: 4 };
}

/** One checksum-valid forward BINEX record located in a byte stream. */
export interface BinexRecord {
  /** Record ID (e.g. 0x01, 0x7f). */
  id: number;
  /** Offset of the sync byte. */
  start: number;
  /** Offset of the message body (first byte after the length field). */
  body: number;
  /** Message body length in bytes. */
  len: number;
  /** True when the sync selects little-endian field byte order. */
  littleEndian: boolean;
  /** True when the sync selects the enhanced-CRC model. */
  enhanced: boolean;
}

const SYNC = new Map<number, { littleEndian: boolean; enhanced: boolean }>([
  [0xe2, { littleEndian: false, enhanced: false }],
  [0xc2, { littleEndian: true, enhanced: false }],
  [0xe8, { littleEndian: false, enhanced: true }],
  [0xc8, { littleEndian: true, enhanced: true }],
]);

/** Checksum width (bytes) for a covered-byte count under a CRC model. */
function csumWidth(covered: number, enhanced: boolean): number {
  if (enhanced) {
    if (covered < 128) return 2; // CRC16
    if (covered < 1048576) return 4; // CRC32
    return 16; // MD5 (unsupported)
  }
  if (covered < 128) return 1; // XOR-8
  if (covered < 4096) return 2; // CRC16
  if (covered < 1048576) return 4; // CRC32
  return 16; // MD5 (unsupported)
}

/**
 * Verify the trailing checksum of a forward record. `covStart` is the
 * offset of the record-ID byte and `covEnd` the offset just past the
 * message body; the checksum sits at `covEnd` and spans `width` bytes.
 */
function checksumOk(
  data: Uint8Array,
  view: DataView,
  covStart: number,
  covEnd: number,
  width: number
): boolean {
  switch (width) {
    case 1:
      return binexCsum8(data, covStart, covEnd) === (data[covEnd] ?? -1);
    case 2:
      return binexCrc16(data, covStart, covEnd) === view.getUint16(covEnd);
    case 4:
      return binexCrc32(data, covStart, covEnd) === view.getUint32(covEnd);
    default:
      return false; // 16-byte MD5 not implemented
  }
}

/**
 * Iterate every checksum-valid forward BINEX record in `data`. Corrupt
 * or truncated candidates resync at the next byte; checksum failures
 * additionally increment `stats.badCrc`. Reverse-readable records are
 * not recognised.
 */
export function* binexRecords(
  data: Uint8Array,
  view: DataView,
  stats: { badCrc: number }
): Generator<BinexRecord> {
  let i = 0;
  while (i + 2 <= data.length) {
    const sync = SYNC.get(data[i]!);
    if (!sync) {
      i++;
      continue;
    }
    const id = data[i + 1]!;
    const { value: len, size: lenH } = getBnxi(data, i + 2);
    const body = i + 2 + lenH;
    const covStart = i + 1; // record ID … end of body
    const covEnd = body + len;
    const covered = covEnd - covStart;
    const width = csumWidth(covered, sync.enhanced);
    if (width === 16 || covEnd + width > data.length) {
      i++;
      continue;
    }
    if (!checksumOk(data, view, covStart, covEnd, width)) {
      stats.badCrc++;
      i++;
      continue;
    }
    yield { id, start: i, body, len, ...sync };
    i = covEnd + width;
  }
}
