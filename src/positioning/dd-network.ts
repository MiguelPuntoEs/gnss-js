/**
 * Double-difference network solution — the core of a geodetic network analysis:
 * every station of a network solved together from ionosphere-free
 * double-differenced carrier phase, over baselines of any length, with
 * integer ambiguity resolution and the full cross-covariance, reduced to
 * normal equations (station coordinates + troposphere) for stacking.
 *
 * Processing chain (one session, typically 24 h):
 *
 *  1. Zero-difference modelling per station (as the PPP filter does, but
 *     batch): precise orbit + clock at emission (emission time from the
 *     pseudorange, so the receiver clock offset is synchronised by the
 *     code), periodic relativity, Earth rotation, a-priori troposphere +
 *     mapping hook, and the caller's {@link PppCorrections} (antenna
 *     PCO/PCV, wind-up, solid-earth tides, ocean loading).
 *  2. Pre-processing per station and satellite: code outliers against the
 *     epoch's code clock (median), cycle slips by the Melbourne–Wübbena
 *     wide-lane and a geometry-free phase prediction (no clock-dependent
 *     test: satellite clocks cancel in the double differences, and the
 *     5-minute clock interpolation must not trigger slips), gaps; every
 *     break starts a new ambiguity (no repair). Short arcs are dropped.
 *  3. Independent baselines (OBS-MAX or SHORTEST spanning tree).
 *  4. Per baseline: between-station single differences with one receiver-
 *     clock-difference per epoch, eliminated epoch by epoch — exactly the
 *     double differences with their full correlation, without choosing a
 *     reference satellite. Parameters: coordinates, piecewise-linear ZTD
 *     per station (default 2 h), piecewise-linear N/E gradients (default
 *     24 h), one float iono-free ambiguity per single-difference arc,
 *     pre-eliminated per baseline. Elevation weighting σ²/sin²(e).
 *  5. Network normal equations, solved with minimum constraints (no-net-
 *     translation on the a-priori coordinates); residual screening and
 *     re-solve.
 *  6. Ambiguity resolution: wide-lane from the
 *     Melbourne–Wübbena single-difference means (after the baseline's
 *     receiver wide-lane bias), then narrow-lane on the iono-free float
 *     solution with LAMBDA (ratio test, partial fixing), double differences
 *     within each constellation. Fixed ambiguities enter as constraints and
 *     the network is re-solved.
 *
 * GLONASS is left out by default (inter-frequency biases make its double
 * differences non-integer between receiver types); with `systems` including
 * R it is processed float-only. BeiDou likewise float-only.
 *
 * Correlations between baselines are ignored (baseline-wise correlations only).
 * The NEQ carries no datum: constraints (datum, troposphere) are added only
 * when solving here. Before pre-elimination, one ambiguity per baseline is
 * held at zero (it takes the common mode the epoch clocks cannot separate)
 * and the others get a weak 10 m a-priori against further defects.
 */

import { C_LIGHT, OMEGA_E } from '../constants/gnss';
import { ecefToGeodetic, getAer } from '../coordinates/ecef';
import type {
  NeqParameter,
  NormalEquations,
} from '../analysis/normal-equations';
import {
  selectBaselines,
  type SelectedBaseline,
} from '../analysis/baseline-selection';
import type { PppEpoch, PppEphemerisSource, PppTroposphereModel } from './ppp';
import { niellMapping } from './ppp-tropo';
import {
  applyCorrections,
  type PppCorrections,
  type SatGeom,
} from './ppp-corrections';
import { lambdaSearch } from './lambda';

type V3 = [number, number, number];

/* ================================================================== */
/*  Public types                                                       */
/* ================================================================== */

export interface DdStationInput {
  /** Station id (4- or 9-character); the first 4 go to the NEQ. */
  id: string;
  /** Dual-frequency observations (as for solvePpp), time-ordered. */
  epochs: readonly PppEpoch[];
  /** A-priori marker ECEF (m) — a PPP solution (cm) is ideal. */
  apriori: V3;
  /** This station's corrections (fresh instance: wind-up keeps state). */
  corrections?: PppCorrections;
}

export interface DdArOptions {
  /** Longest baseline whose ambiguities are resolved (km). Default 6000. */
  maxBaselineKm?: number;
  /** Max |fraction| of a single-difference wide-lane (cycles). Default 0.25. */
  wlMaxFrac?: number;
  /** Max σ of a wide-lane mean (cycles). Default 0.1. */
  wlMaxSigma?: number;
  /** LAMBDA ratio threshold. Default 3. */
  ratio?: number;
  /** Narrow-lane candidates need a float σ below this (cycles). Default 0.15. */
  nlMaxSigma?: number;
  /** Ambiguities need at least this much data (s). Default 1800. */
  minArcS?: number;
  /** Fixing rounds (each re-solves the network). Default 2. */
  rounds?: number;
}

export interface DdNetworkOptions {
  /** Elevation cutoff (deg). Default 5 (10 doubled the height error on EPN week 2297; 3 is worse with Niell). */
  elevationMaskDeg?: number;
  /** Observation sampling of the adjustment (s); pre-processing uses
   *  every epoch. Default 30. */
  sampleS?: number;
  /** Zero-difference iono-free phase σ at zenith (m); also σ₀. Default 0.003. */
  phaseSigmaM?: number;
  /** ZTD node spacing (h), piecewise linear. Default 1 (as EUREF). */
  ztdIntervalH?: number;
  /** Estimate N/E troposphere gradients. Default true. */
  gradients?: boolean;
  /** Gradient node spacing (h), piecewise linear. Default 24. */
  gradientIntervalH?: number;
  /** A-priori troposphere (ZHD + mapping); default Saastamoinen + Niell. */
  troposphereModel?: PppTroposphereModel;
  /** Baseline strategy, or explicit station pairs. Default 'obs-max'. */
  baselines?: 'obs-max' | 'shortest' | readonly (readonly [string, string])[];
  /** Constellations. Default 'GE'. */
  systems?: string;
  /** A gap longer than this starts a new ambiguity (s). Default 180. */
  maxGapS?: number;
  /** Arcs shorter than this are dropped (s). Default 600. */
  minArcS?: number;
  /** Satellite code bias (m) per RINEX-3 code ('1W', '5Q'…), removed from
   *  the code — matters for the wide-lane when two receivers track
   *  different codes. Optional. */
  codeBias?: (prn: string, code: string, tMs: number) => number | null;
  /** Integer ambiguity resolution. Default true. */
  ar?: boolean | DdArOptions;
  /** Datum for the solution returned here (the NEQ has none): no-net-
   *  translation (+ rotation) on the a-priori coordinates of these
   *  stations (default all), σ in m. */
  datum?: {
    stations?: readonly string[];
    sigmaM?: number;
    rotations?: boolean;
  };
  /** Solve-time a-priori σ on ZTD nodes and gradients (m). Defaults 1 / 0.01. */
  constraints?: { ztdSigmaM?: number; gradientSigmaM?: number };
  /** Residual screening: reject |v| > k·σ̂ (per baseline). Default 4;
   *  `iterations` re-solves. Default 3. */
  screening?: { k?: number; iterations?: number };
}

export interface DdBaselineReport {
  a: string;
  b: string;
  lengthKm: number;
  /** Single-difference observations used / rejected. */
  nObs: number;
  nRejected: number;
  /** Single-difference ambiguities (arcs). */
  nAmb: number;
  /** Post-fit RMS of the single differences after the clock (mm). */
  rmsMm: number;
  /** Double-difference wide-lane / narrow-lane candidates and fixes. */
  wl: { candidates: number; fixed: number };
  nl: { candidates: number; fixed: number; ratio: number };
}

export interface DdStationResult {
  id: string;
  apriori: V3;
  ecef: V3;
  /** Formal 1σ E/N/U (m), a-posteriori. */
  sigmaEnu: V3;
  /** ZTD nodes: time, total delay and 1σ (m). */
  ztd: { tMs: number; ztdM: number; sigmaM: number }[];
  /** Pre-processing counts. */
  arcs: number;
  slips: number;
  codeOutliers: number;
}

