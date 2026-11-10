import { describe, it, expect } from 'vitest';
import {
  estimateHelmert,
  applyHelmertFit,
} from '../src/analysis/network-alignment';
import { geodeticToEcef } from '../src/coordinates/ecef';

const deg = Math.PI / 180;
// Six European stations (approximate) — a regional network.
const SITES = [
  [49.14, 12.88],
  [52.38, 13.07],
  [57.4, 11.93],
  [50.8, 4.36],
  [46.88, 7.47],
  [47.07, 15.49],
].map(([la, lo]) => geodeticToEcef(la! * deg, lo! * deg, 600));

/** Positions as a daily solution would give them: shifted by a common
 *  translation (+ optional small rotation/scale) and per-site noise. */
function shifted(
  t: [number, number, number],
  noise = 0,
  r: [number, number, number] = [0, 0, 0],
  d = 0
) {
  return SITES.map((x, i) => {
    const y = applyHelmertFit(x, {
      model: 'similarity',
      t,
      r,
      d,
      residuals: [],
      used: [],
      rms: 0,
    });
    return [0, 1, 2].map(
      (k) => y[k]! + noise * Math.sin(i * 3.1 + k * 1.7)
    ) as [number, number, number];
  });
}

describe('estimateHelmert', () => {
  it('recovers a common translation and removes it', () => {
    const day = shifted([0.004, -0.006, 0.009], 0.001);
    const f = estimateHelmert(day, SITES)!;
    expect(f.model).toBe('translation');
    // day = truth + t ⇒ the fit maps back by −t.
    expect(f.t[0]).toBeCloseTo(-0.004, 3);
    expect(f.t[1]).toBeCloseTo(0.006, 3);
    expect(f.t[2]).toBeCloseTo(-0.009, 3);
    expect(f.rms).toBeLessThan(0.0015);
    expect(f.used.every(Boolean)).toBe(true);
  });

  it('rejects a reference station that moved', () => {
    const day = shifted([0.004, 0, 0], 0.0005);
    day[2] = [day[2]![0] + 0.05, day[2]![1], day[2]![2]]; // a 5 cm blunder
    const f = estimateHelmert(day, SITES)!;
    expect(f.used[2]).toBe(false);
    expect(f.used.filter(Boolean).length).toBe(5);
    expect(f.t[0]).toBeCloseTo(-0.004, 3);
  });

  it('fits rotation and scale with the similarity model', () => {
    const r: [number, number, number] = [2e-9, -3e-9, 1e-9];
    const day = shifted([0.01, 0.002, -0.004], 0, r, 5e-9);
    const f = estimateHelmert(day, SITES, { model: 'similarity' })!;
    expect(f.rms).toBeLessThan(1e-6);
    for (let i = 0; i < SITES.length; i++) {
      const y = applyHelmertFit(day[i]!, f);
      expect(
        Math.hypot(
          y[0] - SITES[i]![0],
          y[1] - SITES[i]![1],
          y[2] - SITES[i]![2]
        )
      ).toBeLessThan(1e-5);
    }
  });

  it('needs enough reference stations', () => {
    expect(estimateHelmert(SITES.slice(0, 2), SITES.slice(0, 2))).toBeNull();
  });
});
