/**
 * Satellite clock estimation from a station network with fixed precise
 * orbits and fixed station coordinates — the clock part of an IGS analysis
 * centre's processing (epoch-wise clock parameters).
 *
 * Observation model, ionosphere-free code and phase (m), every
 * `sampleS`, with the user-side PPP model (antenna PCO/PCV, tides,
 * wind-up, relativity, Niell a-priori troposphere) removed — the same
 * `PppCorrections` the PPP engine uses, so the clocks are consistent with
 * it:
 *
 *   P_IF − model = c·dtᵣ − c·δtˢ + m_w·ZWDᵣ(t)
 *   Φ_IF − model = c·dtᵣ − c·δtˢ + m_w·ZWDᵣ(t) + Bᵣˢ
 *
 *  - c·dtᵣ, c·δtˢ: one receiver clock (per station and constellation) and
 *    one satellite clock correction (to the a-priori clock of `source`)
 *    per epoch — free, white-noise parameters;
 *  - ZWDᵣ: piecewise linear per station, nodes every `zwdNodeS`;
 *  - Bᵣˢ: one float ambiguity per continuous arc (arcs break on LLI, gaps
 *    and Melbourne–Wübbena / geometry-free jumps, found at the full data
 *    rate).
 *
 * One least-squares adjustment over the whole session: the epoch
 * parameters are pre-eliminated epoch by epoch onto the normal equations
 * of the global ones (ambiguities, ZWD), which are solved, and the clocks
 * are then back-substituted — the rigorous batch solution, not a filter.
 *
 * Datum: the receiver clock(s) of a reference station are fixed to zero
 * each epoch (the first station of `referenceStations` with data), so the
 * satellite clocks are relative to that station's clock; `alignTo`
 * optionally shifts the whole solution by an offset + drift onto another
 * clock scale (as IGS aligns to broadcast GPS time). Comparisons with
 * other clock products remove a common offset per epoch anyway.
 *
 * Validated against IGS and ESA final clocks.
 */

import { ecefToGeodetic, getAer } from '../coordinates';
import {
  satStateAtEmission,
  type PppEpoch,
  type PppEphemerisSource,
} from '../positioning/ppp';
import {
  applyCorrections,
  type PppCorrections,
} from '../positioning/ppp-corrections';
import { niellMapping } from '../positioning/ppp-tropo';
import { choleskyDecompose, choleskySolve, DenseNeq } from './dense-ls';
import type { ClkFile, ClkRecord } from '../rinex/clk';

const C = 299792458;

export interface ClockStation {
  id: string;
  /** Fixed ECEF position (m), e.g. from a weekly SINEX or static PPP. */
  xyz: readonly [number, number, number];
  epochs: readonly PppEpoch[];
  /** The station's PPP corrections (antenna, tides, wind-up); fresh per
   *  station — wind-up keeps state. */
  corrections?: PppCorrections;
}

export interface NetworkClockOptions {
  /** Constellations (default 'G'). */
  systems?: string;
  elevationMaskDeg?: number;
  /** The adjustment uses epochs every this many seconds (default 300).
   *  Arcs are still found at the full data rate. */
  sampleS?: number;
  /** Output clocks every this many seconds (default `sampleS`; must divide
   *  it). Epochs between the adjustment's get their clocks with the
   *  ambiguities and ZWD of the adjustment held fixed — CODE's clock
   *  densification (30 s from a 300 s solution). */
  outputS?: number;
  /** Zenith σ of the ionosphere-free code and phase (m). */
  codeSigma?: number;
  phaseSigma?: number;
  /** ZWD node spacing (s, default 7200). */
  zwdNodeS?: number;
  /** Stations whose clocks define the datum, in order of preference
   *  (default: the station list's order). */
  referenceStations?: string[];
  /** Code biases to remove from the observations before the IF
   *  combination (m, subtracted), e.g. C1C → C1W from a DCB product, so
   *  stations tracking different codes give one clock datum. */
  codeBias?: (prn: string, code: string) => number | null;
  /** Shift the solution by an offset + drift fitted to the mean of
   *  (estimate − alignTo) over satellites: a clock scale to align to,
   *  e.g. broadcast clocks (s). */
  alignTo?: (prn: string, tMs: number) => number | null;
  /** Fewer stations than this see a satellite at an epoch → no clock. */
  minStations?: number;
  /** Arcs with fewer epochs (at `sampleS`) are dropped. Default 4. */
  minArcEpochs?: number;
}