export interface DdSolution {
  /** Corrections to the a-priori values, NEQ parameter order. */
  dx: Float64Array;
  /** Full covariance (a-posteriori, m²), row-major. */
  covariance: Float64Array;
  /** A-posteriori σ₀ (m) and its degrees of freedom. */
  sigma0: number;
  dof: number;
}

export interface DdNetworkResult {
  stations: DdStationResult[];
  baselines: DdBaselineReport[];
  /** Normal equations of the final (ambiguity-fixed where fixed) solution:
   *  station XYZ, ZTD and gradient nodes; ambiguities and epoch clocks
   *  pre-eliminated. No datum. */
  neq: NormalEquations;
  /** The float solution's NEQ (same parameters). */
  floatNeq: NormalEquations;
  solution: DdSolution;
  floatSolution: DdSolution;
  /** Network totals. */
  ar: {
    wlCandidates: number;
    wlFixed: number;
    nlCandidates: number;
    nlFixed: number;
  };
  timings: Record<string, number>;
}

/* ================================================================== */
/*  Zero-difference modelling + pre-processing                         */
/* ================================================================== */

/** Satellite id → small integer (system × 100 + number), so the zero
 *  differences pack into typed arrays and sort by satellite. */
const SYS_CODES = 'GERCJIS';
const satIndex = (prn: string) =>
  SYS_CODES.indexOf(prn[0]!) * 100 + Number(prn.slice(1));
const satPrn = (i: number) =>
  SYS_CODES[Math.floor(i / 100)]! + String(i % 100).padStart(2, '0');

/** Number of float32 geometry values per zero difference:
 *  elevation, LOS (3), wet mapping, gradient partials N/E. */
const NGEO = 7;

/**
 * One station's modelled, pre-processed zero differences — packed into
 * typed arrays (about 60 bytes per observation), so a 40-station day fits
 * in a few hundred MB and the raw observations can be released as soon as
 * a station is modelled ({@link prepareDdStation}).
 */
interface StationZd {
  id: string;
  apriori: V3;
  times: Float64Array;
  timeIndex: Map<number, number>;
  /** Observations of epoch i: [start[i], start[i+1]), sorted by satellite. */
  start: Int32Array;
  sat: Int16Array;
  arc: Int32Array;
  omcP: Float64Array;
  mw: Float64Array;
  geo: Float32Array;
  /** Carrier frequencies per satellite index. */
  freq: Map<number, [number, number]>;
  zhdZenith: (tMs: number) => number;
  arcs: number;
  slips: number;
  codeOutliers: number;
}

/** A station modelled by {@link prepareDdStation}, ready for the network. */
export interface DdStationData {
  readonly id: string;
  /** Opaque: the packed zero differences. */
  readonly zd: unknown;
}

const gradientMapping = (el: number) =>
  1 / (Math.sin(el) * Math.tan(el) + 0.0032);

/** Satellite position (reception frame) + clock at emission, emission
 *  time from the pseudorange (receiver clock synchronised by the code). */
function satAtEmission(
  src: PppEphemerisSource,
  prn: string,
  tRxMs: number,
  rcv: V3,
  codeM: number
): { pos: V3; clkM: number } | null {
  let tEmit = tRxMs - (codeM / C_LIGHT) * 1000;
  const s0 = src.satState(prn, tEmit);
  if (!s0) return null;
  tEmit -= s0.clkS * 1000;
  const s = src.satState(prn, tEmit);
  if (!s) return null;
  let travel = 0.075;
  let pos: V3 = [s.x, s.y, s.z];
  for (let i = 0; i < 3; i++) {
    const th = OMEGA_E * travel;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    pos = [s.x * c + s.y * sn, -s.x * sn + s.y * c, s.z];
    travel =
      Math.hypot(pos[0] - rcv[0], pos[1] - rcv[1], pos[2] - rcv[2]) / C_LIGHT;
  }
  const rel = (-2 * (s.x * s.vx + s.y * s.vy + s.z * s.vz)) / C_LIGHT ** 2;
  return { pos, clkM: C_LIGHT * (s.clkS + rel) };
}

