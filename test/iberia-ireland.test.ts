import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IRISH_TM,
  PORTUGAL_TM06,
  SPAIN_UTM_ZONES,
  geodeticToGrid,
  gridToGeodetic,
} from '../src/coordinates';

/*
 * Oracle: PROJ 9.8.1, ETRS89 (EPSG:4258) → ITM (EPSG:2157), PT-TM06
 * (EPSG:3763) and ETRS89 / UTM 29–31 (EPSG:25829–25831), 15 seeded points
 * each across the country.
 */
const cases: {
  epsg: number;
  lat: number;
  lon: number;
  e: number;
  n: number;
}[] = JSON.parse(
  readFileSync(
    join(__dirname, '../test-fixtures/iberia_ireland_proj.json'),
    'utf8'
  )
);
const D2R = Math.PI / 180;

describe('Ireland, Portugal and Spain grids vs PROJ', () => {
  it.each(
    [IRISH_TM, PORTUGAL_TM06, ...SPAIN_UTM_ZONES].map(
      (p) => [`${p.name} (EPSG:${p.epsg})`, p] as const
    )
  )('%s forward and inverse', (_n, p) => {
    const cs = cases.filter((c) => c.epsg === p.epsg);
    expect(cs.length).toBe(15);
    for (const c of cs) {
      const g = geodeticToGrid(c.lat * D2R, c.lon * D2R, p);
      expect(Math.abs(g.easting - c.e)).toBeLessThan(1e-4);
      expect(Math.abs(g.northing - c.n)).toBeLessThan(1e-4);
      const q = gridToGeodetic(c.e, c.n, p);
      expect(Math.abs(q.lat / D2R - c.lat)).toBeLessThan(1e-9);
      expect(Math.abs(q.lon / D2R - c.lon)).toBeLessThan(1e-9);
    }
  });
});