export interface NetworkClockSolution {
  /** Clock epochs (ms, GPS scale). */
  epochs: number[];
  /** Satellite clock (s) per epoch, NaN where not estimated. Like IGS
   *  clock products: without the periodic relativistic term. */
  satClocks: Map<string, Float64Array>;
  /** Stations observing the satellite at each epoch. */
  satStations: Map<string, Uint8Array>;
  /** Receiver clocks (s) per station and constellation ('WTZR00DEU|G'). */
  rcvClocks: Map<string, Float64Array>;
  /** Reference station per epoch. */
  reference: string[];
  /** Post-fit RMS of code and phase residuals (m). */
  codeRms: number;
  phaseRms: number;
  nObs: number;
  nRejected: number;
  nAmbiguities: number;
  /** Offset (s) and drift (s/s) applied by `alignTo` (0 without). */
  alignment: { offsetS: number; driftSPerS: number };
}

interface Row {
  st: number;
  sys: string;
  sat: number;
  amb: number;
  zwdA: number;
  zwdB: number;
  wz: number;
  mw: number;
  omcP: number;
  omcL: number;
  /** 1 / σ² factor (sin² el). */
  w: number;
  bad: boolean;
}

/**
 * Estimate satellite (and receiver) clocks from a network. `source` gives
 * the fixed orbit and the a-priori satellite clock (e.g.
 * `Sp3EphemerisSource` on an SP3 file — its 5-minute clocks only linearise:
 * the epoch clocks are free parameters, so the result doesn't depend on
 * them beyond the datum alignment).
 */
