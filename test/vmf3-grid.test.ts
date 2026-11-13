/**
 * Gridded and site-wise VMF3 (TU Wien VMF Data Server, VMF3_OP, CC BY 4.0,
 * based on ECMWF operational analyses). The fixtures are 2024-01-14 00/06 UTC
 * 1°×1° grids cropped to central Europe, the matching orography crop, and the
 * site-wise lines of ten EPN/IGS stations for that day.
 *
 * Oracle: TU Wien's site-wise values are ray-traced at the stations
 * themselves; the grid interpolated + height-reduced to the same positions
 * (TU Wien's gnss.ell) must agree with them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseVmf3Grid,
  parseVmf3Orography,
  parseVmf3Sitewise,
  vmf3GridAt,
  vmf3GridCovers,
  vmf3GridEpochsFor,
  vmf3GridUrl,
  vmf3SitewiseUrl,
  reduceVmf3Delays,
  createVmf3GridTroposphere,
  createVmf3SiteTroposphere,
} from '../src/troposphere';

const FIX = join(__dirname, '..', 'test-fixtures');
const read = (f: string) => readFileSync(join(FIX, f), 'utf8');
const deg = Math.PI / 180;
const T0 = Date.UTC(2024, 0, 14);
const H6 = 6 * 3_600_000;

const epochs = [
  parseVmf3Grid(read('vmf3_1x1_20240114_H00_europe.txt')),
  parseVmf3Grid(read('vmf3_1x1_20240114_H06_europe.txt')),
];
const oro = parseVmf3Orography(read('vmf3_orography_ell_1x1_europe.txt'));
const site = parseVmf3Sitewise(read('vmf3_sitewise_2024014_slice.vmf3_g'));

/** TU Wien gnss.ell: latitude, longitude (deg), ellipsoidal height (m). */
const STATIONS: Record<string, [number, number, number]> = {
  GOPE: [49.9137, 14.7856, 592.6],
  JOZE: [52.0973, 21.0315, 141.4],
  MATE: [40.6491, 16.7045, 535.6],
  ONSA: [57.3953, 11.9255, 45.5],
  POTS: [52.3793, 13.0661, 144.4],
  TLSE: [43.5607, 1.4809, 207.2],
  WTZR: [49.1442, 12.8789, 666.0],
  ZIMM: [46.8771, 7.4653, 956.4],
};

