/**
 * Synthetic multi-frequency PPP scenario for the engine tests: satellites
 * on circular orbits, a static receiver, per-satellite slant ionosphere,
 * receiver clock and code biases, integer ambiguities with receiver and
 * satellite phase biases, the GPS L5 inter-frequency clock bias, and white
 * noise — all known, so the estimates can be checked against the truth.
 */
import {
  satStateAtEmission,
  type PppEphemerisSource,
  type SatSample,
} from '../src/positioning/ppp';
import type { PppMultiEpoch, PppSignal } from '../src/positioning/ppp-signals';
import { getAer } from '../src/coordinates/ecef';

const C = 299792458;
const OMEGA_E = 7.2921151467e-5;
const GM = 3.986004418e14;
export const F_REF = 1575.42e6;

/** Deterministic normal deviates (LCG + Box–Muller). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  const u = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

interface Orbit {
  r: number;
  inc: number;
  raan: number;
  u0: number;
  clk0: number;
}

/** Circular-orbit ephemeris (ECEF), with simple satellite clocks. */
export class SyntheticSource implements PppEphemerisSource {
  readonly orbits = new Map<string, Orbit>();
  codeBias?: PppEphemerisSource['codeBias'];
  phaseBias?: PppEphemerisSource['phaseBias'];
  constructor(
    sats: { prn: string; r: number; inc: number; raan: number; u0: number }[],
    /** Satellite biases (m) the source publishes (OSB), by tracking code. */
    biases?: {
      code?: (prn: string, code: string) => number | null;
      phase?: (prn: string, code: string) => number | null;
    }
  ) {
    sats.forEach((s, k) =>
      this.orbits.set(s.prn, { ...s, clk0: (k - 5) * 1.3e-5 })
    );
    if (biases?.code) {
      const f = biases.code;
      this.codeBias = (prn, code) => f(prn, code);
    }
    if (biases?.phase) {
      const f = biases.phase;
      this.phaseBias = (prn, code) => f(prn, code);
    }
  }
  private pos(o: Orbit, tS: number): [number, number, number] {
    const n = Math.sqrt(GM / o.r ** 3);
    const u = o.u0 + n * tS;
    const xo = o.r * Math.cos(u);
    const yo = o.r * Math.sin(u);
    // Inertial: rotate by inclination about x, then RAAN about z.
    const xi = xo;
    const yi = yo * Math.cos(o.inc);
    const zi = yo * Math.sin(o.inc);
    const X = xi * Math.cos(o.raan) - yi * Math.sin(o.raan);
    const Y = xi * Math.sin(o.raan) + yi * Math.cos(o.raan);
    // ECEF: Earth rotation.
    const th = OMEGA_E * tS;
    return [
      X * Math.cos(th) + Y * Math.sin(th),
      -X * Math.sin(th) + Y * Math.cos(th),
      zi,
    ];
  }
  satState(prn: string, tEmitMs: number): SatSample | null {
    const o = this.orbits.get(prn);
    if (!o) return null;
    const t = tEmitMs / 1000;
    const p = this.pos(o, t);
    const p1 = this.pos(o, t + 0.5);
    const p0 = this.pos(o, t - 0.5);
    return {
      x: p[0],
      y: p[1],
      z: p[2],
      vx: p1[0] - p0[0],
      vy: p1[1] - p0[1],
      vz: p1[2] - p0[2],
      clkS: o.clk0 + 1e-11 * t,
    };
  }
}

/** A constellation of `n` satellites in `planes` planes. */
export function constellation(
  sys: string,
  n: number,
  planes: number,
  r: number,
  incDeg: number,
  phase = 0
) {
  return Array.from({ length: n }, (_, k) => ({
    prn: `${sys}${String(k + 1).padStart(2, '0')}`,
    r,
    inc: (incDeg * Math.PI) / 180,
    raan: ((k % planes) * 2 * Math.PI) / planes + phase,
    u0:
      (Math.floor(k / planes) * 2 * Math.PI) / Math.ceil(n / planes) +
      (k % planes) * 0.7,
  }));
}

export interface SyntheticSignal {
  band: string;
  freq: number;
  code: string;
}

