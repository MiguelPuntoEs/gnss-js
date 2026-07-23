/**
 * RTK stage 2: integer ambiguity resolution (LAMBDA/MLAMBDA) tests.
 *
 * - `lambdaSearch`/`lambdaReduction` unit tests: decorrelation
 *   properties (unimodular Z, condition number reduction), integer
 *   least-squares optimality against brute force over a lattice box.
 * - `RtkFloatEngine` with `ambiguityResolution: 'instant'` on the
 *   synthetic exact-geometry scenario of test/rtk.test.ts: known
 *   integer ambiguities recovered with a saturated ratio, early/noisy
 *   epochs correctly rejected by the ratio test, partial fixing drops
 *   a corrupted low-elevation satellite.
 * - WHU OEM719 short-baseline dataset: fixed solutions at the
 *   centimetre level against the surveyed rover point (oracle
 *   cross-check against RTKLIB rnx2rtkp lives in oracle-rtkfix.tmp.mjs).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { RtkFloatEngine, toRtkEpoch } from '../src/positioning/rtk';
import type {
  RtkMeasurement,
  RtkEpochMeasurements,
} from '../src/positioning/rtk';
import { lambdaSearch, lambdaReduction } from '../src/positioning/lambda';
import { satClockCorrection } from '../src/positioning';
import { computeSatPosition, ecefToAzEl } from '../src/orbit';
import type { Ephemeris, KeplerEphemeris } from '../src/rinex/nav';
import { geodeticToEcef, getEnuDifference } from '../src/coordinates/ecef';
import { C_LIGHT, OMEGA_E } from '../src/constants/gnss';
import { parseNovatelRange, parseNovatelNav } from '../src/novatel';

/* ================================================================== */
/*  Small dense helpers (test-local)                                   */
/* ================================================================== */

/** Invert a small square matrix (Gauss-Jordan, partial pivoting). */
function inv(A: readonly (readonly number[])[]): number[][] {
  const n = A.length;
  const M = A.map((row, i) => {
    const r = [...row, ...new Array<number>(n).fill(0)];
    r[n + i] = 1;
    return r;
  });
  for (let col = 0; col < n; col++) {
    let p = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(M[r]![col]!) > Math.abs(M[p]![col]!)) p = r;
    [M[col], M[p]] = [M[p]!, M[col]!];
    const d = M[col]![col]!;
    for (let c = 0; c < 2 * n; c++) M[col]![c]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]!;
      for (let c = 0; c < 2 * n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  return M.map((row) => row.slice(n));
}

/** Quadratic form (a−z)ᵀ·Qinv·(a−z). */
function qform(
  a: readonly number[],
  z: readonly number[],
  Qinv: readonly (readonly number[])[]
): number {
  const n = a.length;
  let s = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      s += (a[i]! - z[i]!) * Qinv[i]![j]! * (a[j]! - z[j]!);
  return s;
}

/** Brute-force ILS over the lattice box round(a) ± box, sorted by s. */
function bruteForce(
  a: readonly number[],
  Q: readonly (readonly number[])[],
  box: number
): { z: number[]; s: number }[] {
  const n = a.length;
  const Qinv = inv(Q);
  const out: { z: number[]; s: number }[] = [];
  const z = new Array<number>(n).fill(0);
  const rec = (i: number): void => {
    if (i === n) {
      out.push({ z: [...z], s: qform(a, z, Qinv) });
      return;
    }
    const c = Math.round(a[i]!);
    for (let d = -box; d <= box; d++) {
      z[i] = c + d;
      rec(i + 1);
    }
  };
  rec(0);
  out.sort((p, q) => p.s - q.s);
  return out;
}

/** Eigenvalues of a symmetric matrix by cyclic Jacobi rotations. */
function symEig(A: readonly (readonly number[])[]): number[] {
  const n = A.length;
  const M = A.map((r) => [...r]);
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) off += M[i]![j]! * M[i]![j]!;
    if (off < 1e-24) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(M[p]![q]!) < 1e-18) continue;
        const theta = (M[q]![q]! - M[p]![p]!) / (2 * M[p]![q]!);
        const t =
          Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const mkp = M[k]![p]!;
          const mkq = M[k]![q]!;
          M[k]![p] = c * mkp - s * mkq;
          M[k]![q] = s * mkp + c * mkq;
        }
        for (let k = 0; k < n; k++) {
          const mpk = M[p]![k]!;
          const mqk = M[q]![k]!;
          M[p]![k] = c * mpk - s * mqk;
          M[q]![k] = s * mpk + c * mqk;
        }
      }
  }
  return Array.from({ length: n }, (_, i) => M[i]![i]!);
}

