import { describe, it, expect } from 'vitest';
import { decodeSsr, isSsrMessage } from '../src/rtcm3/ssr';
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
const frame = (messageType: number, payload: Uint8Array): Rtcm3Frame => ({
  messageType,
  length: payload.length,
  payload,
});

describe('RTCM3 SSR corrections (RTCM 10403.2 §3.5.12)', () => {
  it('decodes a GPS combined orbit+clock message (1060)', () => {
    const w = new BitWriter();
    w.u(1060, 12); // DF002
    w.u(400000, 20); // DF385 epoch (s of week)
    w.u(6, 4); // DF391 update interval idx 6 → 60 s
    w.u(0, 1); // DF388 multiple-message
    w.u(0, 1); // DF375 datum (orbit/combined only)
    w.u(3, 4); // DF413 IOD SSR
    w.u(256, 16); // DF414 provider
    w.u(1, 4); // DF415 solution
    w.u(1, 6); // DF387 nsat
    // satellite
    w.u(5, 6); // DF068 sat id → G05
    w.u(42, 8); // DF071 IODE
    w.s(1000, 22); // DF365 radial → 0.1 m
    w.s(-500, 20); // DF366 along → -0.2 m
    w.s(250, 20); // DF367 cross → 0.1 m
    w.s(100, 21); // DF368 dot radial
    w.s(-40, 19); // DF369
    w.s(20, 19); // DF370
    w.s(2000, 22); // DF376 c0 → 0.2 m
    w.s(-10, 21); // DF377 c1
    w.s(5, 27); // DF378 c2

    const m = decodeSsr(frame(1060, w.bytes()));
    expect(m).not.toBeNull();
    expect(m!.system).toBe('G');
    expect(m!.kind).toBe('combined');
    expect(m!.epochS).toBe(400000);
    expect(m!.updateIntervalS).toBe(60);
    expect(m!.referenceDatum).toBe(0);
    expect(m!.iodSsr).toBe(3);
    expect(m!.providerId).toBe(256);
    expect(m!.satellites).toHaveLength(1);
    const s = m!.satellites[0]!;
    expect(s.prn).toBe('G05');
    expect(s.iode).toBe(42);
    expect(s.deltaRadial).toBeCloseTo(0.1, 6); // 1000 × 0.1 mm
    expect(s.deltaAlongTrack).toBeCloseTo(-0.2, 6); // -500 × 0.4 mm
    expect(s.deltaCrossTrack).toBeCloseTo(0.1, 6); // 250 × 0.4 mm
    expect(s.c0).toBeCloseTo(0.2, 6); // 2000 × 0.1 mm
  });

  it('decodes a GPS code-bias message (1059) with nested per-signal biases', () => {
    const w = new BitWriter();
    w.u(1059, 12); // DF002
    w.u(400000, 20); // DF385
    w.u(2, 4); // DF391 idx 2 → 5 s
    w.u(0, 1); // DF388
    w.u(0, 4); // DF413
    w.u(300, 16); // DF414
    w.u(0, 4); // DF415
    w.u(1, 6); // DF387 nsat
    w.u(12, 6); // DF068 → G12
    w.u(2, 5); // DF379 two code biases
    w.u(0, 5); // DF380 signal 0 (L1 C/A)
    w.s(150, 14); // DF383 → 1.5 m
    w.u(7, 5); // DF380 signal 7 (L2C(M))
    w.s(-80, 14); // DF383 → -0.8 m

    const m = decodeSsr(frame(1059, w.bytes()));
    expect(m).not.toBeNull();
    expect(m!.kind).toBe('codeBias');
    const s = m!.satellites[0]!;
    expect(s.prn).toBe('G12');
    expect(s.codeBiases).toHaveLength(2);
    expect(s.codeBiases![0]).toMatchObject({ signal: 0, signalName: 'L1 C/A' });
    expect(s.codeBiases![0]!.biasM).toBeCloseTo(1.5, 6);
    expect(s.codeBiases![1]!.signalName).toBe('L2C(M)');
    expect(s.codeBiases![1]!.biasM).toBeCloseTo(-0.8, 6);
  });

  it('classifies + rejects non-SSR types', () => {
    expect(isSsrMessage(1060)).toBe(true);
    expect(isSsrMessage(1068)).toBe(true);
    expect(isSsrMessage(1077)).toBe(false);
    expect(decodeSsr(frame(1077, new Uint8Array(20)))).toBeNull();
  });
});
