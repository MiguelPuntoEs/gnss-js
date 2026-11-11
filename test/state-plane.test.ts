import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BELGIAN_LAMBERT_2008,
  POLAND_CS2000_ZONES,
  POLAND_CS92,
  US_STATE_PLANE_ZONES,
  geodeticToGrid,
  gridToGeodetic,
  isConicProjection,
  statePlaneZoneAt,
  type MapProjection,
} from '../src/coordinates';

/*
 * Oracle: PROJ 9.8.1 — NAD83(2011) geographic (EPSG:6318) → each SPCS83
 * metre zone (6 seeded points inside each EPSG area of use), and ETRS89
 * (EPSG:4258) → Belgian Lambert 2008 (EPSG:3812), PL-1992 (2180) and
 * PL-2000 zones (2176–2179).
 */
const cases: {
  epsg: number;
  lat: number;
  lon: number;
  e: number;
  n: number;
}[] = JSON.parse(
  readFileSync(
    join(__dirname, '../test-fixtures/state_plane_be_pl_proj.json'),
    'utf8'
  )
);
const D2R = Math.PI / 180;
const ALL: MapProjection[] = [
  ...US_STATE_PLANE_ZONES,
  BELGIAN_LAMBERT_2008,
  POLAND_CS92,
  ...POLAND_CS2000_ZONES,
];

describe('State Plane, Belgium and Poland vs PROJ', () => {
  it('has 117 SPCS83 zones, each with oracle points', () => {
    expect(US_STATE_PLANE_ZONES.length).toBe(117);
    expect(new Set(cases.map((c) => c.epsg))).toEqual(
      new Set(ALL.map((p) => p.epsg))
    );
  });

  it('matches PROJ to 0.1 mm, both ways, on every zone', () => {
    let worst = 0;
    for (const p of ALL) {
      for (const c of cases.filter((x) => x.epsg === p.epsg)) {
        const g = geodeticToGrid(c.lat * D2R, c.lon * D2R, p);
        worst = Math.max(
          worst,
          Math.abs(g.easting - c.e),
          Math.abs(g.northing - c.n)
        );
        const q = gridToGeodetic(c.e, c.n, p);
        expect(Math.abs(q.lat / D2R - c.lat)).toBeLessThan(1e-9);
        expect(Math.abs(q.lon / D2R - c.lon)).toBeLessThan(1e-9);
      }
    }
    expect(worst).toBeLessThan(1e-4);
  });

  it('tells the projection kinds apart', () => {
    expect(isConicProjection(BELGIAN_LAMBERT_2008)).toBe(true);
    expect(isConicProjection(POLAND_CS92)).toBe(false);
  });

  it('picks the State Plane zone for a point', () => {
    expect(statePlaneZoneAt(40.7128, -74.006)?.name).toBe(
      'New York Long Island'
    );
    expect(statePlaneZoneAt(34.0522, -118.2437)?.name).toBe(
      'California zone 5'
    );
    expect(statePlaneZoneAt(29.7604, -95.3698)?.name).toBe(
      'Texas South Central'
    );
    expect(statePlaneZoneAt(51.88, -176.65)?.name).toBe('Alaska zone 10'); // Adak
    expect(statePlaneZoneAt(52.9, 173.2)?.name).toBe('Alaska zone 10'); // Attu
    // Hawaii is on NAD83(PA11), not in this table.
    expect(statePlaneZoneAt(21.3069, -157.8583)).toBeUndefined();
    expect(statePlaneZoneAt(48.85, 2.35)).toBeUndefined();
  });
});
