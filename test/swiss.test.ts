import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LV95,
  etrs89ToLv95,
  geodeticToSwissObliqueMercator,
  lv95ToEtrs89,
  swissObliqueMercatorToGeodetic,
} from '../src/coordinates';
import { transformFrame } from '../src/frames';

/*
 * Oracle: PROJ 9.8.1 — ETRS89 3D (EPSG:4937) → CH1903+ / LV95 (EPSG:2056)
 * through EPSG:1647 inverse, keeping the height through the shift (37
 * points, 200–4000 m); CH1903+ geographic (EPSG:4150) → LV95 for the
 * projection alone; ITRF2020 → ETRF89 (EPSG:7914) through ITRF89.
 */
type V3 = [number, number, number];
const fx: {
  full: {
    name: string;
    lat: number;
    lon: number;
    h: number;
    e: number;
    n: number;
  }[];
  projection: { lat: number; lon: number; e: number; n: number }[];
  etrf89: { itrf: V3; epoch: number; out: V3 }[];
} = JSON.parse(
  readFileSync(join(__dirname, '../test-fixtures/swiss_proj.json'), 'utf8')
);
const D2R = Math.PI / 180;

describe('Swiss oblique Mercator and LV95 vs PROJ', () => {
  it('is (2 600 000, 1 200 000) at Bern', () => {
    const g = geodeticToSwissObliqueMercator(
      LV95.lat0 * D2R,
      LV95.lon0 * D2R,
      LV95
    );
    expect(g.easting).toBeCloseTo(2600000, 6);
    expect(g.northing).toBeCloseTo(1200000, 6);
  });

  it('projects as PROJ somerc, both ways', () => {
    for (const c of fx.projection) {
      const g = geodeticToSwissObliqueMercator(c.lat * D2R, c.lon * D2R, LV95);
      expect(Math.abs(g.easting - c.e)).toBeLessThan(1e-4);
      expect(Math.abs(g.northing - c.n)).toBeLessThan(1e-4);
      const q = swissObliqueMercatorToGeodetic(c.e, c.n, LV95);
      expect(Math.abs(q.lat / D2R - c.lat)).toBeLessThan(1e-9);
      expect(Math.abs(q.lon / D2R - c.lon)).toBeLessThan(1e-9);
    }
  });

  it.each(fx.full.map((c) => [c.name, c] as const))(
    '%s: ETRS89 → LV95 and back',
    (_n, c) => {
      const g = etrs89ToLv95(c.lat, c.lon, c.h);
      expect(Math.abs(g.easting - c.e)).toBeLessThan(1e-3);
      expect(Math.abs(g.northing - c.n)).toBeLessThan(1e-3);
      const q = lv95ToEtrs89(c.e, c.n, c.h);
      expect(Math.abs(q.latDeg - c.lat)).toBeLessThan(1e-8);
      expect(Math.abs(q.lonDeg - c.lon)).toBeLessThan(1e-8);
    }
  );

  it('reaches ETRF89 through ITRF89', () => {
    for (const c of fx.etrf89) {
      const got = transformFrame(c.itrf, 'ITRF2020', 'ETRF89', c.epoch);
      got.forEach((v, i) => expect(Math.abs(v - c.out[i]!)).toBeLessThan(2e-4));
    }
  });
});