export function estimateNetworkClocks(
  stations: readonly ClockStation[],
  source: PppEphemerisSource,
  options: NetworkClockOptions = {}
): NetworkClockSolution {
  const systems = options.systems ?? 'G';
  const mask = ((options.elevationMaskDeg ?? 10) * Math.PI) / 180;
  const stepMs = (options.sampleS ?? 300) * 1000;
  const outMs = (options.outputS ?? options.sampleS ?? 300) * 1000;
  if (stepMs % outMs !== 0) throw new Error('outputS must divide sampleS.');
  const sP = options.codeSigma ?? 0.6;
  const sL = options.phaseSigma ?? 0.006;
  const zwdStep = (options.zwdNodeS ?? 7200) * 1000;
  const minSt = options.minStations ?? 2;
  const minArc = options.minArcEpochs ?? 4;
  const refOrder = (options.referenceStations ?? stations.map((s) => s.id))
    .map((id) => stations.findIndex((s) => s.id === id))
    .filter((i) => i >= 0);

  // --- epochs ---
  let tStart = Infinity;
  let tEnd = -Infinity;
  for (const s of stations)
    for (const e of s.epochs)
      if (e.timeMs % outMs === 0) {
        tStart = Math.min(tStart, e.timeMs);
        tEnd = Math.max(tEnd, e.timeMs);
      }
  if (!Number.isFinite(tStart))
    throw new Error('No observations on the clock epochs.');
  const nEp = Math.round((tEnd - tStart) / outMs) + 1;
  const epochs = Array.from({ length: nEp }, (_, i) => tStart + i * outMs);
  /** Epochs of the adjustment (the others are densified). */
  const isEst = epochs.map((t) => t % stepMs === 0);
  const z0 = Math.floor(tStart / zwdStep) * zwdStep;
  const nZ = Math.floor((tEnd - z0) / zwdStep) + 2;

  // --- observations: arcs at full rate, rows at the clock epochs ---
  const sats: string[] = [];
  const satIdx = new Map<string, number>();
  const rowsByEpoch: Row[][] = Array.from({ length: nEp }, () => []);
  let nAmb = 0;
  const ambEpochs: number[] = [];
  stations.forEach((st, si) => {
    const pos: [number, number, number] = [st.xyz[0], st.xyz[1], st.xyz[2]];
    const [lat, , hgt] = ecefToGeodetic(pos[0], pos[1], pos[2]);
    type Arc = {
      amb: number;
      offset: number | null;
      lastT: number;
      mw: number;
      mwN: number;
      gf: number;
    };
    const arcs = new Map<string, Arc>();
    for (const ep of st.epochs) {
      const onGrid =
        ep.timeMs % outMs === 0 && ep.timeMs >= tStart && ep.timeMs <= tEnd;
      const ctx = onGrid
        ? (st.corrections?.epochContext?.(ep.timeMs, pos) ?? null)
        : null;
      for (const o of ep.obs) {
        const sys = o.prn[0]!;
        if (!systems.includes(sys)) continue;
        if (!o.c1 || !o.c2 || !o.l1 || !o.l2) continue;
        const c1 = o.c1 - (options.codeBias?.(o.prn, o.code1 ?? '') ?? 0);
        const c2 = o.c2 - (options.codeBias?.(o.prn, o.code2 ?? '') ?? 0);
        const lam1 = C / o.f1;
        const lam2 = C / o.f2;
        // Slip detection on every epoch.
        const lamW = C / (o.f1 - o.f2);
        const mwv =
          o.l1 - o.l2 - (o.f1 * c1 + o.f2 * c2) / (o.f1 + o.f2) / lamW;
        const gf = o.l1 * lam1 - o.l2 * lam2;
        let arc = arcs.get(o.prn);
        const slip =
          !arc ||
          o.slip ||
          ep.timeMs - arc.lastT > 180_000 ||
          Math.abs(mwv - arc.mw) > 4 ||
          Math.abs(gf - arc.gf) > 0.15;
        if (slip) {
          arc = {
            amb: -1,
            offset: null,
            lastT: ep.timeMs,
            mw: mwv,
            mwN: 1,
            gf,
          };
          arcs.set(o.prn, arc);
        } else {
          arc!.mwN++;
          arc!.mw += (mwv - arc!.mw) / Math.min(arc!.mwN, 100);
          arc!.gf = gf;
          arc!.lastT = ep.timeMs;
        }
        if (!onGrid) continue;
        const sat = satStateAtEmission(source, o.prn, ep.timeMs, pos, c1);
        if (!sat) continue;
        const s = sat.state;
        const [el, az] = getAer(s.x, s.y, s.z, pos[0], pos[1], pos[2]);
        if (el < mask) continue;
        const dx = s.x - pos[0];
        const dy = s.y - pos[1];
        const dz = s.z - pos[2];
        const range = Math.hypot(dx, dy, dz);
        const g = (o.f1 * o.f1) / (o.f1 * o.f1 - o.f2 * o.f2);
        const trop = niellMapping(el, lat, hgt, ep.timeMs);
        const corr = st.corrections
          ? applyCorrections(
              st.corrections,
              {
                prn: o.prn,
                satEcef: [s.x, s.y, s.z],
                rcvEcef: pos,
                los: [dx / range, dy / range, dz / range],
                elRad: el,
                azRad: az,
                f1: o.f1,
                f2: o.f2,
                band1: o.band1,
                band2: o.band2,
                g,
              },
              ctx
            )
          : { rangeM: 0, phaseWindupM: 0 };
        const model = range - s.clkM + trop.zhd * trop.mh + corr.rangeM;
        const omcP = g * c1 - (g - 1) * c2 - model;
        let omcL =
          g * o.l1 * lam1 - (g - 1) * o.l2 * lam2 - model - corr.phaseWindupM;
        if (!Number.isFinite(omcP) || !Number.isFinite(omcL)) continue;
        const a = arc!;
        if (a.amb < 0) {
          a.amb = nAmb++;
          ambEpochs.push(0);
          a.offset = omcL - omcP;
        }
        omcL -= a.offset!;
        if (ep.timeMs % stepMs === 0) ambEpochs[a.amb]!++;
        let sIdx = satIdx.get(o.prn);
        if (sIdx === undefined) {
          sIdx = sats.length;
          sats.push(o.prn);
          satIdx.set(o.prn, sIdx);
        }
        const ei = Math.round((ep.timeMs - tStart) / outMs);
        const f = (ep.timeMs - z0) / zwdStep;
        const zk = Math.min(nZ - 2, Math.floor(f));
        rowsByEpoch[ei]!.push({
          st: si,
          sys,
          sat: sIdx,
          amb: a.amb,
          zwdA: si * nZ + zk,
          zwdB: si * nZ + zk + 1,
          wz: f - zk,
          mw: trop.mw,
          omcP,
          omcL,
          w: Math.sin(el) ** 2,
          bad: false,
        });
      }
    }
  });

  // Ambiguity indices of arcs long enough; others' rows are dropped.
  const ambMap = new Int32Array(nAmb).fill(-1);
  let nA = 0;
  for (let i = 0; i < nAmb; i++) if (ambEpochs[i]! >= minArc) ambMap[i] = nA++;
  const nZw = stations.length * nZ;
  const nG = nA + nZw;
  for (const rows of rowsByEpoch)
    for (const r of rows) if (ambMap[r.amb]! < 0) r.bad = true;

  /** The epoch's local parameters: receiver clocks (non-reference) and
   *  satellite clocks of satellites seen by ≥ minSt stations. */
  const epochParams = (rows: Row[]) => {
    const seen = new Map<number, Set<number>>();
    for (const r of rows) {
      if (r.bad) continue;
      let set = seen.get(r.sat);
      if (!set) seen.set(r.sat, (set = new Set()));
      set.add(r.st);
    }
    const present = new Set(
      rows
        .filter((r) => !r.bad && (seen.get(r.sat)?.size ?? 0) >= minSt)
        .map((r) => r.st)
    );
    const ref = refOrder.find((i) => present.has(i)) ?? -1;
    const local = new Map<string, number>();
    const use = rows.filter(
      (r) => !r.bad && (seen.get(r.sat)?.size ?? 0) >= minSt
    );
    for (const r of use) {
      if (r.st !== ref) {
        const k = `r${r.st}|${r.sys}`;
        if (!local.has(k)) local.set(k, local.size);
      }
      const k = `s${r.sat}`;
      if (!local.has(k)) local.set(k, local.size);
    }
    return { use, ref, local };
  };
  const wP = 1 / (sP * sP);
  const wL = 1 / (sL * sL);

  let xG = new Float64Array(nG);
  let codeRms = 0;
  let phaseRms = 0;
  let nUsed = 0;
  let nRejected = 0;
  const epochX: { local: Map<string, number>; x: Float64Array; ref: number }[] =
    [];
  for (let pass = 0; pass < 2; pass++) {
    const neq = new DenseNeq(nG);
    const N = neq.N;
    const b = neq.b;
    for (const [ei, rows] of rowsByEpoch.entries()) {
      if (!isEst[ei]) continue;
      const { use, local } = epochParams(rows);
      if (!use.length) continue;
      const nE = local.size;
      // Global parameters this epoch touches.
      const gl = new Map<number, number>();
      const gIdx = (g: number) => {
        let i = gl.get(g);
        if (i === undefined) gl.set(g, (i = gl.size));
        return i;
      };
      type R = {
        e: number[];
        ea: number[];
        g: number[];
        ga: number[];
        l: number;
        w: number;
      };
      const rs: R[] = [];
      for (const r of use) {
        const e: number[] = [];
        const ea: number[] = [];
        const rk = local.get(`r${r.st}|${r.sys}`);
        if (rk !== undefined) {
          e.push(rk);
          ea.push(1);
        }
        e.push(local.get(`s${r.sat}`)!);
        ea.push(-1);
        const zA = nA + r.zwdA;
        const zB = nA + r.zwdB;
        const g = [gIdx(zA), gIdx(zB)];
        const ga = [r.mw * (1 - r.wz), r.mw * r.wz];
        rs.push({ e, ea, g: [...g], ga: [...ga], l: r.omcP, w: wP * r.w });
        rs.push({
          e,
          ea,
          g: [...g, gIdx(ambMap[r.amb]!)],
          ga: [...ga, 1],
          l: r.omcL,
          w: wL * r.w,
        });
      }
      const nGe = gl.size;
      const gList = new Int32Array(nGe);
      for (const [g, i] of gl) gList[i] = g;
      const Nee = new Float64Array(nE * nE);
      const Neg = new Float64Array(nE * nGe);
      const be = new Float64Array(nE);
      for (const r of rs) {
        for (let i = 0; i < r.e.length; i++) {
          const wi = r.w * r.ea[i]!;
          be[r.e[i]!]! += wi * r.l;
          for (let j = 0; j < r.e.length; j++)
            Nee[r.e[i]! * nE + r.e[j]!]! += wi * r.ea[j]!;
          for (let j = 0; j < r.g.length; j++)
            Neg[r.e[i]! * nGe + r.g[j]!]! += wi * r.ga[j]!;
        }
        for (let i = 0; i < r.g.length; i++) {
          const gi = gList[r.g[i]!]!;
          const wi = r.w * r.ga[i]!;
          b[gi]! += wi * r.l;
          for (let j = 0; j < r.g.length; j++)
            N[gi * nG + gList[r.g[j]!]!]! += wi * r.ga[j]!;
        }
      }
      // Pre-eliminate: N_gg −= N_ge·N_ee⁻¹·N_eg, b_g −= N_ge·N_ee⁻¹·b_e.
      const L = choleskyDecompose(Nee, nE);
      const X = new Float64Array(nE * nGe); // N_ee⁻¹·N_eg, column by column
      const col = new Float64Array(nE);
      for (let j = 0; j < nGe; j++) {
        for (let k = 0; k < nE; k++) col[k] = Neg[k * nGe + j]!;
        const c = choleskySolve(L, nE, col);
        for (let k = 0; k < nE; k++) X[k * nGe + j] = c[k]!;
      }
      const y = choleskySolve(L, nE, be);
      for (let i = 0; i < nGe; i++) {
        const gi = gList[i]!;
        let sb = 0;
        for (let k = 0; k < nE; k++) sb += Neg[k * nGe + i]! * y[k]!;
        b[gi]! -= sb;
        const row = gi * nG;
        for (let j = 0; j < nGe; j++) {
          let s = 0;
          for (let k = 0; k < nE; k++) s += Neg[k * nGe + i]! * X[k * nGe + j]!;
          N[row + gList[j]!]! -= s;
        }
      }
    }
    // Weak priors: ZWD (σ 0.5 m) and ambiguities (σ 100 m) keep nodes and
    // arcs without enough data defined.
    for (let i = 0; i < nA; i++) N[i * nG + i]! += 1e-4;
    for (let i = nA; i < nG; i++) N[i * nG + i]! += 4;
    xG = neq.solve().x as Float64Array<ArrayBuffer>;

    // Back-substitute the epoch parameters; residuals.
    epochX.length = 0;
    let sp = 0;
    let sl = 0;
    let np = 0;
    const resid: { r: Row; vP: number; vL: number }[] = [];
    for (const [ei, rows] of rowsByEpoch.entries()) {
      const { use, local, ref } = epochParams(rows);
      const nE = local.size;
      const Nee = new Float64Array(nE * nE);
      const be = new Float64Array(nE);
      const red = use.map((r) => {
        const z =
          xG[nA + r.zwdA]! * r.mw * (1 - r.wz) + xG[nA + r.zwdB]! * r.mw * r.wz;
        return { r, lP: r.omcP - z, lL: r.omcL - z - xG[ambMap[r.amb]!]! };
      });
      for (const { r, lP, lL } of red) {
        const e: number[] = [];
        const ea: number[] = [];
        const rk = local.get(`r${r.st}|${r.sys}`);
        if (rk !== undefined) {
          e.push(rk);
          ea.push(1);
        }
        e.push(local.get(`s${r.sat}`)!);
        ea.push(-1);
        for (const [l, w] of [
          [lP, wP * r.w],
          [lL, wL * r.w],
        ] as const)
          for (let i = 0; i < e.length; i++) {
            be[e[i]!]! += w * ea[i]! * l;
            for (let j = 0; j < e.length; j++)
              Nee[e[i]! * nE + e[j]!]! += w * ea[i]! * ea[j]!;
          }
      }
      const x = nE
        ? choleskySolve(choleskyDecompose(Nee, nE), nE, be)
        : new Float64Array(0);
      epochX.push({ local, x, ref });
      if (!isEst[ei]) continue;
      for (const { r, lP, lL } of red) {
        const rk = local.get(`r${r.st}|${r.sys}`);
        const m = (rk !== undefined ? x[rk]! : 0) - x[local.get(`s${r.sat}`)!]!;
        const vP = lP - m;
        const vL = lL - m;
        sp += vP * vP;
        sl += vL * vL;
        np++;
        resid.push({ r, vP, vL });
      }
    }
    codeRms = Math.sqrt(sp / np);
    phaseRms = Math.sqrt(sl / np);
    nUsed = np;
    if (pass === 1) break;
    // Screen: phase residuals beyond 5σ (elevation-scaled) or code beyond
    // 5σ; one rejection pass.
    nRejected = 0;
    for (const { r, vP, vL } of resid) {
      const s = 1 / Math.sqrt(r.w);
      if (
        Math.abs(vL) > 5 * Math.max(phaseRms, sL) * s ||
        Math.abs(vP) > 5 * Math.max(codeRms, sP) * s
      ) {
        r.bad = true;
        nRejected++;
      }
    }
    if (!nRejected) break;
  }

  // --- clocks ---
  const satClocks = new Map<string, Float64Array>();
  const satStations = new Map<string, Uint8Array>();
  for (const p of sats) {
    satClocks.set(p, new Float64Array(nEp).fill(NaN));
    satStations.set(p, new Uint8Array(nEp));
  }
  const rcvClocks = new Map<string, Float64Array>();
  const reference: string[] = [];
  epochX.forEach(({ local, x, ref }, ei) => {
    reference.push(ref >= 0 ? stations[ref]!.id : '');
    const t = epochs[ei]!;
    for (const [k, i] of local) {
      if (k[0] === 's') {
        const prn = sats[Number(k.slice(1))]!;
        const a = source.satState(prn, t);
        if (!a) continue;
        satClocks.get(prn)![ei] = a.clkS + x[i]! / C;
      } else {
        const [st, sys] = k.slice(1).split('|') as [string, string];
        const key = `${stations[Number(st)]!.id}|${sys}`;
        let arr = rcvClocks.get(key);
        if (!arr) rcvClocks.set(key, (arr = new Float64Array(nEp).fill(NaN)));
        arr[ei] = x[i]! / C;
      }
    }
    if (ref >= 0)
      for (const sys of systems) {
        const key = `${stations[ref]!.id}|${sys}`;
        let arr = rcvClocks.get(key);
        if (!arr) rcvClocks.set(key, (arr = new Float64Array(nEp).fill(NaN)));
        arr[ei] = 0;
      }
  });
  rowsByEpoch.forEach((rows, ei) => {
    const seen = new Map<number, Set<number>>();
    for (const r of rows)
      if (!r.bad) {
        let s = seen.get(r.sat);
        if (!s) seen.set(r.sat, (s = new Set()));
        s.add(r.st);
      }
    for (const [sat, s] of seen)
      satStations.get(sats[sat]!)![ei] = Math.min(255, s.size);
  });

  // The reference station's clock offset relative to the a-priori satellite
  // clocks is in every satellite clock as `clkS + x/c`: the estimates are
  // "a-priori + correction", the correction carrying the datum.
  let offsetS = 0;
  let driftSPerS = 0;
  if (options.alignTo) {
    const ts: number[] = [];
    const ds: number[] = [];
    epochs.forEach((t, ei) => {
      let s = 0;
      let n = 0;
      for (const [prn, arr] of satClocks) {
        const v = arr[ei]!;
        const r = options.alignTo!(prn, t);
        if (Number.isFinite(v) && r != null) {
          s += v - r;
          n++;
        }
      }
      if (n) {
        ts.push((t - tStart) / 1000);
        ds.push(s / n);
      }
    });
    if (ts.length >= 2) {
      const mt = ts.reduce((a, v) => a + v, 0) / ts.length;
      const md = ds.reduce((a, v) => a + v, 0) / ds.length;
      let sxy = 0;
      let sxx = 0;
      for (let i = 0; i < ts.length; i++) {
        sxy += (ts[i]! - mt) * (ds[i]! - md);
        sxx += (ts[i]! - mt) ** 2;
      }
      driftSPerS = sxx > 0 ? sxy / sxx : 0;
      offsetS = md - driftSPerS * mt;
      epochs.forEach((t, ei) => {
        const d = offsetS + driftSPerS * ((t - tStart) / 1000);
        for (const arr of satClocks.values()) arr[ei]! -= d;
        for (const arr of rcvClocks.values()) arr[ei]! -= d;
      });
    }
  }
  return {
    epochs,
    satClocks,
    satStations,
    rcvClocks,
    reference,
    codeRms,
    phaseRms,
    nObs: nUsed,
    nRejected,
    nAmbiguities: nA,
    alignment: { offsetS, driftSPerS },
  };
}

