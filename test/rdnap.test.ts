import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  RD_NEW,
  geodeticToEcef,
  geodeticToObliqueStereographic,
  obliqueStereographicToGeodetic,
} from '../src/coordinates';
import {
  etrs89ToRdnap,
  itrfToRdnap,
  latLonGridModel,
  rdnapToEtrs89,
  rdnapToItrf,
  transformFrame,
  type LatLonGrid,
  type RdnapGrids,
} from '../src/frames';

/*
 * Oracles:
 *  - nsgi_z001_etrs89_rdnap.txt: NSGI's certified RDNAPTRANS2018 reference
 *    points (Z001_ETRS89andRDNAP.txt from github.com/GeodetischeInfrastructuur/
 *    transformations, CC-BY 4.0): id, ETRS89 φ λ h, RD x y, NAP H.
 *  - rd_sterea_proj.json: PROJ 9.8.1, Amersfoort geographic (EPSG:4289) →
 *    RD New (EPSG:28992).
 *  - nsgi_rdtrans2018.bin / nsgi_nlgeo2018.bin: NSGI's grids from PROJ's
 *    CDN, compacted (delta-coded int16, 1e-5″ and 0.1 mm) by a scratch
 *    script; layout decoded below.
 */
const FIX = join(__dirname, '../test-fixtures');
const D2R = Math.PI / 180;

/** "RDG1": u16 count, u16 0; per grid u16 rows, cols, planes, 5 f64 geometry + unit; per plane i32 first column, i16 column deltas. */
function decode(file: string): LatLonGrid[] {
  const b = gunzipSync(readFileSync(join(FIX, file)));
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  expect(b.subarray(0, 4).toString()).toBe('RDG1');
  let o = 8;
  return Array.from({ length: dv.getUint16(4, true) }, () => {
    const rows = dv.getUint16(o, true);
    const cols = dv.getUint16(o + 2, true);
    const n = dv.getUint16(o + 4, true);
    const f = (k: number) => dv.getFloat64(o + 6 + 8 * k, true);
    const [latNorth, lonWest, dLat, dLon, unit] = [0, 1, 2, 3, 4].map(f);
    o += 46;
    const planes = Array.from({ length: n }, () => {
      const out = new Float64Array(rows * cols);
      const first = o;
      o += 4 * rows;
      for (let r = 0; r < rows; r++) {
        let v = dv.getInt32(first + 4 * r, true);
        out[r * cols] = v * unit!;
        for (let c = 1; c < cols; c++) {
          v += dv.getInt16(o, true);
          o += 2;
          out[r * cols + c] = v * unit!;
        }
      }
      return out;
    });
    return {
      latNorth: latNorth!,
      lonWest: lonWest!,
      dLat: dLat!,
      dLon: dLon!,
      rows,
      cols,
      planes,
    };
  });
}

const grids: RdnapGrids = {
  rdtrans: latLonGridModel(...decode('nsgi_rdtrans2018.bin')),
  nlgeo: latLonGridModel(...decode('nsgi_nlgeo2018.bin')),
};

const z001 = readFileSync(join(FIX, 'nsgi_z001_etrs89_rdnap.txt'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => l.trim().split(/\s+/).map(Number))
  .map(([id, lat, lon, h, x, y, H]) => ({ id, lat, lon, h, x, y, H }));

describe('RD New (oblique stereographic) vs PROJ', () => {
  const cases: { lat: number; lon: number; x: number; y: number }[] =
    JSON.parse(readFileSync(join(FIX, 'rd_sterea_proj.json'), 'utf8'));

  it('is zero at the origin', () => {
    const g = geodeticToObliqueStereographic(
      RD_NEW.lat0 * D2R,
      RD_NEW.lon0 * D2R,
      RD_NEW
    );
    expect(g.easting).toBeCloseTo(155000, 6);
    expect(g.northing).toBeCloseTo(463000, 6);
  });

  it.each(cases.map((c) => [`${c.lat}, ${c.lon}`, c] as const))(
    '%s forward and inverse',
    (_n, c) => {
      const g = geodeticToObliqueStereographic(
        c.lat * D2R,
        c.lon * D2R,
        RD_NEW
      );
      expect(Math.abs(g.easting - c.x)).toBeLessThan(1e-4);
      expect(Math.abs(g.northing - c.y)).toBeLessThan(1e-4);
      const q = obliqueStereographicToGeodetic(c.x, c.y, RD_NEW);
      expect(Math.abs(q.lat / D2R - c.lat)).toBeLessThan(1e-9);
      expect(Math.abs(q.lon / D2R - c.lon)).toBeLessThan(1e-9);
    }
  );
});

describe('RDNAPTRANS2018 vs NSGI certified points (Z001)', () => {
  it('has the 100 points', () => expect(z001.length).toBe(100));

  // NSGI's certification tolerance: 1 mm in RD and NAP, 1e-8° in φ, λ.
  it('ETRS89 → RD/NAP', () => {
    let worst = 0;
    for (const p of z001) {
      const r = etrs89ToRdnap(p.lat!, p.lon!, p.h!, grids);
      worst = Math.max(worst, Math.abs(r.x - p.x!), Math.abs(r.y - p.y!));
      expect(Math.abs(r.x - p.x!)).toBeLessThan(1e-3);
      expect(Math.abs(r.y - p.y!)).toBeLessThan(1e-3);
      expect(Math.abs(r.H! - p.H!)).toBeLessThan(1e-3);
    }
    expect(worst).toBeLessThan(1e-3);
  });

  it('RD/NAP → ETRS89', () => {
    for (const p of z001) {
      const e = rdnapToEtrs89(p.x!, p.y!, p.H!, grids);
      expect(Math.abs(e.latDeg - p.lat!)).toBeLessThan(1e-8);
      expect(Math.abs(e.lonDeg - p.lon!)).toBeLessThan(1e-8);
      expect(Math.abs(e.h! - p.h!)).toBeLessThan(1e-3);
    }
  });

  it('goes through ETRF2000 from ITRF, and back', () => {
    const p = z001[0]!;
    const etrf = geodeticToEcef(p.lat! * D2R, p.lon! * D2R, p.h!);
    const itrf = transformFrame(etrf, 'ETRF2000', 'ITRF2020', 2026.5);
    const r = itrfToRdnap(itrf, 'ITRF2020', 2026.5, grids);
    expect(Math.abs(r.x - p.x!)).toBeLessThan(1e-3);
    expect(Math.abs(r.H! - p.H!)).toBeLessThan(1e-3);
    const back = rdnapToItrf(r.x, r.y, r.H!, 'ITRF2020', 2026.5, grids);
    back.forEach((v, i) => expect(Math.abs(v - itrf[i]!)).toBeLessThan(1e-3));
  });

  it('refuses positions outside the grids', () => {
    expect(() => etrs89ToRdnap(40.4, -3.7, 0, grids)).toThrow(/outside/);
  });
});
