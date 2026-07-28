import { describe, it, expect } from 'vitest';
import {
  SbasProcessor,
  sbasLongTermDeg,
  sbasIonoDeg,
  type Degradation,
} from '../src/positioning';
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

/** Build a CRC-valid SBAS L1 message of the given type with field writes. */
function mkMsg(type: number, writes: [number, number, number][]): Uint8Array {
  const m = new Uint8Array(32);
  setBitU(m, 0, 8, 0x53); // a valid L1 preamble
  setBitU(m, 8, 6, type);
  for (const [pos, len, val] of writes) setBitU(m, pos, len, val);
  setBitU(m, 226, 24, crc24q(m, 226)); // parity over the first 226 bits
  return m;
}

describe('SBAS degradation model (DO-229D §A.4.5)', () => {
  // A known degradation set (raw MT10 fields × their Table A-9 LSBs).
  const d: Degradation = {
    brrc: 0.02,
    cltcLsb: 0.02,
    cltcV1: 0.001,
    iltcV1: 100,
    cltcV0: 0.02,
    iltcV0: 60,
    cgeoLsb: 0,
    cgeoV: 0,
    igeo: 0,
    cer: 2,
    cionoStep: 0.05,
    iiono: 300,
    cionoRamp: 0.00005,
    rssUdre: false,
    rssIono: true,
  };

  it('long-term degradation ε_ltc, velocity code 1 (A-54)', () => {
    expect(sbasLongTermDeg(d, true, 50)).toBe(0); // inside [t0, t0+Iltc_v1]
    // Aged past the window: Cltc_lsb + Cltc_v1·(t − t0 − Iltc_v1).
    expect(sbasLongTermDeg(d, true, 250)).toBeCloseTo(0.02 + 0.001 * 150, 9);
    // Before t0 (t0 − t): Cltc_lsb + Cltc_v1·30.
    expect(sbasLongTermDeg(d, true, -30)).toBeCloseTo(0.02 + 0.001 * 30, 9);
  });

  it('long-term degradation ε_ltc, velocity code 0 (A-55)', () => {
    // Cltc_v0 · floor(|t − tltc| / Iltc_v0).
    expect(sbasLongTermDeg(d, false, 130)).toBeCloseTo(0.02 * 2, 9);
    expect(sbasLongTermDeg(d, false, 59)).toBe(0);
  });

  it('ionospheric degradation ε_iono (A-59)', () => {
    // Ciono_step·floor(dt/Iiono) + Ciono_ramp·dt.
    expect(sbasIonoDeg(d, 700)).toBeCloseTo(0.05 * 2 + 0.00005 * 700, 9);
    expect(sbasIonoDeg(d, 0)).toBe(0);
  });

  it('decodes MT10 fields at their Table A-9 offsets/scales', () => {
    const proc = new SbasProcessor();
    const msg = mkMsg(10, [
      [14, 10, 10], // Brrc raw 10 → 0.02 m
      [24, 10, 10], // Cltc_lsb → 0.02 m
      [34, 10, 20], // Cltc_v1 raw 20 → 0.001 m/s
      [44, 9, 100], // Iltc_v1 → 100 s
      [53, 10, 10], // Cltc_v0 → 0.02 m
      [63, 9, 60], // Iltc_v0 → 60 s
      [101, 6, 4], // Cer raw 4 → 2.0 m
      [107, 10, 50], // Ciono_step raw 50 → 0.05 m
      [117, 9, 300], // Iiono → 300 s
      [126, 10, 10], // Ciono_ramp raw 10 → 0.00005 m/s
      [137, 1, 1], // RSSiono = 1
    ]);
    expect(proc.update(msg, 2300, 100000)).toBe(10);
    const got = proc.degradation!;
    expect(got).not.toBeNull();
    expect(got.cltcLsb).toBeCloseTo(0.02, 9);
    expect(got.cltcV1).toBeCloseTo(0.001, 9);
    expect(got.iltcV1).toBe(100);
    expect(got.iltcV0).toBe(60);
    expect(got.cer).toBeCloseTo(2, 9);
    expect(got.cionoStep).toBeCloseTo(0.05, 9);
    expect(got.iiono).toBe(300);
    expect(got.cionoRamp).toBeCloseTo(0.00005, 9);
    expect(got.rssUdre).toBe(false);
    expect(got.rssIono).toBe(true);
  });
});
