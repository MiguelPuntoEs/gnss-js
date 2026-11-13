import { describe, expect, it } from 'vitest';
import { selectBaselines } from '../src/analysis/baseline-selection';
import { solveDdNetwork } from '../src/positioning/dd-network';
import type {
  PppEpoch,
  PppEphemerisSource,
  SatSample,
} from '../src/positioning/ppp';
import { niellMapping } from '../src/positioning/ppp-tropo';
import { C_LIGHT, OMEGA_E } from '../src/constants/gnss';
import {
  ecefToGeodetic,
  geodeticToEcef,
  getAer,
} from '../src/coordinates/ecef';

type V = [number, number, number];

describe('selectBaselines', () => {
  const st = [
    { id: 'A', ecef: [0, 0, 0] as V },
    { id: 'B', ecef: [100e3, 0, 0] as V },
    { id: 'C', ecef: [200e3, 0, 0] as V },
    { id: 'D', ecef: [100e3, 50e3, 0] as V },
  ];
  it('shortest: the minimum spanning tree', () => {
    const r = selectBaselines(st, { strategy: 'shortest' });
    expect(r.components).toBe(1);
    expect(r.baselines.map((b) => b.a + b.b).sort()).toEqual([
      'AB',
      'BC',
      'BD',
    ]);
  });
  it('obs-max: maximises common observations, n − 1 independent baselines', () => {
    const common: Record<string, number> = {
      AC: 900,
      AD: 800,
      CD: 700,
      AB: 100,
      BC: 100,
      BD: 600,
    };
    const r = selectBaselines(st, {
      strategy: 'obs-max',
      commonObs: (a, b) => common[a + b] ?? 0,
    });
    expect(r.baselines.map((b) => b.a + b.b)).toEqual(['AC', 'AD', 'BD']);
  });
  it('reports a split network', () => {
    const r = selectBaselines(st, {
      commonObs: (a, b) => (a + b === 'AB' || a + b === 'CD' ? 5 : 0),
    });
    expect(r.components).toBe(2);
  });
});

// --- Simulated network: Walker GPS-like constellation, three stations ---
const F1 = 1575.42e6;
const F2 = 1227.6e6;
const A_ORB = 26_560e3;
const N_ORB = Math.sqrt(3.986004418e14 / A_ORB ** 3);

function satInertial(k: number, t: number): V {
  const plane = k % 6;
  const slot = Math.floor(k / 6);
  const raan = (plane * Math.PI) / 3;
  const inc = (55 * Math.PI) / 180;
  const u = N_ORB * t + (slot * Math.PI) / 2 + (plane * Math.PI) / 12;
  const x = A_ORB * Math.cos(u);
  const y = A_ORB * Math.sin(u);
  const yi = y * Math.cos(inc);
  const z = y * Math.sin(inc);
  return [
    x * Math.cos(raan) - yi * Math.sin(raan),
    x * Math.sin(raan) + yi * Math.cos(raan),
    z,
  ];
}
/** ECEF at GPS time t (ms). */
function satEcef(k: number, tMs: number): V {
  const t = tMs / 1000;
  const [x, y, z] = satInertial(k, t);
  const th = OMEGA_E * t;
  return [
    x * Math.cos(th) + y * Math.sin(th),
    -x * Math.sin(th) + y * Math.cos(th),
    z,
  ];
}
const prnOf = (k: number) => `G${String(k + 1).padStart(2, '0')}`;
const source: PppEphemerisSource = {
  satState(prn: string, tMs: number): SatSample {
    const k = Number(prn.slice(1)) - 1;
    const p = satEcef(k, tMs);
    const a = satEcef(k, tMs + 500);
    const b = satEcef(k, tMs - 500);
    return {
      x: p[0],
      y: p[1],
      z: p[2],
      vx: a[0] - b[0],
      vy: a[1] - b[1],
      vz: a[2] - b[2],
      clkS: 0,
    };
  },
};

let seed = 7;
const uni = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = () =>
  Math.sqrt(-2 * Math.log(uni() + 1e-12)) * Math.cos(2 * Math.PI * uni());

