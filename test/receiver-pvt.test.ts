import { describe, it, expect } from 'vitest';
import { parseUbxPvt } from '../src/ubx';
import { parseNovatelPvt } from '../src/novatel';
import { crc32 } from '../src/novatel/frame';

/** Frame a UBX message (sync, class, id, len, payload, Fletcher-8). */
function ubxFrame(cls: number, id: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  out[0] = 0xb5;
  out[1] = 0x62;
  out[2] = cls;
  out[3] = id;
  out[4] = payload.length & 0xff;
  out[5] = (payload.length >> 8) & 0xff;
  out.set(payload, 6);
  let a = 0;
  let b = 0;
  for (let j = 2; j < 6 + payload.length; j++) {
    a = (a + out[j]!) & 0xff;
    b = (b + a) & 0xff;
  }
  out[6 + payload.length] = a;
  out[7 + payload.length] = b;
  return out;
}

describe('parseUbxPvt (NAV-PVT)', () => {
  it('decodes a synthesised RTK-fixed fix', () => {
    const p = new Uint8Array(92);
    const v = new DataView(p.buffer);
    v.setUint32(0, 259200000, true); // iTOW (ms)
    v.setUint16(4, 2026, true); // year
    p[6] = 7; // month
    p[7] = 28; // day
    p[8] = 12; // hour
    p[20] = 3; // fixType = 3D
    p[21] = 0x01 | (2 << 6); // gnssFixOK + carrSoln=2 (RTK fixed)
    p[23] = 22; // numSV
    v.setInt32(24, Math.round(4.39 * 1e7), true); // lon
    v.setInt32(28, Math.round(51.99 * 1e7), true); // lat
    v.setInt32(32, 75000, true); // height (mm, ellipsoidal)
    v.setUint32(40, 140, true); // hAcc (mm)
    v.setUint32(44, 220, true); // vAcc (mm)

    const res = parseUbxPvt(ubxFrame(0x01, 0x07, p));
    expect(res.records).toHaveLength(1);
    const r = res.records[0]!;
    expect(r.mode).toBe('rtk-fixed');
    expect(r.latDeg!).toBeCloseTo(51.99, 4);
    expect(r.lonDeg!).toBeCloseTo(4.39, 4);
    expect(r.heightM!).toBeCloseTo(75, 2);
    expect(r.hAccuracyM!).toBeCloseTo(0.14, 3);
    expect(r.vAccuracyM!).toBeCloseTo(0.22, 3);
    expect(r.nrSV).toBe(22);
  });
});

/** Frame a NovAtel OEM4 binary message with a valid CRC-32. */
function oem4Frame(
  id: number,
  week: number,
  towMs: number,
  body: Uint8Array
): Uint8Array {
  const HLEN = 28;
  const out = new Uint8Array(HLEN + body.length + 4);
  const v = new DataView(out.buffer);
  out[0] = 0xaa;
  out[1] = 0x44;
  out[2] = 0x12;
  out[3] = HLEN;
  v.setUint16(4, id, true);
  out[6] = 0; // message type: binary (bits 4-5 = 0)
  v.setUint16(8, body.length, true);
  v.setUint16(14, week, true);
  v.setUint32(16, towMs, true);
  out.set(body, HLEN);
  v.setUint32(HLEN + body.length, crc32(out, 0, HLEN + body.length), true);
  return out;
}

describe('parseNovatelPvt (BESTPOS)', () => {
  it('decodes a synthesised SBAS-aided fix', () => {
    const body = new Uint8Array(72);
    const v = new DataView(body.buffer);
    v.setUint32(0, 0, true); // solStat = SOL_COMPUTED
    v.setUint32(4, 18, true); // posType = WAAS (SBAS)
    v.setFloat64(8, 51.99, true); // lat
    v.setFloat64(16, 4.39, true); // lon
    v.setFloat64(24, 43.0, true); // hgt (MSL)
    v.setFloat32(32, 47.0, true); // undulation → ellipsoidal 90
    v.setFloat32(40, 0.8, true); // lat σ
    v.setFloat32(44, 0.6, true); // lon σ
    v.setFloat32(48, 1.5, true); // hgt σ
    body[65] = 14; // #SVs in solution

    const res = parseNovatelPvt(oem4Frame(42, 2429, 259200000, body));
    expect(res.records).toHaveLength(1);
    const r = res.records[0]!;
    expect(r.mode).toBe('sbas-aided');
    expect(r.latDeg!).toBeCloseTo(51.99, 6);
    expect(r.heightM!).toBeCloseTo(90.0, 3); // 43 + 47
    expect(r.hAccuracyM!).toBeCloseTo(Math.hypot(0.8, 0.6), 3);
    expect(r.vAccuracyM!).toBeCloseTo(1.5, 3);
    expect(r.nrSV).toBe(14);
    expect(r.week).toBe(2429);
  });
});
