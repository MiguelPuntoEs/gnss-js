import { describe, expect, it } from 'vitest';
import {
  clockSolutionToClk,
  estimateNetworkClocks,
} from '../src/analysis/network-clocks';
import type { PppEphemerisSource, PppEpoch } from '../src/positioning/ppp';
import { niellMapping } from '../src/positioning/ppp-tropo';
import { satStateAtEmission } from '../src/positioning/ppp';
import { getAer, ecefToGeodetic } from '../src/coordinates';
import { parseClk, clkBias } from '../src/rinex/clk';
import { writeClk } from '../src/rinex/clk-writer';

// Synthetic network: true satellite and receiver clocks, a ZWD per station,
// ambiguous phase, no other effects. The estimator must give the satellite
// clocks back relative to the reference station's clock.
const C = 299792458;
const F1 = 1575.42e6;
const F2 = 1227.6e6;
const DEG = Math.PI / 180;
const R = 6371e3;
const T0 = Date.UTC(2024, 0, 14);
const HOURS = 6;

const ecef = (lat: number, lon: number) =>
  [
    R * Math.cos(lat * DEG) * Math.cos(lon * DEG),
    R * Math.cos(lat * DEG) * Math.sin(lon * DEG),
    R * Math.sin(lat * DEG),
  ] as [number, number, number];

const PRNS = Array.from(
  { length: 12 },
  (_, i) => `G${String(i + 1).padStart(2, '0')}`
);
/** True satellite clock (s): offset + drift + a wiggle. */
const satClk = (prn: string, t: number) => {
  const i = Number(prn.slice(1));
  const s = (t - T0) / 1000;
  return (i - 6) * 1e-5 + i * 1e-12 * s + 2e-10 * Math.sin(s / 900 + i);
};
const orbit = (prn: string, t: number) => {
  const i = Number(prn.slice(1)) - 1;
  const a = 26_560e3;
  const u = (2 * Math.PI * (t - T0)) / 43_082_000 + i * 0.52;
  const raan = (i % 6) * 1.05;
  const inc = 55 * DEG;
  const xo = a * Math.cos(u);
  const yo = a * Math.sin(u);
  return [
    xo * Math.cos(raan) - yo * Math.cos(inc) * Math.sin(raan),
    xo * Math.sin(raan) + yo * Math.cos(inc) * Math.cos(raan),
    yo * Math.sin(inc),
  ];
};
const source: PppEphemerisSource = {
  satState(prn, t) {
    const p = orbit(prn, t);
    const q = orbit(prn, t + 500);
    const m = orbit(prn, t - 500);
    return {
      x: p[0]!,
      y: p[1]!,
      z: p[2]!,
      vx: q[0]! - m[0]!,
      vy: q[1]! - m[1]!,
      vz: q[2]! - m[2]!,
      // The a-priori clock is deliberately wrong by a bias + drift: the
      // estimates must not depend on it.
      clkS: satClk(prn, t) + 3e-8 + 1e-12 * ((t - T0) / 1000),
    };
  },
};
const SITES = [
  ['REF0', 50, 10, 1e-4, 0.12],
  ['AAAA', 52, 5, -2e-4, 0.08],
  ['BBBB', 48, 16, 3e-5, 0.15],
  ['CCCC', 60, 25, 5e-4, 0.05],
  ['DDDD', 41, -4, -1e-5, 0.2],
  ['EEEE', 45, 10, 2e-4, 0.1],
] as const;
const rcvClk = (off: number, t: number) =>
  off + 1e-9 * Math.sin((t - T0) / 3.6e6);

