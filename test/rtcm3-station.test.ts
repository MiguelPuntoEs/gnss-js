import { describe, it, expect } from 'vitest';
import { BitReader } from '../src/rtcm3/decoder';
import type { Rtcm3Frame } from '../src/rtcm3/decoder';
import { createStationMeta, updateStationMeta } from '../src/rtcm3/station';

/* ================================================================== */
/*  Helpers                                                            */
/* ================================================================== */

/** Bit writer safe for fields wider than 32 bits (up to 53). */
class WideBitWriter {
  private bits: number[] = [];

  writeU(value: number, numBits: number): void {
    for (let i = numBits - 1; i >= 0; i--) {
      this.bits.push(Math.floor(value / 2 ** i) % 2);
    }
  }

  writeS(value: number, numBits: number): void {
    this.writeU(value < 0 ? value + 2 ** numBits : value, numBits);
  }

  toUint8Array(): Uint8Array {
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
    for (let i = 0; i < this.bits.length; i++) {
      bytes[i >> 3] |= this.bits[i]! << (7 - (i & 7));
    }
    return bytes;
  }
}

/** Build a 1005/1006 payload with the given ECEF position in meters. */
function buildStationArpFrame(opts: {
  messageType: 1005 | 1006;
  stationId: number;
  ecef: [number, number, number]; // meters
  antennaHeight?: number; // meters, 1006 only
}): Rtcm3Frame {
  const w = new WideBitWriter();
  w.writeU(opts.messageType, 12);
  w.writeU(opts.stationId, 12);
  w.writeU(0, 6); // ITRF realization year
  w.writeU(0, 4); // GPS/GLO/GAL/ref station indicators
  w.writeS(Math.round(opts.ecef[0] * 10000), 38);
  w.writeU(0, 2); // single receiver oscillator + reserved
  w.writeS(Math.round(opts.ecef[1] * 10000), 38);
  w.writeU(0, 2); // quarter cycle indicator + reserved
  w.writeS(Math.round(opts.ecef[2] * 10000), 38);
  if (opts.messageType === 1006) {
    w.writeU(Math.round((opts.antennaHeight ?? 0) * 10000), 16);
  }
  const payload = w.toUint8Array();
  return { messageType: opts.messageType, length: payload.length, payload };
}

/* ================================================================== */
/*  Tests                                                              */
/* ================================================================== */

describe('BitReader wide reads', () => {
  it('reads unsigned values wider than 32 bits', () => {
    const w = new WideBitWriter();
    w.writeU(39246877039, 38); // needs 36 bits — overflows 32-bit shifts
    const r = new BitReader(w.toUint8Array());
    expect(r.readU(38)).toBe(39246877039);
  });

  it('reads negative 38-bit two’s complement values', () => {
    const w = new WideBitWriter();
    w.writeS(-50019107712, 38);
    const r = new BitReader(w.toUint8Array());
    expect(r.readS(38)).toBe(-50019107712);
  });

  it('reads sign-magnitude values wider than 32 bits', () => {
    const w = new WideBitWriter();
    w.writeU(2 ** 37 + 39246877039, 38); // sign bit set + magnitude
    const r = new BitReader(w.toUint8Array());
    expect(r.readSM(38)).toBe(-39246877039);
  });
});

describe('station ARP (1005/1006)', () => {
  // Regression: DELF00NLD0 (gnss1.tudelft.nl). X and Z exceed 2^32 in
  // 0.1 mm units and were truncated to 59217.1375 / 277446.7456 m.
  it('decodes 1005 coordinates above the 32-bit boundary', () => {
    const frame = buildStationArpFrame({
      messageType: 1005,
      stationId: 138,
      ecef: [3924687.7039, 301132.7618, 5001910.7712],
    });
    const meta = createStationMeta();
    expect(updateStationMeta(meta, frame)).toBe(true);
    expect(meta.stationId).toBe(138);
    expect(meta.position).not.toBeNull();
    expect(meta.position![0]).toBeCloseTo(3924687.7039, 4);
    expect(meta.position![1]).toBeCloseTo(301132.7618, 4);
    expect(meta.position![2]).toBeCloseTo(5001910.7712, 4);
  });

  it('decodes 1006 with negative coordinates and antenna height', () => {
    // Southern/western hemisphere station (Santiago de Chile area)
    const frame = buildStationArpFrame({
      messageType: 1006,
      stationId: 7,
      ecef: [1769723.4567, -5044549.1234, -3468428.9876],
      antennaHeight: 1.2345,
    });
    const meta = createStationMeta();
    expect(updateStationMeta(meta, frame)).toBe(true);
    expect(meta.position![0]).toBeCloseTo(1769723.4567, 4);
    expect(meta.position![1]).toBeCloseTo(-5044549.1234, 4);
    expect(meta.position![2]).toBeCloseTo(-3468428.9876, 4);
    expect(meta.antennaHeight).toBeCloseTo(1.2345, 4);
  });
});
