/**
 * NovAtel OEM4/6/7 binary framing shared by the measurement and
 * navigation decoders: sync pattern 0xAA 0x44 0x12, a 28+-byte header,
 * and a reflected CRC-32 (poly 0xEDB88320) over the whole frame.
 */

/** Minimum (standard) OEM4 binary header length. */
export const OEM4_HLEN = 28;

/** Reflected CRC-32 (poly 0xEDB88320, init 0) — NovAtel "32-bit CRC". */
export function crc32(data: Uint8Array, start: number, len: number): number {
  let crc = 0;
  for (let i = start; i < start + len; i++) {
    crc ^= data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return crc >>> 0;
}

/** One CRC-valid OEM4 frame located in a byte stream. */
export interface Oem4Frame {
  /** Message ID. */
  id: number;
  /** Offset of the frame start (first sync byte). */
  start: number;
  /** Offset of the payload (frame start + header length). */
  payload: number;
  /** Payload length in bytes. */
  msgLen: number;
  /** True when the header's message-type field marks a binary body. */
  binary: boolean;
  /** GPS week from the header. */
  week: number;
  /** GPS time of week from the header (ms). */
  towMs: number;
}

/**
 * Iterate every CRC-valid OEM4 frame in `data`. Corrupt or truncated
 * candidates resync at the next byte; CRC failures additionally
 * increment `stats.badCrc`.
 */
export function* oem4Frames(
  data: Uint8Array,
  view: DataView,
  stats: { badCrc: number }
): Generator<Oem4Frame> {
  let i = 0;
  while (i + OEM4_HLEN + 4 <= data.length) {
    if (data[i] !== 0xaa || data[i + 1] !== 0x44 || data[i + 2] !== 0x12) {
      i++;
      continue;
    }
    const hlen = data[i + 3]!;
    const msgLen = view.getUint16(i + 8, true);
    const total = hlen + msgLen + 4;
    if (hlen < OEM4_HLEN || i + total > data.length) {
      i++;
      continue;
    }
    if (
      crc32(data, i, hlen + msgLen) !== view.getUint32(i + hlen + msgLen, true)
    ) {
      stats.badCrc++;
      i++;
      continue;
    }
    yield {
      id: view.getUint16(i + 4, true),
      start: i,
      payload: i + hlen,
      msgLen,
      binary: ((data[i + 6]! >> 4) & 0x3) === 0,
      week: view.getUint16(i + 14, true),
      towMs: view.getUint32(i + 16, true),
    };
    i += total;
  }
}