function observe(
  lat: number,
  lon: number,
  off: number,
  zwd: number
): PppEpoch[] {
  const rx = ecef(lat, lon);
  const [la, , h] = ecefToGeodetic(rx[0], rx[1], rx[2]);
  const out: PppEpoch[] = [];
  for (let t = T0; t <= T0 + HOURS * 3600_000; t += 30_000) {
    const obs = [];
    for (const prn of PRNS) {
      // Generate with the model the estimator inverts: emission time from
      // the pseudorange itself (iterated), true clocks.
      let geo = 2.2e7;
      let el = 0;
      for (let it = 0; it < 3; it++) {
        const sat = satStateAtEmission(source, prn, t, rx, geo);
        if (!sat) break;
        const s = sat.state;
        el = getAer(s.x, s.y, s.z, rx[0], rx[1], rx[2])[0];
        const range = Math.hypot(s.x - rx[0], s.y - rx[1], s.z - rx[2]);
        const apr = source.satState(prn, t)!;
        // clkM uses the a-priori clock; swap in the true one.
        const trueClkM = s.clkM + C * (satClk(prn, t) - apr.clkS);
        const trop = niellMapping(el, la, h, t);
        geo =
          range -
          trueClkM +
          C * rcvClk(off, t) +
          trop.zhd * trop.mh +
          zwd * trop.mw;
      }
      if (el < 10 * DEG) continue;
      obs.push({
        prn,
        f1: F1,
        f2: F2,
        c1: geo,
        c2: geo,
        l1: geo / (C / F1) + 1000 + Number(prn.slice(1)),
        l2: geo / (C / F2) - 500,
        code1: '1W',
        code2: '2W',
        slip: false,
      });
    }
    out.push({ timeMs: t, obs });
  }
  return out;
}

describe('estimateNetworkClocks', () => {
  const stations = SITES.map(([id, lat, lon, off, zwd]) => ({
    id,
    xyz: ecef(lat, lon),
    epochs: observe(lat, lon, off, zwd),
  }));
  const sol = estimateNetworkClocks(stations, source, {
    referenceStations: ['REF0'],
    minArcEpochs: 2,
  });

  it('recovers satellite clocks relative to the reference clock', () => {
    let worst = 0;
    let n = 0;
    sol.epochs.forEach((t, ei) => {
      for (const [prn, arr] of sol.satClocks) {
        const v = arr[ei]!;
        if (!Number.isFinite(v)) continue;
        // Datum: the reference receiver clock is zero.
        const truth = satClk(prn, t) - rcvClk(SITES[0][3], t);
        worst = Math.max(worst, Math.abs(v - truth));
        n++;
      }
    });
    expect(n).toBeGreaterThan(200);
    expect(worst * C).toBeLessThan(0.002); // 2 mm
    expect(sol.reference.every((r) => r === 'REF0')).toBe(true);
    expect(sol.phaseRms).toBeLessThan(0.001);
  });

  it('recovers receiver clocks', () => {
    const a = sol.rcvClocks.get('CCCC|G')!;
    sol.epochs.forEach((t, ei) => {
      if (Number.isFinite(a[ei]!))
        expect((a[ei]! - (rcvClk(5e-4, t) - rcvClk(1e-4, t))) * C).toBeLessThan(
          0.002
        );
    });
  });

  it('writes RINEX CLOCK 3.04 that reads back', () => {
    const clk = clockSolutionToClk(sol, {
      agency: 'TST',
      stations: stations.map((s) => ({ name: s.id, xyz: s.xyz })),
    });
    const back = parseClk(writeClk(clk));
    const t = sol.epochs[10]!;
    const prn = [...sol.satClocks].find(([, a]) => Number.isFinite(a[10]!))![0];
    expect(clkBias(back, prn, t)).toBeCloseTo(sol.satClocks.get(prn)![10]!, 15);
  });

  it('densifies to 30 s with the adjustment held fixed', () => {
    const dense = estimateNetworkClocks(stations, source, {
      referenceStations: ['REF0'],
      minArcEpochs: 2,
      outputS: 30,
    });
    expect(dense.epochs[1]! - dense.epochs[0]!).toBe(30_000);
    let worst = 0;
    let n = 0;
    dense.epochs.forEach((t, ei) => {
      if (t % 300_000 === 0) return;
      for (const [prn, arr] of dense.satClocks) {
        const v = arr[ei]!;
        if (!Number.isFinite(v)) continue;
        worst = Math.max(
          worst,
          Math.abs(v - (satClk(prn, t) - rcvClk(SITES[0][3], t)))
        );
        n++;
      }
    });
    expect(n).toBeGreaterThan(2000);
    expect(worst * C).toBeLessThan(0.002);
  });
});
