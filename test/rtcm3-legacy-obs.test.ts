import { describe, it, expect } from 'vitest';
import { decodeLegacyObs } from '../src/rtcm3/legacy-obs';
import type { Rtcm3Frame } from '../src/rtcm3/decoder';

const C = 299792458;
const PRUNIT_GPS = 299792.458;
const PRUNIT_GLO = 599584.916;

/** MSB-first bit writer for building a synthetic RTCM3 payload. */
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

const frame = (messageType: number, payload: Uint8Array): Rtcm3Frame => ({
  messageType,
  length: payload.length,
  payload,
});

describe('legacy RTCM3 observations (RTCM 10403.2 §3.5.1/§3.5.4)', () => {
  it('decodes an extended dual-freq GPS message (1004)', () => {
    const w = new BitWriter();
    // Header (Table 3.5-1)
    w.u(1004, 12); // DF002
    w.u(0, 12); // DF003 ref station
    w.u(100000, 30); // DF004 TOW ms
    w.u(0, 1); // DF005 sync
    w.u(1, 5); // DF006 nsat
    w.u(0, 1); // DF007
    w.u(0, 3); // DF008
    // One satellite (Table 3.5-5)
    const pr1raw = 1_000_000,
      ppr1 = 200,
      lock1 = 10,
      amb = 66,
      cnr1 = 180;
    const code2 = 0,
      pr21 = 100,
      ppr2 = -300,
      lock2 = 9,
      cnr2 = 176;
    w.u(5, 6); // DF009 sat id → G05
    w.u(0, 1); // DF010 L1 code → 1C
    w.u(pr1raw, 24); // DF011
    w.s(ppr1, 20); // DF012
    w.u(lock1, 7); // DF013
    w.u(amb, 8); // DF014
    w.u(cnr1, 8); // DF015
    w.u(code2, 2); // DF016 → 2X
    w.s(pr21, 14); // DF017
    w.s(ppr2, 20); // DF018
    w.u(lock2, 7); // DF019
    w.u(cnr2, 8); // DF020

    const ep = decodeLegacyObs(frame(1004, w.bytes()));
    expect(ep).not.toBeNull();
    expect(ep!.system).toBe('G');
    expect(ep!.epochMs).toBe(100000);
    expect(ep!.observations).toHaveLength(1);
    const sat = ep!.observations[0]!;
    expect(sat.prn).toBe('G05');
    expect(sat.signals).toHaveLength(2);

    const pr1 = pr1raw * 0.02 + amb * PRUNIT_GPS;
    const lamL1 = C / 1575.42e6;
    const lamL2 = C / 1227.6e6;
    const [l1, l2] = sat.signals;
    expect(l1!.rinexCode).toBe('1C');
    expect(l1!.pseudorange).toBeCloseTo(pr1, 3);
    expect(l1!.phase).toBeCloseTo((pr1 + ppr1 * 0.0005) / lamL1, 2);
    expect(l1!.cn0).toBeCloseTo(cnr1 * 0.25, 6);
    expect(l2!.rinexCode).toBe('2X');
    expect(l2!.pseudorange).toBeCloseTo(pr1 + pr21 * 0.02, 3);
    expect(l2!.phase).toBeCloseTo((pr1 + ppr2 * 0.0005) / lamL2, 2);
    expect(l2!.cn0).toBeCloseTo(cnr2 * 0.25, 6);
  });

  it('decodes an extended dual-freq GLONASS message (1012) with inline channel', () => {
    const w = new BitWriter();
    w.u(1012, 12); // DF002
    w.u(0, 12); // DF003
    w.u(3600000, 27); // DF034 ms of day
    w.u(0, 1); // DF005
    w.u(1, 5); // DF035 nsat
    w.u(0, 1); // DF036
    w.u(0, 3); // DF037
    const freqCh = 8; // → k = +1
    const pr1raw = 2_000_000,
      ppr1 = 150,
      amb = 33,
      cnr1 = 172;
    w.u(7, 6); // DF038 slot → R07
    w.u(0, 1); // DF039 → 1C
    w.u(freqCh, 5); // DF040
    w.u(pr1raw, 25); // DF041
    w.s(ppr1, 20); // DF042
    w.u(12, 7); // DF043 lock
    w.u(amb, 7); // DF044
    w.u(cnr1, 8); // DF045
    w.u(0, 2); // DF046 → 2C
    w.s(80, 14); // DF047
    w.s(-90, 20); // DF048
    w.u(11, 7); // DF049
    w.u(170, 8); // DF050

    const ep = decodeLegacyObs(frame(1012, w.bytes()));
    expect(ep).not.toBeNull();
    expect(ep!.system).toBe('R');
    // ms-of-day preserved in the low 27 bits (high bits carry the day of week)
    expect(ep!.epochMs & 0x07ffffff).toBe(3600000);
    const sat = ep!.observations[0]!;
    expect(sat.prn).toBe('R07');
    expect(sat.signals).toHaveLength(2);
    const k = freqCh - 7;
    const lamL1 = C / (1602.0e6 + k * 0.5625e6);
    const pr1 = pr1raw * 0.02 + amb * PRUNIT_GLO;
    expect(sat.signals[0]!.pseudorange).toBeCloseTo(pr1, 3);
    expect(sat.signals[0]!.wavelength).toBeCloseTo(lamL1, 9);
    expect(sat.signals[0]!.cn0).toBeCloseTo(cnr1 * 0.25, 6);
    expect(sat.signals[1]!.rinexCode).toBe('2C');
  });

  it('returns null for non-legacy message types', () => {
    expect(decodeLegacyObs(frame(1077, new Uint8Array(20)))).toBeNull();
    expect(decodeLegacyObs(frame(1005, new Uint8Array(20)))).toBeNull();
  });
});
