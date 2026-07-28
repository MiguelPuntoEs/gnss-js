import { describe, it, expect } from 'vitest';
import { decodeIgsSsr } from '../src/rtcm3/igs-ssr';
import type { Rtcm3Frame } from '../src/rtcm3/decoder';

class BitWriter {
  private bits: number[] = [];
  u(val: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  }
  s(val: number, n: number): void {
    this.u(val < 0 ? val + 2 ** n : val, n);
  }
  bytes(): Uint8Array {
    const b = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, i) => {
      if (bit) b[i >> 3]! |= 1 << (7 - (i & 7));
    });
    return b;
  }
}
const frame = (payload: Uint8Array): Rtcm3Frame => ({
  messageType: 4076,
  length: payload.length,
  payload,
});
// Common IGS-SSR framing: 4076 + version + IGS message number.
function head(w: BitWriter, im: number): void {
  w.u(4076, 12); // DF002
  w.u(1, 3); // IDF001 version
  w.u(im, 8); // IDF002 IGS message number
}

describe('IGS-SSR 4076 (IGS SSR Format v1.00)', () => {
  it('decodes a GPS combined orbit+clock message (IM 23)', () => {
    const w = new BitWriter();
    head(w, 23); // GPS combined
    w.u(400000, 20); // IDF003 epoch
    w.u(6, 4); // IDF004 → 60 s
    w.u(0, 1); // IDF005 MMI
    w.u(2, 4); // IDF007 IOD SSR
    w.u(256, 16); // IDF008 provider
    w.u(1, 4); // IDF009 solution
    w.u(0, 1); // IDF006 CRS (combined has it)
    w.u(1, 6); // IDF010 nsat
    w.u(5, 6); // IDF011 sat id → G05
    w.u(42, 8); // IDF012 IOD
    w.s(1000, 22); // radial → 0.1 m
    w.s(-500, 20); // along → -0.2 m
    w.s(250, 20); // cross → 0.1 m
    w.s(0, 21);
    w.s(0, 19);
    w.s(0, 19);
    w.s(3000, 22); // c0 → 0.3 m
    w.s(0, 21);
    w.s(0, 27);

    const m = decodeIgsSsr(frame(w.bytes()));
    expect(m).not.toBeNull();
    expect(m!.system).toBe('G');
    expect(m!.kind).toBe('combined');
    expect(m!.igsMessageNumber).toBe(23);
    expect(m!.updateIntervalS).toBe(60);
    const s = m!.satellites[0]!;
    expect(s.prn).toBe('G05');
    expect(s.iode).toBe(42);
    expect(s.deltaRadial).toBeCloseTo(0.1, 6);
    expect(s.deltaAlongTrack).toBeCloseTo(-0.2, 6);
    expect(s.c0).toBeCloseTo(0.3, 6);
  });

  it('decodes a Galileo phase-bias message (IM 66) with per-signal biases', () => {
    const w = new BitWriter();
    head(w, 66); // Galileo phase bias
    w.u(400000, 20); // epoch
    w.u(2, 4); // → 5 s
    w.u(0, 1); // MMI
    w.u(0, 4); // IOD SSR
    w.u(300, 16); // provider
    w.u(0, 4); // solution
    w.u(1, 1); // IDF032 dispersive consistency
    w.u(0, 1); // IDF033 MW consistency
    w.u(1, 6); // nsat
    w.u(7, 6); // sat id → E07
    w.u(1, 5); // one bias
    w.u(128, 9); // yaw angle
    w.s(0, 8); // yaw rate
    w.u(3, 5); // signal id
    w.u(1, 1); // integer indicator
    w.u(2, 2); // wide-lane group
    w.u(4, 4); // discontinuity
    w.s(1234, 20); // phase bias → 0.1234 m

    const m = decodeIgsSsr(frame(w.bytes()));
    expect(m).not.toBeNull();
    expect(m!.system).toBe('E');
    expect(m!.kind).toBe('phaseBias');
    expect(m!.dispersiveConsistency).toBe(true);
    const s = m!.satellites[0]!;
    expect(s.prn).toBe('E07');
    expect(s.phaseBiases).toHaveLength(1);
    const pb = s.phaseBiases![0]!;
    expect(pb.signal).toBe(3);
    expect(pb.integer).toBe(true);
    expect(pb.wideLaneGroup).toBe(2);
    expect(pb.discontinuity).toBe(4);
    expect(pb.biasM).toBeCloseTo(0.1234, 6);
  });

  it('maps QZSS/SBAS satellite IDs and rejects non-4076', () => {
    // QZSS URA (IM 87), one sat id 1 → J01
    const w = new BitWriter();
    head(w, 87);
    w.u(1, 20);
    w.u(0, 4);
    w.u(0, 1);
    w.u(0, 4);
    w.u(0, 16);
    w.u(0, 4);
    w.u(1, 6); // nsat
    w.u(1, 6); // sat id
    w.u(0b101_010, 6); // URA class 5 value 2
    const m = decodeIgsSsr(frame(w.bytes()));
    expect(m!.system).toBe('J');
    expect(m!.kind).toBe('ura');
    expect(m!.satellites[0]!.prn).toBe('J01');
    expect(m!.satellites[0]!.uraMm).toBeGreaterThan(0);

    expect(
      decodeIgsSsr({ messageType: 1077, length: 4, payload: new Uint8Array(4) })
    ).toBeNull();
  });
});
