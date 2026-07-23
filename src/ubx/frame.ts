/**
 * u-blox UBX framing shared by the measurement and navigation decoders:
 * 0xB5 0x62 sync, message class and ID, little-endian payload length,
 * payload, and an 8-bit Fletcher checksum over class..payload.
 */

/** One checksum-valid UBX frame located in a byte stream. */
export interface UbxFrame {
  /** Message class, e.g. 0x02 for RXM. */
  msgClass: number;
  /** Message ID within the class, e.g. 0x15 for RXM-RAWX. */
  msgId: number;
  /** Payload bytes (a view into the input buffer, not a copy). */
  payload: Uint8Array;
  /** Byte offset of the payload within the input buffer. */
  payloadStart: number;
}

/**
 * Iterate every checksum-valid UBX frame in `data`. Bad checksums are
 * counted in `stats.badChecksums` and a resync continues at the next
 * byte; a frame candidate that overruns the buffer ends the scan
 * (truncated capture).
 */
export function* ubxFrames(
  data: Uint8Array,
  stats: { badChecksums: number } = { badChecksums: 0 }
): Generator<UbxFrame> {
  let i = 0;
  while (i + 8 <= data.length) {
    if (data[i] !== 0xb5 || data[i + 1] !== 0x62) {
      i++;
      continue;
    }
    const len = data[i + 4]! | (data[i + 5]! << 8);
    const end = i + 6 + len + 2;
    if (end > data.length) break;

    // Fletcher-8 over class..payload
    let ckA = 0;
    let ckB = 0;
    for (let j = i + 2; j < i + 6 + len; j++) {
      ckA = (ckA + data[j]!) & 0xff;
      ckB = (ckB + ckA) & 0xff;
    }
    if (ckA !== data[i + 6 + len] || ckB !== data[i + 7 + len]) {
      stats.badChecksums++;
      i++;
      continue;
    }

    yield {
      msgClass: data[i + 2]!,
      msgId: data[i + 3]!,
      payload: data.subarray(i + 6, i + 6 + len),
      payloadStart: i + 6,
    };
    i = end;
  }
}
