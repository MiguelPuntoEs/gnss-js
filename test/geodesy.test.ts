import { describe, it, expect } from 'vitest';
import {
  vincenty,
  vincentyDirect,
  meridianArc,
  rhumbLine,
  euclidean3D,
  greatCircleMidpoint,
  horizonDistance,
} from '../src/coordinates/geodesy';
import { deg2rad } from '../src/coordinates/units';

describe('vincenty', () => {
  it('computes distance between London and Paris', () => {
    const lat1 = deg2rad(51.5074),
      lon1 = deg2rad(-0.1278);
    const lat2 = deg2rad(48.8566),
      lon2 = deg2rad(2.3522);
    const { distance } = vincenty(lat1, lon1, lat2, lon2);
    expect(distance).toBeGreaterThan(340_000);
    expect(distance).toBeLessThan(345_000);
  });

  it('computes distance between New York and Los Angeles', () => {
    const lat1 = deg2rad(40.7128),
      lon1 = deg2rad(-74.006);
    const lat2 = deg2rad(34.0522),
      lon2 = deg2rad(-118.2437);
    const { distance } = vincenty(lat1, lon1, lat2, lon2);
    expect(distance).toBeGreaterThan(3_940_000);
    expect(distance).toBeLessThan(3_950_000);
  });

  it('returns zero for coincident points', () => {
    const lat = deg2rad(45),
      lon = deg2rad(10);
    const { distance } = vincenty(lat, lon, lat, lon);
    expect(distance).toBe(0);
  });

  it('computes bearings correctly (due north)', () => {
    const lat1 = deg2rad(0),
      lon = deg2rad(0);
    const lat2 = deg2rad(10);
    const { initialBearing } = vincenty(lat1, lon, lat2, lon);
    expect(Math.abs(initialBearing)).toBeLessThan(0.001);
  });

  it('computes bearings correctly (due east)', () => {
    const lat = deg2rad(0),
      lon1 = deg2rad(0),
      lon2 = deg2rad(10);
    const { initialBearing } = vincenty(lat, lon1, lat, lon2);
    expect(initialBearing).toBeCloseTo(Math.PI / 2, 2);
  });

  it('handles near-antipodal points without throwing', () => {
    const { distance } = vincenty(
      deg2rad(0),
      deg2rad(0),
      deg2rad(0.5),
      deg2rad(179.5)
    );
    expect(distance).toBeGreaterThan(19_900_000);
    expect(distance).toBeLessThan(20_100_000);
  });
});

describe('rhumbLine', () => {
  it('computes rhumb distance between London and Paris', () => {
    const lat1 = deg2rad(51.5074),
      lon1 = deg2rad(-0.1278);
    const lat2 = deg2rad(48.8566),
      lon2 = deg2rad(2.3522);
    const { distance } = rhumbLine(lat1, lon1, lat2, lon2);
    expect(distance).toBeGreaterThan(340_000);
    expect(distance).toBeLessThan(345_000);
  });

  it('rhumb distance >= orthodromic distance', () => {
    const lat1 = deg2rad(40.7128),
      lon1 = deg2rad(-74.006);
    const lat2 = deg2rad(34.0522),
      lon2 = deg2rad(-118.2437);
    const { distance: rhumb } = rhumbLine(lat1, lon1, lat2, lon2);
    const { distance: ortho } = vincenty(lat1, lon1, lat2, lon2);
    expect(rhumb).toBeGreaterThanOrEqual(ortho * 0.999);
  });
});

describe('euclidean3D', () => {
  it('computes straight-line distance', () => {
    const d = euclidean3D(1, 0, 0, 4, 0, 0);
    expect(d).toBeCloseTo(3, 10);
  });

  it('computes 3D diagonal', () => {
    const d = euclidean3D(0, 0, 0, 3, 4, 0);
    expect(d).toBeCloseTo(5, 10);
  });
});

describe('greatCircleMidpoint', () => {
  it('midpoint of equator segment is on equator', () => {
    const [midLat] = greatCircleMidpoint(0, 0, 0, deg2rad(90));
    expect(midLat).toBeCloseTo(0, 10);
  });

  it('midpoint longitude is average for same-latitude points', () => {
    const [, midLon] = greatCircleMidpoint(
      deg2rad(45),
      deg2rad(0),
      deg2rad(45),
      deg2rad(90)
    );
    expect(midLon).toBeCloseTo(deg2rad(45), 1);
  });
});

describe('horizonDistance', () => {
  it('returns 0 for zero height', () => {
    expect(horizonDistance(0)).toBe(0);
  });

  it('returns 0 for negative height', () => {
    expect(horizonDistance(-10)).toBe(0);
  });

  it('returns ~3.6 km for 1 m height', () => {
    const d = horizonDistance(1);
    expect(d).toBeGreaterThan(3_500);
    expect(d).toBeLessThan(4_000);
  });

  it('returns ~113 km for 1000 m height', () => {
    const d = horizonDistance(1000);
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(125_000);
  });
});

