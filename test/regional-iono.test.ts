import { describe, expect, it } from 'vitest';
import {
  estimateRegionalIonosphere,
  regionalIonoGrid,
} from '../src/analysis/regional-iono';
import type { PppEpoch } from '../src/positioning/ppp';

// Synthetic network: a smooth Sun-fixed ionosphere, known satellite and
// receiver DCBs (C1W − C2W, ns), ambiguous phase. The estimator must give
// the field and the biases back.
const C = 299792458;
const F1 = 1575.42e6;
const F2 = 1227.6e6;
const K = 40.3e16;
const DEG = Math.PI / 180;
const R = 6371e3;
const H = 506.7e3;
const T0 = Date.UTC(2024, 0, 14);
const OMEGA = (2 * Math.PI) / 86_400_000;

const ecef = (latDeg: number, lonDeg: number, r: number) =>
  [
    r * Math.cos(latDeg * DEG) * Math.cos(lonDeg * DEG),
    r * Math.cos(latDeg * DEG) * Math.sin(lonDeg * DEG),
    r * Math.sin(latDeg * DEG),
  ] as [number, number, number];

/** VTEC (TECU), a function of latitude and local (Sun-fixed) time. */
const truth = (lat: number, lon: number, t: number) =>
  15 +
  6 * Math.cos((lat - 45) * DEG) +
  4 * Math.cos(lon * DEG + OMEGA * (t - T0) - Math.PI);

// Satellites on 8 inclined circular orbits.
const PRNS = Array.from(
  { length: 10 },
  (_, i) => `G${String(i + 1).padStart(2, '0')}`
);
const satPos = (prn: string, t: number) => {
  const i = Number(prn.slice(1)) - 1;
  const a = 26_560e3;
  const u = (2 * Math.PI * (t - T0)) / 43_082_000 + i * 0.63;
  const raan = i * 1.1;
  const inc = 55 * DEG;
  const xo = a * Math.cos(u);
  const yo = a * Math.sin(u);
  return [
    xo * Math.cos(raan) - yo * Math.cos(inc) * Math.sin(raan),
    xo * Math.sin(raan) + yo * Math.cos(inc) * Math.cos(raan),
    yo * Math.sin(inc),
  ] as const;
};
const SAT_DCB: Record<string, number> = {};
PRNS.forEach(
  (p, i) => (SAT_DCB[p] = [-3, 2, 1.5, -0.5, 4, -2, -1, 0.5, 1, -3.5][i]!)
);
const SITES = [
  ['AAAA', 52, 5, 7],
  ['BBBB', 48, 16, -4],
  ['CCCC', 60, 25, 10],
  ['DDDD', 41, -4, 2],
  ['EEEE', 45, 10, -6],
  ['FFFF', 56, 12, 0],
  ['GGGG', 50, 30, 3],
] as const;

function observe(lat0: number, lon0: number, rcvDcb: number): PppEpoch[] {
  const rx = ecef(lat0, lon0, R);
  const up = [rx[0] / R, rx[1] / R, rx[2] / R];
  const out: PppEpoch[] = [];
  for (let t = T0; t <= T0 + 12 * 3600_000; t += 60_000) {
    const obs = [];
    for (const prn of PRNS) {
      const s = satPos(prn, t);
      const d = [s[0] - rx[0], s[1] - rx[1], s[2] - rx[2]];
      const rho = Math.hypot(d[0]!, d[1]!, d[2]!);
      const sinEl = (d[0]! * up[0]! + d[1]! * up[1]! + d[2]! * up[2]!) / rho;
      if (sinEl < Math.sin(10 * DEG)) continue;
      // Pierce point on the shell along the ray.
      const b = (2 * (rx[0] * d[0]! + rx[1] * d[1]! + rx[2] * d[2]!)) / rho;
      const c = R * R - (R + H) ** 2;
      const s1 = (-b + Math.sqrt(b * b - 4 * c)) / 2;
      const p = [0, 1, 2].map((k) => rx[k]! + (s1 * d[k]!) / rho);
      const latP = Math.asin(p[2]! / (R + H)) / DEG;
      const lonP = Math.atan2(p[1]!, p[0]!) / DEG;
      const z = Math.acos(sinEl);
      const zm = Math.asin((R / (R + H)) * Math.sin(0.9782 * z));
      const stec = truth(latP, lonP, t) / Math.cos(zm);
      const i1 = (K * stec) / (F1 * F1);
      const i2 = (K * stec) / (F2 * F2);
      const dcbM = C * 1e-9 * (rcvDcb + SAT_DCB[prn]!);
      obs.push({
        prn,
        f1: F1,
        f2: F2,
        c1: rho + i1 + dcbM,
        c2: rho + i2,
        l1: (rho - i1) / (C / F1) + 1234,
        l2: (rho - i2) / (C / F2) - 777,
        code1: '1W',
        code2: '2W',
        slip: false,
      });
    }
    out.push({ timeMs: t, obs });
  }
  return out;
}

describe('estimateRegionalIonosphere', () => {
  const stations = SITES.map(([id, lat, lon, dcb]) => ({
    id,
    xyz: ecef(lat, lon, R),
    epochs: observe(lat, lon, dcb),
  }));
  const model = estimateRegionalIonosphere(stations, satPos, {
    startMs: T0,
    endMs: T0 + 12 * 3600_000,
  });

  it('recovers the satellite and receiver DCBs', () => {
    expect(model.satelliteDcb).toHaveLength(PRNS.length);
    const mean =
      Object.values(SAT_DCB).reduce((a, b) => a + b, 0) / PRNS.length;
    for (const d of model.satelliteDcb) {
      expect(d.obs1).toBe('C1W');
      expect(d.obs2).toBe('C2W');
      expect(d.valueNs).toBeCloseTo(SAT_DCB[d.prn]! - mean, 1);
    }
    for (const d of model.receiverDcb) {
      const site = SITES.find((s) => s[0] === d.station)!;
      expect(d.valueNs).toBeCloseTo(site[3] + mean, 1);
    }
  });

  it('recovers the VTEC field over the network', () => {
    let worst = 0;
    for (const [, lat, lon] of SITES)
      for (let h = 1; h < 12; h++) {
        const t = T0 + h * 3600_000;
        worst = Math.max(
          worst,
          Math.abs(model.vtec(lat, lon, t) - truth(lat, lon, t))
        );
      }
    expect(worst).toBeLessThan(0.3);
    expect(model.rmsTecu).toBeLessThan(0.2);
  });

  it('grids the model only where it has data', () => {
    const g = regionalIonoGrid(model, {
      epochs: [T0 + 6 * 3600_000],
      lats: [50, -30],
      lons: [10],
    });
    expect(g.maps[0]![0]).toBeCloseTo(truth(50, 10, T0 + 6 * 3600_000), 0);
    expect(Number.isNaN(g.maps[0]![1]!)).toBe(true);
    expect(g.rms[0]![0]).toBeGreaterThan(0);
  });
});