function simulate(
  truth: V,
  zwd: (t: number) => number,
  t0: number,
  hours: number
): PppEpoch[] {
  const [lat, , h] = ecefToGeodetic(...truth);
  const lam1 = C_LIGHT / F1;
  const lam2 = C_LIGHT / F2;
  const n1 = new Map<string, number>();
  const n2 = new Map<string, number>();
  const epochs: PppEpoch[] = [];
  for (let t = t0; t <= t0 + hours * 3.6e6; t += 30_000) {
    const dtr = 1e-4 * Math.sin(t / 1e6); // receiver clock (s)
    const obs: PppEpoch['obs'] = [];
    for (let k = 0; k < 24; k++) {
      const prn = prnOf(k);
      // Light time with Earth rotation.
      let tau = 0.07;
      let p: V = [0, 0, 0];
      for (let i = 0; i < 4; i++) {
        // The receiver's clock is dtr fast: true reception at t − dtr.
        const s = satEcef(k, t - dtr * 1000 - tau * 1000);
        const th = OMEGA_E * tau;
        p = [
          s[0] * Math.cos(th) + s[1] * Math.sin(th),
          -s[0] * Math.sin(th) + s[1] * Math.cos(th),
          s[2],
        ];
        tau =
          Math.hypot(p[0] - truth[0], p[1] - truth[1], p[2] - truth[2]) /
          C_LIGHT;
      }
      const rho = tau * C_LIGHT;
      const [el] = getAer(p[0], p[1], p[2], ...truth);
      if (el < (8 * Math.PI) / 180) continue;
      const st = source.satState(prn, t - dtr * 1000 - tau * 1000);
      const rel =
        (-2 * (st.x * st.vx + st.y * st.vy + st.z * st.vz)) / C_LIGHT ** 2;
      const m = niellMapping(el, lat, h, t);
      const trop = m.zhd * m.mh + zwd(t) * m.mw;
      const iono = (5 / Math.sin(el)) * (1 + 0.3 * Math.sin(t / 7e6 + k)); // m on L1
      const r = rho + C_LIGHT * dtr - C_LIGHT * rel + trop;
      if (!n1.has(prn)) {
        n1.set(prn, Math.round(uni() * 2e6 - 1e6));
        n2.set(prn, Math.round(uni() * 2e6 - 1e6));
      }
      const g2 = (F1 / F2) ** 2;
      obs.push({
        prn,
        f1: F1,
        f2: F2,
        c1: r + iono + 0.3 * gauss(),
        c2: r + iono * g2 + 0.3 * gauss(),
        l1: (r - iono) / lam1 + n1.get(prn)! + 0.002 * gauss(),
        l2: (r - iono * g2) / lam2 + n2.get(prn)! + 0.002 * gauss(),
        slip: false,
      });
    }
    epochs.push({ timeMs: t, obs });
  }
  return epochs;
}

