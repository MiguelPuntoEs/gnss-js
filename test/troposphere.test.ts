import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  vmf3,
  saastamoinenZhd,
  parseGpt3Grid,
  gpt3,
  createGpt3Troposphere,
} from '../src/troposphere';
import { niellMapping } from '../src/positioning';

const FIX = join(__dirname, '..', 'test-fixtures');
const HAS_GRID = existsSync(join(FIX, 'gpt3_5.grd'));
const deg = Math.PI / 180;
// Wettzell (IGS WTZR).
const LAT = 49.1442 * deg;
const LON = 12.8789 * deg;
const H = 666;

describe('VMF3 mapping', () => {
  it('is 1 at the zenith and agrees with Niell to < 0.5 % at 10°', () => {
    const t = Date.UTC(2024, 0, 15);
    const z = vmf3(0.00121, 0.00058, t, LAT, LON, 0, 90 * deg);
    expect(z.mfh).toBeCloseTo(1, 6);
    expect(z.mfw).toBeCloseTo(1, 6);
    const v = vmf3(0.00121, 0.00058, t, LAT, LON, H, 10 * deg);
    const n = niellMapping(10 * deg, LAT, H, t);
    expect(Math.abs(v.mfh / n.mh - 1)).toBeLessThan(0.005);
    expect(Math.abs(v.mfw / n.mw - 1)).toBeLessThan(0.005);
  });

  it('Saastamoinen gives ~2.3 m at sea-level standard pressure', () => {
    expect(saastamoinenZhd(1013.25, 45 * deg, 0)).toBeCloseTo(2.307, 2);
  });
});

describe.skipIf(!HAS_GRID)('GPT3 (5° grid)', () => {
  const grid = HAS_GRID
    ? parseGpt3Grid(readFileSync(join(FIX, 'gpt3_5.grd'), 'utf8'))
    : null!;

  it('matches TU Wien gpt3_5_fast.py to 1e-10', () => {
    // [MJD, lat°, lon°, h (m), p (hPa), e (hPa), ah, aw, Gn_h (m)] from
    // vmf.geo.tuwien.ac.at/codes/Python_Tools_Adavi/gpt3_5_fast.py.
    const REF = [
      [
        60323.0, 49.144, 12.879, 666, 943.204320634429, 4.30756032066748,
        0.00120730081274304, 0.000526572240536587, -0.0002546530771665,
      ],
      [
        60323.25, -33.9, 18.4, 50, 1011.62676638869, 17.1256539104264,
        0.00126396701736688, 0.000537285046475919, 0.000228027134161268,
      ],
      [
        60450.5, 0.3, -78.5, 2800, 735.74988294577, 10.1237476689715,
        0.00127538335587018, 0.000623416055605011, 6.8053385024691e-6,
      ],
      [
        60600.75, 0.3, -78.5, 2800, 735.206107729953, 9.7320552688718,
        0.00127499011381588, 0.000616063851382941, 9.61480422062451e-6,
      ],
    ] as const;
    for (const [mjd, lat, lon, h, p, e, ah, aw, gn] of REF) {
      const r = gpt3(grid, (mjd - 40587) * 86_400_000, lat * deg, lon * deg, h);
      expect(r.p).toBeCloseTo(p, 9);
      expect(r.e).toBeCloseTo(e, 9);
      expect(r.ah).toBeCloseTo(ah, 15);
      expect(r.aw).toBeCloseTo(aw, 15);
      expect(r.Gn_h).toBeCloseTo(gn, 15);
    }
  });

  it('gives Wettzell a plausible climate', () => {
    const jan = gpt3(grid, Date.UTC(2024, 0, 15), LAT, LON, H);
    const jul = gpt3(grid, Date.UTC(2024, 6, 15), LAT, LON, H);
    expect(jan.p).toBeGreaterThan(930);
    expect(jan.p).toBeLessThan(955);
    expect(jan.T).toBeLessThan(jul.T); // winter colder
    expect(jul.T - jan.T).toBeGreaterThan(10);
    expect(jul.e).toBeGreaterThan(jan.e); // more water vapour in summer
    expect(jan.ah).toBeGreaterThan(0.0011);
    expect(jan.ah).toBeLessThan(0.0013);
  });

  it('feeds the PPP engine a ZHD near 2.15 m and finite mappings', () => {
    const m = createGpt3Troposphere(grid).delays(
      Date.UTC(2024, 0, 15),
      LAT,
      LON,
      H,
      30 * deg,
      0
    );
    expect(m.zhd).toBeGreaterThan(2.1);
    expect(m.zhd).toBeLessThan(2.2);
    expect(m.mh).toBeGreaterThan(1.9);
    expect(m.mh).toBeLessThan(2.1);
    expect(Math.abs(m.gradient)).toBeLessThan(0.01);
  });
});
