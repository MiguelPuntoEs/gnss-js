import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseFinals2000A,
  parseEopC04,
  interpolateEop,
} from '../src/positioning/eop';
import {
  secularPole,
  wobble,
  solidPoleTideEnu,
  parseOceanPoleTideGrid,
  oceanPoleTideAt,
  oceanPoleTideEnu,
} from '../src/positioning/pole-tide';
import {
  parseAtmTideGrid,
  atmTideAt,
  atmosphericTideEnu,
} from '../src/positioning/atmospheric-tide-loading';

const fx = (f: string) => readFileSync(`test-fixtures/${f}`, 'utf8');
const D2R = Math.PI / 180;

describe('EOP series (IERS finals2000A, EOP 20 C04)', () => {
  const c04 = parseEopC04(fx('eop20c04-excerpt.txt'));
  const fin = parseFinals2000A(fx('finals2000a-excerpt.txt'));
  const finB = parseFinals2000A(fx('finals2000a-excerpt.txt'), {
    bulletinB: true,
  });

  it('reads the published 2024-01-08 values', () => {
    const a = c04.find((r) => r.mjd === 60317)!;
    expect(a.xp).toBe(0.123296);
    expect(a.yp).toBe(0.206642);
    expect(a.ut1Utc).toBe(0.0067475);
    const b = fin.find((r) => r.mjd === 60317)!;
    expect(b.xp).toBe(0.123321); // Bulletin A
    expect(b.yp).toBe(0.20662);
    expect(b.ut1Utc).toBe(0.0067901);
    // Bulletin B columns of finals2000A equal C04 (same IERS combination).
    const bb = finB.find((r) => r.mjd === 60317)!;
    expect(bb.xp).toBe(0.123296);
    expect(bb.yp).toBe(0.206642);
  });

  it('interpolates linearly at a GPS-scale instant', () => {
    // 2024-01-08 12:00 UTC = 12:00:18 GPS → halfway between MJD 60317, 60318.
    const t = Date.UTC(2024, 0, 8, 12) + 18_000;
    const e = interpolateEop(c04, t)!;
    expect(e.xp).toBeCloseTo((0.123296 + 0.121192) / 2, 9);
    expect(e.yp).toBeCloseTo((0.206642 + 0.206575) / 2, 9);
    expect(interpolateEop(c04, Date.UTC(2025, 0, 1))).toBeNull();
    // Rapid vs final agree to < 0.1 mas here (→ ≪ 0.01 mm of pole tide).
    const f = interpolateEop(fin, t)!;
    expect(Math.abs(f.xp - e.xp)).toBeLessThan(1e-4);
  });
});

describe('solid-earth pole tide (IERS 2010 7.1.4, 2018 secular pole)', () => {
  it('secular pole of eq. 21', () => {
    // 2024-01-01.5 (MJD 60310.5) — 24.0 years after J2000.
    const p = secularPole(51544.5 + 24 * 365.25);
    expect(p.xs * 1000).toBeCloseTo(55.0 + 1.677 * 24, 9);
    expect(p.ys * 1000).toBeCloseTo(320.5 + 3.46 * 24, 9);
  });

  it('coefficients follow from the Love numbers (eq. 24)', () => {
    // Sr = h2 ΔV/g with ΔV = −Ω²a²/2 sin2θ (m1 cosλ + m2 sinλ): at θ = 45°,
    // λ = 0, m1 = 1″ the radial is −h2 Ω² a² /(2g) · 1″ in radians.
    const h2 = 0.6207;
    const l2 = 0.0836;
    const omega = 7.292115e-5;
    const a = 6.378e6;
    const g = 9.80665;
    const as = D2R / 3600;
    const radial = ((-h2 * omega * omega * a * a) / (2 * g)) * as;
    const enu = solidPoleTideEnu(45 * D2R, 0, 1, 0);
    expect(enu[2]).toBeCloseTo(radial, 3); // −33 mm (rounded in eq. 26)
    // Sθ = l2/g ∂θΔV at θ = 0 (north pole, cos2θ = 1): −l2 Ω² a²/g · 1″.
    const south = ((-l2 * omega * omega * a * a) / g) * as;
    expect(-solidPoleTideEnu(90 * D2R, 0, 1, 0)[1]).toBeCloseTo(south, 3);
  });

  it('peaks at ~25 mm radial, ~7 mm horizontal for a 0.8″ wobble', () => {
    let up = 0;
    let hz = 0;
    for (let lat = -90; lat <= 90; lat += 5)
      for (let lon = 0; lon < 360; lon += 15) {
        const d = solidPoleTideEnu(
          lat * D2R,
          lon * D2R,
          0.8 * Math.SQRT1_2,
          0.8 * Math.SQRT1_2
        );
        up = Math.max(up, Math.abs(d[2]));
        hz = Math.max(hz, Math.hypot(d[0], d[1]));
      }
    expect(up * 1000).toBeCloseTo(26.4, 0);
    expect(hz * 1000).toBeGreaterThan(6.5);
    expect(hz * 1000).toBeLessThan(7.5);
  });

  it('WTZR on 2024-01-08 (C04 pole): a few mm, mostly Up', () => {
    const { m1, m2 } = wobble(0.123296, 0.206642, 60317);
    // m1 ≈ +27.9 mas, m2 ≈ +197 mas from the secular pole.
    expect(m1 * 1000).toBeCloseTo(123.296 - (55 + 1.677 * 24.0185), 0);
    const d = solidPoleTideEnu(49.144 * D2R, 12.879 * D2R, m1, m2);
    expect(Math.abs(d[2]) * 1000).toBeGreaterThan(1);
    expect(Math.abs(d[2]) * 1000).toBeLessThan(10);
  });
});

