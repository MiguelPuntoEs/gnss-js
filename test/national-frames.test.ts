import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANADA_MTM_ZONES,
  CANADA_UTM_ZONES,
  DENMARK_DKTM_ZONES,
  DENMARK_UTM_ZONES,
  FINLAND_GK_ZONES,
  MGA2020_ZONES,
  MGA94_ZONES,
  NORWAY_NTM_ZONES,
  NORWAY_UTM_ZONES,
  TM35FIN,
  geodeticToTransverseMercator,
  nearestZone,
  transverseMercatorToGeodetic,
} from '../src/coordinates';
import {
  geocentricShiftGridModel,
  itrfToNkg,
  nkgToItrf,
  transformFrame,
  velocityGridModel,
  type NkgFrame,
  type NkgModels,
  type ReferenceFrame,
} from '../src/frames';

/*
 * Oracles from PROJ 9.8.1 (pyproj 3.8.0), made by a scratch script:
 *  - national_frames_proj.json: ITRF2020 (EPSG:9988) / ITRF2014
 *    (EPSG:7789) → EUREF-FIN (10688), ETRS89-NOR [EUREF89] (10873),
 *    ETRS89-DNK (10890), GDA2020 (7842), GDA94 (4938), NAD83(CSRS)v8
 *    (10412), geocentric, PROJ's best operation (NKG2020 pipelines with
 *    the full grids), towns + seeded random points, three epochs.
 *  - national_grids_proj.json: each grid's geographic CRS → the grid, for
 *    the country's points within 6° of the central meridian.
 *  - nkg_rf17vel_nordic.i16: NKG_RF17vel (CC-BY 4.0) cropped to
 *    72°N–54°N × 4°E–32°E: planes E, N, U of 217 × 169 int16 LE in
 *    0.001 mm/yr, rows from the north (10′ × 5′).
 *  - no_kv_shift_x4.i16: Kartverket's NKG_ETRF14 → EUREF89 geocentric
 *    shift grid, every 4th node (0.16° × 0.08°, 185 × 180 from 71.78°N,
 *    4°E): planes X, Y, Z int16 LE in 0.01 mm. PROJ uses the full grid,
 *    so Norway gets a looser tolerance.
 */
const FIX = join(__dirname, '../test-fixtures');
const D2R = Math.PI / 180;

function planes(file: string, n: number, scale: number) {
  const b = readFileSync(join(FIX, file));
  const all = new Int16Array(b.buffer, b.byteOffset, b.byteLength / 2);
  expect(all.length).toBe(3 * n);
  return [0, 1, 2].map((k) =>
    Float64Array.from(all.subarray(k * n, (k + 1) * n), (v) => v * scale)
  );
}

const [ve, vn, vu] = planes('nkg_rf17vel_nordic.i16', 217 * 169, 1e-3);
const [sx, sy, sz] = planes('no_kv_shift_x4.i16', 185 * 180, 1e-5);
const models: NkgModels = {
  velocity: velocityGridModel({
    latNorth: 72,
    lonWest: 4,
    dLat: 1 / 12,
    dLon: 1 / 6,
    rows: 217,
    cols: 169,
    east: ve!,
    north: vn!,
    up: vu!,
  }),
  norway: geocentricShiftGridModel({
    latNorth: 71.78,
    lonWest: 4,
    dLat: 0.08,
    dLon: 0.16,
    rows: 185,
    cols: 180,
    x: sx!,
    y: sy!,
    z: sz!,
  }),
};

type V3 = [number, number, number];
const frameCases: {
  to: string;
  frame: ReferenceFrame;
  name: string;
  epoch: number;
  itrf: V3;
  out: V3;
}[] = JSON.parse(readFileSync(join(FIX, 'national_frames_proj.json'), 'utf8'));

