import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseErp, writeErp, erpAt, type ErpRecord } from '../src/rinex/erp';

// Three centres' spellings of ERP version 2 (whole files, fetched
// 2026-11-13): IGS final week 2390 and ESA final day 2025/299 (BKG / ESA
// navigation office), CODE MGEX 3-day solution com22370 (BKG mgex/2237).
const fx = (f: string) =>
  readFileSync(join(__dirname, '..', 'test-fixtures', f), 'utf8');
const igsText = fx('IGS0OPSFIN_20252990000_07D_01D_ERP.ERP');
const esaText = fx('ESA0OPSFIN_20252990000_01D_01D_ERP.ERP');
const codText = fx('com22370.erp');

const lines = (t: string) =>
  t
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l !== '');

describe('writeErp — round trip', () => {
  for (const [name, t] of [
    ['IGS', igsText],
    ['ESA', esaText],
    ['CODE', codText],
  ] as const)
    it(`writes the ${name} file back line for line`, () => {
      // Only ESA's two trailing blank lines are not kept.
      const a = parseErp(t);
      expect(lines(writeErp(a))).toEqual(lines(t));
      expect(parseErp(writeErp(a))).toEqual(a);
    });

  it('writes bare records in the IGS layout', () => {
    const recs = parseErp(esaText).records;
    const out = writeErp(recs);
    expect(out.split('\n')[0]).toBe('version 2');
    const back = parseErp(out).records;
    // ESA's extra-less record comes back identical, in IGS column order.
    expect(back).toEqual(recs);
  });
});

describe('ERP — spec oracle (IGSMAIL-1943 fields and units)', () => {
  it('maps every centre’s column names to the same fields', () => {
    const igs = parseErp(igsText);
    expect(igs.columns.slice(0, 12)).toEqual(
      'MJD Xpole Ypole UT1-UTC LOD Xsig Ysig UTsig LODsig Nr Nf Nt'.split(' ')
    );
    // "60974.50   185147   322653    939046  -3277      3      3       0
    //  7   0  0  0   -1561   -487      11     11      0       0"
    expect(igs.records[0]).toEqual({
      mjd: 60974.5,
      xp: 0.185147,
      yp: 0.322653,
      ut1utc: 0.0939046,
      lod: -0.0003277,
      xpSigma: 3e-6,
      ypSigma: 3e-6,
      ut1Sigma: 0,
      lodSigma: 7e-7,
      nr: 0,
      nf: 0,
      nt: 0,
      xpRate: -0.001561,
      ypRate: -0.000487,
      xpRateSigma: 11e-6,
      ypRateSigma: 11e-6,
      extra: { dpsi: 0, deps: 0 },
    });
    const esa = parseErp(esaText).records[0]!;
    expect(esa).toMatchObject({
      mjd: 60974.5,
      xp: 0.185142,
      ut1utc: 0.0939075,
      lodSigma: 12e-7,
      nr: 187,
      nt: 114,
      ypRateSigma: 24e-6,
    });
    expect(esa.extra).toBeUndefined();
    const cod = parseErp(codText).records[1]!;
    expect(cod).toMatchObject({
      mjd: 59902.5,
      xp: 0.175556,
      ut1utc: -0.0166926,
      nr: 143,
      nf: 61,
      nt: 116,
      xpRateSigma: 8e-6,
    });
    // Correlations (E-2 in CODE's units line) stay as written.
    expect(cod.extra).toEqual({
      'C-XY': 1,
      'C-XT': 2,
      'C-YT': -11,
      DPSI: 0,
      DEPS: 0,
      'S-DP': 0,
      'S-DE': 0,
    });
  });

  it('agrees with IERS 20 C04 (independent series) to its noise', () => {
    // C04 (hpiers.obspm.fr eopc04.1962-now) at 0h UTC, x y ("), UT1−UTC
    // (s), LOD (s): 2025-10-27 (MJD 60975) and 2022-11-21 (MJD 59904).
    const c04: [string, number, number, number, number, number][] = [
      [igsText, 60975, 0.184392, 0.322426, 0.0941098, -0.0003306],
      [
        esaText,
        60974.5,
        (0.186061 + 0.184392) / 2,
        (0.322825 + 0.322426) / 2,
        (0.093769 + 0.0941098) / 2,
        -0.00032,
      ],
      [codText, 59904, 0.172509, 0.192678, -0.0178983, 0.0007898],
    ];
    for (const [t, mjd, x, y, dut, lod] of c04) {
      const e = erpAt(parseErp(t), mjd)!;
      // 1e-6" units: a 1e-5 reading would be 10× off (≈ 1.8").
      expect(Math.abs(e.xp - x)).toBeLessThan(150e-6);
      expect(Math.abs(e.yp - y)).toBeLessThan(150e-6);
      // 1e-7 s units: UT1 from GNSS drifts, ≲ 0.1 ms from C04.
      expect(Math.abs(e.ut1utc - dut)).toBeLessThan(1.5e-4);
      expect(Math.abs(e.lod - lod)).toBeLessThan(1e-4);
    }
  });
});

