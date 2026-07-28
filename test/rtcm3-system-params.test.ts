import { describe, it, expect } from 'vitest';
import { decodeSystemParams } from '../src/rtcm3/system-params';
import { createStationMeta, updateStationMeta } from '../src/rtcm3/station';
import type { Rtcm3Frame } from '../src/rtcm3/decoder';

class BitWriter {
  private bits: number[] = [];
  // Division-based bit extraction so values wider than 32 bits (e.g. int38
  // ECEF) aren't truncated by JS 32-bit `>>>`.
  u(val: number, n: number): void {
    for (let i = n - 1; i >= 0; i--)
      this.bits.push(Math.floor(val / 2 ** i) % 2);
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
const frame = (mt: number, payload: Uint8Array): Rtcm3Frame => ({
  messageType: mt,
  length: payload.length,
  payload,
});

describe('RTCM3 System Parameters (1013) + Physical Ref Station (1032)', () => {
  it('decodes 1013 leap seconds + message schedule', () => {
    const w = new BitWriter();
    w.u(1013, 12); // DF002
    w.u(123, 12); // DF003 ref station
    w.u(60000, 16); // DF051 MJD
    w.u(43200, 17); // DF052 sec of day
    w.u(2, 5); // DF053 Nm
    w.u(18, 8); // DF054 leap seconds
    w.u(1004, 12); // msg 1
    w.u(0, 1);
    w.u(10, 16); // 1.0 s
    w.u(1012, 12); // msg 2
    w.u(1, 1);
    w.u(50, 16); // 5.0 s

    const p = decodeSystemParams(frame(1013, w.bytes()));
    expect(p).not.toBeNull();
    expect(p!.referenceStationId).toBe(123);
    expect(p!.mjd).toBe(60000);
    expect(p!.leapSeconds).toBe(18);
    expect(p!.messages).toHaveLength(2);
    expect(p!.messages[0]).toMatchObject({ messageId: 1004, sync: false });
    expect(p!.messages[0]!.intervalS).toBeCloseTo(1.0, 6);
    expect(p!.messages[1]).toMatchObject({ messageId: 1012, sync: true });
    expect(p!.messages[1]!.intervalS).toBeCloseTo(5.0, 6);
    expect(decodeSystemParams(frame(1005, new Uint8Array(20)))).toBeNull();
  });

  it('decodes 1032 physical reference station position', () => {
    const w = new BitWriter();
    w.u(1032, 12); // DF002
    w.u(100, 12); // DF003 non-physical ref station
    w.u(200, 12); // DF226 physical ref station
    w.u(20, 6); // DF021 ITRF year
    const X = 38900000000,
      Y = 1000000000,
      Z = 47000000000; // ×0.0001 m
    w.s(X, 38); // DF025
    w.s(Y, 38); // DF026
    w.s(Z, 38); // DF027

    const meta = createStationMeta();
    expect(updateStationMeta(meta, frame(1032, w.bytes()))).toBe(true);
    expect(meta.stationId).toBe(100);
    expect(meta.physicalRefStationId).toBe(200);
    expect(meta.itrf).toBe(20);
    expect(meta.position![0]).toBeCloseTo(X * 0.0001, 3);
    expect(meta.position![2]).toBeCloseTo(Z * 0.0001, 3);
  });
});
