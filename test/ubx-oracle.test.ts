/**
 * u-blox UBX against RTKLIB convbin and the M8 protocol specification
 * (UBX-13003221 R13, §31.19.4.2 RXM-RAWX, §31.17.14 NAV-PVT).
 *
 * RTKLIB 2.4.2 predates RAWX sigId (it writes every RAWX record as an L1 row,
 * so a dual-frequency satellite appears twice), so its RINEX
 * (test-fixtures/convbin/f9p_rawx.obs) is matched row by row on the
 * pseudorange, then phase, Doppler, C/N0 and the half-cycle LLI bit are
 * compared. Galileo rows are empty there (code 1X has no column) and skipped.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseUbxPvt, parseUbxRawx } from '../src/ubx';
import { readRinex3Obs } from './helpers/rinex3-obs-oracle';

const FIX = join(__dirname, '..', 'test-fixtures');
const res = parseUbxRawx(
  new Uint8Array(readFileSync(join(FIX, 'f9p_rawx_slice.ubx')))
);
const oracle = readRinex3Obs(
  readFileSync(join(FIX, 'convbin', 'f9p_rawx.obs'), 'utf8')
);

describe('RXM-RAWX matches RTKLIB convbin row by row', () => {
  it('same five epochs, GPS time with the 5 ms receiver offset', () => {
    expect(oracle.epochs.map((e) => e.timeMs)).toEqual(
      res.epochs.map((e) => e.timeMs)
    );
    expect(oracle.epochs[0]!.timeMs).toBe(
      Date.UTC(2020, 11, 24, 21, 28, 42, 5)
    );
  });

  it('every oracle row is one of our measurements, to the print quantum', () => {
    let rows = 0;
    let phases = 0;
    oracle.epochs.forEach((ep, i) => {
      const meas = res.epochs[i]!.meas;
      for (const { prn, obs } of ep.rows) {
        const c = obs.get(prn[0] === 'C' ? 'C1I' : 'C1C');
        if (!c) continue; // Galileo (no 1C column) or no valid range
        const m = meas.find(
          (x) =>
            x.prn === prn && x.pr !== null && Math.abs(x.pr - c.value) < 6e-4
        );
        expect(m, `${prn} ${c.value}`).toBeDefined();
        const sfx = prn[0] === 'C' ? '1I' : '1C';
        const l = obs.get('L' + sfx);
        if (l) {
          expect(Math.abs(m!.cp! - l.value)).toBeLessThanOrEqual(5e-4 + 1e-6);
          // LLI bit 1 (2) = half-cycle unresolved; RTKLIB sets it when
          // trkStat bit 2 ("half cycle valid") is clear.
          expect((l.lli & 2) !== 0).toBe(m!.halfCycleAmbiguous);
          phases++;
        }
        // A blank phase with ours present: RTKLIB drops phases whose
        // cpStdev exceeds 5 (CPSTD_VALID), a quality cut we leave to users.
        const d = obs.get('D' + sfx)!;
        // RAWX doMes is Hz with RINEX sign; RTKLIB copies it unchanged.
        expect(Math.abs(m!.doppler - d.value)).toBeLessThanOrEqual(5e-4 + 1e-6);
        expect(obs.get('S' + sfx)!.value).toBe(m!.cn0);
        rows++;
      }
    });
    expect(rows).toBeGreaterThan(200);
    expect(phases).toBeGreaterThan(200);
  });

  it('Doppler sign: −dΦ/dt over 1 s equals the Doppler (RINEX convention)', () => {
    let n = 0;
    for (let i = 1; i < res.epochs.length; i++) {
      for (const b of res.epochs[i]!.meas) {
        const a = res.epochs[i - 1]!.meas.find(
          (x) => x.prn === b.prn && x.code === b.code
        );
        if (!a || a.cp === null || b.cp === null) continue;
        const rate = -(b.cp - a.cp);
        expect(Math.abs(rate - (a.doppler + b.doppler) / 2)).toBeLessThan(2);
        n++;
      }
    }
    expect(n).toBeGreaterThan(200);
  });
});

/* ------------------------------------------------------------------ */
/*  NAV-PVT field order, units, signs                                  */
/* ------------------------------------------------------------------ */

function ubxFrame(cls: number, id: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  out.set([0xb5, 0x62, cls, id, payload.length & 0xff, payload.length >> 8]);
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

describe('NAV-PVT conventions (M8 protocol §31.17.14)', () => {
  it('lon before lat, 1e-7 deg; height (ellipsoid) not hMSL, mm; signs kept', () => {
    // Southern + western hemisphere, distinct |lat| / |lon|, and an hMSL
    // that differs from the ellipsoidal height by a −22.345 m undulation, so
    // a swapped field, lost sign, wrong unit or MSL height all fail.
    const p = new Uint8Array(92);
    const v = new DataView(p.buffer);
    v.setUint32(0, 345600123, true); // iTOW ms
    v.setUint16(4, 2026, true);
    p.set([11, 11, 23, 59, 42], 6); // 2026-11-11 23:59:42 UTC
    p[20] = 3; // 3D
    p[21] = 0x01;
    p[23] = 17;
    v.setInt32(24, -581234567, true); // lon −58.1234567°
    v.setInt32(28, -345678901, true); // lat −34.5678901°
    v.setInt32(32, 12345, true); // height 12.345 m (ellipsoid)
    v.setInt32(36, 34690, true); // hMSL 34.690 m
    v.setUint32(40, 1234, true); // hAcc 1.234 m
    v.setUint32(44, 2345, true); // vAcc 2.345 m
    const r = parseUbxPvt(ubxFrame(0x01, 0x07, p)).records[0]!;
    expect(r.latDeg).toBeCloseTo(-34.5678901, 9);
    expect(r.lonDeg).toBeCloseTo(-58.1234567, 9);
    expect(r.heightM).toBeCloseTo(12.345, 9);
    expect(r.hAccuracyM).toBeCloseTo(1.234, 9);
    expect(r.vAccuracyM).toBeCloseTo(2.345, 9);
    expect(r.mode).toBe('standalone');
    // iTOW is GPS time: Thu 2026-11-12 00:00:00.123 GPS, week 2444.
    expect(r.week).toBe(2444);
    expect(r.timeMs).toBe(Date.UTC(2026, 10, 12, 0, 0, 0, 123));
    expect(r.tow).toBeCloseTo(345600.123, 6);
  });
});
