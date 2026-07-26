/**
 * Wide-lane fractional-cycle bias (FCB) estimation for PPP-AR — the
 * self-contained route to integer ambiguities that needs no external
 * phase-bias product, only a small network of stations.
 *
 * A single receiver cannot resolve ambiguities because its Melbourne–Wübbena
 * wide-lane float is `Ñ_wl = N (integer) + b_rcv + b_sat`, and the integer
 * and the satellite fractional bias `b_sat` are entangled. Across a *network*
 * they separate: every station sees the same `b_sat` for a given satellite
 * but its own integers and receiver bias, so the fractional part common to
 * all stations *is* the satellite FCB. This is the classic Ge/Gendt method.
 *
 * The estimator alternates:
 *   1. round each arc to its integer  N = round(Ñ_wl − b_rcv − b_sat);
 *   2. update each satellite FCB      = circular-mean over stations of
 *      (Ñ_wl − N − b_rcv);
 *   3. update each receiver bias       = circular-mean over satellites of
 *      (Ñ_wl − N − b_sat);
 *   4. pin the datum (b_rcv of a reference station ≡ 0) — receiver and
 *      satellite biases otherwise trade off by an arbitrary constant.
 *
 * The output `satFcb` feeds `resolvePppAmbiguities`' `wlBiasCyc`.
 */

import { C_LIGHT } from '../constants/gnss';

/** Minimal per-satellite observation for wide-lane extraction. */
export interface WlObs {
  prn: string;
  f1: number;
  f2: number;
  /** Code on f1/f2 (m) and carrier phase on f1/f2 (cycles). */
  c1: number;
  c2: number;
  l1: number;
  l2: number;
}

/**
 * Extract arc-averaged Melbourne–Wübbena wide-lanes for one station from its
 * epoch stream. The MW combination
 *   MW = (L1 − L2) − [(f1·C1 + f2·C2)/(f1+f2)] / (c/(f1−f2))   [cycles]
 * is geometry-, clock- and (first-order) ionosphere-free, so it holds the
 * wide-lane ambiguity plus biases and is near-constant within an arc. Arcs
 * are split on a running-mean jump (cycle slip) or a time gap.
 */
export function extractWidelaneArcs(
  station: string,
  epochs: { timeMs: number; obs: WlObs[] }[],
  opts: { slipCyc?: number; gapMs?: number; minObs?: number } = {}
): WlArc[] {
  const slipCyc = opts.slipCyc ?? 4;
  const gapMs = opts.gapMs ?? 120_000;
  const minObs = opts.minObs ?? 20;
  // Per satellite: running arc state.
  const state = new Map<
    string,
    { sum: number; n: number; mean: number; lastT: number }
  >();
  const out: WlArc[] = [];
  const flush = (prn: string) => {
    const s = state.get(prn);
    if (s && s.n >= minObs)
      out.push({ station, prn, wlFloat: s.sum / s.n, nObs: s.n });
  };
  for (const ep of epochs) {
    for (const o of ep.obs) {
      if (!o.c1 || !o.c2 || !o.l1 || !o.l2) continue;
      const lamW = C_LIGHT / (o.f1 - o.f2);
      const codeNl = (o.f1 * o.c1 + o.f2 * o.c2) / (o.f1 + o.f2);
      const mw = o.l1 - o.l2 - codeNl / lamW;
      const s = state.get(o.prn);
      if (
        !s ||
        ep.timeMs - s.lastT > gapMs ||
        Math.abs(mw - s.mean) > slipCyc
      ) {
        if (s) flush(o.prn);
        state.set(o.prn, { sum: mw, n: 1, mean: mw, lastT: ep.timeMs });
      } else {
        s.sum += mw;
        s.n += 1;
        s.mean = s.sum / s.n; // running mean (Hatch-style smoothing)
        s.lastT = ep.timeMs;
      }
    }
  }
  for (const prn of state.keys()) flush(prn);
  return out;
}

/** One continuous wide-lane arc at a station. */
export interface WlArc {
  station: string;
  prn: string;
  /** Arc-averaged Melbourne–Wübbena wide-lane float (cycles). */
  wlFloat: number;
  /** Number of epochs averaged (used as the weight). */
  nObs: number;
}

export interface WlFcbOptions {
  /** Max iterations. Default 50. */
  maxIter?: number;
  /** Convergence threshold on the largest bias change (cycles). Default 1e-4. */
  tol?: number;
  /** Fix-rate acceptance window |resid| (cycles). Default 0.25. */
  fixWindow?: number;
}

