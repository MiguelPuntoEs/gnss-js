import { describe, it, expect } from 'vitest';
import { SbasProcessor } from '../src/positioning';
import { crc24q } from '../src/navbits/cnav';

/** Set `len` bits (MSB-first) at bit `pos` in a 250-bit SBAS message buffer. */
function setBitU(buf: Uint8Array, pos: number, len: number, val: number): void {
  for (let i = 0; i < len; i++) {
    const bit = (val >>> (len - 1 - i)) & 1;
    const bytePos = (pos + i) >> 3;
    const bitPos = 7 - ((pos + i) & 7);
    if (bit) buf[bytePos]! |= 1 << bitPos;
    else buf[bytePos]! &= ~(1 << bitPos);
  }
}
/** Two's-complement writer for a signed field. */
function setBitS(buf: Uint8Array, pos: number, len: number, val: number): void {
  setBitU(buf, pos, len, val < 0 ? val + (1 << len) : val);
}
function mkMsg(type: number, writes: [number, number, number][]): Uint8Array {
  const m = new Uint8Array(32);
  setBitU(m, 0, 8, 0x53);
  setBitU(m, 8, 6, type);
  for (const [pos, len, val] of writes) setBitU(m, pos, len, val);
  setBitU(m, 226, 24, crc24q(m, 226));
  return m;
}
/** MT1 mask with a single satellite bit set (→ slot 0 of the mask). */
function mkMask(maskIndex: number, iodp: number): Uint8Array {
  return mkMsg(1, [
    [13 + maskIndex, 1, 1],
    [224, 2, iodp],
  ]);
}
/** White-box accessor for the private geometry evaluator. */
const mt28Udre = (
  proc: SbasProcessor,
  prn: string,
  los: readonly [number, number, number]
): number | null =>
  (
    proc as unknown as {
      mt28DeltaUdre: (
        p: string,
        l: readonly [number, number, number]
      ) => number | null;
    }
  ).mt28DeltaUdre(prn, los);

describe('SBAS MT28 clock-ephemeris covariance → δUDRE (ICAO Annex 10 §3.5.5.6.2.5)', () => {
  const week = 2300;
  const tow = 100000;
  const scaleExp = 5; // SF = 2^(5−5) = 1
  const E = [100, 80, 60, 40, -20, 10, -5, 15, -8, 12]; // E11..E44, E12..E34
  const los: [number, number, number] = [0.36, 0.48, 0.8]; // |los| = 1

  function feed(proc: SbasProcessor, ccovRaw: number) {
    // MT1: mask index 1 → 'G01' at slot 0.
    proc.update(mkMask(1, 0), week, tow);
    // MT10: only Ccovariance matters here (bit 138, ×0.1).
    proc.update(mkMsg(10, [[138, 7, ccovRaw]]), week, tow);
    // MT28: satellite 1 = slot 0.
    const base = 16;
    const base2 = 121; // satellite 2 in the message
    const m = mkMsg(28, [
      [14, 2, 0], // IODP (matches mask)
      [base, 6, 0], // slot 0 → G01
      [base + 6, 3, scaleExp],
      [base + 9, 9, E[0]!],
      [base + 18, 9, E[1]!],
      [base + 27, 9, E[2]!],
      [base + 36, 9, E[3]!],
      [base2, 6, 63], // satellite 2 → unmapped slot (only G01 is masked)
    ]);
    setBitS(m, base + 45, 10, E[4]!);
    setBitS(m, base + 55, 10, E[5]!);
    setBitS(m, base + 65, 10, E[6]!);
    setBitS(m, base + 75, 10, E[7]!);
    setBitS(m, base + 85, 10, E[8]!);
    setBitS(m, base + 95, 10, E[9]!);
    setBitU(m, 226, 24, crc24q(m, 226));
    expect(proc.update(m, week, tow)).toBe(28); // recognised + IODP matches
  }

  /** Independent recomputation of δUDRE = ‖R·I‖ + C_cov·SF. */
  function expectedDudre(ccovRaw: number): number {
    const sf = 2 ** (scaleExp - 5);
    const [e11, e22, e33, e44, e12, e13, e14, e23, e24, e34] = E;
    const [ix, iy, iz] = los;
    const v0 = (e11! * ix + e12! * iy + e13! * iz + e14!) * sf;
    const v1 = (e22! * iy + e23! * iz + e24!) * sf;
    const v2 = (e33! * iz + e34!) * sf;
    const v3 = e44! * sf;
    return (
      Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2 + v3 * v3) + ccovRaw * 0.1 * sf
    );
  }

  it('decodes E/scaleExp and evaluates δUDRE = √(IᵀCI) + εc', () => {
    const proc = new SbasProcessor();
    feed(proc, 20); // Ccovariance = 2.0 m
    // White-box: the private geometry evaluator.
    const dudre = mt28Udre(proc, 'G01', los);
    expect(dudre).not.toBeNull();
    expect(dudre!).toBeCloseTo(expectedDudre(20), 6);
  });

  it('εc scales with the MT10 Ccovariance term', () => {
    const a = new SbasProcessor();
    feed(a, 0);
    const b = new SbasProcessor();
    feed(b, 50); // 5.0 m
    const da = mt28Udre(a, 'G01', los)!;
    const db = mt28Udre(b, 'G01', los)!;
    expect(db - da).toBeCloseTo(5.0, 6); // ε difference = 5.0 m × SF(=1)
  });

  it('returns null for a PRN with no MT28 data', () => {
    const proc = new SbasProcessor();
    feed(proc, 0);
    expect(mt28Udre(proc, 'G07', los)).toBeNull();
  });

  it('drops MT28 whose IODP does not match the current mask', () => {
    const proc = new SbasProcessor();
    proc.update(mkMask(1, 0), week, tow); // mask IODP 0
    const m = mkMsg(28, [
      [14, 2, 1], // IODP 1 ≠ 0
      [16, 6, 0],
      [22, 3, scaleExp],
    ]);
    expect(proc.update(m, week, tow)).toBe(-1);
    expect(mt28Udre(proc, 'G01', los)).toBeNull();
  });
});