/** Metadata for {@link clockSolutionToClk}. */
export interface ClockFileMeta {
  /** 3-character analysis centre code. */
  agency: string;
  agencyName?: string;
  /** Stations of the solution (name, ECEF m) for the SOLN STA records. */
  stations: {
    name: string;
    id?: string;
    xyz: readonly [number, number, number];
  }[];
  comments?: string[];
  /** Frame of the station coordinates (default IGS20). */
  trf?: string;
  createdMs?: number;
}

/**
 * The solution as a RINEX CLOCK file object (`writeClk` → 3.04 text): AS
 * records for the satellites, AR records for the receivers (each station's
 * clock of the first constellation), the reference station as the
 * analysis clock reference.
 */
export function clockSolutionToClk(
  sol: NetworkClockSolution,
  meta: ClockFileMeta
): ClkFile {
  const records: ClkRecord[] = [];
  const sats: ClkFile['sats'] = {};
  const prns = [...sol.satClocks.keys()].sort();
  const rcv = [...sol.rcvClocks.keys()]
    .filter((k) => k.endsWith(`|${[...sol.rcvClocks.keys()][0]!.slice(-1)}`))
    .sort();
  sol.epochs.forEach((t, ei) => {
    for (const k of rcv) {
      const v = sol.rcvClocks.get(k)![ei]!;
      if (Number.isFinite(v))
        records.push({ type: 'AR', name: k.split('|')[0]!, t, values: [v] });
    }
    for (const prn of prns) {
      const v = sol.satClocks.get(prn)![ei]!;
      if (!Number.isFinite(v)) continue;
      records.push({ type: 'AS', name: prn, t, values: [v] });
      const s = (sats[prn] ??= { t: [], c: [] });
      s.t.push(t);
      s.c.push(v);
    }
  });
  const refs = [...new Set(sol.reference.filter(Boolean))];
  const created = new Date(meta.createdMs ?? Date.now());
  const pad = (n: number) => String(n).padStart(2, '0');
  const systems = new Set(prns.map((p) => p[0]!));
  return {
    sats,
    intervalSec:
      sol.epochs.length > 1 ? (sol.epochs[1]! - sol.epochs[0]!) / 1000 : 300,
    version: 3.04,
    satSystem: systems.size === 1 ? [...systems][0]! : 'M',
    pgm: 'gnss-js',
    runBy: meta.agency,
    date: `${created.getUTCFullYear()}${pad(created.getUTCMonth() + 1)}${pad(created.getUTCDate())} ${pad(created.getUTCHours())}${pad(created.getUTCMinutes())}${pad(created.getUTCSeconds())} UTC`,
    comments: meta.comments ?? [],
    timeSystem: 'GPS',
    dataTypes: ['AR', 'AS'],
    analysisCenter: { id: meta.agency, name: meta.agencyName ?? '' },
    clkRefs: [
      {
        refs: refs.map((name) => ({
          name,
          id: meta.stations.find((s) => s.name === name)?.id ?? '',
        })),
      },
    ],
    numStations: meta.stations.length,
    trf: meta.trf ?? 'IGS20',
    stations: meta.stations.map((s) => ({
      name: s.name,
      id: s.id ?? '',
      xMm: Math.round(s.xyz[0] * 1000),
      yMm: Math.round(s.xyz[1] * 1000),
      zMm: Math.round(s.xyz[2] * 1000),
    })),
    prns,
    records,
  };
}