function condition(A: readonly (readonly number[])[]): number {
  const ev = symEig(A).map(Math.abs);
  return Math.max(...ev) / Math.min(...ev);
}

const flat = (A: readonly (readonly number[])[]): Float64Array => {
  // Column-major; symmetric inputs make the layout moot, Z is not.
  const n = A.length;
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) out[i + j * n] = A[i]![j]!;
  return out;
};

/** Qz = Zᵀ·Q·Z with Z column-major flat (as lambdaReduction returns). */
function transformed(
  Q: readonly (readonly number[])[],
  Zflat: Float64Array
): number[][] {
  const n = Q.length;
  const Z: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => Zflat[i + j * n]!)
  );
  const out = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++)
        for (let l = 0; l < n; l++) s += Z[k]![i]! * Q[k]![l]! * Z[l]![j]!;
      out[i]![j] = s;
    }
  return out;
}

/** Integer determinant by fraction-free elimination (small n). */
function det(A: readonly (readonly number[])[]): number {
  const n = A.length;
  const M = A.map((r) => [...r]);
  let d = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (M[p]![c] === 0) return 0;
    if (p !== c) {
      [M[c], M[p]] = [M[p]!, M[c]!];
      d = -d;
    }
    d *= M[c]![c]!;
    for (let r = c + 1; r < n; r++) {
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k < n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return d;
}

/* ================================================================== */
/*  lambdaSearch / lambdaReduction                                     */
/* ================================================================== */

describe('lambdaSearch', () => {
  it('solves the trivial diagonal case by rounding', () => {
    const a = Float64Array.from([1.2, -0.8, 3.1]);
    const Q = flat([
      [0.25, 0, 0],
      [0, 0.25, 0],
      [0, 0, 0.25],
    ]);
    const res = lambdaSearch(a, Q, 3, 2)!;
    expect(res).not.toBeNull();
    expect([...res.candidates[0]!]).toEqual([1, -1, 3]);
    // s1 = (0.2² + 0.2² + 0.1²)/0.25
    expect(res.residuals[0]!).toBeCloseTo(0.36, 10);
    expect(res.ratio).toBeGreaterThan(1);
  });

  it('matches brute force on the classic 3D LAMBDA example', () => {
    // De Jonge & Tiberius (1996) / Teunissen LAMBDA demo problem.
    const Q = [
      [6.29, 5.978, 0.544],
      [5.978, 6.292, 2.34],
      [0.544, 2.34, 6.288],
    ];
    const a = [5.45, 3.1, 2.97];
    const bf = bruteForce(a, Q, 10);
    const res = lambdaSearch(Float64Array.from(a), flat(Q), 3, 2)!;
    expect(res).not.toBeNull();
    expect([...res.candidates[0]!]).toEqual(bf[0]!.z);
    expect([...res.candidates[1]!]).toEqual(bf[1]!.z);
    expect(res.residuals[0]!).toBeCloseTo(bf[0]!.s, 8);
    expect(res.residuals[1]!).toBeCloseTo(bf[1]!.s, 8);
    expect(res.ratio).toBeCloseTo(bf[1]!.s / bf[0]!.s, 8);
  });

  it('finds the ILS minimizer on a correlated 5D problem', () => {
    // Strongly correlated PD covariance (outer products + jitter):
    // naive rounding of `a` is NOT the minimizer here.
    const g1 = [1, 0.9, 0.8, 0.7, 0.6];
    const g2 = [0.2, -0.4, 0.6, -0.8, 1.0];
    const n = 5;
    const Q: number[][] = Array.from({ length: n }, (_, i) =>
      Array.from(
        { length: n },
        (_, j) =>
          4 * g1[i]! * g1[j]! + 1.5 * g2[i]! * g2[j]! + (i === j ? 0.05 : 0)
      )
    );
    const a = [0.4, -1.45, 2.38, 0.55, -0.51];
    const bf = bruteForce(a, Q, 4);
    const res = lambdaSearch(Float64Array.from(a), flat(Q), n, 2)!;
    expect(res).not.toBeNull();
    expect([...res.candidates[0]!]).toEqual(bf[0]!.z);
    expect(res.residuals[0]!).toBeCloseTo(bf[0]!.s, 8);
    expect([...res.candidates[1]!]).toEqual(bf[1]!.z);
    expect(res.residuals[1]!).toBeCloseTo(bf[1]!.s, 8);
    // Plain rounding must be strictly worse (the decorrelation earns
    // its keep on this one).
    const rounded = a.map(Math.round);
    expect(rounded).not.toEqual(bf[0]!.z);
  });

  it('returns Infinity ratio for a noise-free (on-integer) input', () => {
    const a = Float64Array.from([2, -5, 11]);
    const Q = flat([
      [0.1, 0.02, 0],
      [0.02, 0.1, 0.01],
      [0, 0.01, 0.1],
    ]);
    const res = lambdaSearch(a, Q, 3, 2)!;
    expect([...res.candidates[0]!]).toEqual([2, -5, 11]);
    expect(res.residuals[0]!).toBe(0);
    expect(res.ratio).toBe(Infinity);
  });

  it('rejects a non-positive-definite covariance', () => {
    const Q = flat([
      [1, 2],
      [2, 1], // eigenvalues 3, −1
    ]);
    expect(lambdaSearch(Float64Array.from([0.3, 0.7]), Q, 2)).toBeNull();
    expect(lambdaReduction(Q, 2)).toBeNull();
  });
});

describe('lambdaReduction', () => {
  it('produces a unimodular Z that reduces the condition number', () => {
    const g1 = [1, 0.95, 0.9, 0.85, 0.8, 0.75];
    const g2 = [0.1, -0.3, 0.5, -0.7, 0.9, -1.1];
    const n = 6;
    const Q: number[][] = Array.from({ length: n }, (_, i) =>
      Array.from(
        { length: n },
        (_, j) =>
          9 * g1[i]! * g1[j]! + 2 * g2[i]! * g2[j]! + (i === j ? 0.001 : 0)
      )
    );
    const Zf = lambdaReduction(flat(Q), n)!;
    expect(Zf).not.toBeNull();
    const Z: number[][] = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => Zf[i + j * n]!)
    );
    // Unimodular: all-integer entries, |det| = 1.
    for (const row of Z)
      for (const v of row) expect(Number.isInteger(v)).toBe(true);
    expect(Math.abs(det(Z))).toBeCloseTo(1, 6);
    // Decorrelation: cond(ZᵀQZ) ≪ cond(Q).
    const condQ = condition(Q);
    const condZ = condition(transformed(Q, Zf));
    expect(condQ).toBeGreaterThan(1e4); // the test case is genuinely nasty
    expect(condZ).toBeLessThan(condQ / 100);
  });
});