const NKG: NkgFrame[] = ['EUREF-FIN', 'EUREF89', 'ETRS89-DNK'];
const dist = (a: V3, b: V3) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('NKG2020 national frames vs PROJ', () => {
  it.each(NKG)('%s forward and back', (to) => {
    const cases = frameCases.filter((c) => c.to === to);
    expect(cases.length).toBeGreaterThan(60);
    // Norway's shift grid is thinned 4× here (PROJ: full grid).
    const tol = to === 'EUREF89' ? 1.5e-3 : 2e-4;
    let worst = 0;
    for (const c of cases) {
      const got = itrfToNkg(c.itrf, c.frame, c.epoch, to, models);
      worst = Math.max(worst, dist(got, c.out));
      const back = nkgToItrf(c.out, to, c.frame, c.epoch, models);
      expect(dist(back, c.itrf)).toBeLessThan(tol);
    }
    expect(worst).toBeLessThan(tol);
  });

  it('needs the shift grid for Norway', () => {
    const c = frameCases.find((x) => x.to === 'EUREF89')!;
    expect(() =>
      itrfToNkg(c.itrf, c.frame, c.epoch, 'EUREF89', {
        velocity: models.velocity,
      })
    ).toThrow(/shift grid/);
  });

  it('throws outside the models', () => {
    // Madrid
    expect(() =>
      itrfToNkg(
        [4849202, -360329, 4114913],
        'ITRF2020',
        2026,
        'EUREF-FIN',
        models
      )
    ).toThrow(/outside/);
  });
});

describe('GDA2020, GDA94 and NAD83(CSRS) vs PROJ', () => {
  it.each(['GDA2020', 'GDA94', 'NAD83(CSRS)'] as const)('%s', (to) => {
    const cases = frameCases.filter((c) => c.to === to);
    expect(cases.length).toBeGreaterThan(60);
    for (const c of cases) {
      const got = transformFrame(c.itrf, c.frame, to, c.epoch);
      expect(dist(got, c.out)).toBeLessThan(2e-4);
      const back = transformFrame(c.out, to, c.frame, c.epoch);
      expect(dist(back, c.itrf)).toBeLessThan(2e-4);
    }
  });

  it('NAD83(CSRS) is NAD83(2011)', () => {
    const p: V3 = [918129.6, -4346071.3, 4561977.8];
    const a = transformFrame(p, 'ITRF2020', 'NAD83(CSRS)', 2026.5);
    const b = transformFrame(p, 'ITRF2020', 'NAD83(2011)', 2026.5);
    expect(dist(a, b)).toBeLessThan(1e-4);
  });
});

const gridCases: {
  epsg: number;
  name: string;
  lat: number;
  lon: number;
  e: number;
  n: number;
}[] = JSON.parse(readFileSync(join(FIX, 'national_grids_proj.json'), 'utf8'));

const GRIDS = [
  TM35FIN,
  ...FINLAND_GK_ZONES,
  ...NORWAY_UTM_ZONES,
  ...NORWAY_NTM_ZONES,
  ...DENMARK_UTM_ZONES,
  ...DENMARK_DKTM_ZONES,
  ...MGA2020_ZONES,
  ...MGA94_ZONES,
  ...CANADA_UTM_ZONES,
  ...CANADA_MTM_ZONES,
];

describe('national grids (Krüger) vs PROJ', () => {
  it('has one grid per oracle EPSG code, and no duplicates', () => {
    const codes = new Set(gridCases.map((c) => c.epsg));
    // 25832/25833 appear for both Norway and Denmark.
    expect(new Set(GRIDS.map((g) => g.epsg))).toEqual(codes);
  });

  it.each(GRIDS.map((g) => [`${g.name} (EPSG:${g.epsg})`, g] as const))(
    '%s forward and inverse',
    (_name, g) => {
      const cases = gridCases.filter((c) => c.epsg === g.epsg);
      expect(cases.length).toBeGreaterThan(0);
      for (const c of cases) {
        const p = geodeticToTransverseMercator(c.lat * D2R, c.lon * D2R, g);
        expect(Math.abs(p.easting - c.e)).toBeLessThan(1e-3);
        expect(Math.abs(p.northing - c.n)).toBeLessThan(1e-3);
        const q = transverseMercatorToGeodetic(c.n, c.e, g);
        expect(Math.abs(q.lat / D2R - c.lat)).toBeLessThan(1e-8);
        expect(Math.abs(q.lon / D2R - c.lon)).toBeLessThan(1e-8);
      }
    }
  );

  it('picks the nearest zone', () => {
    expect(nearestZone(NORWAY_NTM_ZONES, 10.75).name).toBe('NTM zone 10');
    expect(nearestZone(FINLAND_GK_ZONES, 24.94).name).toBe('ETRS-GK25');
    expect(nearestZone(MGA2020_ZONES, 151.2).epsg).toBe(7856);
  });
});