describe('ERP — convention locks', () => {
  const igs = parseErp(igsText);

  it('x and y are not swapped; pole rate sign matches the pole motion', () => {
    // Oct 2025: x ≈ 0.18″ falling, y ≈ 0.32″ (C04: −1.7 / −0.07 mas/day).
    const r = igs.records;
    expect(r[0]!.xp).toBeLessThan(r[0]!.yp);
    const dxdt = (r[6]!.xp - r[0]!.xp) / (r[6]!.mjd - r[0]!.mjd);
    expect(dxdt).toBeLessThan(0);
    expect(Math.abs(dxdt - r[3]!.xpRate!)).toBeLessThan(0.5e-3);
  });

  it('LOD is the UT1−UTC decrease per day (LOD = −d(UT1−UTC)/dt)', () => {
    const r = igs.records;
    for (let i = 1; i < r.length - 1; i++) {
      const d = -(r[i + 1]!.ut1utc - r[i - 1]!.ut1utc) / 2;
      expect(Math.abs(d - r[i]!.lod)).toBeLessThan(0.1e-3);
    }
  });

  it('erpAt interpolates linearly and refuses to extrapolate', () => {
    const r = igs.records;
    const mid = erpAt(igs, (r[0]!.mjd + r[1]!.mjd) / 2)!;
    expect(mid.xp).toBeCloseTo((r[0]!.xp + r[1]!.xp) / 2, 12);
    expect(mid.ut1utc).toBeCloseTo((r[0]!.ut1utc + r[1]!.ut1utc) / 2, 12);
    expect(erpAt(igs, r[0]!.mjd)!.yp).toBe(r[0]!.yp);
    expect(erpAt(igs, r[0]!.mjd - 0.01)).toBeNull();
    expect(erpAt(igs, r.at(-1)!.mjd + 0.01)).toBeNull();
  });

  it('erpAt keeps a leap second at 0h UTC', () => {
    // 2016-12-31/2017-01-01 (MJD 57754): UT1−UTC +0.4 s → −0.6 s.
    const rec = (mjd: number, ut1utc: number): ErpRecord => ({
      mjd,
      xp: 0.1,
      yp: 0.3,
      ut1utc,
      lod: 0.001,
      xpSigma: 0,
      ypSigma: 0,
      ut1Sigma: 0,
      lodSigma: 0,
      nr: 0,
      nf: 0,
      nt: 0,
    });
    const recs = [rec(57753.5, 0.4), rec(57754.5, -0.602)];
    expect(erpAt(recs, 57753.9)!.ut1utc).toBeCloseTo(0.4 - 0.4 * 0.002, 9);
    expect(erpAt(recs, 57754.1)!.ut1utc).toBeCloseTo(-0.6 - 0.6 * 0.002, 9);
  });

  it('refuses ERP version 1', () => {
    expect(() => parseErp('  MJD  X  Y\n50000.5 1 2\n')).toThrow(/version 2/);
  });
});