/** Least-squares polynomial (degree ≤ 2) through the points, at t. */
function polyPredict(
  pts: readonly { t: number; v: number }[],
  t: number,
  deg: number
): number {
  const last = pts.at(-1)!;
  if (deg <= 0) return last.v;
  const m = deg + 1;
  const N = new Array<number>(m * m).fill(0);
  const b = new Array<number>(m).fill(0);
  for (const p of pts) {
    const x = (p.t - last.t) / 60_000;
    const row = [1, x, x * x].slice(0, m);
    for (let i = 0; i < m; i++) {
      b[i]! += row[i]! * (p.v - last.v);
      for (let j = 0; j < m; j++) N[i * m + j]! += row[i]! * row[j]!;
    }
  }
  // Gaussian elimination (m ≤ 3).
  for (let c = 0; c < m; c++) {
    const piv = N[c * m + c]!;
    if (Math.abs(piv) < 1e-12) return last.v;
    for (let r = c + 1; r < m; r++) {
      const f = N[r * m + c]! / piv;
      for (let k = c; k < m; k++) N[r * m + k]! -= f * N[c * m + k]!;
      b[r]! -= f * b[c]!;
    }
  }
  const x = new Array<number>(m).fill(0);
  for (let r = m - 1; r >= 0; r--) {
    let acc = b[r]!;
    for (let k = r + 1; k < m; k++) acc -= N[r * m + k]! * x[k]!;
    x[r] = acc / N[r * m + r]!;
  }
  const dt = (t - last.t) / 60_000;
  return last.v + x[0]! + x[1]! * dt + (m > 2 ? x[2]! * dt * dt : 0);
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function modelStation(
  st: DdStationInput,
  src: PppEphemerisSource,
  o: Required<
    Pick<
      DdNetworkOptions,
      'elevationMaskDeg' | 'systems' | 'maxGapS' | 'minArcS'
    >
  > &
    DdNetworkOptions
): StationZd {
  const rcv = st.apriori;
  const [lat, lon, h] = ecefToGeodetic(rcv[0], rcv[1], rcv[2]);
  const mask = (o.elevationMaskDeg * Math.PI) / 180;
  const tropo = (tMs: number, el: number, az: number) =>
    o.troposphereModel
      ? o.troposphereModel.delays(tMs, lat, lon, h, el, az)
      : { ...niellMapping(el, lat, h, tMs), gradient: 0 };
  const corr = st.corrections;

  interface Track {
    arc: number;
    lastT: number;
    o1: number;
    o2: number;
    n: number;
    mwMean: number;
    mwM2: number;
    gf: { t: number; v: number }[];
    /** Running mean square of the geometry-free prediction error (m²):
     *  the threshold follows the arc's own noise (low elevations,
     *  scintillation at high latitude) instead of a fixed 4 cm. */
    gfMs: number;
    startT: number;
  }
  const tracks = new Map<string, Track>();
  const arcSpan: { startT: number; endT: number; n: number }[] = [];
  let slips = 0;
  let codeOutliers = 0;
  const times: number[] = [];
  const start: number[] = [];
  const cSat: number[] = [];
  const cArc: number[] = [];
  const cOmc: number[] = [];
  const cMw: number[] = [];
  const cGeo: number[] = [];
  const freq = new Map<number, [number, number]>();

  for (const ep of st.epochs) {
    const t = ep.timeMs;
    const ctx = corr?.epochContext?.(t, rcv) ?? null;
    interface Cand {
      raw: PppEpoch['obs'][number];
      c1: number;
      c2: number;
      pIf: number;
      lIfRaw: number;
      omcC: number;
      modelP: number;
      el: number;
      e: V3;
      mwet: number;
      mgN: number;
      mgE: number;
    }
    const cands: Cand[] = [];
    for (const raw of ep.obs) {
      if (!o.systems.includes(raw.prn[0]!)) continue;
      if (!raw.c1 || !raw.c2 || !raw.l1 || !raw.l2) continue;
      let c1 = raw.c1;
      let c2 = raw.c2;
      if (o.codeBias) {
        c1 -= o.codeBias(raw.prn, raw.code1 ?? '', t) ?? 0;
        c2 -= o.codeBias(raw.prn, raw.code2 ?? '', t) ?? 0;
      }
      const sat = satAtEmission(src, raw.prn, t, rcv, c1);
      if (!sat) continue;
      const [el, az] = getAer(
        sat.pos[0],
        sat.pos[1],
        sat.pos[2],
        rcv[0],
        rcv[1],
        rcv[2]
      );
      if (el < mask) continue;
      const dx = sat.pos[0] - rcv[0];
      const dy = sat.pos[1] - rcv[1];
      const dz = sat.pos[2] - rcv[2];
      const range = Math.hypot(dx, dy, dz);
      const e: V3 = [dx / range, dy / range, dz / range];
      const g = (raw.f1 * raw.f1) / (raw.f1 * raw.f1 - raw.f2 * raw.f2);
      const lam1 = C_LIGHT / raw.f1;
      const lam2 = C_LIGHT / raw.f2;
      const pIf = g * c1 - (g - 1) * c2;
      const lIfRaw = g * raw.l1 * lam1 - (g - 1) * raw.l2 * lam2;
      const tr = tropo(t, el, az);
      const geom: SatGeom = {
        prn: raw.prn,
        satEcef: sat.pos,
        rcvEcef: rcv,
        los: e,
        elRad: el,
        azRad: az,
        f1: raw.f1,
        f2: raw.f2,
        band1: raw.band1,
        band2: raw.band2,
        g,
      };
      const cr = corr
        ? applyCorrections(corr, geom, ctx)
        : { rangeM: 0, phaseWindupM: 0 };
      const model = range - sat.clkM + tr.zhd * tr.mh + tr.gradient + cr.rangeM;
      const mg = gradientMapping(el);
      cands.push({
        raw,
        c1,
        c2,
        pIf,
        lIfRaw,
        omcC: pIf - model,
        modelP: model + cr.phaseWindupM,
        el,
        e,
        mwet: tr.mw,
        mgN: mg * Math.cos(az),
        mgE: mg * Math.sin(az),
      });
    }
    // Code clock synchronisation: the epoch's receiver clock is the median
    // code residual; code outliers (> 30 m from it) are dropped.
    const epochObs: {
      sat: number;
      arc: number;
      omc: number;
      mw: number;
      geo: number[];
    }[] = [];
    if (cands.length >= 2) {
      const clk = median(cands.map((c) => c.omcC));
      for (const c of cands) {
        if (Math.abs(c.omcC - clk) > 30) {
          codeOutliers++;
          continue;
        }
        const r = c.raw;
        const lam1 = C_LIGHT / r.f1;
        const lam2 = C_LIGHT / r.f2;
        const lamW = C_LIGHT / (r.f1 - r.f2);
        const mwRaw =
          r.l1 - r.l2 - (r.f1 * c.c1 + r.f2 * c.c2) / (r.f1 + r.f2) / lamW;
        const gf = r.l1 * lam1 - r.l2 * lam2;
        let tk = tracks.get(r.prn);
        let slip = !tk || r.slip || t - tk.lastT > o.maxGapS * 1000;
        if (tk && !slip) {
          const mwOff = mwRaw - (tk.o1 - tk.o2);
          if (tk.n >= 5) {
            const sd = Math.sqrt(tk.mwM2 / (tk.n - 1));
            if (Math.abs(mwOff - tk.mwMean) > Math.max(4 * sd, 1.5))
              slip = true;
          }
          // Geometry-free: linear prediction from the last points.
          const h = tk.gf;
          // Polynomial prediction from the last points (quadratic with
          // ≥ 5, so a low satellite's ionosphere curvature isn't a slip;
          // one point: only gross jumps — the MW test carries a fresh arc).
          const pred = polyPredict(h, t, h.length >= 5 ? 2 : h.length - 1);
          const gapMin = (t - tk.lastT) / 60_000;
          const thr =
            h.length === 1
              ? 1
              : Math.min(
                  0.15,
                  Math.max(0.04, 5 * Math.sqrt(tk.gfMs)) + 0.01 * gapMin
                );
          const err = gf - pred;
          if (Math.abs(err) > thr) slip = true;
          else if (h.length >= 3)
            tk.gfMs += (Math.min(err * err, thr * thr) - tk.gfMs) / 20;
          if (slip) slips++;
        }
        if (slip) {
          if (tk) arcSpan[tk.arc]!.endT = tk.lastT;
          const o1 = Math.round(r.l1 - c.c1 / lam1);
          const o2 = Math.round(r.l2 - c.c2 / lam2);
          tk = {
            arc: arcSpan.length,
            lastT: t,
            o1,
            o2,
            n: 0,
            mwMean: 0,
            mwM2: 0,
            gf: [],
            gfMs: tk?.gfMs ?? 0.01 ** 2,
            startT: t,
          };
          arcSpan.push({ startT: t, endT: t, n: 0 });
          tracks.set(r.prn, tk);
        }
        const mw = mwRaw - (tk!.o1 - tk!.o2);
        tk!.n++;
        const d = mw - tk!.mwMean;
        tk!.mwMean += d / tk!.n;
        tk!.mwM2 += d * (mw - tk!.mwMean);
        tk!.gf.push({ t, v: gf });
        if (tk!.gf.length > 8) tk!.gf.shift();
        tk!.lastT = t;
        arcSpan[tk!.arc]!.endT = t;
        arcSpan[tk!.arc]!.n++;
        const g = (r.f1 * r.f1) / (r.f1 * r.f1 - r.f2 * r.f2);
        const lIf = c.lIfRaw - (g * lam1 * tk!.o1 - (g - 1) * lam2 * tk!.o2);
        const si = satIndex(r.prn);
        if (!freq.has(si)) freq.set(si, [r.f1, r.f2]);
        epochObs.push({
          sat: si,
          arc: tk!.arc,
          omc: lIf - c.modelP,
          mw,
          geo: [c.el, ...c.e, c.mwet, c.mgN, c.mgE],
        });
      }
    }
    epochObs.sort((a, b) => a.sat - b.sat);
    times.push(t);
    start.push(cSat.length);
    for (const z of epochObs) {
      cSat.push(z.sat);
      cArc.push(z.arc);
      cOmc.push(z.omc);
      cMw.push(z.mw);
      cGeo.push(...z.geo);
    }
  }
  start.push(cSat.length);
  // Drop short arcs while packing.
  const short = arcSpan.map(
    (a) => a.endT - a.startT < o.minArcS * 1000 || a.n < 10
  );
  const keep = cArc.map((a) => !short[a]);
  const nKeep = keep.filter(Boolean).length;
  const zd: StationZd = {
    id: st.id,
    apriori: rcv,
    times: Float64Array.from(times),
    timeIndex: new Map(times.map((t, i) => [t, i])),
    start: new Int32Array(times.length + 1),
    sat: new Int16Array(nKeep),
    arc: new Int32Array(nKeep),
    omcP: new Float64Array(nKeep),
    mw: new Float64Array(nKeep),
    geo: new Float32Array(nKeep * NGEO),
    freq,
    zhdZenith: (tMs: number) => tropo(tMs, Math.PI / 2, 0).zhd,
    arcs: short.filter((x) => !x).length,
    slips,
    codeOutliers,
  };
  let k = 0;
  for (let i = 0; i < times.length; i++) {
    zd.start[i] = k;
    for (let j = start[i]!; j < start[i + 1]!; j++) {
      if (!keep[j]) continue;
      zd.sat[k] = cSat[j]!;
      zd.arc[k] = cArc[j]!;
      zd.omcP[k] = cOmc[j]!;
      zd.mw[k] = cMw[j]!;
      for (let g = 0; g < NGEO; g++) zd.geo[k * NGEO + g] = cGeo[j * NGEO + g]!;
      k++;
    }
  }
  zd.start[times.length] = k;
  return zd;
}

/** Merge-join two stations' observations of one common epoch: calls
 *  `f(ka, kb)` for every satellite both observed. */
function forCommon(
  A: StationZd,
  i: number,
  B: StationZd,
  j: number,
  f: (ka: number, kb: number) => void
): void {
  let ka = A.start[i]!;
  let kb = B.start[j]!;
  const ea = A.start[i + 1]!;
  const eb = B.start[j + 1]!;
  while (ka < ea && kb < eb) {
    const sa = A.sat[ka]!;
    const sb = B.sat[kb]!;
    if (sa === sb) f(ka++, kb++);
    else if (sa < sb) ka++;
    else kb++;
  }
}

/* ================================================================== */
/*  Baselines: single differences, local normal equations              */
/* ================================================================== */

interface AmbInfo {
  prn: string;
  f1: number;
  f2: number;
  nObs: number;
  /** MW single-difference statistics over every common epoch. */
  mwN: number;
  mwSum: number;
  mwSq: number;
  startT: number;
  endT: number;
}

interface Baseline {
  ia: number;
  ib: number;
  lengthM: number;
  ambs: AmbInfo[];
  /** Per observation. */
  ep: Int32Array;
  amb: Int32Array;
  y: Float64Array;
  w: Float64Array;
  /** eA(3) eB(3) mwetA mwetB mgNA mgEA mgNB mgEB. */
  part: Float32Array;
  use: Uint8Array;
  epTimes: number[];
  /** The ambiguity held at zero: with one receiver clock difference per
   *  epoch, all ambiguities shifted together are not estimable — this one
   *  takes the shift (its observations carry no ambiguity column). */
  datumAmb: number;
  /** Fixed-ambiguity constraints: [ambIdx i, ambIdx ref, value m]. */
  fixes: [number, number, number][];
  report: DdBaselineReport;
}

const NPART = 12;

function buildBaseline(
  A: StationZd,
  B: StationZd,
  ia: number,
  ib: number,
  sampleMs: number,
  sigma0: number,
  sigma: number
): Baseline {
  const ambKey = new Map<number, number>();
  const ambs: AmbInfo[] = [];
  const ep: number[] = [];
  const amb: number[] = [];
  const y: number[] = [];
  const w: number[] = [];
  const part: number[] = [];
  const epTimes: number[] = [];
  for (let i = 0; i < A.times.length; i++) {
    const t = A.times[i]!;
    const j = B.timeIndex.get(t);
    if (j === undefined) continue;
    const sampled = Math.round(t / 1000) % Math.round(sampleMs / 1000) === 0;
    let eIdx = -1;
    forCommon(A, i, B, j, (ka, kb) => {
      const key = A.arc[ka]! * 1e6 + B.arc[kb]!;
      let k = ambKey.get(key);
      if (k === undefined) {
        k = ambs.length;
        ambKey.set(key, k);
        const [f1, f2] = A.freq.get(A.sat[ka]!)!;
        ambs.push({
          prn: satPrn(A.sat[ka]!),
          f1,
          f2,
          nObs: 0,
          mwN: 0,
          mwSum: 0,
          mwSq: 0,
          startT: t,
          endT: t,
        });
      }
      const a = ambs[k]!;
      const mw = A.mw[ka]! - B.mw[kb]!;
      a.mwN++;
      a.mwSum += mw;
      a.mwSq += mw * mw;
      a.endT = t;
      if (!sampled) return;
      if (eIdx < 0) {
        eIdx = epTimes.length;
        epTimes.push(t);
      }
      a.nObs++;
      ep.push(eIdx);
      amb.push(k);
      y.push(A.omcP[ka]! - B.omcP[kb]!);
      const ga = ka * NGEO;
      const gb = kb * NGEO;
      const var_ =
        sigma ** 2 *
        (1 / Math.sin(A.geo[ga]!) ** 2 + 1 / Math.sin(B.geo[gb]!) ** 2);
      w.push(sigma0 ** 2 / var_);
      part.push(
        A.geo[ga + 1]!,
        A.geo[ga + 2]!,
        A.geo[ga + 3]!,
        B.geo[gb + 1]!,
        B.geo[gb + 2]!,
        B.geo[gb + 3]!,
        A.geo[ga + 4]!,
        B.geo[gb + 4]!,
        A.geo[ga + 5]!,
        A.geo[ga + 6]!,
        B.geo[gb + 5]!,
        B.geo[gb + 6]!
      );
    });
  }
  const ra = A.apriori;
  const rb = B.apriori;
  const lengthM = Math.hypot(ra[0] - rb[0], ra[1] - rb[1], ra[2] - rb[2]);
  return {
    ia,
    ib,
    lengthM,
    ambs,
    ep: Int32Array.from(ep),
    amb: Int32Array.from(amb),
    y: Float64Array.from(y),
    w: Float64Array.from(w),
    part: Float32Array.from(part),
    use: new Uint8Array(y.length).fill(1),
    epTimes,
    datumAmb: ambs.reduce((p, c, i) => (c.nObs > ambs[p]!.nObs ? i : p), 0),
    fixes: [],
    report: {
      a: A.id,
      b: B.id,
      lengthKm: Math.round(lengthM / 100) / 10,
      nObs: y.length,
      nRejected: 0,
      nAmb: ambs.length,
      rmsMm: NaN,
      wl: { candidates: 0, fixed: 0 },
      nl: { candidates: 0, fixed: 0, ratio: 0 },
    },
  };
}

/** Parameter layout shared by every station. */
interface Layout {
  t0: number;
  ztdDtMs: number;
  nZtd: number;
  gradDtMs: number;
  nGrad: number;
  /** Per-station block size: 3 + nZtd + 2·nGrad. */
  nb: number;
}

/** Sparse design row of one single difference over the baseline's local
 *  parameters (station A block, station B block, then ambiguities). */
function rowOf(
  bl: Baseline,
  k: number,
  L: Layout,
  idx: number[],
  val: number[]
): void {
  idx.length = 0;
  val.length = 0;
  const p = bl.part;
  const o = k * NPART;
  const t = bl.epTimes[bl.ep[k]!]!;
  const zf = (t - L.t0) / L.ztdDtMs;
  const zk = Math.min(Math.floor(zf), L.nZtd - 2);
  const zw = zf - zk;
  const gf = (t - L.t0) / L.gradDtMs;
  const gk = Math.min(Math.floor(gf), L.nGrad - 2);
  const gw = gf - gk;
  for (const [base, sign, eo, mo, go] of [
    [0, -1, 0, 6, 8],
    [L.nb, 1, 3, 7, 10],
  ] as const) {
    for (let c = 0; c < 3; c++) {
      idx.push(base + c);
      val.push(sign * p[o + eo + c]!);
    }
    // The SD is A − B: station A's delays enter +, B's −.
    const s = -sign;
    const mw = p[o + mo]!;
    idx.push(base + 3 + zk, base + 3 + zk + 1);
    val.push(s * (1 - zw) * mw, s * zw * mw);
    if (L.nGrad > 0) {
      const gN = p[o + go]!;
      const gE = p[o + go + 1]!;
      const gb = base + 3 + L.nZtd;
      idx.push(gb + gk, gb + gk + 1, gb + L.nGrad + gk, gb + L.nGrad + gk + 1);
      val.push(s * (1 - gw) * gN, s * gw * gN, s * (1 - gw) * gE, s * gw * gE);
    }
  }
  if (bl.amb[k] !== bl.datumAmb) {
    idx.push(2 * L.nb + bl.amb[k]!);
    val.push(1);
  }
}

interface LocalNeq {
  /** Reduced (ambiguities eliminated) 2nb×2nb, rhs, lᵀPl. */
  Nr: Float64Array;
  br: Float64Array;
  ltpl: number;
  /** N_aa⁻¹ and T = N_aa⁻¹·N_ag (na × 2nb), b_a. */
  M: Float64Array;
  T: Float64Array;
  ba: Float64Array;
  nObs: number;
  nEpochs: number;
}

/** Weak a-priori on every ambiguity (σ, m): guards against further
 *  common-mode defects (time blocks without overlapping arcs). */
const AMB_APRIORI_M = 10;
/** σ of a fixed double-difference ambiguity constraint (m). */
const FIX_SIGMA_M = 1e-6;

function accumulate(bl: Baseline, L: Layout, sigma0: number): LocalNeq {
  const ng = 2 * L.nb;
  const na = bl.ambs.length;
  const n = ng + na;
  const N = new Float64Array(n * n);
  const b = new Float64Array(n);
  let ltpl = 0;
  let nObs = 0;
  let nEpochs = 0;
  const idx: number[] = [];
  const val: number[] = [];
  const s = new Float64Array(n);
  const touched: number[] = [];
  const mark = new Uint8Array(n);
  let k = 0;
  const nk = bl.y.length;
  while (k < nk) {
    const e = bl.ep[k]!;
    let sw = 0;
    let sy = 0;
    let used = 0;
    for (; k < nk && bl.ep[k] === e; k++) {
      if (!bl.use[k]) continue;
      rowOf(bl, k, L, idx, val);
      const w = bl.w[k]!;
      const yk = bl.y[k]!;
      for (let i = 0; i < idx.length; i++) {
        const ii = idx[i]!;
        const wi = w * val[i]!;
        b[ii]! += wi * yk;
        for (let j = 0; j < idx.length; j++)
          N[ii * n + idx[j]!]! += wi * val[j]!;
        s[ii]! += wi;
        if (!mark[ii]) {
          mark[ii] = 1;
          touched.push(ii);
        }
      }
      ltpl += w * yk * yk;
      sw += w;
      sy += w * yk;
      used++;
    }
    if (used >= 2) {
      // Eliminate this epoch's clock difference (rank-1 downdate).
      for (const i of touched) {
        const si = s[i]! / sw;
        b[i]! -= si * sy;
        for (const j of touched) N[i * n + j]! -= si * s[j]!;
      }
      ltpl -= (sy * sy) / sw;
      nObs += used - 1;
      nEpochs++;
    } else if (used === 1) {
      // A lone observation only determines the clock: take it back out.
      for (const i of touched) {
        const si = s[i]! / sw;
        b[i]! -= si * sy;
        for (const j of touched) N[i * n + j]! -= si * s[j]!;
      }
      ltpl -= (sy * sy) / sw;
    }
    for (const i of touched) {
      s[i] = 0;
      mark[i] = 0;
    }
    touched.length = 0;
  }
  const wa = (sigma0 / AMB_APRIORI_M) ** 2;
  const wf = (sigma0 / FIX_SIGMA_M) ** 2;
  for (let a = 0; a < na; a++)
    N[(ng + a) * n + ng + a]! += a === bl.datumAmb ? wf : wa;
  for (const [i, r, v] of bl.fixes) {
    const ii = ng + i;
    const rr = ng + r;
    N[ii * n + ii]! += wf;
    N[rr * n + rr]! += wf;
    N[ii * n + rr]! -= wf;
    N[rr * n + ii]! -= wf;
    b[ii]! += wf * v;
    b[rr]! -= wf * v;
    ltpl += wf * v * v;
  }

  // Pre-eliminate the ambiguities.
  const Naa = new Float64Array(na * na);
  for (let i = 0; i < na; i++)
    for (let j = 0; j < na; j++) Naa[i * na + j] = N[(ng + i) * n + ng + j]!;
  const M = invertSpd(Naa, na);
  if (!M) throw new Error('ambiguity normal matrix not positive definite');
  const T = new Float64Array(na * ng);
  for (let i = 0; i < na; i++)
    for (let c = 0; c < ng; c++) {
      let acc = 0;
      for (let j = 0; j < na; j++) acc += M[i * na + j]! * N[(ng + j) * n + c]!;
      T[i * ng + c] = acc;
    }
  const ba = new Float64Array(na);
  for (let i = 0; i < na; i++) ba[i] = b[ng + i]!;
  const Nr = new Float64Array(ng * ng);
  const br = new Float64Array(ng);
  // N_red = N_gg − N_ga·T ; b_red = b_g − Tᵀ·b_a ; ltpl −= b_aᵀ·M·b_a.
  for (let r = 0; r < ng; r++)
    for (let c = 0; c < ng; c++) {
      let acc = N[r * n + c]!;
      for (let i = 0; i < na; i++) acc -= N[r * n + ng + i]! * T[i * ng + c]!;
      Nr[r * ng + c] = acc;
    }
  for (let r = 0; r < ng; r++) {
    let acc = 0;
    for (let i = 0; i < na; i++) acc += T[i * ng + r]! * ba[i]!;
    br[r] = b[r]! - acc;
  }
  let q = 0;
  for (let i = 0; i < na; i++) {
    let acc = 0;
    for (let j = 0; j < na; j++) acc += M[i * na + j]! * ba[j]!;
    q += ba[i]! * acc;
  }
  return { Nr, br, ltpl: ltpl - q, M, T, ba, nObs, nEpochs };
}

/* ================================================================== */
/*  Dense SPD helpers (row-major Float64Array)                         */
/* ================================================================== */

/** Cholesky in place (lower), false when not positive definite. */
function cholesky(A: Float64Array, n: number): boolean {
  for (let j = 0; j < n; j++) {
    let d = A[j * n + j]!;
    for (let k = 0; k < j; k++) d -= A[j * n + k]! ** 2;
    if (!(d > 0)) return false;
    const ljj = Math.sqrt(d);
    A[j * n + j] = ljj;
    for (let i = j + 1; i < n; i++) {
      let s = A[i * n + j]!;
      for (let k = 0; k < j; k++) s -= A[i * n + k]! * A[j * n + k]!;
      A[i * n + j] = s / ljj;
    }
  }
  return true;
}

/** Inverse of a symmetric positive-definite matrix (null if not SPD). */
function invertSpd(A: Float64Array, n: number): Float64Array | null {
  const L = Float64Array.from(A);
  if (!cholesky(L, n)) return null;
  // Inverse of L (lower), then A⁻¹ = L⁻ᵀ·L⁻¹.
  const Li = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    Li[i * n + i] = 1 / L[i * n + i]!;
    for (let j = 0; j < i; j++) {
      let s = 0;
      for (let k = j; k < i; k++) s -= L[i * n + k]! * Li[k * n + j]!;
      Li[i * n + j] = s / L[i * n + i]!;
    }
  }
  const X = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let k = i; k < n; k++) s += Li[k * n + i]! * Li[k * n + j]!;
      X[i * n + j] = s;
      X[j * n + i] = s;
    }
  return X;
}

