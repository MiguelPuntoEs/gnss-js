import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  etrs89ToOsgb,
  itrfToOsgb,
  osgbToEtrs89,
  osgbToItrf,
  transformFrame,
  type OstnGrid,
} from '../src/frames';
import { geodeticToEcef } from '../src/coordinates';

/*
 * Oracles:
 *  - os_ostn15_testpoints.json: Ordnance Survey's OSTN15/OSGM15 test points
 *    TP01–TP40 in both directions (OSTN15-OSGM15-DevelopersPack.zip, BSD,
 *    © Ordnance Survey Limited 2016, © Crown copyright and database rights
 *    Land & Property Services 2016, © Ordnance Survey Ireland 2016), with
 *    the 1 km grid nodes around each point from OSTN15_OSGM15_DataFile.txt.
 *  - etrf97_proj.json: PROJ 9.8.1, ITRF2020 (EPSG:9988) → ETRF97
 *    (EPSG:7928) through ITRF97.
 */
const FIX = join(__dirname, '../test-fixtures');
type Node = [number, number, number, number];
const fx: {
  forward: {
    id: string;
    lat: number;
    lon: number;
    h: number;
    e: number;
    n: number;
    H: number;
    flag: number;
  }[];
  inverse: { id: string; e: number; n: number; H: number; row: string[] }[];
  nodes: Record<string, Node>;
} = JSON.parse(readFileSync(join(FIX, 'os_ostn15_testpoints.json'), 'utf8'));

const grid: OstnGrid = (i, j) => fx.nodes[`${i},${j}`] ?? null;

describe('OSTN15/OSGM15 vs Ordnance Survey test points', () => {
  it('has TP01–TP40 both ways', () => {
    expect(fx.forward.length).toBe(40);
    expect(fx.inverse.length).toBe(40);
  });

  it.each(fx.forward.map((p) => [p.id, p] as const))(
    '%s ETRS89 → National Grid + height',
    (_id, p) => {
      const r = etrs89ToOsgb(p.lat, p.lon, p.h, grid);
      // OS gives mm.
      expect(Math.abs(r.easting - p.e)).toBeLessThanOrEqual(0.0006);
      expect(Math.abs(r.northing - p.n)).toBeLessThanOrEqual(0.0006);
      expect(Math.abs(r.H - p.H)).toBeLessThanOrEqual(0.0006);
      expect(r.datumFlag).toBe(p.flag);
    }
  );

  it.each(fx.inverse.map((p) => [p.id, p] as const))(
    '%s National Grid + height → ETRS89',
    (_id, p) => {
      const r = osgbToEtrs89(p.e, p.n, p.H, grid);
      // RESULT row: lat, lon (11 decimals), h (0.1 mm)
      expect(Math.abs(r.latDeg - Number(p.row[2]))).toBeLessThan(1e-9);
      expect(Math.abs(r.lonDeg - Number(p.row[3]))).toBeLessThan(1e-9);
      expect(Math.abs(r.h! - Number(p.row[4]))).toBeLessThanOrEqual(0.00006);
    }
  );

  it('refuses positions outside the grid', () => {
    expect(() => etrs89ToOsgb(40.4, -3.7, 0, grid)).toThrow(/outside/);
  });
});

describe('ETRF97 and the ITRF route', () => {
  const cases: {
    itrf: [number, number, number];
    epoch: number;
    out: [number, number, number];
  }[] = JSON.parse(readFileSync(join(FIX, 'etrf97_proj.json'), 'utf8'));

  it('matches PROJ through ITRF97', () => {
    for (const c of cases) {
      const got = transformFrame(c.itrf, 'ITRF2020', 'ETRF97', c.epoch);
      got.forEach((v, i) => expect(Math.abs(v - c.out[i]!)).toBeLessThan(2e-4));
    }
  });

  it('itrfToOsgb goes through ETRF97, and back', () => {
    const p = fx.forward[8]!; // TP09, London
    const etrf = geodeticToEcef(
      (p.lat * Math.PI) / 180,
      (p.lon * Math.PI) / 180,
      p.h
    );
    const itrf = transformFrame(etrf, 'ETRF97', 'ITRF2020', 2026.5);
    const r = itrfToOsgb(itrf, 'ITRF2020', 2026.5, grid);
    expect(Math.abs(r.easting - p.e)).toBeLessThan(1e-3);
    expect(Math.abs(r.H - p.H)).toBeLessThan(1e-3);
    const back = osgbToItrf(
      r.easting,
      r.northing,
      r.H,
      'ITRF2020',
      2026.5,
      grid
    );
    back.forEach((v, i) => expect(Math.abs(v - itrf[i]!)).toBeLessThan(1e-3));
  });
});