/* ================================================================== */
/*  Synthetic scenario (same construction as test/rtk.test.ts)         */
/* ================================================================== */

const GPS_EPOCH = Date.UTC(1980, 0, 6);
const T0 = Date.UTC(2025, 2, 26, 4, 0, 0); // GPS-scale epoch ms
const sowOf = (ms: number) => ((ms - GPS_EPOCH) / 1000) % 604800;
const weekOf = (ms: number) => Math.floor((ms - GPS_EPOCH) / (604800 * 1000));

const BASE = geodeticToEcef(
  (30.53 * Math.PI) / 180,
  (114.36 * Math.PI) / 180,
  40
);
const TRUE_BASELINE: [number, number, number] = [3.2, -2.4, 1.7];
const ROVER: [number, number, number] = [
  BASE[0] + TRUE_BASELINE[0],
  BASE[1] + TRUE_BASELINE[1],
  BASE[2] + TRUE_BASELINE[2],
];

function kepler(prn: string, m0: number, omega0: number): KeplerEphemeris {
  return {
    system: prn[0] as 'G' | 'E' | 'C',
    prn,
    toc: sowOf(T0),
    tocDate: new Date(T0),
    af0: 0,
    af1: 0,
    af2: 0,
    iode: 1,
    crs: 0,
    deltaN: 0,
    m0,
    cuc: 0,
    e: 0,
    cus: 0,
    sqrtA: Math.sqrt(26559800),
    toe: sowOf(T0),
    cic: 0,
    omega0,
    cis: 0,
    i0: 0.9617,
    crc: 0,
    omega: 0,
    omegaDot: 0,
    idot: 0,
    week: weekOf(T0),
    svHealth: 0,
    tgd: 0,
  };
}