/* ================================================================== */
/*  Network assembly, datum, solve                                     */
/* ================================================================== */

interface NetNeq {
  N: Float64Array;
  b: Float64Array;
  ltpl: number;
  /** Double differences (single differences − one per epoch clock). */
  nObs: number;
  /** Epoch clocks eliminated. */
  nClk: number;
}

function assemble(
  baselines: Baseline[],
  locals: LocalNeq[],
  nSt: number,
  L: Layout
): NetNeq {
  const G = nSt * L.nb;
  const N = new Float64Array(G * G);
  const b = new Float64Array(G);
  let ltpl = 0;
  let nObs = 0;
  let nClk = 0;
  baselines.forEach((bl, k) => {
    const loc = locals[k]!;
    const ng = 2 * L.nb;
    const map = (i: number) =>
      i < L.nb ? bl.ia * L.nb + i : bl.ib * L.nb + (i - L.nb);
    for (let r = 0; r < ng; r++) {
      const gr = map(r);
      b[gr]! += loc.br[r]!;
      for (let c = 0; c < ng; c++) N[gr * G + map(c)]! += loc.Nr[r * ng + c]!;
    }
    ltpl += loc.ltpl;
    nObs += loc.nObs;
    nClk += loc.nEpochs;
  });
  return { N, b, ltpl, nObs, nClk };
}

