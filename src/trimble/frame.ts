/**
 * Trimble RT17/RT27 binary framing shared by the measurement and
 * navigation decoders.
 *
 * A packet is `STX(0x02) STATUS TYPE LENGTH DATA[LENGTH] CHECKSUM ETX(0x03)`,
 * where the checksum is the low byte of `STATUS + TYPE + LENGTH + Σ DATA`.
 * Framing, packet-type constants (RAWDATA 0x57, RETSVDATA 0x55) and the
 * multi-page RAWDATA reassembly are ported from RTKLIB's `src/rcv/rt17.c`
 * (tomojitakasu/RTKLIB, `input_rt17` / `unwrap_rawdata`,
 * Copyright (C) 2014 D. A. Cook / T. Takasu, BSD-2-Clause). All
 * multi-byte scalar fields on the wire are big-endian (RT17 default).
 */

export const STX = 0x02;
export const ETX = 0x03;
export const RAWDATA = 0x57; // position / real-time survey data report
export const RETSVDATA = 0x55; // satellite information report (eph/alm/ion)

/** One checksum-valid Trimble packet located in a byte stream. */
export interface TrimbleFrame {
  /** Offset of the STX byte. */
  start: number;
  /** STATUS byte. */
  status: number;
  /** Packet TYPE byte (e.g. 0x57 RAWDATA, 0x55 RETSVDATA). */
  type: number;
  /** DATA length in bytes. */
  len: number;
  /** Offset of the first DATA byte (i.e. `start + 4`). */
  payload: number;
}

/**
 * Iterate every checksum-valid Trimble packet in `data`. A prospective
 * packet must end in ETX and match its checksum; otherwise the walker
 * resyncs at the next byte and, for a checksum mismatch on an
 * otherwise-well-formed packet, increments `stats.badChecksum`.
 */
export function* trimbleFrames(
  data: Uint8Array,
  stats: { badChecksum: number }
): Generator<TrimbleFrame> {
  let i = 0;
  while (i + 6 <= data.length) {
    if (data[i] !== STX) {
      i++;
      continue;
    }
    const len = data[i + 3]!;
    const total = 4 + len + 2; // STX status type len | data | checksum etx
    if (i + total > data.length) {
      i++;
      continue;
    }
    if (data[i + total - 1] !== ETX) {
      i++;
      continue;
    }
    let cs = 0;
    for (let k = 1; k <= 3 + len; k++) cs = (cs + data[i + k]!) & 0xff;
    if (cs !== data[i + 4 + len]!) {
      stats.badChecksum++;
      i++;
      continue;
    }
    yield {
      start: i,
      status: data[i + 1]!,
      type: data[i + 2]!,
      len,
      payload: i + 4,
    };
    i += total;
  }
}
