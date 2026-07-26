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

/** One float ambiguity (cycles) at a station: value = integer + b_rcv + b_sat. */
interface FcbEntry {
  station: string;
  sat: string;
  value: number;
  weight: number;
}

/**
 * Generic Ge/Gendt fractional-cycle-bias decomposition: given float
 * ambiguities `value = N(integer) + b_rcv(station) + b_sat(satellite)` across
 * a network, alternate integer rounding with circular-mean bias updates,
 * pinning a reference station's bias to fix the datum. Shared by the wide-
 * and narrow-lane estimators.
 */
function decomposeFcb(
  entries: FcbEntry[],
  opts: WlFcbOptions = {}
): WlFcbResult {
  const maxIter = opts.maxIter ?? 50;
  const tol = opts.tol ?? 1e-4;
  const fixWindow = opts.fixWindow ?? 0.25;

  const sats = [...new Set(entries.map((e) => e.sat))].sort();
  const stations = [...new Set(entries.map((e) => e.station))].sort();
  const refStation = stations[0] ?? '';

  const satFcb = new Map<string, number>(sats.map((s) => [s, 0]));
  const rcvBias = new Map<string, number>(stations.map((s) => [s, 0]));
  const nInt = new Array(entries.length).fill(0);

  let iterations = 0;
  for (let it = 0; it < maxIter; it++) {
    iterations = it + 1;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      nInt[i] = Math.round(
        e.value - rcvBias.get(e.station)! - satFcb.get(e.sat)!
      );
    }

    let maxChange = 0;
    for (const s of sats) {
      const vals: number[] = [];
      const w: number[] = [];
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        if (e.sat !== s) continue;
        vals.push(e.value - nInt[i] - rcvBias.get(e.station)!);
        w.push(e.weight);
      }
      if (!vals.length) continue;
      const nv = circMean(vals, w);
      maxChange = Math.max(maxChange, Math.abs(wrapHalf(nv - satFcb.get(s)!)));
      satFcb.set(s, nv);
    }

    for (const r of stations) {
      const vals: number[] = [];
      const w: number[] = [];
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        if (e.station !== r) continue;
        vals.push(e.value - nInt[i] - satFcb.get(e.sat)!);
        w.push(e.weight);
      }
      if (!vals.length) continue;
      rcvBias.set(r, circMean(vals, w));
    }

    const shift = rcvBias.get(refStation)!;
    if (shift !== 0) {
      for (const r of stations)
        rcvBias.set(r, wrapHalf(rcvBias.get(r)! - shift));
      for (const s of sats) satFcb.set(s, wrapHalf(satFcb.get(s)! + shift));
    }

    if (maxChange < tol) break;
  }

  let sumSq = 0;
  let fixed = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const resid = wrapHalf(
      e.value - nInt[i] - rcvBias.get(e.station)! - satFcb.get(e.sat)!
    );
    sumSq += resid * resid;
    if (Math.abs(resid) <= fixWindow) fixed++;
  }
  const residRms = entries.length ? Math.sqrt(sumSq / entries.length) : 0;
  const fixRate = entries.length ? fixed / entries.length : 0;

  return { satFcb, rcvBias, residRms, fixRate, refStation, iterations };
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
  return decomposeFcb(
    arcs.map((a) => ({
      station: a.station,
      sat: a.prn,
      value: a.wlFloat,
      weight: a.nObs,
    })),
    opts
  );
}

/** One converged arc (from `solvePpp`) tagged with its station, for NL FCB. */
export interface NlArc {
  station: string;
  prn: string;
  /** Float ionosphere-free ambiguity (m). */
  aIF: number;
  /** Arc-averaged Melbourne–Wübbena wide-lane (cycles). */
  mwCyc: number;
  f1: number;
  f2: number;
  nEpochs: number;
}

export interface NlFcbResult extends WlFcbResult {
  /** Arcs whose wide-lane fixed and were used in the narrow-lane estimation. */
  usedArcs: number;
  /** Arcs dropped because the wide-lane did not round confidently. */
  wlRejected: number;
}

const C = 299792458;

/**
 * Estimate per-satellite **narrow-lane** FCBs — the centimetre half of
 * PPP-AR. Needs the wide-lane FCBs already solved (`wl`, from the same
 * network) to fix each arc's N_WL, from which the float narrow-lane
 * ambiguity is recovered:
 *
 *   A_IF = λ_NL·N1 + λ_NL·(f2/(f1−f2))·N_WL
 *   ⇒ N1_float = A_IF/λ_NL − (f2/(f1−f2))·N_WL,   λ_NL = c/(f1+f2)
 *
 * then decomposed across the network exactly like the wide-lane. The
 * narrow-lane wavelength is ~10.7 cm, so this is far more sensitive to
 * residual orbit/clock/troposphere/position error than the ~86 cm wide-lane
 * — the fix rate is the honest measure of how close the network is to cm.
 */