interface Solved {
  x: Float64Array;
  Q: Float64Array;
}

function solveConstrained(
  N0: Float64Array,
  b: Float64Array,
  stations: StationZd[],
  L: Layout,
  o: DdNetworkOptions,
  sigma0: number
): Solved {
  const G = stations.length * L.nb;
  const N = Float64Array.from(N0);
  const zs = o.constraints?.ztdSigmaM ?? 1;
  const gs = o.constraints?.gradientSigmaM ?? 0.01;
  for (let s = 0; s < stations.length; s++) {
    const base = s * L.nb;
    for (let z = 0; z < L.nZtd; z++)
      N[(base + 3 + z) * G + base + 3 + z]! += (sigma0 / zs) ** 2;
    for (let g = 0; g < 2 * L.nGrad; g++) {
      const i = base + 3 + L.nZtd + g;
      N[i * G + i]! += (sigma0 / gs) ** 2;
    }
  }
  // Minimum constraints: no-net-translation (+ rotation) on the a-priori.
  const ds = o.datum?.sigmaM ?? 1e-4;
  const ref = o.datum?.stations
    ? stations
        .map((s, i) => [s, i] as const)
        .filter(([s]) =>
          o.datum!.stations!.some((d) => s.id.startsWith(d.slice(0, 4)))
        )
    : stations.map((s, i) => [s, i] as const);
  const rows: { i: number; v: number }[][] = [];
  for (let c = 0; c < 3; c++)
    rows.push(ref.map(([, i]) => ({ i: i * L.nb + c, v: 1 })));
  if (o.datum?.rotations) {
    const R = 6.371e6;
    for (let c = 0; c < 3; c++)
      rows.push(
        ref.flatMap(([s, i]) => {
          const [x, y, z] = s.apriori;
          // rotation about axis c: d = ω × r
          const r = c === 0 ? [0, -z, y] : c === 1 ? [z, 0, -x] : [-y, x, 0];
          return r.map((v, k) => ({ i: i * L.nb + k, v: v / R }));
        })
      );
  }
  const wd = (sigma0 / ds) ** 2;
  for (const row of rows)
    for (const a of row)
      for (const c of row) N[a.i * G + c.i]! += wd * a.v * c.v;
  const Q = invertSpd(N, G);
  if (!Q) throw new Error('network normal matrix not positive definite');
  const x = new Float64Array(G);
  for (let i = 0; i < G; i++) {
    let s = 0;
    for (let j = 0; j < G; j++) s += Q[i * G + j]! * b[j]!;
    x[i] = s;
  }
  return { x, Q };
}

