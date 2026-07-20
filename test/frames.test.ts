import { describe, it, expect } from 'vitest';
import {
  transformFrame,
  applyHelmert,
  dateToEpoch,
  REFERENCE_FRAMES,
  type Helmert14,
} from '../src/frames';
import { ecefToGeodetic } from '../src/coordinates/ecef';

/** DELF00NLD (Delft) official ETRF2000(R05) coordinates, epoch 2010.5 —
 *  https://gnss1.tudelft.nl/dpga/coordinates.html */
const DELF: [number, number, number] = [
  3924687.7039, 301132.7618, 5001910.7712,
];

/** Boulder-ish CONUS point for the NAD83 tests. */
const BOULDER: [number, number, number] = [-1288398.0, -4721696.0, 4078625.0];

const dist = (
  a: readonly [number, number, number],
  b: readonly [number, number, number]
) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** ENU displacement of b relative to a, at a's location. */
function enu(
  a: [number, number, number],
  b: [number, number, number]
): [number, number, number] {
  const [lat, lon] = ecefToGeodetic(...a);
  const [dx, dy, dz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const sLat = Math.sin(lat),
    cLat = Math.cos(lat),
    sLon = Math.sin(lon),
    cLon = Math.cos(lon);
  return [
    -sLon * dx + cLon * dy,
    -sLat * cLon * dx - sLat * sLon * dy + cLat * dz,
    cLat * cLon * dx + cLat * sLon * dy + sLat * dz,
  ];
}

describe('applyHelmert (Position Vector convention)', () => {
  // Hand-checkable parameter set: pure values, no rates.
  const p: Helmert14 = {
    t: [1000, 2000, 3000], // mm → 1, 2, 3 m
    d: 1000, // ppb → 1e-6
    r: [0, 0, 206264.806], // mas → 1e-3 rad (approx: 206264806 mas = 1 rad)
    tDot: [0, 0, 0],
    dDot: 0,
    rDot: [0, 0, 0],
    epoch: 2010.0,
  };

  it('applies translation, scale and rotation with PV signs', () => {
    // Point on the x-axis: rotation about z moves it toward +y (PV).
    const [x, y, z] = applyHelmert([1e6, 0, 0], p, 2010.0);
    expect(x).toBeCloseTo(1e6 + 1 + 1e-6 * 1e6, 6); // + T1 + D·x
    expect(y).toBeCloseTo(2 + 1e-3 * 1e6, 3); // + T2 + R3·x
    expect(z).toBeCloseTo(3, 6); // + T3
  });

  it('inverse round-trips to sub-millimetre at realistic magnitudes', () => {
    // The linearized inverse (negated parameters) is exact to second
    // order — fine for real frame rotations (tens of mas), not for the
    // exaggerated rotation used in the sign-check above.
    const realistic: Helmert14 = {
      ...p,
      r: [1.701, 10.29, -16.632],
      rDot: [0.081, 0.49, -0.792],
    };
    const fwd = applyHelmert(DELF, realistic, 2012.3);
    const back = applyHelmert(fwd, realistic, 2012.3, true);
    expect(dist(back, DELF)).toBeLessThan(1e-3);
  });
});

describe('EPSG cross-validation', () => {
  it('ITRF2020→ETRF2020 via epoch-1989 params equals EPSG:10573 epoch-2015 params', () => {
    // EPSG publishes the same transformation with parameters expressed
    // at 1989 (10572, rates only — used by the module) and at 2015
    // (10573, R = [2.236, 13.494, −19.578] mas + same rates). A correct
    // time-dependent implementation must make them agree everywhere.
    const epsg10573: Helmert14 = {
      t: [0, 0, 0],
      d: 0,
      r: [2.236, 13.494, -19.578],
      tDot: [0, 0, 0],
      dDot: 0,
      rDot: [0.086, 0.519, -0.753],
      epoch: 2015.0,
    };
    for (const epoch of [1989.0, 2010.5, 2025.25]) {
      const viaModule = transformFrame(DELF, 'ITRF2020', 'ETRF2020', epoch);
      const via10573 = applyHelmert(DELF, epsg10573, epoch);
      expect(dist(viaModule, via10573)).toBeLessThan(1e-4);
    }
  });
});

describe('transformFrame', () => {
  it('identity when frames are equal', () => {
    expect(transformFrame(DELF, 'ITRF2014', 'ITRF2014', 2020)).toEqual(DELF);
  });

  it('WGS84 aliases ITRF2020', () => {
    const a = transformFrame(DELF, 'WGS84', 'ETRF2000', 2010.5);
    const b = transformFrame(DELF, 'ITRF2020', 'ETRF2000', 2010.5);
    expect(dist(a, b)).toBe(0);
  });

  it('every frame pair round-trips below 0.1 mm', () => {
    for (const from of REFERENCE_FRAMES) {
      for (const to of REFERENCE_FRAMES) {
        const fwd = transformFrame(DELF, from, to, 2015.0);
        const back = transformFrame(fwd, to, from, 2015.0);
        expect(dist(back, DELF), `${from}→${to}`).toBeLessThan(1e-4);
      }
    }
  });

  it('ITRF2020→ITRF2000 at the reference epoch applies the published offsets', () => {
    // At epoch 2015.0 the rates vanish; for a point at the origin only
    // the translations remain: (−0.2, 0.8, −34.2) mm.
    const [x, y, z] = transformFrame([0, 0, 0], 'ITRF2020', 'ITRF2000', 2015.0);
    expect(x).toBeCloseTo(-0.0002, 7);
    expect(y).toBeCloseTo(0.0008, 7);
    expect(z).toBeCloseTo(-0.0342, 7);
  });

  it('reproduces Eurasia plate motion at Delft (physical sign anchor)', () => {
    // A fixed ETRF2000 coordinate maps to ITRF positions that drift with
    // the Eurasian plate: ~2.5 cm/yr toward the northeast. A sign error
    // in the rotation convention would send this southwest.
    const itrf2010 = transformFrame(DELF, 'ETRF2000', 'ITRF2014', 2010.0);
    const itrf2020 = transformFrame(DELF, 'ETRF2000', 'ITRF2014', 2020.0);
    const [east, north, up] = enu(itrf2010, itrf2020); // motion over 10 yr
    expect(east).toBeGreaterThan(0.1); // eastward, ~0.18 m/decade
    expect(north).toBeGreaterThan(0.05); // northward, ~0.16 m/decade
    const horizontal = Math.hypot(east, north);
    expect(horizontal).toBeGreaterThan(0.15);
    expect(horizontal).toBeLessThan(0.35);
    expect(Math.abs(up)).toBeLessThan(0.05); // plate motion is horizontal
  });

  it('ETRF2000 and ITRF2014 differ by ~half a metre at Delft in 2010', () => {
    // ~21.5 years of plate rotation since 1989 at ~2.5 cm/yr.
    const itrf = transformFrame(DELF, 'ETRF2000', 'ITRF2014', 2010.5);
    const d = dist(itrf, DELF);
    expect(d).toBeGreaterThan(0.3);
    expect(d).toBeLessThan(0.8);
  });

  it('NAD83(2011) offset from ITRF2014 is ~1.52 m at Boulder (2010.0)', () => {
    const nad = transformFrame(BOULDER, 'ITRF2014', 'NAD83(2011)', 2010.0);
    const d = dist(nad, BOULDER);
    expect(d).toBeGreaterThan(1.4);
    expect(d).toBeLessThan(1.7);
  });

  it('NAD83(2011) rates produce plate-scale secular motion (2010→2020)', () => {
    // At the 2010.0 parameter epoch the rate terms vanish, so this pair
    // of epochs is what actually exercises the CF→PV rate negation: a
    // NAD83-fixed point drifts through ITRF2014 with the North American
    // plate, ~1.8 cm/yr at Boulder.
    const at2010 = transformFrame(BOULDER, 'ITRF2014', 'NAD83(2011)', 2010.0);
    const at2020 = transformFrame(BOULDER, 'ITRF2014', 'NAD83(2011)', 2020.0);
    const drift = dist(at2010, at2020);
    expect(drift).toBeGreaterThan(0.1);
    expect(drift).toBeLessThan(0.25);
  });
});

describe('pinned vectors (independent implementation)', () => {
  // Expected outputs computed with a separate Python implementation of
  // the time-dependent Helmert formula, fed the published parameters —
  // for NAD83 starting from EPSG:8970's RAW Coordinate-Frame rotations
  // with the CF→PV negation performed independently. Epochs are chosen
  // off the parameter epochs so every rate term is active, and the
  // points are far from the origin so every rotation term is active.
  // Round-trip tests cancel a consistently-applied sign error; these
  // pins do not.

  it('ITRF2020→ITRF93 at 2020.0 (full rotation vector + all rates)', () => {
    const out = transformFrame(DELF, 'ITRF2020', 'ITRF93', 2020.0);
    expect(out[0]).toBeCloseTo(3924687.5144, 4);
    expect(out[1]).toBeCloseTo(301132.88, 4);
    expect(out[2]).toBeCloseTo(5001910.8085, 4);
  });

  it('ITRF2014→NAD83(2011) at 2020.0 (CF→PV negation, rates active)', () => {
    const out = transformFrame(BOULDER, 'ITRF2014', 'NAD83(2011)', 2020.0);
    expect(out[0]).toBeCloseTo(-1288397.0668, 4);
    expect(out[1]).toBeCloseTo(-4721697.3057, 4);
    expect(out[2]).toBeCloseTo(4078625.1209, 4);
  });

  it('ITRF2020→ETRF2000 at 2024.0 (two-edge path through ITRF2014)', () => {
    const out = transformFrame(DELF, 'ITRF2020', 'ETRF2000', 2024.0);
    expect(out[0]).toBeCloseTo(3924688.2277, 4);
    expect(out[1]).toBeCloseTo(301132.2184, 4);
    expect(out[2]).toBeCloseTo(5001910.3677, 4);
  });
});

describe('dateToEpoch', () => {
  it('converts calendar dates to decimal years', () => {
    expect(dateToEpoch(new Date('2010-01-01T00:00:00Z'))).toBeCloseTo(
      2010.0,
      9
    );
    expect(dateToEpoch(new Date('2010-07-02T12:00:00Z'))).toBeCloseTo(
      2010.5,
      2
    );
  });
});