export function estimateNarrowlaneFcb(
  arcs: NlArc[],
  wl: WlFcbResult,
  opts: WlFcbOptions = {}
): NlFcbResult {
  const entries: FcbEntry[] = [];
  let wlRejected = 0;
  for (const a of arcs) {
    const satWl = wl.satFcb.get(a.prn);
    const rcvWl = wl.rcvBias.get(a.station);
    if (satWl === undefined || rcvWl === undefined) continue;
    const wlFloat = a.mwCyc - satWl - rcvWl;
    const nWl = Math.round(wlFloat);
    if (Math.abs(wlFloat - nWl) > (opts.fixWindow ?? 0.25)) {
      wlRejected++;
      continue; // wide-lane not confidently fixed → can't form the narrow-lane
    }
    const lamNl = C / (a.f1 + a.f2);
    const n1Float = a.aIF / lamNl - (a.f2 / (a.f1 - a.f2)) * nWl;
    entries.push({
      station: a.station,
      sat: a.prn,
      value: n1Float,
      weight: a.nEpochs,
    });
  }
  const res = decomposeFcb(entries, { fixWindow: 0.15, ...opts });
  return { ...res, usedArcs: entries.length, wlRejected };
}

export interface NetworkFcbSummary {
  wlFixRate: number;
  wlResidRms: number;
  nlUsedArcs: number;
  nlFixRate: number;
  nlResidRms: number;
  wlRejected: number;
}

export interface NetworkFcbResult {
  /** Per-satellite wide-lane FCB (cycles), all constellations merged. */
  satWlFcb: Map<string, number>;
  /** Per-satellite narrow-lane FCB (cycles), all constellations merged. */
  satNlFcb: Map<string, number>;
  /** Per-constellation fix-rate / residual summary, keyed by system letter. */
  perSystem: Record<string, NetworkFcbSummary>;
}

/**
 * Full network FCB calibration for PPP-AR from a set of `solvePpp` arcs (each
 * tagged with its station), **per constellation** — the receiver wide- and
 * narrow-lane biases are system-specific, so lumping GPS/Galileo/BeiDou under
 * one datum corrupts the fit. Runs the wide-lane then narrow-lane
 * decomposition for each system and merges the per-satellite biases.
 *
 * The satellite FCBs (`satWlFcb`/`satNlFcb`) are the reusable product: a rover
 * applies them and solves only its own receiver bias. Multi-GNSS input
 * multiplies the fixable arcs (Galileo roughly doubles GPS-only) without
 * changing per-arc behaviour — each satellite's arc length is independent of
 * how many constellations are present.
 */
export function estimateNetworkFcbs(
  arcs: NlArc[],
  opts: { minArcEpochs?: number; minWlObs?: number; fixWindow?: number } = {}
): NetworkFcbResult {
  const minArcEpochs = opts.minArcEpochs ?? 120;
  const minWlObs = opts.minWlObs ?? 40;
  const fixWindow = opts.fixWindow ?? 0.15;

  const satWlFcb = new Map<string, number>();
  const satNlFcb = new Map<string, number>();
  const perSystem: Record<string, NetworkFcbSummary> = {};

  const systems = [...new Set(arcs.map((a) => a.prn[0]!))].sort();
  for (const sys of systems) {
    const sysArcs = arcs.filter((a) => a.prn[0] === sys);
    const wlArcs: WlArc[] = sysArcs
      .filter((a) => a.nEpochs >= minWlObs)
      .map((a) => ({
        station: a.station,
        prn: a.prn,
        wlFloat: a.mwCyc,
        nObs: a.nEpochs,
      }));
    if (wlArcs.length < 3) continue; // too little to separate biases
    const wl = estimateWidelaneFcb(wlArcs, { fixWindow });
    const nlInput = sysArcs.filter((a) => a.nEpochs >= minArcEpochs);
    const nl = estimateNarrowlaneFcb(nlInput, wl, { fixWindow });
    for (const [prn, v] of wl.satFcb) satWlFcb.set(prn, v);
    for (const [prn, v] of nl.satFcb) satNlFcb.set(prn, v);
    perSystem[sys] = {
      wlFixRate: wl.fixRate,
      wlResidRms: wl.residRms,
      nlUsedArcs: nl.usedArcs,
      nlFixRate: nl.fixRate,
      nlResidRms: nl.residRms,
      wlRejected: nl.wlRejected,
    };
  }
  return { satWlFcb, satNlFcb, perSystem };
}