/** Local parameter vector / covariance block of a baseline. */
function localOf(bl: Baseline, L: Layout, x: Float64Array): Float64Array {
  const ng = 2 * L.nb;
  const out = new Float64Array(ng);
  for (let i = 0; i < ng; i++)
    out[i] = x[i < L.nb ? bl.ia * L.nb + i : bl.ib * L.nb + i - L.nb]!;
  return out;
}

/** Float ambiguities given the network solution: a = M·b_a − T·x_l. */
function ambiguitiesOf(
  loc: LocalNeq,
  xl: Float64Array,
  na: number,
  ng: number
) {
  const a = new Float64Array(na);
  for (let i = 0; i < na; i++) {
    let s = 0;
    for (let j = 0; j < na; j++) s += loc.M[i * na + j]! * loc.ba[j]!;
    for (let c = 0; c < ng; c++) s -= loc.T[i * ng + c]! * xl[c]!;
    a[i] = s;
  }
  return a;
}

/** Post-fit residuals after the epoch clock; returns Σw·v² and RMS. */
function residuals(
  bl: Baseline,
  L: Layout,
  xl: Float64Array,
  a: Float64Array,
  out?: Float64Array
): { vtpv: number; rms: number; n: number } {
  const idx: number[] = [];
  const val: number[] = [];
  const nk = bl.y.length;
  const r = new Float64Array(nk);
  let vtpv = 0;
  let ss = 0;
  let n = 0;
  let k = 0;
  while (k < nk) {
    const e = bl.ep[k]!;
    const k0 = k;
    let sw = 0;
    let swr = 0;
    for (; k < nk && bl.ep[k] === e; k++) {
      rowOf(bl, k, L, idx, val);
      let m = 0;
      for (let i = 0; i < idx.length; i++)
        if (idx[i]! < xl.length) m += val[i]! * xl[idx[i]!]!;
      r[k] = bl.y[k]! - m - a[bl.amb[k]!]!;
      if (bl.use[k]) {
        sw += bl.w[k]!;
        swr += bl.w[k]! * r[k]!;
      }
    }
    const clk = sw > 0 ? swr / sw : 0;
    for (let j = k0; j < k; j++) {
      r[j]! -= clk;
      if (bl.use[j]) {
        vtpv += bl.w[j]! * r[j]! ** 2;
        ss += r[j]! ** 2;
        n++;
      }
    }
  }
  if (out) out.set(r);
  return { vtpv, rms: n ? Math.sqrt(ss / n) : NaN, n };
}

/* ================================================================== */
/*  Ambiguity resolution                                               */
/* ================================================================== */

function resolveBaseline(
  bl: Baseline,
  a: Float64Array,
  Qa: Float64Array,
  o: Required<DdArOptions>,
  round: number
): void {
  const na = bl.ambs.length;
  const wlRes: (number | null)[] = new Array(na).fill(null);
  const minMs = o.minArcS * 1000;
  let wlCand = 0;
  let wlFixed = 0;
  // --- Wide-lane per constellation: SD MW means after the baseline's
  // receiver wide-lane bias (circular mean of the fractions).
  for (const sys of ['G', 'E']) {
    const ids = bl.ambs
      .map((m, i) => i)
      .filter(
        (i) =>
          bl.ambs[i]!.prn[0] === sys &&
          bl.ambs[i]!.mwN >= 20 &&
          bl.ambs[i]!.endT - bl.ambs[i]!.startT >= minMs &&
          bl.ambs[i]!.nObs >= 10
      );
    if (ids.length < 2) continue;
    const mean = (i: number) => bl.ambs[i]!.mwSum / bl.ambs[i]!.mwN;
    const sigma = (i: number) => {
      const m = bl.ambs[i]!;
      const v = Math.max(0, m.mwSq / m.mwN - mean(i) ** 2);
      // MW noise is time-correlated (multipath): ~10 epochs per independent sample.
      return Math.sqrt(v / Math.max(1, m.mwN / 10));
    };
    let cs = 0;
    let sn = 0;
    for (const i of ids) {
      const wgt = bl.ambs[i]!.mwN;
      cs += wgt * Math.cos(2 * Math.PI * mean(i));
      sn += wgt * Math.sin(2 * Math.PI * mean(i));
    }
    const bias = Math.atan2(sn, cs) / (2 * Math.PI);
    wlCand += ids.length - 1;
    let nFix = 0;
    for (const i of ids) {
      const r = mean(i) - bias;
      const n = Math.round(r);
      if (Math.abs(r - n) <= o.wlMaxFrac && sigma(i) <= o.wlMaxSigma) {
        wlRes[i] = n;
        nFix++;
      }
    }
    wlFixed += Math.max(0, nFix - 1);
  }
  bl.report.wl = { candidates: wlCand, fixed: wlFixed };

  // --- Narrow-lane: DD within each constellation against the WL-fixed
  // ambiguity with the most data; LAMBDA with partial fixing.
  type Dd = {
    i: number;
    r: number;
    sys: string;
    n1: number;
    kW: number;
    lamN: number;
  };
  const dds: Dd[] = [];
  const already = new Set(bl.fixes.map((f) => f[0]));
  for (const sys of ['G', 'E']) {
    const ids = bl.ambs
      .map((_, i) => i)
      .filter((i) => wlRes[i] !== null && bl.ambs[i]!.prn[0] === sys);
    if (ids.length < 2) continue;
    // Keep the reference of an earlier round.
    const prevRef = bl.fixes.find((f) => bl.ambs[f[1]]!.prn[0] === sys)?.[1];
    const ref =
      prevRef !== undefined && ids.includes(prevRef)
        ? prevRef
        : ids.reduce((p, c) => (bl.ambs[c]!.nObs > bl.ambs[p]!.nObs ? c : p));
    for (const i of ids) {
      if (i === ref || already.has(i)) continue;
      const m = bl.ambs[i]!;
      const lamN = C_LIGHT / (m.f1 + m.f2);
      const kW = (lamN * m.f2) / (m.f1 - m.f2);
      const dW = wlRes[i]! - wlRes[ref]!;
      dds.push({
        i,
        r: ref,
        sys,
        n1: (a[i]! - a[ref]! - kW * dW) / lamN,
        kW: kW * dW,
        lamN,
      });
    }
  }
  const qOf = (x: Dd, y: Dd) =>
    (Qa[x.i * na + y.i]! -
      Qa[x.i * na + y.r]! -
      Qa[x.r * na + y.i]! +
      Qa[x.r * na + y.r]!) /
    (x.lamN * y.lamN);
  let cand = dds
    .map((d) => ({ d, s: Math.sqrt(Math.max(0, qOf(d, d))) }))
    .filter((c) => c.s <= o.nlMaxSigma)
    .sort((p, q) => p.s - q.s)
    .map((c) => c.d);
  if (round === 0) bl.report.nl.candidates = dds.length;
  let fixedSet: { d: Dd; n: number }[] = [];
  let ratio = 0;
  while (cand.length >= 2) {
    const m = cand.length;
    const v = new Float64Array(m);
    const Q = new Float64Array(m * m);
    for (let p = 0; p < m; p++) {
      v[p] = cand[p]!.n1;
      for (let q = 0; q < m; q++) Q[p * m + q] = qOf(cand[p]!, cand[q]!);
    }
    const res = lambdaSearch(v, Q, m, 2);
    const rt = res ? Math.min(res.ratio, 999.9) : 0;
    if (res && rt >= o.ratio) {
      ratio = rt;
      fixedSet = cand.map((d, p) => ({ d, n: res.candidates[0]![p]! }));
      break;
    }
    cand = cand.slice(0, -1);
  }
  for (const { d, n } of fixedSet) bl.fixes.push([d.i, d.r, d.lamN * n + d.kW]);
  bl.report.nl.fixed += fixedSet.length;
  bl.report.nl.ratio = Math.max(bl.report.nl.ratio, ratio);
}

