/**
 * NovAtel OEM binary against RTKLIB convbin and the OEM7 Commands and Logs
 * Reference Manual v5 (RANGE §3.158, RANGECMP §3.159, BESTPOS §3.22,
 * Table 95 position type, Table 182 channel tracking status, Table 183
 * RINEX mappings).
 *
 * Oracles: test-fixtures/convbin/oem719_base.obs (OEM719 RANGE, WHU) and
 * oemv_rangecmp.obs (OEMV RANGECMP, 2009). RTKLIB 2.4.2 differs from the
 * manual in two documented places, both mapped here:
 *  - GPS/QZSS L2C(M) (signal type 17) is written "2X"; Table 183 says C2S.
 *  - The full 16-bit GPS week in the header is pushed through RTKLIB's
 *    `adjgpsweek` as if it were mod 1024, so 2009 data lands 1024 weeks
 *    later (2029). The header week is not truncated (Table 4).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseNovatelPvt, parseNovatelRange } from '../src/novatel';
import { geodeticToEcef } from '../src/coordinates/ecef';
import { compareWithOracle, readRinex3Obs } from './helpers/rinex3-obs-oracle';

const FIX = join(__dirname, '..', 'test-fixtures');
const load = (f: string) => new Uint8Array(readFileSync(join(FIX, f)));
const oracle = (f: string) =>
  readRinex3Obs(readFileSync(join(FIX, 'convbin', f), 'utf8'));
const WEEK_MS = 7 * 86_400_000;

describe('RANGE (OEM719) matches RTKLIB convbin', () => {
  const res = parseNovatelRange(load('oem719_rtk_base.gps'));
  const o = oracle('oem719_base.obs');

  it('agrees on every value; L2C(M) is 2S per Table 183 (RTKLIB: 2X)', () => {
    expect(o.epochs).toHaveLength(10);
    expect(o.epochs[0]!.timeMs).toBe(Date.UTC(2025, 2, 26, 3, 55, 0));
    const r = compareWithOracle(o, res.epochs, (prn, code) =>
      'GJ'.includes(prn[0]!) && code === '2X' ? '2S' : code
    );
    for (const k of ['C', 'L', 'D', 'S'] as const) {
      expect(r[k].missing, k).toEqual([]);
      expect(r[k].n, k).toBe(680);
    }
    expect(r.C.maxDiff).toBeLessThanOrEqual(5e-4 + 1e-6);
    expect(r.L.maxDiff).toBeLessThanOrEqual(5e-4 + 1e-6);
    expect(r.D.maxDiff).toBeLessThanOrEqual(5e-4 + 1e-6);
    // RTKLIB keeps C/N0 in 0.25 dB-Hz steps.
    expect(r.S.maxDiff).toBeLessThan(0.25);
  });

  it('every signal code is the Table 183 RINEX code for its system', () => {
    const TABLE_183: Record<string, string[]> = {
      G: ['1C', '1L', '2S', '2P', '2W', '5Q'],
      R: ['1C', '2C', '2P', '3Q'],
      E: ['1C', '5Q', '7Q', '8Q', '6B', '6C'],
      S: ['1C', '5I'],
      J: ['1C', '1L', '2S', '5Q', '6L', '6S'],
      C: ['2I', '1P', '7I', '5P', '7D', '6I'],
      I: ['5A'],
    };
    for (const [sys, codes] of Object.entries(res.obsCodes)) {
      for (const c of codes) expect(TABLE_183[sys], sys + c).toContain(c);
    }
    expect(res.obsCodes['G']).toContain('2S');
    expect(res.obsCodes['G']).toContain('2W'); // L2P(Y) semi-codeless
  });

  it('Doppler sign: −dΦ/dt over 1 s equals the Doppler', () => {
    let n = 0;
    for (let i = 1; i < 20; i++) {
      const a = res.epochs[i - 1]!;
      const b = res.epochs[i]!;
      if (b.timeMs - a.timeMs !== 1000) continue;
      for (const mb of b.meas) {
        const ma = a.meas.find((x) => x.prn === mb.prn && x.code === mb.code);
        if (!ma || ma.cp === null || mb.cp === null) continue;
        if (ma.doppler === null || mb.doppler === null) continue;
        const rate = -(mb.cp - ma.cp);
        expect(Math.abs(rate - (ma.doppler + mb.doppler) / 2)).toBeLessThan(5);
        n++;
      }
    }
    expect(n).toBeGreaterThan(500);
  });
});

describe('RANGECMP (OEMV, 2009) matches RTKLIB convbin', () => {
  const res = parseNovatelRange(load('oemv_rangecmp.gps'));
  const o = oracle('oemv_rangecmp.obs');

  it('keeps the full header week: RTKLIB is exactly 1024 weeks late', () => {
    expect(res.epochs[0]!.timeMs).toBe(Date.UTC(2009, 11, 18, 23, 7, 0));
    expect(o.epochs[0]!.timeMs - res.epochs[0]!.timeMs).toBe(1024 * WEEK_MS);
  });

  it('agrees on every value incl. the reconstructed RANGECMP phase', () => {
    for (const e of o.epochs) e.timeMs -= 1024 * WEEK_MS;
    const r = compareWithOracle(o, res.epochs);
    for (const k of ['C', 'L', 'D', 'S'] as const) {
      expect(r[k].missing, k).toEqual([]);
      expect(r[k].n, k).toBeGreaterThan(150);
    }
    expect(r.C.maxDiff).toBeLessThanOrEqual(5e-4 + 1e-6);
    expect(r.L.maxDiff).toBeLessThanOrEqual(5e-4 + 1e-6);
    expect(r.D.maxDiff).toBeLessThanOrEqual(5e-4 + 1e-6);
    expect(r.S.maxDiff).toBe(0); // RANGECMP C/N0 is whole dB-Hz
  });
});

describe('BESTPOS conventions (OEM7 §3.22)', () => {
  const pvt = parseNovatelPvt(load('oem719_rtk_base.gps'));

  it('height = MSL height + undulation (geoid above ellipsoid, here −14.4 m)', () => {
    // The WHU base is a FIXEDPOS station: lat 30.5429677°, lon 114.3555051°,
    // MSL 47.860 m, undulation −14.400 m. The ellipsoidal height must be
    // 33.460 m: with the undulation sign flipped it would be 62.26 m.
    expect(pvt.records).toHaveLength(150);
    const r = pvt.records[0]!;
    expect(r.mode).toBe('fixed-location');
    expect(r.latDeg).toBeCloseTo(30.5429677, 7);
    expect(r.lonDeg).toBeCloseTo(114.3555051, 7);
    expect(r.heightM).toBeCloseTo(33.46, 3);
  });

  it('lands on the base coordinates the RTK test verifies against WHU truth', () => {
    // test/rtk.test.ts fixes this base and resolves the rover to the WHU
    // repository's independent reference at the centimetre level — so the
    // base ECEF below is itself checked by an outside source.
    const WHU_BASE = [-2267335.669351269, 5008649.155499206, 3222374.973582075];
    const r = pvt.records[0]!;
    const ecef = geodeticToEcef(
      (r.latDeg! * Math.PI) / 180,
      (r.lonDeg! * Math.PI) / 180,
      r.heightM!
    );
    ecef.forEach((v, i) => expect(v).toBeCloseTo(WHU_BASE[i]!, 3));
  });

  it('GPS week + ms of week from the header (no rollover)', () => {
    const r = pvt.records[0]!;
    expect(r.week).toBe(2359);
    expect(r.timeMs).toBe(Date.UTC(2025, 2, 26, 3, 55, 0));
  });
});