// ── Exactness against independent references ────────────────────────────

const A_WGS = 6378137;
const F_WGS = 1 / 298.257223563;
const E2_WGS = F_WGS * (2 - F_WGS);

/** Meridian arc by Simpson integration of ρ(φ) — independent of the series. */
function meridianArcRef(lat: number): number {
  const n = 4000,
    h = lat / n;
  let s = 0;
  for (let i = 0; i <= n; i++) {
    const w = i === 0 || i === n ? 1 : i % 2 ? 4 : 2;
    s += w * (1 - E2_WGS * Math.sin(i * h) ** 2) ** -1.5;
  }
  return ((A_WGS * (1 - E2_WGS) * s * h) / 3) as number;
}

describe('meridianArc', () => {
  it('matches numerical integration to < 1 mm, equator to pole', () => {
    for (const deg of [1, 10, 30, 45, 60, 80, 89.9]) {
      const lat = deg2rad(deg);
      expect(Math.abs(meridianArc(lat) - meridianArcRef(lat))).toBeLessThan(
        1e-3
      );
    }
    expect(meridianArc(deg2rad(90))).toBeCloseTo(10_001_965.729, 2);
  });
});

describe('rhumbLine exactness', () => {
  /** Exact rhumb length: ΔM/|cos α| (or N·cosφ·|Δλ| for due E–W). */
  function rhumbRef(lat1: number, lon1: number, lat2: number, lon2: number) {
    const { bearing } = rhumbLine(lat1, lon1, lat2, lon2);
    if (lat1 === lat2) {
      let dLon = Math.abs(lon2 - lon1);
      if (dLon > Math.PI) dLon = 2 * Math.PI - dLon;
      const N = A_WGS / Math.sqrt(1 - E2_WGS * Math.sin(lat1) ** 2);
      return N * Math.cos(lat1) * dLon;
    }
    return (
      Math.abs(meridianArcRef(lat2) - meridianArcRef(lat1)) /
      Math.abs(Math.cos(bearing))
    );
  }

  it.each([
    ['1° N–S at the equator', 0, 0, 1, 0],
    ['1° N–S at 60°N', 60, 0, 61, 0],
    ['Delft → Paris', 52, 4, 48, 2],
    ['10° E–W at 45°N', 45, 0, 45, 10],
    ['1° E–W at the equator', 0, 0, 0, 1],
    ['near E–W (1 m of latitude)', 45, 0, 45.000009, 10],
    ['across the antimeridian', 10, 170, -20, -170],
  ])('%s — within 1 mm of exact', (_n, la1, lo1, la2, lo2) => {
    const args = [la1, lo1, la2, lo2].map(deg2rad) as [
      number,
      number,
      number,
      number,
    ];
    const { distance } = rhumbLine(...args);
    expect(Math.abs(distance - rhumbRef(...args))).toBeLessThan(1e-3);
  });
});

describe('vincentyDirect', () => {
  it('round-trips the inverse to sub-mm', () => {
    const cases: [number, number, number, number][] = [
      [52, 4, 48, 2],
      [40.7128, -74.006, 51.5074, -0.1278],
      [-33.87, 151.21, 35.68, 139.69],
      [10, 170, -20, -170],
    ];
    for (const c of cases) {
      const [la1, lo1, la2, lo2] = c.map(deg2rad) as typeof c;
      const { distance, initialBearing } = vincenty(la1, lo1, la2, lo2);
      const [la, lo] = vincentyDirect(la1, lo1, initialBearing, distance);
      expect(vincenty(la, lo, la2, lo2).distance).toBeLessThan(1e-3);
    }
  });
});

describe('greatCircleMidpoint is the geodesic midpoint', () => {
  it.each([
    [52, 4, 48, 2],
    [40, -74, 51.5, 0],
    [0, 0, 60, 90],
    [10, 170, -20, -170],
  ])('(%d,%d)→(%d,%d): equidistant and on the path', (la1, lo1, la2, lo2) => {
    const A = [deg2rad(la1), deg2rad(lo1)] as const;
    const B = [deg2rad(la2), deg2rad(lo2)] as const;
    const M = greatCircleMidpoint(A[0], A[1], B[0], B[1]);
    const dAB = vincenty(A[0], A[1], B[0], B[1]).distance;
    const dAM = vincenty(A[0], A[1], M[0], M[1]).distance;
    const dMB = vincenty(M[0], M[1], B[0], B[1]).distance;
    expect(Math.abs(dAM - dMB)).toBeLessThan(1e-3);
    expect(Math.abs(dAM + dMB - dAB)).toBeLessThan(1e-3);
  });
});

describe('vincenty convergence flag', () => {
  it('is true normally and false for the near-antipodal fallback', () => {
    expect(
      vincenty(deg2rad(52), deg2rad(4), deg2rad(48), deg2rad(2)).converged
    ).toBe(true);
    expect(vincenty(0, 0, 0, deg2rad(179.7)).converged).toBe(false);
  });
});