describe('solveDdNetwork (simulated network)', () => {
  const t0 = Date.UTC(2024, 0, 14);
  const deg = Math.PI / 180;
  const truth: Record<string, V> = {
    AAAA: geodeticToEcef(49 * deg, 12 * deg, 600),
    BBBB: geodeticToEcef(52 * deg, 16 * deg, 100),
    CCCC: geodeticToEcef(46 * deg, 7 * deg, 900),
  };
  // A-priori errors with zero mean, so no-net-translation recovers truth.
  const err: Record<string, V> = {
    AAAA: [0.02, -0.01, 0.015],
    BBBB: [-0.01, 0.025, -0.005],
    CCCC: [-0.01, -0.015, -0.01],
  };
  const zwd: Record<string, (t: number) => number> = {
    AAAA: (t) => 0.1 + (0.02 * (t - t0)) / 3.6e7,
    BBBB: (t) => 0.15 - (0.01 * (t - t0)) / 3.6e7,
    CCCC: () => 0.08,
  };
  const inputs = Object.keys(truth).map((id) => ({
    id,
    epochs: simulate(truth[id]!, zwd[id]!, t0, 6),
    apriori: [0, 1, 2].map((i) => truth[id]![i]! + err[id]![i]!) as V,
  }));
  const res = solveDdNetwork(inputs, source, {
    systems: 'G',
    ztdIntervalH: 1,
    gradients: false,
    elevationMaskDeg: 10,
    ar: { minArcS: 1200 },
  });

  it('recovers every station to the mm with ambiguities fixed', () => {
    for (const s of res.stations) {
      const d = s.ecef.map((v, i) => v - truth[s.id]![i]!);
      expect(Math.hypot(...d)).toBeLessThan(0.001);
    }
    expect(res.ar.nlCandidates).toBeGreaterThan(10);
    expect(res.ar.nlFixed / res.ar.nlCandidates).toBeGreaterThan(0.9);
    expect(res.ar.wlFixed / res.ar.wlCandidates).toBeGreaterThan(0.7);
  });

  it('recovers the zenith wet delays', () => {
    for (const s of res.stations)
      for (const z of s.ztd.slice(1, -1)) {
        const [lat, , h] = ecefToGeodetic(...truth[s.id]!);
        const zhd = niellMapping(Math.PI / 2, lat, h, z.tMs).zhd;
        expect(Math.abs(z.ztdM - zhd - zwd[s.id]!(z.tMs))).toBeLessThan(0.01);
      }
  });

  it('outputs constraint-free normal equations of the right shape', () => {
    const n = res.neq.params.length;
    expect(n).toBe(3 * (3 + res.stations[0]!.ztd.length));
    expect(res.neq.N.length).toBe(n * n);
    expect(res.neq.params.slice(0, 3).map((p) => p.type)).toEqual([
      'STAX',
      'STAY',
      'STAZ',
    ]);
    // Symmetric, and the free NEQ is (near-)singular in translation:
    // N·t ≈ 0 for a common shift of every station.
    for (let i = 0; i < n; i++)
      for (let j = 0; j < i; j++)
        expect(
          Math.abs(res.neq.N[i * n + j]! - res.neq.N[j * n + i]!)
        ).toBeLessThan(1e-6 * (1 + Math.abs(res.neq.N[i * n + j]!)));
    const shift = new Float64Array(n);
    res.neq.params.forEach((p, i) => (shift[i] = p.type === 'STAX' ? 1 : 0));
    let nt = 0;
    let nn = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += res.neq.N[i * n + j]! * shift[j]!;
      nt += s * s;
      nn += res.neq.N[i * n + i]! ** 2;
    }
    expect(Math.sqrt(nt / nn)).toBeLessThan(0.05);
    expect(res.solution.sigma0).toBeGreaterThan(0);
  });

  it('the NEQ plus the same datum/ZTD constraints reproduces the solution', () => {
    const { N, b, params, sigma0Apriori: s0 } = res.neq;
    const n = params.length;
    const A = Float64Array.from(N);
    params.forEach((p, i) => {
      if (p.type === 'TROTOT') A[i * n + i]! += (s0 / 1) ** 2;
    });
    // No-net-translation on the a-priori (σ 0.1 mm), as solveDdNetwork does.
    for (const t of ['STAX', 'STAY', 'STAZ']) {
      const idx = params.flatMap((p, i) => (p.type === t ? [i] : []));
      for (const r of idx)
        for (const c of idx) A[r * n + c]! += (s0 / 1e-4) ** 2;
    }
    // Gaussian elimination.
    const x = Float64Array.from(b);
    for (let c = 0; c < n; c++)
      for (let r = c + 1; r < n; r++) {
        const f = A[r * n + c]! / A[c * n + c]!;
        for (let k = c; k < n; k++) A[r * n + k]! -= f * A[c * n + k]!;
        x[r]! -= f * x[c]!;
      }
    for (let r = n - 1; r >= 0; r--) {
      for (let k = r + 1; k < n; k++) x[r]! -= A[r * n + k]! * x[k]!;
      x[r]! /= A[r * n + r]!;
    }
    for (let i = 0; i < n; i++)
      expect(Math.abs(x[i]! - res.solution.dx[i]!)).toBeLessThan(1e-5);
  });
});
