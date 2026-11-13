import { describe, it, expect } from 'vitest';
import {
  solidEarthTideIers,
  permanentTideEnu,
} from '../src/positioning/solid-earth-tide';

type V = [number, number, number];
/** UTC calendar instant → GPS-scale ms. */
const gps = (y: number, m: number, d: number, leap: number) =>
  Date.UTC(y, m - 1, d) + leap * 1000;

// The test cases documented with the IERS Conventions' reference routine
// (DEHANTTIDEINEL.F, 2010 Conventions software): station, Sun and Moon ECEF
// positions and the expected displacement. Only the numbers are used.
const CASES: { t: number; sta: V; sun: V; moon: V; want: V }[] = [
  {
    t: gps(2009, 4, 13, 15),
    sta: [4075578.385, 931852.89, 4801570.154],
    sun: [137859926952.015, 54228127881.435, 23509422341.696],
    moon: [-179996231.920342, -312468450.131567, -169288918.59216],
    want: [
      0.07700420357108125891, 0.06304056321824967613, 0.0551656815259724681,
    ],
  },
  {
    t: gps(2012, 7, 13, 16),
    sta: [1112189.66, -4842955.026, 3985352.284],
    sun: [-54537460436.2357, 130244288385.279, 56463429031.5996],
    moon: [300396716.912, 243238281.451, 120548075.939],
    want: [
      -0.02036831479592075833, 0.05658254776225972449, -0.07597679676871742227,
    ],
  },
  {
    t: gps(2015, 7, 15, 17),
    sta: [1112200.5696, -4842957.8511, 3985345.9122],
    sun: [100210282451.6279, 103055630398.316, 56855096480.4475],
    moon: [369817604.4348, 1897917.5258, 120804980.8284],
    want: [0.00509570869172363845, 0.08286630259835287, -0.0636634925404189617],
  },
];

describe('solidEarthTideIers (IERS 2010 Steps 1+2)', () => {
  for (const c of CASES)
    it(`matches the IERS test case at ${new Date(c.t).toISOString().slice(0, 10)}`, () => {
      const d = solidEarthTideIers(c.sta, c.sun, c.moon, c.t);
      for (let k = 0; k < 3; k++)
        expect(Math.abs(d[k]! - c.want[k]!)).toBeLessThan(1e-4);
    });

  it('permanent tide matches eq. 14 magnitudes (−12 cm pole, +6 cm equator)', () => {
    expect(permanentTideEnu(Math.PI / 2)[2]).toBeCloseTo(-0.1205, 3);
    expect(permanentTideEnu(0)[2]).toBeCloseTo(0.0603, 3);
  });
});