function visibleKepler(sysPrefix: string, count: number): KeplerEphemeris[] {
  const out: { eph: KeplerEphemeris; el: number }[] = [];
  let n = 1;
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 6; j++) {
      const eph = kepler(
        `${sysPrefix}${String(n).padStart(2, '0')}`,
        (i * Math.PI) / 6,
        (j * Math.PI) / 3
      );
      const s = computeSatPosition(eph, T0);
      const el = ecefToAzEl(BASE[0], BASE[1], BASE[2], s.x, s.y, s.z).el;
      if (el > (20 * Math.PI) / 180) {
        out.push({ eph, el });
        n++;
      }
    }
  }
  out.sort((a, b) => b.el - a.el);
  return out.slice(0, count).map((o, i) => ({
    ...o.eph,
    prn: `${sysPrefix}${String(i + 1).padStart(2, '0')}`,
  }));
}

function sagnac(
  pos: { x: number; y: number; z: number },
  travelS: number
): [number, number, number] {
  const th = OMEGA_E * travelS;
  const c = Math.cos(th);
  const s = Math.sin(th);
  return [pos.x * c + pos.y * s, -pos.x * s + pos.y * c, pos.z];
}

function synth(
  eph: Ephemeris,
  rx: readonly [number, number, number],
  timeMs: number,
  o: {
    code: string;
    clockM: number;
    lambdaM: number;
    ambCycles?: number;
    phaseBiasCycles?: number;
    lockTimeMs?: number;
    prNoiseM?: number;
    cpNoiseCycles?: number;
  }
): RtkMeasurement {
  let pr = 2.4e7;
  let rho = 0;
  for (let i = 0; i < 10; i++) {
    const tTx = timeMs - (pr / C_LIGHT) * 1000;
    const dts = satClockCorrection(eph, tTx);
    const sat = computeSatPosition(eph, tTx - dts * 1000);
    const travel =
      Math.hypot(sat.x - rx[0], sat.y - rx[1], sat.z - rx[2]) / C_LIGHT;
    const [sx, sy, sz] = sagnac(sat, travel);
    rho = Math.hypot(sx - rx[0], sy - rx[1], sz - rx[2]);
    pr = rho + o.clockM;
  }
  return {
    code: o.code,
    pr: pr + (o.prNoiseM ?? 0),
    cp:
      (rho + o.clockM) / o.lambdaM +
      (o.phaseBiasCycles ?? 0) +
      (o.ambCycles ?? 0) +
      (o.cpNoiseCycles ?? 0),
    lockTimeMs: o.lockTimeMs ?? 600_000,
    gloChannel: null,
  };
}

const L1 = C_LIGHT / 1575.42e6;

interface Scenario {
  ephs: Ephemeris[];
  amb: Record<string, number>;
}

function gpsGalScenario(): Scenario {
  const ephs = [...visibleKepler('G', 6), ...visibleKepler('E', 5)];
  const amb: Record<string, number> = {};
  ephs.forEach((e, i) => {
    amb[e.prn] = ((i * 37) % 25) - 12;
  });
  return { ephs, amb };
}

/** Deterministic PRNG (mulberry32), iterated for an iid stream. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Precomputed iid noise draws in (−1, 1): NRND[k][s] = [base pr,
 * base cp, rover pr, rover cp] for epoch k, satellite index s.
 * (A single iterated stream — hashing structured (k, s) seeds through
 * one mixing round produces correlated draws and biased DD noise.)
 */
const NRND = (() => {
  const rnd = mulberry32(0xc0ffee);
  const out: number[][][] = [];
  for (let k = 0; k < 200; k++) {
    const row: number[][] = [];
    for (let s = 0; s < 16; s++)
      row.push([rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]);
    out.push(row);
  }
  return out;
})();

