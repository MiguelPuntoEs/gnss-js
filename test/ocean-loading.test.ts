import { describe, it, expect } from 'vitest';
import {
  oceanLoadingEnu,
  parseBlq,
  type OceanLoadingCoefficients,
} from '../src/positioning/ocean-loading';

/** Coefficients with a single constituent `k` (BLQ order) set. */
function only(
  k: number,
  amp: [number, number, number],
  phase: [number, number, number] = [0, 0, 0]
): OceanLoadingCoefficients {
  return {
    amplitude: Array.from({ length: 11 }, (_, i) =>
      i === k ? amp : ([0, 0, 0] as [number, number, number])
    ),
    phase: Array.from({ length: 11 }, (_, i) =>
      i === k ? phase : ([0, 0, 0] as [number, number, number])
    ),
  };
}

describe('oceanLoadingEnu', () => {
  it('synthesises M2 with its amplitude and 12.42 h period', () => {
    const c = only(0, [0.02, 0, 0]);
    const t0 = Date.UTC(2024, 5, 1);
    const up = Array.from(
      { length: 2 * 24 * 60 },
      (_, i) => oceanLoadingEnu(c, t0 + i * 60_000)[2]
    );
    expect(Math.max(...up)).toBeCloseTo(0.02, 4);
    expect(Math.min(...up)).toBeCloseTo(-0.02, 4);
    // Upward zero crossings, 12.42 h apart.
    const cross = up.flatMap((v, i) =>
      i > 0 && up[i - 1]! < 0 && v >= 0 ? [i] : []
    );
    const gaps = cross.slice(1).map((v, i) => (v - cross[i]!) / 60);
    for (const g of gaps) expect(g).toBeCloseTo(12.42, 1);
  });

  it('maps BLQ west/south to East/North with the sign flipped', () => {
    const t = Date.UTC(2024, 0, 1, 6);
    const w = oceanLoadingEnu(only(1, [0, 0.01, 0]), t); // S2, west only
    const s = oceanLoadingEnu(only(1, [0, 0, 0.01]), t); // S2, south only
    const r = oceanLoadingEnu(only(1, [0.01, 0, 0]), t); // S2, radial only
    expect(w[0]).toBeCloseTo(-r[2], 12);
    expect(s[1]).toBeCloseTo(-r[2], 12);
    expect(w[1]).toBe(-0);
  });

  it('shifts a constituent by its phase lag', () => {
    const t = Date.UTC(2024, 0, 1);
    const a = oceanLoadingEnu(only(4, [0.01, 0, 0], [0, 0, 0]), t)[2]; // K1
    const b = oceanLoadingEnu(only(4, [0.01, 0, 0], [90, 0, 0]), t)[2];
    expect(Math.hypot(a, b)).toBeCloseTo(0.01, 6); // quadrature
  });
});

describe('parseBlq', () => {
  it('reads stations from an Onsala-format file', () => {
    const rows = (v: number) =>
      Array.from({ length: 3 }, () =>
        Array(11).fill(v.toFixed(5)).join(' ')
      ).join('\n');
    const ph = Array.from({ length: 3 }, () =>
      Array(11).fill('10.0').join(' ')
    ).join('\n');
    const text = [
      '$$ Ocean loading displacement',
      '$$ END HEADER',
      '  wtzr',
      '$$ Complete FES2014b',
      '$$ WTZR,                      RADI TANG  lon/lat:   12.8789   49.1442  666.0',
      rows(0.001),
      ph,
      '$$',
      '  BRST',
      rows(0.002),
      ph,
      '$$ END TABLE',
    ].join('\n');
    const m = parseBlq(text);
    expect([...m.keys()]).toEqual(['WTZR', 'BRST']);
    expect(m.get('BRST')!.amplitude[0]).toEqual([0.002, 0.002, 0.002]);
    expect(m.get('WTZR')!.phase[10]).toEqual([10, 10, 10]);
  });
});