export interface WlFcbResult {
  /** Per-satellite wide-lane FCB (cycles, wrapped to [−0.5, 0.5)). */
  satFcb: Map<string, number>;
  /** Per-station wide-lane bias (cycles); the reference station is 0. */
  rcvBias: Map<string, number>;
  /** RMS of the post-fit arc residuals Ñ_wl − N − b_rcv − b_sat (cycles). */
  residRms: number;
  /** Fraction of arcs whose residual lies within `fixWindow` of an integer. */
  fixRate: number;
  /** Reference station pinning the datum. */
  refStation: string;
  iterations: number;
}

/** Wrap a value in cycles to [−0.5, 0.5). */
function wrapHalf(x: number): number {
  return x - Math.round(x);
}

/** Weighted circular mean of cycle values, returned in [−0.5, 0.5). */
function circMean(vals: number[], weights: number[]): number {
  let s = 0;
  let c = 0;
  for (let i = 0; i < vals.length; i++) {
    const a = 2 * Math.PI * vals[i]!;
    s += weights[i]! * Math.sin(a);
    c += weights[i]! * Math.cos(a);
  }
  if (s === 0 && c === 0) return 0;
  return wrapHalf(Math.atan2(s, c) / (2 * Math.PI));
}

/**
 * Estimate per-satellite wide-lane FCBs from a network of stations' arc
 * wide-lane floats. Needs ≥2 stations sharing satellites to break the
 * integer/bias entanglement.
 */
export function estimateWidelaneFcb(
  arcs: WlArc[],
  opts: WlFcbOptions = {}
): WlFcbResult {
  const maxIter = opts.maxIter ?? 50;
  const tol = opts.tol ?? 1e-4;
  const fixWindow = opts.fixWindow ?? 0.25;

  const sats = [...new Set(arcs.map((a) => a.prn))].sort();
  const stations = [...new Set(arcs.map((a) => a.station))].sort();
  const refStation = stations[0] ?? '';

  const satFcb = new Map<string, number>(sats.map((s) => [s, 0]));
  const rcvBias = new Map<string, number>(stations.map((s) => [s, 0]));
  const nInt = new Array(arcs.length).fill(0);

  let iterations = 0;
  for (let it = 0; it < maxIter; it++) {
    iterations = it + 1;
    // 1. Integers given current biases.
    for (let i = 0; i < arcs.length; i++) {
      const a = arcs[i]!;
      nInt[i] = Math.round(
        a.wlFloat - rcvBias.get(a.station)! - satFcb.get(a.prn)!
      );
    }

    // 2. Satellite FCBs: circular mean of (Ñ − N − b_rcv) over stations.
    let maxChange = 0;
    for (const s of sats) {
      const vals: number[] = [];
      const w: number[] = [];
      for (let i = 0; i < arcs.length; i++) {
        const a = arcs[i]!;
        if (a.prn !== s) continue;
        vals.push(a.wlFloat - nInt[i] - rcvBias.get(a.station)!);
        w.push(a.nObs);
      }
      if (!vals.length) continue;
      const nv = circMean(vals, w);
      maxChange = Math.max(maxChange, Math.abs(wrapHalf(nv - satFcb.get(s)!)));
      satFcb.set(s, nv);
    }

    // 3. Receiver biases: circular mean of (Ñ − N − b_sat) over satellites.
    for (const r of stations) {
      const vals: number[] = [];
      const w: number[] = [];
      for (let i = 0; i < arcs.length; i++) {
        const a = arcs[i]!;
        if (a.station !== r) continue;
        vals.push(a.wlFloat - nInt[i] - satFcb.get(a.prn)!);
        w.push(a.nObs);
      }
      if (!vals.length) continue;
      rcvBias.set(r, circMean(vals, w));
    }

    // 4. Datum: pin the reference receiver bias to 0 (shift into satFcb).
    const shift = rcvBias.get(refStation)!;
    if (shift !== 0) {
      for (const r of stations)
        rcvBias.set(r, wrapHalf(rcvBias.get(r)! - shift));
      for (const s of sats) satFcb.set(s, wrapHalf(satFcb.get(s)! + shift));
    }

    if (maxChange < tol) break;
  }

  // Post-fit residuals + fix rate.
  let sumSq = 0;
  let fixed = 0;
  for (let i = 0; i < arcs.length; i++) {
    const a = arcs[i]!;
    const resid = wrapHalf(
      a.wlFloat - nInt[i] - rcvBias.get(a.station)! - satFcb.get(a.prn)!
    );
    sumSq += resid * resid;
    if (Math.abs(resid) <= fixWindow) fixed++;
  }
  const residRms = arcs.length ? Math.sqrt(sumSq / arcs.length) : 0;
  const fixRate = arcs.length ? fixed / arcs.length : 0;

  return { satFcb, rcvBias, residRms, fixRate, refStation, iterations };
}