function makeEpoch(
  sc: Scenario,
  timeMs: number,
  opts: {
    noise?: boolean;
    cpBiasCycles?: Record<string, number>;
  } = {}
): { rover: Map<string, RtkMeasurement>; base: Map<string, RtkMeasurement> } {
  const rover = new Map<string, RtkMeasurement>();
  const base = new Map<string, RtkMeasurement>();
  const lock = 600_000 + (timeMs - T0);
  const k = Math.round((timeMs - T0) / 1000);
  sc.ephs.forEach((eph, s) => {
    const sys = eph.prn[0]!;
    const clockBase = sys === 'G' ? 150 : 210;
    const clockRover = sys === 'G' ? -80 : -35;
    base.set(
      eph.prn,
      synth(eph, BASE, timeMs, {
        code: '1C',
        clockM: clockBase,
        lambdaM: L1,
        phaseBiasCycles: 0.31,
        lockTimeMs: lock,
        prNoiseM: opts.noise ? 0.1 * NRND[k]![s]![0]! : 0,
        cpNoiseCycles: opts.noise ? 0.02 * NRND[k]![s]![1]! : 0,
      })
    );
    rover.set(
      eph.prn,
      synth(eph, ROVER, timeMs, {
        code: '1C',
        clockM: clockRover,
        lambdaM: L1,
        phaseBiasCycles: -0.72,
        ambCycles: sc.amb[eph.prn]! + (opts.cpBiasCycles?.[eph.prn] ?? 0),
        lockTimeMs: lock,
        prNoiseM: opts.noise ? 0.1 * NRND[k]![s]![2]! : 0,
        cpNoiseCycles: opts.noise ? 0.02 * NRND[k]![s]![3]! : 0,
      })
    );
  });
  return { rover, base };
}

function expectDd(sc: Scenario, refs: Record<string, string>, prn: string) {
  const ref = refs[prn[0] + '1C']!;
  return sc.amb[prn]! - sc.amb[ref]!;
}

/* ================================================================== */
/*  RtkFloatEngine + instant AR (synthetic)                            */
/* ================================================================== */

