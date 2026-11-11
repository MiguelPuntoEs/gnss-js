/**
 * RTCM3 encoding primitives: a bit-level payload writer (the inverse of
 * `BitReader`) and transport-layer framing with CRC-24Q.
 */

import { crc24q } from './decoder';

/* ================================================================== */
/*  BitWriter                                                          */
/* ================================================================== */

/** Bit writer for building RTCM3 payloads, MSB first. */
export class BitWriter {
  private bytes: number[] = [];
  private current = 0;
  private nBits = 0; // bits already in `current` (0-7)

  /** Total bits written so far. */
  get bitLength(): number {
    return this.bytes.length * 8 + this.nBits;
  }

  /**
   * Write `value` as an `n`-bit unsigned integer (max 53). Out-of-range
   * values throw: silently truncating would corrupt every later field.
   */
  writeU(value: number, n: number): void {
    if (n === 0) return;
    if (!Number.isInteger(value) || value < 0 || value >= 2 ** n) {
      throw new RangeError(`value ${value} does not fit in ${n} unsigned bits`);
    }
    // Float arithmetic instead of shifts so fields wider than 32 bits work.
    for (let i = n - 1; i >= 0; i--) {
      this.pushBit(Math.floor(value / 2 ** i) % 2);
    }
  }

  /** Write `value` as an `n`-bit two's-complement signed integer. */
  writeS(value: number, n: number): void {
    const half = 2 ** (n - 1);
    if (!Number.isInteger(value) || value < -half || value >= half) {
      throw new RangeError(`value ${value} does not fit in ${n} signed bits`);
    }
    this.writeU(value < 0 ? value + 2 ** n : value, n);
  }

  /** Write `value` as an `n`-bit sign-magnitude integer (MSB = sign). */
  writeSM(value: number, n: number): void {
    const half = 2 ** (n - 1);
    const mag = Math.abs(value);
    if (!Number.isInteger(value) || mag >= half) {
      throw new RangeError(
        `value ${value} does not fit in ${n} sign-magnitude bits`
      );
    }
    // A negative zero keeps its sign bit, as BitReader.readSM returns it.
    const negative = value < 0 || Object.is(value, -0);
    this.writeU(negative ? half + mag : mag, n);
  }

  /** Write `n` zero bits (reserved fields). */
  zeros(n: number): void {
    for (let i = 0; i < n; i++) this.pushBit(0);
  }

  /** Payload bytes, zero-padded to a whole byte. */
  toBytes(): Uint8Array {
    const out = new Uint8Array(this.bytes.length + (this.nBits > 0 ? 1 : 0));
    out.set(this.bytes);
    if (this.nBits > 0) {
      out[this.bytes.length] = this.current << (8 - this.nBits);
    }
    return out;
  }

  private pushBit(bit: number): void {
    this.current = (this.current << 1) | bit;
    if (++this.nBits === 8) {
      this.bytes.push(this.current);
      this.current = 0;
      this.nBits = 0;
    }
  }
}

/* ================================================================== */
/*  Framing                                                            */
/* ================================================================== */

/** Largest payload an RTCM3 frame can carry (10-bit length field). */
export const RTCM3_MAX_PAYLOAD = 1023;

/**
 * Wrap a payload in an RTCM3 transport frame:
 * [0xD3] [6 reserved bits + 10-bit length] [payload] [CRC-24Q].
 */
export function frameRtcm3(payload: Uint8Array): Uint8Array {
  if (payload.length > RTCM3_MAX_PAYLOAD) {
    throw new RangeError(
      `RTCM3 payload of ${payload.length} bytes exceeds ${RTCM3_MAX_PAYLOAD}`
    );
  }
  const frame = new Uint8Array(payload.length + 6);
  frame[0] = 0xd3;
  frame[1] = (payload.length >> 8) & 0x03;
  frame[2] = payload.length & 0xff;
  frame.set(payload, 3);
  const crc = crc24q(frame, payload.length + 3);
  frame[payload.length + 3] = (crc >> 16) & 0xff;
  frame[payload.length + 4] = (crc >> 8) & 0xff;
  frame[payload.length + 5] = crc & 0xff;
  return frame;
}