describe('VMF3 grid files', () => {
  it('parses the header, layout and epoch', () => {
    const g = epochs[0]!;
    expect(g.timeMs).toBe(T0);
    expect(epochs[1]!.timeMs).toBe(T0 + H6);
    expect([g.nLat, g.nLon, g.lat0, g.lon0]).toEqual([26, 31, 65.5, 0.5]);
    expect(oro.length).toBe(26 * 31);
    // First data line of the crop: 65.5 0.5 0.00118722 …
    expect(g.zhd[0]).toBeGreaterThan(2.2);
    expect(g.ah[0]).toBeGreaterThan(0.0011);
  });

  it('names the files and the epochs a day needs', () => {
    const e = vmf3GridEpochsFor(T0, T0 + 86_370_000);
    expect(e).toEqual([0, 1, 2, 3, 4].map((i) => T0 + i * H6));
    expect(vmf3GridUrl(T0 + 3 * H6)).toBe(
      'https://vmf.geo.tuwien.ac.at/trop_products/GRID/1x1/VMF3/VMF3_OP/2024/VMF3_20240114.H18'
    );
    expect(vmf3SitewiseUrl(T0 + 5000)).toMatch(/daily\/2024\/2024014\.vmf3_g$/);
    expect(vmf3GridCovers(epochs, T0, T0 + H6)).toBe(true);
    expect(vmf3GridCovers(epochs, T0, T0 + H6 + 1)).toBe(false);
  });

  it('reduces delays with height (Kouba 2008)', () => {
    const same = reduceVmf3Delays(2.2, 0.1, 47 * deg, 500, 500);
    expect(same.zhd).toBeCloseTo(2.2, 9);
    expect(same.zwd).toBeCloseTo(0.1, 9);
    const up = reduceVmf3Delays(2.2, 0.1, 47 * deg, 500, 600);
    // ~0.26 mm of ZHD per metre near 500 m; ZWD × e^(−0.05).
    expect((2.2 - up.zhd) * 1000).toBeGreaterThan(24);
    expect((2.2 - up.zhd) * 1000).toBeLessThan(28);
    expect(up.zwd).toBeCloseTo(0.1 * Math.exp(-0.05), 9);
  });

  it('matches TU Wien site-wise VMF3 at eight EPN stations', () => {
    const dz: number[] = [];
    const dw: number[] = [];
    for (const [id, [lat, lon, h]] of Object.entries(STATIONS)) {
      for (const r of site.get(id)!.filter((x) => x.timeMs <= T0 + H6)) {
        const v = vmf3GridAt(epochs, oro, r.timeMs, lat * deg, lon * deg, h);
        dz.push(v.zhd - r.zhd);
        dw.push(v.zwd - r.zwd);
        expect(Math.abs(v.zhd - r.zhd)).toBeLessThan(0.01);
        expect(Math.abs(v.zwd - r.zwd)).toBeLessThan(0.015);
        expect(Math.abs(v.ah - r.ah)).toBeLessThan(3e-5);
        // aw varies with the moisture field (ZIMM 06 UTC: 0.22e-3 site-wise);
        // it scales only the small wet delay.
        expect(Math.abs(v.aw - r.aw)).toBeLessThan(3e-4);
      }
    }
    expect(dz.length).toBe(16);
    const rms = (a: number[]) =>
      Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
    expect(rms(dz)).toBeLessThan(0.004);
    expect(rms(dw)).toBeLessThan(0.006);
  });

  it('interpolates linearly in time between the 6-hourly epochs', () => {
    const [lat, lon, h] = STATIONS.WTZR!;
    const a = vmf3GridAt(epochs, oro, T0, lat * deg, lon * deg, h);
    const b = vmf3GridAt(epochs, oro, T0 + H6, lat * deg, lon * deg, h);
    const m = vmf3GridAt(epochs, oro, T0 + H6 / 2, lat * deg, lon * deg, h);
    expect(m.zhd).toBeCloseTo((a.zhd + b.zhd) / 2, 10);
    expect(m.aw).toBeCloseTo((a.aw + b.aw) / 2, 12);
  });

  it('gives the PPP engine a zenith delay with unit mapping', () => {
    const [lat, lon, h] = STATIONS.WTZR!;
    const m = createVmf3GridTroposphere({ epochs, orography: oro });
    const z = m.delays(T0, lat * deg, lon * deg, h, 90 * deg, 0);
    expect(z.zhd).toBeCloseTo(2.1458, 2); // site-wise WTZR 00 UTC
    expect(z.mh).toBeCloseTo(1, 6);
    expect(z.mw).toBeCloseTo(1, 6);
    const low = m.delays(T0, lat * deg, lon * deg, h, 5 * deg, 0);
    expect(low.mh).toBeGreaterThan(9.5);
    expect(low.mh).toBeLessThan(11);
  });

  it('site-wise model uses the ray-traced values directly', () => {
    const [lat, lon, h] = STATIONS.ONSA!;
    const m = createVmf3SiteTroposphere(site.get('ONSA')!);
    const z = m.delays(T0 + H6, lat * deg, lon * deg, h, 90 * deg, 0);
    expect(z.zhd).toBeCloseTo(2.2663, 4);
    expect(z.mw).toBeCloseTo(1, 6);
  });
});

describe('PPP elevation weighting', () => {
  it('scales the zenith variance as documented', async () => {
    const { elevationVarianceFactor } = await import('../src/positioning');
    const e = (d: number) => d * deg;
    expect(elevationVarianceFactor(e(90))).toBeCloseTo(1, 12);
    expect(elevationVarianceFactor(e(30))).toBeCloseTo(4, 9);
    // Default floors sin e at 0.1; 'sin2-full' does not.
    expect(elevationVarianceFactor(e(3))).toBeCloseTo(100, 9);
    expect(elevationVarianceFactor(e(3), 'sin2-full')).toBeCloseTo(
      1 / Math.sin(e(3)) ** 2,
      9
    );
    expect(elevationVarianceFactor(e(30), 'sin')).toBeCloseTo(2, 9);
    expect(elevationVarianceFactor(e(30), 'rtklib')).toBeCloseTo(2.5, 9);
  });
});