describe('RtkFloatEngine instant ambiguity resolution (synthetic)', () => {
  const sc = gpsGalScenario();

  it('fixes the exact scenario with a saturated ratio and true integers', () => {
    const engine = new RtkFloatEngine(BASE, sc.ephs, {
      mode: 'static',
      troposphere: false,
      ambiguityResolution: 'instant',
    });
    let sol = null;
    for (let k = 0; k < 4; k++) {
      const t = T0 + k * 1000;
      const { rover, base } = makeEpoch(sc, t);
      sol = engine.process(rover, base, t);
    }
    expect(sol).not.toBeNull();
    expect(sol!.status).toBe('fixed');
    // Noise-free: best residual is 0 → ratio saturates at the cap.
    expect(sol!.ratio).toBe(999.9);
    // 11 satellites − 2 references = 9 DD ambiguities, all fixed.
    expect(sol!.nFixed).toBe(9);
    // Every fixed DD ambiguity equals the constructed integer.
    expect(sol!.fixedAmbiguities).toBeDefined();
    for (const [prn, n] of Object.entries(sol!.fixedAmbiguities!)) {
      expect(n).toBe(expectDd(sc, sol!.refSatellites, prn));
    }
    // Fixed position/baseline exact to numerical precision.
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(sol!.position[i]! - ROVER[i]!)).toBeLessThan(1e-3);
      expect(
        Math.abs(sol!.fixedBaseline![i]! - TRUE_BASELINE[i]!)
      ).toBeLessThan(1e-3);
    }
  });

  it('leaves the stage-1 float behaviour untouched when AR is off', () => {
    const engine = new RtkFloatEngine(BASE, sc.ephs, {
      mode: 'static',
      troposphere: false,
    });
    let sol = null;
    for (let k = 0; k < 3; k++) {
      const t = T0 + k * 1000;
      const { rover, base } = makeEpoch(sc, t);
      sol = engine.process(rover, base, t);
    }
    expect(sol!.status).toBe('float');
    expect(sol!.ratio).toBeUndefined();
    expect(sol!.nFixed).toBeUndefined();
    expect(sol!.fixedBaseline).toBeUndefined();
  });

  it('ratio test rejects while the float covariance is still wide', () => {
    // With measurement noise, the first phase epoch cannot separate
    // the best and second-best integer sets — the ratio must stay
    // low and the solution float. A wrong fix here is the cardinal
    // sin the ratio test exists to prevent.
    const engine = new RtkFloatEngine(BASE, sc.ephs, {
      mode: 'static',
      troposphere: false,
      codeSigmaM: 0.1,
      ambiguityResolution: 'instant',
      partialFixing: false,
    });
    const t0 = T0;
    const e0 = makeEpoch(sc, t0, { noise: true });
    engine.process(e0.rover, e0.base, t0); // DGNSS init epoch
    const t1 = T0 + 1000;
    const e1 = makeEpoch(sc, t1, { noise: true });
    const sol = engine.process(e1.rover, e1.base, t1);
    expect(sol).not.toBeNull();
    expect(sol!.status).toBe('float');
    expect(sol!.ratio).toBeDefined();
    expect(sol!.ratio!).toBeLessThan(3);
    expect(sol!.fixedBaseline).toBeUndefined();
  });

  it('converges to a fix through noise as epochs accumulate', () => {
    const engine = new RtkFloatEngine(BASE, sc.ephs, {
      mode: 'static',
      troposphere: false,
      codeSigmaM: 0.1,
      ambiguityResolution: 'instant',
    });
    let sol = null;
    let fixedAt = -1;
    let wrongFixes = 0;
    for (let k = 0; k < 60; k++) {
      const t = T0 + k * 1000;
      const { rover, base } = makeEpoch(sc, t, { noise: true });
      sol = engine.process(rover, base, t);
      if (sol?.status === 'fixed') {
        if (fixedAt < 0) fixedAt = k;
        // Every fixed integer, on every fixed epoch, must be true —
        // wrong fixes are the cardinal sin.
        for (const [prn, n] of Object.entries(sol.fixedAmbiguities!)) {
          if (n !== expectDd(sc, sol.refSatellites, prn)) wrongFixes++;
        }
      }
    }
    expect(sol!.status).toBe('fixed');
    expect(sol!.nFixed).toBe(9);
    expect(fixedAt).toBeGreaterThan(2); // not before evidence accrues
    expect(wrongFixes).toBe(0);
    for (let i = 0; i < 3; i++)
      expect(Math.abs(sol!.position[i]! - ROVER[i]!)).toBeLessThan(0.02);
  });

  it('partial fixing drops a corrupted low-elevation satellite', () => {
    // Give the lowest-elevation satellite a constant NON-integer
    // "true" ambiguity (integer + 0.4 cycles — a stand-in for an
    // uncalibrated bias): the full set then has no clean integer
    // solution and fails the ratio test, but the elevation-ordered
    // walk recovers a fix on a clean subset. The scenario's elevation
    // grid has exact ties, so the walk may shed a tied clean
    // satellite before the corrupted one — the invariants are that a
    // fix IS recovered, the corrupted satellite is NOT in it, and
    // every fixed integer is true.
    const els = sc.ephs.map((e) => {
      const s = computeSatPosition(e, T0);
      return {
        prn: e.prn,
        el: ecefToAzEl(BASE[0], BASE[1], BASE[2], s.x, s.y, s.z).el,
      };
    });
    els.sort((a, b) => a.el - b.el);
    const worst = els[0]!.prn;
    const engine = new RtkFloatEngine(BASE, sc.ephs, {
      mode: 'static',
      troposphere: false,
      ambiguityResolution: 'instant',
    });
    let sol = null;
    for (let k = 0; k < 4; k++) {
      const t = T0 + k * 1000;
      const { rover, base } = makeEpoch(sc, t, {
        cpBiasCycles: { [worst]: 0.4 },
      });
      sol = engine.process(rover, base, t);
    }
    expect(sol!.status).toBe('fixed');
    expect(sol!.nFixed).toBeGreaterThanOrEqual(6); // ≥ 6 of 9 candidates
    expect(sol!.nFixed).toBeLessThan(9); // the full set must NOT fix
    expect(sol!.fixedAmbiguities![worst]).toBeUndefined();
    for (const [prn, n] of Object.entries(sol!.fixedAmbiguities!)) {
      expect(n).toBe(expectDd(sc, sol!.refSatellites, prn));
    }
    for (let i = 0; i < 3; i++)
      expect(Math.abs(sol!.position[i]! - ROVER[i]!)).toBeLessThan(1e-3);

    // Without partial fixing the same scenario must NOT fix.
    const engine2 = new RtkFloatEngine(BASE, sc.ephs, {
      mode: 'static',
      troposphere: false,
      ambiguityResolution: 'instant',
      partialFixing: false,
    });
    let sol2 = null;
    for (let k = 0; k < 4; k++) {
      const t = T0 + k * 1000;
      const { rover, base } = makeEpoch(sc, t, {
        cpBiasCycles: { [worst]: 0.4 },
      });
      sol2 = engine2.process(rover, base, t);
    }
    expect(sol2!.status).toBe('float');
    expect(sol2!.ratio!).toBeLessThan(3);
  });
});

