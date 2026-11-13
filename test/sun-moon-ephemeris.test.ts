import { describe, it, expect } from 'vitest';
import { sunEcef, moonEcef } from '../src/positioning/ppp-astro';
import { solidEarthTideIers } from '../src/positioning/solid-earth-tide';
import { getGpsLeap } from '../src/time/utc';

type V = [number, number, number];
// Geometric Sun/Moon positions in the ITRS (no polar motion) from JPL DE421,
// computed with Skyfield 1.x (independent oracle).
const DE421: { utc: string; sun: V; moon: V }[] = [
  {
    utc: '2024-01-07T00:00:00Z',
    sun: [-135903236392, -3470235566, -56201615460],
    moon: [-178900200, 318757873, -130013989],
  },
  {
    utc: '2024-01-07T06:00:00Z',
    sun: [-3535843474, 135932396449, -56128915459],
    moon: [305684148, 193166156, -136589909],
  },
  {
    utc: '2024-01-09T13:00:00Z',
    sun: [132645347648, -31271319887, -55411528776],
    moon: [246307762, -220869267, -173322178],
  },
  {
    utc: '2024-01-12T18:00:00Z',
    sun: [4910075573, -136676590256, -54254435139],
    moon: [121814556, -312138720, -138693016],
  },
  {
    utc: '2009-04-13T00:00:00Z',
    sun: [-148138997935, -408279136, 23512636888],
    moon: [280730564, 225519529, -169115987],
  },
  {
    utc: '2020-06-01T03:00:00Z',
    sun: [-98472069374, 100291994589, 57083698577],
    moon: [-102086558, -352020100, 11671235],
  },
  {
    utc: '2026-11-01T12:00:00Z',
    sun: [143372380766, -10278859635, -37233952682],
    moon: [-20923632, -346143719, 133192711],
  },
];

const angleDeg = (a: V, b: V) =>
  (Math.acos(
    (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) /
      (Math.hypot(...a) * Math.hypot(...b))
  ) *
    180) /
  Math.PI;

describe('low-precision Sun/Moon vs JPL DE421', () => {
  for (const c of DE421)
    it(c.utc, () => {
      const u = Date.parse(c.utc);
      const t = u + getGpsLeap(new Date(u)) * 1000;
      const S = sunEcef(t);
      const M = moonEcef(t);
      expect(angleDeg(S, c.sun)).toBeLessThan(0.012);
      expect(angleDeg(M, c.moon)).toBeLessThan(0.04);
      expect(
        Math.abs(Math.hypot(...M) / Math.hypot(...c.moon) - 1)
      ).toBeLessThan(8e-4);
      // What it costs the solid-earth tide: < 0.3 mm anywhere.
      for (const sta of [
        [4075578.385, 931852.89, 4801570.154],
        [6378000, 0, 0],
        [0, 6378000, 0],
        [3000000, 3000000, 4800000],
      ] as V[]) {
        const a = solidEarthTideIers(sta, c.sun, c.moon, t);
        const b = solidEarthTideIers(sta, S, M, t);
        for (let k = 0; k < 3; k++)
          expect(Math.abs(a[k]! - b[k]!)).toBeLessThan(3e-4);
      }
    });
});