describe('ocean pole tide loading (IERS 2010 7.1.5, Desai 2002)', () => {
  const grid = parseOceanPoleTideGrid(fx('opole-excerpt.txt'));
  it('reads the IERS coefficient file and interpolates on the 0.5° nodes', () => {
    // The node at 12.75 E, 49.25 N, straight from the file.
    const line = fx('opole-excerpt.txt')
      .split('\n')
      .find((l) => /^\s+12\.75\s+49\.25\s/.test(l))!
      .trim()
      .split(/\s+/)
      .map(Number);
    const c = oceanPoleTideAt(grid, 49.25, 12.75);
    expect(c.re[0]).toBeCloseTo(line[2]!, 6);
    expect(c.im[0]).toBeCloseTo(line[3]!, 6);
    expect(c.re[1]).toBeCloseTo(line[4]!, 6);
    expect(c.re[2]).toBeCloseTo(line[6]!, 6);
  });
  it('is ≲ 2 mm radial for a 0.3″ wobble (IERS: typically ≤ 1.8, 0.5, 0.5 mm)', () => {
    const c = oceanPoleTideAt(grid, 49.144, 12.879);
    for (let a = 0; a < 360; a += 30) {
      const d = oceanPoleTideEnu(
        c,
        0.3 * Math.cos(a * D2R),
        0.3 * Math.sin(a * D2R)
      );
      expect(Math.abs(d[2])).toBeLessThan(0.002);
      expect(Math.abs(d[1])).toBeLessThan(0.0006);
      expect(Math.abs(d[0])).toBeLessThan(0.0006);
    }
  });
});

describe('S1/S2 atmospheric tide loading (IERS 2010 7.1.3)', () => {
  const grid = parseAtmTideGrid(fx('atm-tide-grid-excerpt.dat'));
  const sites: Record<string, [number, number]> = {
    WTZR: [49.1442, 12.8789],
    ONSA: [57.3953, 11.9255],
    POTS: [52.3793, 13.0661],
    BRUX: [50.7978, 4.3586],
    ABMF: [16.2623, -61.5275],
  };
  it("grid interpolation reproduces the VMF server's own station values", () => {
    // East of Greenwich only: the server's station file holds the values
    // near longitude 0.5° E for every western station (ABMF, ALGO, AREQ …
    // match the grid at lon ≈ 0.5°, not at their own longitude), so it is
    // not an oracle there.
    for (const line of fx('atm-tide-stations-excerpt.dat').trim().split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f[0] === 'ABMF') continue;
      const [lat, lon] = sites[f[0]!]!;
      const v = f.slice(1).map(Number);
      const c = atmTideAt(grid, lat, lon);
      // Station file: U, E, N blocks of S1c S1s S2c S2s S3c S3s (mm), as the grid.
      const got = [0, 1, 2].flatMap((comp) => {
        const h = (t: 's1' | 's2' | 's3') => [
          c[t]!.cos[comp]!,
          c[t]!.sin[comp]!,
        ];
        return [...h('s1'), ...h('s2'), ...h('s3')];
      });
      for (let k = 0; k < 18; k++)
        expect(
          Math.abs(got[k]! * 1000 - v[k]!),
          `${f[0]} col ${k}`
        ).toBeLessThan(0.03);
    }
  });
  it('S2 dominates in the tropics (~1.3 mm Up at ABMF), sub-mm in Europe', () => {
    const peak = (lat: number, lon: number) => {
      const c = atmTideAt(grid, lat, lon);
      let m = 0;
      for (let h = 0; h < 24; h += 0.25)
        m = Math.max(
          m,
          Math.abs(
            atmosphericTideEnu(c, Date.UTC(2024, 0, 8) + 18e3 + h * 3.6e6)[2]
          )
        );
      return m * 1000;
    };
    expect(peak(...sites.ABMF!)).toBeGreaterThan(1.2);
    expect(peak(...sites.ABMF!)).toBeLessThan(2.5);
    expect(peak(...sites.WTZR!)).toBeLessThan(1);
  });
});

describe('EOP from an IGS ERP file', () => {
  it('parseErp records feed interpolateEop directly', async () => {
    const { parseErp } = await import('../src/rinex/erp');
    const erp = parseErp(fx('IGS0OPSFIN_20252990000_07D_01D_ERP.ERP'));
    const r = erp.records[2]!;
    // ERP epochs are MJD (UTC); at exactly that MJD we get its pole.
    const t = (r.mjd - 40587) * 86_400_000 + 18_000;
    const e = interpolateEop(erp.records, t)!;
    expect(e.xp).toBeCloseTo(r.xp, 9);
    expect(e.yp).toBeCloseTo(r.yp, 9);
  });
});