/* ================================================================== */
/*  Main entry                                                         */
/* ================================================================== */

const withDefaults = (opts: DdNetworkOptions) => ({
  elevationMaskDeg: 5,
  systems: 'GE',
  maxGapS: 180,
  minArcS: 600,
  ...opts,
});

/**
 * Model and pre-process one station ahead of {@link solveDdNetwork} (same
 * `source` and options), so its raw observations can be released before the
 * next station is read — what keeps a 40-station day small.
 */
export function prepareDdStation(
  input: DdStationInput,
  source: PppEphemerisSource,
  opts: DdNetworkOptions = {}
): DdStationData {
  return { id: input.id, zd: modelStation(input, source, withDefaults(opts)) };
}

/**
 * Solve a network of stations from double-differenced carrier phase.
 * `source` is one precise orbit/clock source shared by every station
 * (e.g. `new Sp3EphemerisSource(sp3)`).
 */
export function solveDdNetwork(
  inputs: readonly (DdStationInput | DdStationData)[],
  source: PppEphemerisSource,
  opts: DdNetworkOptions = {}
): DdNetworkResult {
  const timings: Record<string, number> = {};
  let tic = Date.now();
  const lap = (k: string) => {
    const now = Date.now();
    timings[k] = (timings[k] ?? 0) + (now - tic);
    tic = now;
  };
  const o = withDefaults(opts);
  const sigma0 = opts.phaseSigmaM ?? 0.003;
  const sampleMs = (opts.sampleS ?? 30) * 1000;
  const arOpt: Required<DdArOptions> | null =
    opts.ar === false
      ? null
      : {
          maxBaselineKm: 6000,
          wlMaxFrac: 0.25,
          wlMaxSigma: 0.1,
          ratio: 3,
          nlMaxSigma: 0.15,
          minArcS: 1800,
          rounds: 2,
          ...(opts.ar === true || opts.ar === undefined ? {} : opts.ar),
        };

  // 1–2. Zero differences + pre-processing.
  const st = inputs.map((s) =>
    'zd' in s ? (s.zd as StationZd) : modelStation(s, source, o)
  );
  lap('model');

  // Parameter layout: a common ZTD / gradient node grid.
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const s of st)
    if (s.times.length) {
      tMin = Math.min(tMin, s.times[0]!);
      tMax = Math.max(tMax, s.times.at(-1)!);
    }
  const ztdDtMs = (opts.ztdIntervalH ?? 1) * 3_600_000;
  const t0 = Math.floor(tMin / ztdDtMs) * ztdDtMs;
  const nZtd = Math.max(2, Math.ceil((tMax - t0) / ztdDtMs) + 1);
  const useGrad = opts.gradients ?? true;
  const gradDtMs = (opts.gradientIntervalH ?? 24) * 3_600_000;
  const gt0 = t0;
  const nGrad = useGrad
    ? Math.max(2, Math.ceil((tMax - gt0) / gradDtMs) + 1)
    : 0;
  const L: Layout = {
    t0,
    ztdDtMs,
    nZtd,
    gradDtMs,
    nGrad,
    nb: 3 + nZtd + 2 * nGrad,
  };

  // 3. Baselines.
  const ids = st.map((s) => s.id);
  const commonObs = (a: string, b: string) => {
    const A = st[ids.indexOf(a)]!;
    const B = st[ids.indexOf(b)]!;
    let n = 0;
    for (let i = 0; i < A.times.length; i++) {
      const t = A.times[i]!;
      if (Math.round(t / 1000) % Math.round(sampleMs / 1000)) continue;
      const j = B.timeIndex.get(t);
      if (j === undefined) continue;
      forCommon(A, i, B, j, () => n++);
    }
    return n;
  };
  let pairs: SelectedBaseline[];
  if (Array.isArray(opts.baselines))
    pairs = (opts.baselines as readonly (readonly [string, string])[]).map(
      ([a, b]) => ({ a, b, lengthM: 0, commonObs: 0 })
    );
  else {
    const sel = selectBaselines(
      st.map((s) => ({ id: s.id, ecef: s.apriori })),
      {
        strategy: (opts.baselines as 'obs-max' | 'shortest') ?? 'obs-max',
        commonObs,
      }
    );
    if (sel.components > 1)
      throw new Error(
        `The network splits into ${sel.components} groups without common observations.`
      );
    pairs = sel.baselines;
  }
  lap('baselines');
  const bls = pairs.map((p) =>
    buildBaseline(
      st[ids.indexOf(p.a)]!,
      st[ids.indexOf(p.b)]!,
      ids.indexOf(p.a),
      ids.indexOf(p.b),
      sampleMs,
      sigma0,
      sigma0
    )
  );
  lap('singleDifferences');

  // 4–5. Float network with residual screening.
  const G = st.length * L.nb;
  const k = opts.screening?.k ?? 4;
  const iters = opts.screening?.iterations ?? 3;
  let locals: LocalNeq[] = [];
  let net!: NetNeq;
  let sol!: Solved;
  const solveAll = () => {
    locals = bls.map((bl) => accumulate(bl, L, sigma0));
    net = assemble(bls, locals, st.length, L);
    sol = solveConstrained(net.N, net.b, st, L, opts, sigma0);
  };
  solveAll();
  lap('float');
  for (let it = 0; it < iters; it++) {
    let rejected = 0;
    bls.forEach((bl, i) => {
      const xl = localOf(bl, L, sol.x);
      const a = ambiguitiesOf(locals[i]!, xl, bl.ambs.length, 2 * L.nb);
      const r = new Float64Array(bl.y.length);
      const { vtpv, n } = residuals(bl, L, xl, a, r);
      const s0 = Math.sqrt(vtpv / Math.max(1, n));
      for (let j = 0; j < r.length; j++)
        if (
          bl.use[j] &&
          Math.abs(r[j]!) * Math.sqrt(bl.w[j]!) > k * Math.max(s0, sigma0)
        ) {
          bl.use[j] = 0;
          bl.report.nRejected++;
          rejected++;
        }
    });
    if (!rejected) break;
    solveAll();
  }
  lap('screening');

  const stats = (s: Solved, locs: LocalNeq[]) => {
    let vtpv = 0;
    let nAmb = 0;
    let nObs = 0;
    bls.forEach((bl, i) => {
      const xl = localOf(bl, L, s.x);
      const a = ambiguitiesOf(locs[i]!, xl, bl.ambs.length, 2 * L.nb);
      const r = residuals(bl, L, xl, a);
      vtpv += r.vtpv;
      bl.report.rmsMm = Math.round(r.rms * 10000) / 10;
      nAmb += bl.ambs.length - bl.fixes.length;
      nObs += locs[i]!.nObs;
    });
    const dof = Math.max(1, nObs - nAmb - G + 3);
    return { sigma0: Math.sqrt(vtpv / dof), dof };
  };
  const toSolution = (
    s: Solved,
    st0: { sigma0: number; dof: number }
  ): DdSolution => ({
    dx: s.x,
    // Weights are (σ₀/σ)², so Cov = σ̂₀²·N⁻¹.
    covariance: s.Q.map((q) => q * st0.sigma0 ** 2),
    sigma0: st0.sigma0,
    dof: st0.dof,
  });
  const floatStats = stats(sol, locals);
  const floatSolution = toSolution(sol, floatStats);
  const floatNeq = makeNeq(net, st, L, sigma0, bls);

  // 6. Ambiguity resolution.
  if (arOpt) {
    for (let round = 0; round < arOpt.rounds; round++) {
      const s0 = Math.max(floatStats.sigma0, sigma0);
      const scale = (s0 / sigma0) ** 2;
      let added = 0;
      bls.forEach((bl, i) => {
        if (bl.lengthM / 1000 > arOpt.maxBaselineKm) return;
        const na = bl.ambs.length;
        const ng = 2 * L.nb;
        const loc = locals[i]!;
        const xl = localOf(bl, L, sol.x);
        const a = ambiguitiesOf(loc, xl, na, ng);
        // Q_aa = (M + T·Q_ll·Tᵀ)·σ₀² (σ₀ a-posteriori).
        const Qll = new Float64Array(ng * ng);
        const gi = (j: number) =>
          j < L.nb ? bl.ia * L.nb + j : bl.ib * L.nb + j - L.nb;
        for (let r = 0; r < ng; r++)
          for (let c = 0; c < ng; c++)
            Qll[r * ng + c] = sol.Q[gi(r) * G + gi(c)]!;
        const TQ = new Float64Array(na * ng);
        for (let r = 0; r < na; r++)
          for (let c = 0; c < ng; c++) {
            let acc = 0;
            for (let j = 0; j < ng; j++)
              acc += loc.T[r * ng + j]! * Qll[j * ng + c]!;
            TQ[r * ng + c] = acc;
          }
        const Qa = new Float64Array(na * na);
        for (let r = 0; r < na; r++)
          for (let c = 0; c < na; c++) {
            let acc = loc.M[r * na + c]!;
            for (let j = 0; j < ng; j++)
              acc += TQ[r * ng + j]! * loc.T[c * ng + j]!;
            Qa[r * na + c] = acc * sigma0 ** 2 * scale;
          }
        const before = bl.fixes.length;
        resolveBaseline(bl, a, Qa, arOpt, round);
        added += bl.fixes.length - before;
      });
      if (!added) break;
      solveAll();
    }
    // Totals per baseline: count NL fixes cumulatively.
    for (const bl of bls) bl.report.nl.fixed = bl.fixes.length;
  }
  lap('ar');
  const finalStats = stats(sol, locals);
  const solution = toSolution(sol, finalStats);
  const neq = makeNeq(net, st, L, sigma0, bls);

  // Results per station.
  const stations: DdStationResult[] = st.map((s, i) => {
    const base = i * L.nb;
    const ecef: V3 = [0, 1, 2].map(
      (c) => s.apriori[c]! + sol.x[base + c]!
    ) as V3;
    const [lat, lon] = ecefToGeodetic(ecef[0], ecef[1], ecef[2]);
    const R = [
      [-Math.sin(lon), Math.cos(lon), 0],
      [
        -Math.sin(lat) * Math.cos(lon),
        -Math.sin(lat) * Math.sin(lon),
        Math.cos(lat),
      ],
      [
        Math.cos(lat) * Math.cos(lon),
        Math.cos(lat) * Math.sin(lon),
        Math.sin(lat),
      ],
    ];
    const C = solution.covariance;
    const sigmaEnu = [0, 1, 2].map((r) => {
      let v = 0;
      for (let p = 0; p < 3; p++)
        for (let q = 0; q < 3; q++)
          v += R[r]![p]! * C[(base + p) * G + base + q]! * R[r]![q]!;
      return Math.sqrt(Math.max(0, v));
    }) as V3;
    const ztd = Array.from({ length: L.nZtd }, (_, z) => {
      const t = L.t0 + z * L.ztdDtMs;
      const j = base + 3 + z;
      return {
        tMs: t,
        ztdM: s.zhdZenith(t) + sol.x[j]!,
        sigmaM: Math.sqrt(Math.max(0, C[j * G + j]!)),
      };
    });
    return {
      id: s.id,
      apriori: s.apriori,
      ecef,
      sigmaEnu,
      ztd,
      arcs: s.arcs,
      slips: s.slips,
      codeOutliers: s.codeOutliers,
    };
  });

  const ar = { wlCandidates: 0, wlFixed: 0, nlCandidates: 0, nlFixed: 0 };
  for (const bl of bls) {
    ar.wlCandidates += bl.report.wl.candidates;
    ar.wlFixed += bl.report.wl.fixed;
    ar.nlCandidates += bl.report.nl.candidates;
    ar.nlFixed += bl.report.nl.fixed;
  }
  lap('report');
  return {
    stations,
    baselines: bls.map((b) => b.report),
    neq,
    floatNeq,
    solution,
    floatSolution,
    ar,
    timings,
  };
}

