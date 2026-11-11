import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SWEREF99_LOCAL_ZONES,
  SWEREF99_TM,
  geodeticToTransverseMercator,
  nearestSweref99LocalZone,
  transverseMercatorToGeodetic,
} from '../src/coordinates';
import {
  itrfToSweref99,
  sweref99ToItrf,
  velocityGridModel,
  type ReferenceFrame,
} from '../src/frames';

/*
 * Oracles from PROJ 9.8.1 (pyproj 3.8.0):
 *  - sweref99_tm_proj.json: EPSG:4619 (SWEREF 99 geographic) → EPSG:3006–3018
 *    for 48 points across Sweden (named towns + seeded random).
 *  - sweref99_nkg_proj.json: ITRF2020 (EPSG:9988) / ITRF2014 (EPSG:7789) →
 *    SWEREF 99 geocentric (EPSG:4976) via PROJ's NKG pipeline with
 *    eur_nkg_nkgrf17vel.tif, at four coordinate epochs.
 *  - nkg_rf17vel_sweden.i16: that grid (NKG, CC-BY 4.0) cropped to
 *    70°N–54.5°N × 10°E–25°E: planes E, N, U of 187 × 91 int16 LE in
 *    0.001 mm/yr, rows from the north.
 */
const FIX = join(__dirname, '../test-fixtures');
const D2R = Math.PI / 180;

const tmCases: {
  epsg: number;
  name: string;
  lat: number;
  lon: number;
  n: number;
  e: number;
}[] = JSON.parse(readFileSync(join(FIX, 'sweref99_tm_proj.json'), 'utf8'));

const projections = [SWEREF99_TM, ...SWEREF99_LOCAL_ZONES];

describe('SWEREF 99 projections (Krüger) vs PROJ', () => {
  it('covers EPSG:3006–3018', () => {
    expect(projections.map((p) => p.epsg).sort()).toEqual(
      Array.from({ length: 13 }, (_, i) => 3006 + i)
    );
  });

  it.each(projections.map((p) => [p.name, p] as const))(
    '%s forward and inverse',
    (_name, p) => {
      const cases = tmCases.filter((c) => c.epsg === p.epsg);
      expect(cases.length).toBe(48);
      for (const c of cases) {
        const g = geodeticToTransverseMercator(c.lat * D2R, c.lon * D2R, p);
        // Local zones reach ~600 km off their meridian for the far
        // points; still sub-millimetre.
        expect(Math.abs(g.northing - c.n)).toBeLessThan(1e-3);
        expect(Math.abs(g.easting - c.e)).toBeLessThan(1e-3);
        const back = transverseMercatorToGeodetic(c.n, c.e, p);
        // 1e-9 rad ≈ 6 mm; the series is far better than that
        expect(Math.abs(back.lat / D2R - c.lat)).toBeLessThan(1e-9);
        expect(Math.abs(back.lon / D2R - c.lon)).toBeLessThan(1e-9);
      }
    }
  );

  it('SWEREF 99 TM in Stockholm', () => {
    const c = tmCases.find((t) => t.epsg === 3006 && t.name === 'Stockholm')!;
    const g = geodeticToTransverseMercator(
      59.3293 * D2R,
      18.0686 * D2R,
      SWEREF99_TM
    );
    expect(g.northing).toBeCloseTo(c.n, 3);
    expect(g.easting).toBeCloseTo(c.e, 3);
  });

  it('picks the nearest local zone', () => {
    expect(nearestSweref99LocalZone(18.07).name).toBe('SWEREF 99 18 00');
    expect(nearestSweref99LocalZone(11.17).name).toBe('SWEREF 99 12 00');
    expect(nearestSweref99LocalZone(24.1).name).toBe('SWEREF 99 23 15');
  });
});

function loadGrid() {
  const buf = readFileSync(join(FIX, 'nkg_rf17vel_sweden.i16'));
  const rows = 187;
  const cols = 91;
  const n = rows * cols;
  const all = new Int16Array(buf.buffer, buf.byteOffset, 3 * n);
  const plane = (k: number) =>
    Float64Array.from(all.subarray(k * n, (k + 1) * n), (v) => v / 1000);
  return velocityGridModel({
    latNorth: 70,
    lonWest: 10,
    dLat: 1 / 12,
    dLon: 1 / 6,
    rows,
    cols,
    east: plane(0),
    north: plane(1),
    up: plane(2),
  });
}

const nkgCases: {
  frame: ReferenceFrame;
  name: string;
  epoch: number;
  itrf: [number, number, number];
  sweref: [number, number, number];
}[] = JSON.parse(readFileSync(join(FIX, 'sweref99_nkg_proj.json'), 'utf8'));

const dist = (a: number[], b: number[]) =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

describe('NKG2020 ITRF ↔ SWEREF 99 vs PROJ', () => {
  const model = loadGrid();

  it('interpolates the grid at nodes and between them', () => {
    // Node 66°N 20°E: row 48, column 60
    const v = model(66, 20)!;
    expect(v[2]).toBeGreaterThan(8); // the Gulf of Bothnia coast rises ~10 mm/yr
    expect(model(53, 15)).toBeNull();
    expect(model(60, 26)).toBeNull();
  });

  it.each(['ITRF2020', 'ITRF2014'] as const)('%s → SWEREF 99', (frame) => {
    const cases = nkgCases.filter((c) => c.frame === frame);
    expect(cases.length).toBe(96);
    let worst = 0;
    for (const c of cases) {
      const out = itrfToSweref99(c.itrf, frame, c.epoch, model);
      worst = Math.max(worst, dist(out, c.sweref));
    }
    // PROJ combines ITRF2020→ITRF2014→ETRF2014 into one Helmert and
    // the grid here is rounded to 0.001 mm/yr.
    expect(worst).toBeLessThan(0.5e-3);
  });

  it('round-trips SWEREF 99 → ITRF2020', () => {
    for (const c of nkgCases.filter((x) => x.frame === 'ITRF2020')) {
      const back = sweref99ToItrf(c.sweref, 'ITRF2020', c.epoch, model);
      expect(dist(back, c.itrf)).toBeLessThan(0.5e-3);
    }
  });

  it('the shift grows with time (land uplift)', () => {
    const k = nkgCases.filter(
      (c) => c.frame === 'ITRF2020' && c.name === 'Kiruna'
    );
    const shift = k.map((c) => dist(c.itrf, c.sweref));
    expect(shift[3]!).toBeGreaterThan(shift[0]!);
  });

  it('refuses points outside the model', () => {
    const delft: [number, number, number] = [3924687.7, 301132.8, 5001910.8];
    expect(() => itrfToSweref99(delft, 'ITRF2020', 2026, model)).toThrow(
      /outside/
    );
  });
});
