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