function makeNeq(
  net: NetNeq,
  st: StationZd[],
  L: Layout,
  sigma0: number,
  bls: Baseline[]
): NormalEquations {
  const params: NeqParameter[] = [];
  let start = Infinity;
  let end = -Infinity;
  for (const s of st) {
    if (!s.times.length) continue;
    start = Math.min(start, s.times[0]!);
    end = Math.max(end, s.times.at(-1)!);
  }
  const mid = (start + end) / 2;
  for (const s of st) {
    const site = s.id.slice(0, 4).toUpperCase();
    (['STAX', 'STAY', 'STAZ'] as const).forEach((type, c) =>
      params.push({
        type,
        site,
        refEpochMs: mid,
        apriori: s.apriori[c]!,
        unit: 'm',
      })
    );
    for (let z = 0; z < L.nZtd; z++) {
      const t = L.t0 + z * L.ztdDtMs;
      params.push({
        type: 'TROTOT',
        site,
        refEpochMs: t,
        apriori: s.zhdZenith(t),
        unit: 'm',
        startMs: t - L.ztdDtMs,
        endMs: t + L.ztdDtMs,
      });
    }
    for (const type of ['TGNTOT', 'TGETOT'] as const)
      for (let g = 0; g < L.nGrad; g++) {
        const t = L.t0 + g * L.gradDtMs;
        params.push({
          type,
          site,
          refEpochMs: t,
          apriori: 0,
          unit: 'm',
          startMs: t - L.gradDtMs,
          endMs: t + L.gradDtMs,
        });
      }
  }
  const clocks = net.nClk;
  return {
    params,
    N: Float64Array.from(net.N),
    b: Float64Array.from(net.b),
    ltpl: net.ltpl,
    nObs: net.nObs + clocks,
    nPreEliminated:
      clocks + bls.reduce((s, bl) => s + bl.ambs.length - bl.fixes.length, 0),
    sigma0Apriori: sigma0,
    dataStartMs: start,
    dataEndMs: end,
  };
}