export interface ScenarioOptions {
  source: SyntheticSource;
  rcv: [number, number, number];
  t0Ms: number;
  epochs: number;
  stepS: number;
  /** Signals per constellation letter. */
  signals: Record<string, SyntheticSignal[]>;
  codeSigma?: number;
  phaseSigma?: number;
  seed?: number;
  /** Receiver code bias per signal code (m), e.g. { '5Q': 1.7 }. */
  rcvCodeBias?: Record<string, number>;
  /** Satellite code bias per PRN and code (m) — what an OSB removes. */
  satCodeBias?: (prn: string, code: string) => number;
  /** Satellite phase bias per PRN and code (m) — what a phase OSB removes. */
  satPhaseBias?: (prn: string, code: string) => number;
  /** Receiver phase bias per code (cycles). */
  rcvPhaseBias?: Record<string, number>;
  /** GPS L5 inter-frequency clock bias amplitude (m). */
  l5IfcbM?: number;
  /** Elevation below which no observation is generated (deg). */
  horizonDeg?: number;
  /** Slant ionospheric delay at 1575.42 MHz (m); default a smooth
   *  per-satellite function of elevation and time. */
  iono?: (prn: string, elRad: number, azRad: number, tMs: number) => number;
}

/** Observations of a scenario, plus the integers used. */
export function simulate(o: ScenarioOptions): {
  epochs: PppMultiEpoch[];
  ambiguities: Map<string, number>;
} {
  const n = rng(o.seed ?? 1);
  const sc = o.codeSigma ?? 0;
  const sp = o.phaseSigma ?? 0;
  const ambiguities = new Map<string, number>();
  const epochs: PppMultiEpoch[] = [];
  for (let e = 0; e < o.epochs; e++) {
    const t = o.t0Ms + e * o.stepS * 1000;
    const clkRcvM = 1e3 * Math.sin(e / 50) + 30 * n();
    const obs: PppMultiEpoch['obs'] = [];
    for (const prn of o.source.orbits.keys()) {
      const sigsDef = o.signals[prn[0]!];
      if (!sigsDef) continue;
      let pr = 2.2e7;
      let st = satStateAtEmission(o.source, prn, t, o.rcv, pr)!;
      for (let it = 0; it < 3; it++) {
        const rho = Math.hypot(
          st.state.x - o.rcv[0],
          st.state.y - o.rcv[1],
          st.state.z - o.rcv[2]
        );
        pr = rho + clkRcvM - st.state.clkM;
        st = satStateAtEmission(o.source, prn, t, o.rcv, pr)!;
      }
      const [el, az] = getAer(
        st.state.x,
        st.state.y,
        st.state.z,
        o.rcv[0],
        o.rcv[1],
        o.rcv[2]
      );
      if (el < ((o.horizonDeg ?? 5) * Math.PI) / 180) continue;
      const rho = Math.hypot(
        st.state.x - o.rcv[0],
        st.state.y - o.rcv[1],
        st.state.z - o.rcv[2]
      );
      const k = Number(prn.slice(1));
      const iono = o.iono
        ? o.iono(prn, el, az, t)
        : (2 + Math.sin(e / 200 + k)) / Math.sin(Math.max(el, 0.1));
      const signals: PppSignal[] = sigsDef.map((s) => {
        const lam = C / s.freq;
        const mu = (F_REF / s.freq) ** 2;
        const key = `${prn}:${s.band}`;
        let N = ambiguities.get(key);
        if (N === undefined) {
          N = Math.round(1e6 * Math.sin(k * 7.1 + Number(s.band)));
          ambiguities.set(key, N);
        }
        const ifcb =
          prn[0] === 'G' && s.band === '5'
            ? (o.l5IfcbM ?? 0) *
              Math.sin((2 * Math.PI * e * o.stepS) / 43200 + k)
            : 0;
        const geo = rho + clkRcvM - st.state.clkM;
        const P =
          geo +
          mu * iono +
          (o.rcvCodeBias?.[s.code] ?? 0) +
          (o.satCodeBias?.(prn, s.code) ?? 0) +
          sc * n();
        const L =
          geo -
          mu * iono +
          lam * (N + (o.rcvPhaseBias?.[s.code] ?? 0)) +
          (o.satPhaseBias?.(prn, s.code) ?? 0) +
          ifcb +
          sp * n();
        return {
          band: s.band,
          freq: s.freq,
          antexBand: `${prn[0]}0${s.band}`,
          code: s.code,
          pr: P,
          cp: L / lam,
        };
      });
      obs.push({ prn, signals });
    }
    epochs.push({ timeMs: t, obs });
  }
  return { epochs, ambiguities };
}
