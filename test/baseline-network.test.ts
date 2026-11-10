import { describe, expect, it } from 'vitest';
import {
  adjustBaselineNetwork,
  loopMisclosures,
  type BaselineObservation,
} from '../src/analysis/baseline-network';

type V = [number, number, number];
// A small deformation network (~2 km), ECEF.
const P: Record<string, V> = {
  REF: [4000000, 900000, 4800000],
  A: [4001200, 900400, 4799100],
  B: [3999300, 901500, 4800800],
  C: [4000700, 899200, 4800300],
};
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cov = (s = 0.002): number[][] => [
  [s * s, 0, 0],
  [0, s * s, 0],
  [0, 0, (2 * s) ** 2],
];
// Seeded Gaussian.
let seed = 11;
const uni = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = () =>
  Math.sqrt(-2 * Math.log(uni() + 1e-12)) * Math.cos(2 * Math.PI * uni());

function observe(pairs: [string, string][], noise = 0): BaselineObservation[] {
  return pairs.map(([f, t]) => {
    const c = cov();
    const v = sub(P[t]!, P[f]!);
    return {
      from: f,
      to: t,
      vector: [0, 1, 2].map(
        (i) => v[i]! + noise * Math.sqrt(c[i]![i]!) * gauss()
      ) as V,
      covariance: c,
    };
  });
}
const ALL: [string, string][] = [
  ['REF', 'A'],
  ['REF', 'B'],
  ['REF', 'C'],
  ['A', 'B'],
  ['A', 'C'],
  ['B', 'C'],
];
const fixed = new Map([['REF', P.REF!]]);

describe('adjustBaselineNetwork', () => {
  it('recovers the truth exactly from consistent baselines', () => {
    const r = adjustBaselineNetwork(fixed, observe(ALL));
    for (const p of ['A', 'B', 'C'])
      for (let i = 0; i < 3; i++)
        expect(r.points.get(p)!.ecef[i]).toBeCloseTo(P[p]![i]!, 6);
    expect(r.redundancy).toBe(9); // 6 baselines × 3 − 3 points × 3
    expect(r.baselines.every((b) => b.status === 'used')).toBe(true);
    expect(r.loops).toHaveLength(3);
    for (const l of r.loops) expect(l.lengthM).toBeLessThan(1e-9);
  });

  it('gives σ̂₀² ≈ 1 and a passing χ² test with correctly weighted noise', () => {
    let s = 0;
    let pass = 0;
    for (let rep = 0; rep < 200; rep++) {
      const r = adjustBaselineNetwork(fixed, observe(ALL, 1), { snoop: false });
      s += r.sigma0sq;
      if (r.chi2!.pass) pass++;
    }
    expect(s / 200).toBeGreaterThan(0.85);
    expect(s / 200).toBeLessThan(1.15);
    expect(pass / 200).toBeGreaterThan(0.9); // α = 0.05
  });

  it('rarely rejects a good baseline, even with optimistic covariances', () => {
    let rejected = 0;
    let s0 = 0;
    for (let rep = 0; rep < 200; rep++) {
      // True noise 5× the stated sigmas (typical of formal GNSS covariances).
      const r = adjustBaselineNetwork(fixed, observe(ALL, 5));
      rejected += r.baselines.filter((b) => b.status === 'rejected').length;
      s0 += r.sigma0sq;
    }
    expect(rejected / 200).toBeLessThan(0.15); // baselines per network
    expect(s0 / 200).toBeGreaterThan(18); // ≈ 25, and it rescales the result
    const r = adjustBaselineNetwork(fixed, observe(ALL, 5));
    expect(r.points.get('A')!.covariance[0]![0]).toBeGreaterThan(
      4 * 1e-6 // scaled above the unscaled formal variance
    );
  });

  it('finds and drops a 5 cm blunder, and the loops show it', () => {
    const obs = observe(ALL, 1);
    obs[4]!.vector[2] += 0.05; // A→C
    const loops = loopMisclosures(obs);
    expect(Math.max(...loops.map((l) => l.lengthM))).toBeGreaterThan(0.03);
    const r = adjustBaselineNetwork(fixed, obs);
    expect(r.baselines[4]!.status).toBe('rejected');
    expect(r.baselines.filter((b) => b.status === 'rejected')).toHaveLength(1);
    for (let i = 0; i < 3; i++)
      expect(Math.abs(r.points.get('C')!.ecef[i]! - P.C![i]!)).toBeLessThan(
        0.01
      );
  });

  it('never rejects a baseline a point depends on; flags unconnected points', () => {
    const obs = observe([
      ['REF', 'A'],
      ['B', 'C'],
    ]);
    obs[0]!.vector[0] += 1; // a blunder, but A's only link
    const r = adjustBaselineNetwork(fixed, obs);
    expect(r.baselines[0]!.status).toBe('used');
    expect(r.redundancy).toBe(0);
    expect(r.chi2).toBeNull();
    expect(r.unconnected.sort()).toEqual(['B', 'C']);
    expect(r.baselines[1]!.status).toBe('unconnected');
  });

  it('closes loops in either baseline direction', () => {
    const obs = observe([
      ['A', 'REF'],
      ['REF', 'B'],
      ['B', 'A'],
      ['C', 'B'],
      ['REF', 'C'],
    ]);
    const loops = loopMisclosures(obs);
    expect(loops).toHaveLength(2);
    for (const l of loops) {
      expect(l.lengthM).toBeLessThan(1e-9);
      expect(l.points[0]).toBe(l.points[l.points.length - 1]);
    }
  });
});