/* ================================================================== */
/*  Dataset: WHU OEM719 short baseline (2025-03-26), instant AR        */
/* ================================================================== */

const BASE_FIX = join(__dirname, '../test-fixtures/oem719_rtk_base.gps');
const ROVER_FIX = join(__dirname, '../test-fixtures/oem719_rtk_rover.gps');

const WHU_BASE: [number, number, number] = [
  -2267335.669351269, 5008649.155499206, 3222374.973582075,
];
const WHU_ROVER_TRUTH: [number, number, number] = [
  -2267808.336856440175, 5009321.489190992899, 3221021.847353241406,
];

describe.skipIf(!existsSync(BASE_FIX) || !existsSync(ROVER_FIX))(
  'WHU OEM719 short-baseline dataset (instant AR)',
  () => {
    const ready = existsSync(BASE_FIX) && existsSync(ROVER_FIX);
    const pairs: {
      t: number;
      rover: RtkEpochMeasurements;
      base: RtkEpochMeasurements;
    }[] = [];
    let ephs: Ephemeris[] = [];
    if (ready) {
      const baseRaw = new Uint8Array(readFileSync(BASE_FIX));
      const roverRaw = new Uint8Array(readFileSync(ROVER_FIX));
      const baseObs = parseNovatelRange(baseRaw);
      const roverObs = parseNovatelRange(roverRaw);
      ephs = [
        ...parseNovatelNav(baseRaw).ephemerides,
        ...parseNovatelNav(roverRaw).ephemerides,
      ];
      const baseByTime = new Map(baseObs.epochs.map((e) => [e.timeMs, e.meas]));
      const seen = new Set<number>();
      for (const e of roverObs.epochs) {
        if (seen.has(e.timeMs)) continue;
        seen.add(e.timeMs);
        const b = baseByTime.get(e.timeMs);
        if (!b) continue;
        pairs.push({
          t: e.timeMs,
          rover: toRtkEpoch(e.meas),
          base: toRtkEpoch(b),
        });
      }
    }

    it('fixes kinematic epochs at the centimetre level vs the survey', () => {
      const engine = new RtkFloatEngine(WHU_BASE, ephs, {
        mode: 'kinematic',
        elevationMaskDeg: 15,
        ambiguityResolution: 'instant',
      });
      let nSol = 0;
      let nFixedEpochs = 0;
      let sumH = 0;
      let sumV = 0;
      let maxH = 0;
      for (const p of pairs) {
        const sol = engine.process(p.rover, p.base, p.t);
        if (!sol) continue;
        nSol++;
        if (sol.status !== 'fixed') continue;
        nFixedEpochs++;
        const [dE, dN, dU] = getEnuDifference(
          sol.position[0],
          sol.position[1],
          sol.position[2],
          WHU_ROVER_TRUTH[0],
          WHU_ROVER_TRUTH[1],
          WHU_ROVER_TRUTH[2]
        );
        const h = Math.hypot(dE, dN);
        sumH += h * h;
        sumV += dU * dU;
        if (h > maxH) maxH = h;
      }
      expect(nSol).toBeGreaterThanOrEqual(100);
      // Instant AR without hold: most epochs of the window must fix
      // once the float filter has converged (measured: 96% with the
      // first fix ~6 s in; RTKLIB rnx2rtkp instant AR fixes 100% of
      // this window — see oracle-rtkfix.tmp.mjs).
      expect(nFixedEpochs / nSol).toBeGreaterThan(0.8);
      // Fixed-solution accuracy vs the surveyed point (measured:
      // 0.9 cm horizontal RMS, 3.9 cm vertical RMS, 2.7 cm max
      // horizontal — asserted with margin). A fixed epoch beyond
      // ~5 cm horizontal would indicate a wrong fix.
      expect(Math.sqrt(sumH / nFixedEpochs)).toBeLessThan(0.02);
      expect(Math.sqrt(sumV / nFixedEpochs)).toBeLessThan(0.08);
      expect(maxH).toBeLessThan(0.05); // no wrong fixes
    });
  }
);
