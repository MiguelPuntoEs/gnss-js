import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FRANCE_CC_ZONES,
  LAMBERT_93,
  franceCcZone,
  geodeticToLambertConformalConic,
  lambertConformalConicToGeodetic,
} from '../src/coordinates';

/*
 * Oracle: PROJ 9.8.1, RGF93 geographic (EPSG:4171) → Lambert-93
 * (EPSG:2154) for 39 points across France and Corsica, and → CC42–CC50
 * (EPSG:3942–3950) for those within 1.5° of each zone's latitude.
 */
const cases: {
  epsg: number;
  name: string;
  lat: number;
  lon: number;
  e: number;
  n: number;
}[] = JSON.parse(
  readFileSync(join(__dirname, '../test-fixtures/lambert_proj.json'), 'utf8')
);
const D2R = Math.PI / 180;

describe('Lambert conformal conic (France) vs PROJ', () => {
  const grids = [LAMBERT_93, ...FRANCE_CC_ZONES];

  it('covers EPSG:2154 and 3942–3950', () => {
    expect(new Set(cases.map((c) => c.epsg))).toEqual(
      new Set(grids.map((g) => g.epsg))
    );
  });

  it.each(grids.map((g) => [`${g.name} (EPSG:${g.epsg})`, g] as const))(
    '%s forward and inverse',
    (_n, g) => {
      const cs = cases.filter((c) => c.epsg === g.epsg);
      expect(cs.length).toBeGreaterThan(0);
      for (const c of cs) {
        const p = geodeticToLambertConformalConic(c.lat * D2R, c.lon * D2R, g);
        expect(Math.abs(p.easting - c.e)).toBeLessThan(1e-4);
        expect(Math.abs(p.northing - c.n)).toBeLessThan(1e-4);
        const q = lambertConformalConicToGeodetic(c.e, c.n, g);
        expect(Math.abs(q.lat / D2R - c.lat)).toBeLessThan(1e-9);
        expect(Math.abs(q.lon / D2R - c.lon)).toBeLessThan(1e-9);
      }
    }
  );

  it('picks the CC zone by latitude', () => {
    expect(franceCcZone(48.8566).name).toBe('CC49');
    expect(franceCcZone(43.2965).name).toBe('CC43');
    expect(franceCcZone(41.4).name).toBe('CC42');
    expect(franceCcZone(51.1).name).toBe('CC50');
  });
});
