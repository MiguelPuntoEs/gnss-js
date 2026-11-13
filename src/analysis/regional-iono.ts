/**
 * Regional ionosphere model from a network of dual-frequency stations, the
 * way the IGS ionosphere centres and regional models build theirs: vertical TEC on a single layer plus satellite and receiver
 * differential code biases, all in one daily least-squares adjustment.
 *
 *  1. Carrier levelling. Per station-satellite arc, the geometry-free phase
 *     λ₁L₁ − λ₂L₂ (precise, ambiguous) is shifted onto the geometry-free code
 *     P₂ − P₁ (absolute, noisy) by their elevation-weighted mean difference:
 *
 *       lev = α·STEC − c·(DCBᵣ + DCBˢ),  α = 40.3·10¹⁶·(1/f₂² − 1/f₁²) m/TECU
 *
 *     with DCB = bias(C1) − bias(C2), the Bias-SINEX DSB "C1W–C2W" sense.
 *  2. Single-layer mapping. STEC = M(z)·VTEC at the ionospheric pierce
 *     point; default the modified single-layer model of CODE (MSLM:
 *     H = 506.7 km, z scaled by α = 0.9782).
 *  3. VTEC model. A 2-D Taylor series around the network centre in the
 *     Sun-fixed frame (the usual local model; here in azimuthal-equidistant
 *     coordinates, so polar stations don't hit the longitude singularity),
 *     its coefficients
 *     piecewise linear in time between nodes every `nodeIntervalS`. Between
 *     nodes the two maps are rotated with the Sun before interpolating —
 *     IONEX's recommended interpolation, so the shape follows local time.
 *  4. Biases. One DCB per satellite and per receiver, per signal pair
 *     (system + the two code types), constant over the day. The
 *     levelled observations only see DCBᵣ + DCBˢ, so each pair's satellite
 *     biases are constrained to zero mean — the IGS/CODE datum.
 *
 * Validated against ESA's final GIM and CAS/ESA DCBs. GLONASS (FDMA, a different α per satellite) is left out.
 */

import { ecefToGeodetic, getAer } from '../coordinates';
import type { PppEpoch } from '../positioning/ppp';
import type { IonexGrid } from '../rinex/ionex';
import type { BiasRecord, BiasSinex } from '../rinex/bias-sinex';
import { DenseNeq } from './dense-ls';

const C = 299792458;
const K_IONO = 40.3e16; // m·Hz² per TECU
const R_E = 6371e3;
const OMEGA_SUN = (2 * Math.PI) / 86_400_000; // rad per ms (sun-fixed rotation)

export interface RegionalIonoStation {
  /** 9- or 4-character id. */
  id: string;
  /** ECEF (m). */
  xyz: readonly [number, number, number];
  /** Dual-frequency observations (`c1/c2` m, `l1/l2` cycles, `code1/code2`
   *  RINEX-3 codes, as the PPP input). */
  epochs: readonly PppEpoch[];
}

export interface RegionalIonoOptions {
  /** Constellations to use (default 'G'). GLONASS is never used. */
  systems?: string;
  elevationMaskDeg?: number;
  /** Levelled observations kept every this many seconds (default 300). */
  sampleS?: number;
  /** Time between coefficient nodes (default 3600 s). */
  nodeIntervalS?: number;
  /** Maximum total degree of the latitude × sun-fixed longitude Taylor
   *  series (default 4: 15 coefficients per node). */
  degree?: number;
  /** Single-layer height (m, default 506.7 km) and zenith-angle factor
   *  (default 0.9782): CODE's MSLM. Height 450 km with factor 1 is the
   *  plain single-layer model. */
  shellHeightM?: number;
  mslmAlpha?: number;
  /** Pierce points below this elevation (deg, default 20) don't count
   *  towards the model's coverage (`covered`, `regionalIonoGrid`): the
   *  series is fitted to them but extrapolates beyond them. */
  coverageElevationDeg?: number;
  /** Data span of the model (ms); default the observations'. */
  startMs?: number;
  endMs?: number;
}

/** A differential code bias, Bias-SINEX DSB sense: bias(obs1) − bias(obs2). */
export interface DcbEstimate {
  /** PRN for a satellite bias, '' for a receiver bias. */
  prn: string;
  /** Station id for a receiver bias, '' for a satellite. */
  station: string;
  /** System letter (receiver biases are per system and signal pair). */
  system: string;
  obs1: string;
  obs2: string;
  valueNs: number;
  sigmaNs: number;
  /** Levelled observations behind it. */
  nObs: number;
}

export interface RegionalIonoModel {
  /** Vertical TEC (TECU) at a geographic point and time; NaN outside the
   *  model's time span. */
  vtec(latDeg: number, lonDeg: number, tMs: number): number;
  /** Formal 1σ of `vtec` (TECU). */
  vtecSigma(latDeg: number, lonDeg: number, tMs: number): number;
  /** Whether a point is within `radiusKm` of a pierce point seen within
   *  one node interval of `tMs`. */
  covered(
    latDeg: number,
    lonDeg: number,
    tMs: number,
    radiusKm?: number
  ): boolean;
  satelliteDcb: DcbEstimate[];
  receiverDcb: DcbEstimate[];
  /** Post-fit RMS of the levelled observations (TECU), a-posteriori σ₀
   *  (TECU at unit weight), observations used and rejected. */
  rmsTecu: number;
  sigma0: number;
  nObs: number;
  nRejected: number;
  /** Levelled arcs used. */
  nArcs: number;
  startMs: number;
  endMs: number;
  nodeIntervalS: number;
  /** Total degree of the Taylor series. */
  degree: number;
  shellHeightM: number;
  /** Network centre (deg) the series is developed around. */
  centre: { latDeg: number; lonDeg: number };
}

interface LevObs {
  st: number;
  sat: number;
  /** Receiver-bias index. */
  rb: number;
  /** Satellite-bias index. */
  sb: number;
  t: number;
  latP: number;
  lonP: number;
  /** Slant/vertical factor. */
  m: number;
  /** Levelled observation in TECU (lev / α). */
  l: number;
  /** ns of DCB → TECU: c·1e-9/α. */
  kb: number;
  w: number;
}

/** Pierce point and mapping factor for a ray at (el, az) from (lat, lon). */
function pierce(
  lat: number,
  lon: number,
  el: number,
  az: number,
  H: number,
  alpha: number
): { lat: number; lon: number; m: number } {
  const z = Math.PI / 2 - el;
  const zp = Math.asin((R_E / (R_E + H)) * Math.sin(z));
  const psi = z - zp;
  const latP = Math.asin(
    Math.sin(lat) * Math.cos(psi) + Math.cos(lat) * Math.sin(psi) * Math.cos(az)
  );
  const lonP = lon + Math.asin((Math.sin(psi) * Math.sin(az)) / Math.cos(latP));
  const zm = Math.asin((R_E / (R_E + H)) * Math.sin(alpha * z));
  return { lat: latP, lon: lonP, m: 1 / Math.cos(zm) };
}

/**
 * Carrier-levelled geometry-free observations of one station (TECU, with
 * the biases still in). Arcs break on slips, gaps over 3 minutes and jumps
 * of the geometry-free phase; arcs shorter than 20 epochs are dropped.
 */
function levelStation(
  si: number,
  st: RegionalIonoStation,
  satPosition: (
    prn: string,
    tMs: number
  ) => readonly [number, number, number] | null,
  opts: Required<
    Pick<
      RegionalIonoOptions,
      'systems' | 'elevationMaskDeg' | 'sampleS' | 'shellHeightM' | 'mslmAlpha'
    >
  >,
  onArc: (
    pts: Omit<LevObs, 'st' | 'sat' | 'rb' | 'sb'>[],
    prn: string,
    key: string
  ) => void
) {
  const [lat, lon] = ecefToGeodetic(st.xyz[0], st.xyz[1], st.xyz[2]);
  const mask = (opts.elevationMaskDeg * Math.PI) / 180;
  type Pt = {
    t: number;
    gfL: number;
    gfP: number;
    el: number;
    az: number;
    alpha: number;
  };
  const arcs = new Map<string, { pts: Pt[]; key: string }>();
  const flush = (prn: string) => {
    const a = arcs.get(prn);
    arcs.delete(prn);
    if (!a || a.pts.length < 20) return;
    // Elevation-weighted mean of code − phase, twice with a 3σ screen.
    let off = 0;
    let keep = a.pts;
    for (let it = 0; it < 2; it++) {
      let sw = 0;
      let s = 0;
      for (const p of keep) {
        const w = Math.sin(p.el) ** 2;
        s += w * (p.gfP - p.gfL);
        sw += w;
      }
      off = s / sw;
      let ss = 0;
      for (const p of keep) ss += (p.gfP - p.gfL - off) ** 2;
      const sd = Math.sqrt(ss / keep.length);
      const next = keep.filter(
        (p) => Math.abs(p.gfP - p.gfL - off) < 3 * sd + 0.3
      );
      if (next.length < 20) return;
      keep = next;
    }
    const out: Omit<LevObs, 'st' | 'sat' | 'rb' | 'sb'>[] = [];
    const step = opts.sampleS * 1000;
    for (const p of a.pts) {
      if (p.t % step !== 0) continue;
      const pp = pierce(
        lat,
        lon,
        p.el,
        p.az,
        opts.shellHeightM,
        opts.mslmAlpha
      );
      out.push({
        t: p.t,
        latP: pp.lat,
        lonP: pp.lon,
        m: pp.m,
        l: (p.gfL + off) / p.alpha,
        kb: (C * 1e-9) / p.alpha,
        w: Math.sin(p.el) ** 2,
      });
    }
    if (out.length) onArc(out, prn, a.key);
  };
  const last = new Map<string, { t: number; gfL: number }>();
  for (const ep of st.epochs) {
    for (const o of ep.obs) {
      const sys = o.prn[0]!;
      if (sys === 'R' || !opts.systems.includes(sys)) continue;
      if (!o.c1 || !o.c2 || !o.l1 || !o.l2) continue;
      const sp = satPosition(o.prn, ep.timeMs);
      if (!sp) continue;
      const [el, az] = getAer(
        sp[0],
        sp[1],
        sp[2],
        st.xyz[0],
        st.xyz[1],
        st.xyz[2]
      );
      if (el < mask) continue;
      const gfL = (C / o.f1) * o.l1 - (C / o.f2) * o.l2;
      const gfP = o.c2 - o.c1;
      const key = `${sys}|C${o.code1 ?? '1?'}|C${o.code2 ?? '2?'}`;
      const prev = last.get(o.prn);
      const arc = arcs.get(o.prn);
      const dt = prev ? (ep.timeMs - prev.t) / 1000 : Infinity;
      if (
        arc &&
        (o.slip ||
          dt > 180 ||
          Math.abs(gfL - prev!.gfL) > 0.15 + 0.005 * dt ||
          arc.key !== key)
      )
        flush(o.prn);
      last.set(o.prn, { t: ep.timeMs, gfL });
      let a = arcs.get(o.prn);
      if (!a) arcs.set(o.prn, (a = { pts: [], key }));
      a.pts.push({
        t: ep.timeMs,
        gfL,
        gfP,
        el,
        az,
        alpha: K_IONO * (1 / (o.f2 * o.f2) - 1 / (o.f1 * o.f1)),
      });
    }
  }
  for (const prn of [...arcs.keys()]) flush(prn);
  void si;
}

/**
 * Estimate the regional ionosphere and the code biases from a station
 * network. `satPosition` gives the satellite's ECEF position (m) at the
 * observation time (a precise orbit, e.g. `sp3Position`).
 */
export function estimateRegionalIonosphere(
  stations: readonly RegionalIonoStation[],
  satPosition: (
    prn: string,
    tMs: number
  ) => readonly [number, number, number] | null,
  options: RegionalIonoOptions = {}
): RegionalIonoModel {
  const o = {
    systems: options.systems ?? 'G',
    elevationMaskDeg: options.elevationMaskDeg ?? 10,
    sampleS: options.sampleS ?? 300,
    shellHeightM: options.shellHeightM ?? 506.7e3,
    mslmAlpha: options.mslmAlpha ?? 0.9782,
  };
  const nodeS = options.nodeIntervalS ?? 3600;
  const degree = options.degree ?? 4;
  const terms: [number, number][] = [];
  for (let d = 0; d <= degree; d++)
    for (let i = d; i >= 0; i--) terms.push([i, d - i]);
  const nT = terms.length;

  // --- levelling ---
  const obs: LevObs[] = [];
  const sats: string[] = [];
  const satIdx = new Map<string, number>();
  const sbKeys: string[] = [];
  const sbIdx = new Map<string, number>();
  const rbKeys: string[] = [];
  const rbIdx = new Map<string, number>();
  let nArcs = 0;
  const idx = <K>(m: Map<K, number>, arr: K[], k: K) => {
    let i = m.get(k);
    if (i === undefined) {
      i = arr.length;
      arr.push(k);
      m.set(k, i);
    }
    return i;
  };
  stations.forEach((st, si) =>
    levelStation(si, st, satPosition, o, (pts, prn, key) => {
      nArcs++;
      const sat = idx(satIdx, sats, prn);
      const sb = idx(sbIdx, sbKeys, `${prn}|${key}`);
      const rb = idx(rbIdx, rbKeys, `${si}|${key}`);
      for (const p of pts) obs.push({ ...p, st: si, sat, sb, rb });
    })
  );
  if (obs.length < 100)
    throw new Error('Too few levelled observations for an ionosphere model.');

  // --- geometry of the series ---
  let sLat = 0;
  let sx = 0;
  let sy = 0;
  for (const p of obs) {
    sLat += p.latP;
    sx += Math.cos(p.lonP);
    sy += Math.sin(p.lonP);
  }
  const lat0 = sLat / obs.length;
  const lon0 = Math.atan2(sy, sx);
  const SCALE = 0.25; // rad: keeps the monomials O(1) over a continent
  const cosLat0 = Math.cos(lat0);
  let t0 = options.startMs ?? Infinity;
  let t1 = options.endMs ?? -Infinity;
  if (options.startMs == null) for (const p of obs) t0 = Math.min(t0, p.t);
  if (options.endMs == null) for (const p of obs) t1 = Math.max(t1, p.t);
  const step = nodeS * 1000;
  t0 = Math.floor(t0 / step) * step;
  const nNodes = Math.max(2, Math.ceil((t1 - t0) / step) + 1);
  t1 = t0 + (nNodes - 1) * step;

  const nCoef = nNodes * nT;
  const nSb = sbKeys.length;
  const nRb = rbKeys.length;
  const n = nCoef + nSb + nRb;
  /** Basis of node `k` at (lat, lon, t) into out[0..nT): monomials of
   *  the azimuthal-equidistant coordinates of the sun-fixed point around
   *  the network centre — smooth across the pole, unlike latitude ×
   *  longitude. */
  const sinLat0 = Math.sin(lat0);
  const basis = (
    k: number,
    lat: number,
    lon: number,
    t: number,
    out: Float64Array
  ) => {
    const ds = lon + OMEGA_SUN * (t - (t0 + k * step)) - lon0;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    const cosC = sinLat0 * sinLat + cosLat0 * cosLat * Math.cos(ds);
    const rho = Math.acos(Math.max(-1, Math.min(1, cosC)));
    const az = Math.atan2(
      cosLat * Math.sin(ds),
      cosLat0 * sinLat - sinLat0 * cosLat * Math.cos(ds)
    );
    const x = (rho * Math.cos(az)) / SCALE; // north
    const y = (rho * Math.sin(az)) / SCALE; // east (sun-fixed)
    for (let j = 0; j < nT; j++) out[j] = x ** terms[j]![0] * y ** terms[j]![1];
  };
  const nodeOf = (t: number) => {
    const f = (t - t0) / step;
    const k = Math.min(nNodes - 2, Math.max(0, Math.floor(f)));
    return { k, w: Math.min(1, Math.max(0, f - k)) };
  };

  // --- adjustment, then one 4σ screening pass ---
  const bufA = new Float64Array(nT);
  const bufB = new Float64Array(nT);
  const rowIdx = new Array<number>(2 * nT + 2);
  const rowA = new Array<number>(2 * nT + 2);
  const design = (p: LevObs) => {
    const { k, w } = nodeOf(p.t);
    basis(k, p.latP, p.lonP, p.t, bufA);
    basis(k + 1, p.latP, p.lonP, p.t, bufB);
    for (let j = 0; j < nT; j++) {
      rowIdx[j] = k * nT + j;
      rowA[j] = p.m * (1 - w) * bufA[j]!;
      rowIdx[nT + j] = (k + 1) * nT + j;
      rowA[nT + j] = p.m * w * bufB[j]!;
    }
    // l = M·VTEC − kb·(DCBᵣ + DCBˢ)
    rowIdx[2 * nT] = nCoef + p.sb;
    rowA[2 * nT] = -p.kb;
    rowIdx[2 * nT + 1] = nCoef + nSb + p.rb;
    rowA[2 * nT + 1] = -p.kb;
  };
  const satSys = sbKeys.map((k) => k.slice(4)); // "G|C1W|C2W"
  let active = obs.map(() => true);
  let x: Float64Array = new Float64Array(n);
  let Qxx: Float64Array | undefined;
  let rms = 0;
  let sigma0 = 0;
  let nUsed = 0;
  for (let pass = 0; pass < 2; pass++) {
    const neq = new DenseNeq(n);
    obs.forEach((p, i) => {
      if (!active[i]) return;
      design(p);
      neq.add(rowIdx, rowA, p.l, p.w);
    });
    // Zero-mean satellite biases per signal pair (heavy pseudo-observation).
    for (const g of new Set(satSys)) {
      const ids: number[] = [];
      satSys.forEach((s, i) => s === g && ids.push(nCoef + i));
      neq.add(
        ids,
        ids.map(() => 1),
        0,
        1e6
      );
    }
    // A very weak prior on the coefficients keeps nodes without data (and
    // high-degree terms the geometry can't see) defined.
    for (let i = 0; i < nCoef; i++) neq.N[i * n + i]! += 1e-6;
    const sol = neq.solve(pass === 1);
    x = sol.x;
    Qxx = sol.Qxx;
    let ss = 0;
    let sw = 0;
    let cnt = 0;
    const res = obs.map((p, i) => {
      design(p);
      let v = p.l;
      for (let j = 0; j < rowIdx.length; j++) v -= rowA[j]! * x[rowIdx[j]!]!;
      if (active[i]) {
        ss += v * v;
        sw += p.w * v * v;
        cnt++;
      }
      return v;
    });
    rms = Math.sqrt(ss / cnt);
    sigma0 = Math.sqrt(sw / Math.max(1, cnt - n));
    nUsed = cnt;
    if (pass === 0) {
      const lim = 4 * rms;
      active = res.map((v) => Math.abs(v) < lim);
    }
  }
  const Q = Qxx!;
  const s0sq = sigma0 * sigma0;

  // --- outputs ---
  const nPerSb = new Array<number>(nSb).fill(0);
  const nPerRb = new Array<number>(nRb).fill(0);
  obs.forEach((p, i) => {
    if (!active[i]) return;
    nPerSb[p.sb]!++;
    nPerRb[p.rb]!++;
  });
  const parseKey = (k: string) => {
    const [sys, c1, c2] = k.split('|') as [string, string, string];
    return { system: sys, obs1: c1, obs2: c2 };
  };
  const satelliteDcb: DcbEstimate[] = sbKeys.map((k, i) => ({
    prn: k.slice(0, 3),
    station: '',
    ...parseKey(k.slice(4)),
    valueNs: x[nCoef + i]!,
    sigmaNs: Math.sqrt(s0sq * Q[(nCoef + i) * n + nCoef + i]!),
    nObs: nPerSb[i]!,
  }));
  const receiverDcb: DcbEstimate[] = rbKeys.map((k, i) => {
    const bar = k.indexOf('|');
    const j = nCoef + nSb + i;
    return {
      prn: '',
      station: stations[Number(k.slice(0, bar))]!.id,
      ...parseKey(k.slice(bar + 1)),
      valueNs: x[j]!,
      sigmaNs: Math.sqrt(s0sq * Q[j * n + j]!),
      nObs: nPerRb[i]!,
    };
  });

  const DEG = Math.PI / 180;
  const coefRow = (latDeg: number, lonDeg: number, tMs: number) => {
    const { k, w } = nodeOf(tMs);
    basis(k, latDeg * DEG, lonDeg * DEG, tMs, bufA);
    basis(k + 1, latDeg * DEG, lonDeg * DEG, tMs, bufB);
    const ids: number[] = [];
    const a: number[] = [];
    for (let j = 0; j < nT; j++) {
      ids.push(k * nT + j, (k + 1) * nT + j);
      a.push((1 - w) * bufA[j]!, w * bufB[j]!);
    }
    return { ids, a };
  };
  const inSpan = (t: number) => t >= t0 && t <= t1;
  // Pierce points by node, for the coverage test.
  const byNode: { lat: number; lon: number }[][] = Array.from(
    { length: nNodes },
    () => []
  );
  const minW =
    Math.sin(((options.coverageElevationDeg ?? 20) * Math.PI) / 180) ** 2;
  obs.forEach((p, i) => {
    if (!active[i] || p.w < minW) return;
    const { k, w } = nodeOf(p.t);
    byNode[w < 0.5 ? k : k + 1]!.push({ lat: p.latP, lon: p.lonP });
  });

  return {
    vtec(latDeg, lonDeg, tMs) {
      if (!inSpan(tMs)) return NaN;
      const { ids, a } = coefRow(latDeg, lonDeg, tMs);
      let v = 0;
      for (let j = 0; j < ids.length; j++) v += a[j]! * x[ids[j]!]!;
      return v;
    },
    vtecSigma(latDeg, lonDeg, tMs) {
      if (!inSpan(tMs)) return NaN;
      const { ids, a } = coefRow(latDeg, lonDeg, tMs);
      let v = 0;
      for (let i = 0; i < ids.length; i++)
        for (let j = 0; j < ids.length; j++)
          v += a[i]! * a[j]! * Q[ids[i]! * n + ids[j]!]!;
      return Math.sqrt(s0sq * Math.max(0, v));
    },
    covered(latDeg, lonDeg, tMs, radiusKm = 500) {
      if (!inSpan(tMs)) return false;
      const k = Math.round((tMs - t0) / step);
      const lat = latDeg * DEG;
      const lon = lonDeg * DEG;
      const cosMax = Math.cos((radiusKm * 1000) / (R_E + o.shellHeightM));
      for (const kk of [k - 1, k, k + 1]) {
        for (const p of byNode[kk] ?? []) {
          const c =
            Math.sin(lat) * Math.sin(p.lat) +
            Math.cos(lat) * Math.cos(p.lat) * Math.cos(lon - p.lon);
          if (c >= cosMax) return true;
        }
      }
      return false;
    },
    satelliteDcb,
    receiverDcb,
    rmsTecu: rms,
    sigma0,
    nObs: nUsed,
    nRejected: obs.length - nUsed,
    nArcs,
    startMs: t0,
    endMs: t1,
    nodeIntervalS: nodeS,
    degree,
    shellHeightM: o.shellHeightM,
    centre: { latDeg: lat0 / DEG, lonDeg: lon0 / DEG },
  };
}

/**
 * The model on an IONEX grid: TEC and RMS maps (TECU) at `epochs`, NaN
 * (IONEX 9999) where no pierce point lies within `radiusKm` — a regional
 * model says nothing outside its network.
 */
export function regionalIonoGrid(
  model: RegionalIonoModel,
  grid: { epochs: number[]; lats: number[]; lons: number[] },
  radiusKm = 500
): IonexGrid & { rms: Float32Array[] } {
  const { epochs, lats, lons } = grid;
  const maps: Float32Array[] = [];
  const rms: Float32Array[] = [];
  for (const t of epochs) {
    const m = new Float32Array(lats.length * lons.length).fill(NaN);
    const r = new Float32Array(lats.length * lons.length).fill(NaN);
    lats.forEach((lat, i) =>
      lons.forEach((lon, j) => {
        if (!model.covered(lat, lon, t, radiusKm)) return;
        m[i * lons.length + j] = model.vtec(lat, lon, t);
        r[i * lons.length + j] = model.vtecSigma(lat, lon, t);
      })
    );
    maps.push(m);
    rms.push(r);
  }
  return { epochs: [...epochs], lats: [...lats], lons: [...lons], maps, rms };
}

/** Producer metadata for {@link regionalIonoToIonex} / {@link regionalDcbToBiasSinex}. */
export interface RegionalIonoFileMeta {
  /** 3-character agency code. */
  agency: string;
  /** Stations used (with DOMES numbers when known). */
  stations: { id: string; domes?: string }[];
  createdMs?: number;
  elevationMaskDeg?: number;
}

/**
 * The gridded model (from {@link regionalIonoGrid}) as an IONEX 1.0 file
 * object for `writeIonex`: TEC + RMS maps, and the satellite and receiver
 * DCBs in the DIFFERENTIAL CODE BIASES auxiliary block (ns, P1−P2 sense as
 * in IGS GIMs).
 */
export function regionalIonoToIonex(
  model: RegionalIonoModel,
  grid: IonexGrid & { rms: Float32Array[] },
  meta: RegionalIonoFileMeta
): IonexGrid {
  const created = new Date(meta.createdMs ?? Date.now());
  const step = (a: number[]) => (a.length > 1 ? a[1]! - a[0]! : 0);
  const domes = new Map(meta.stations.map((s) => [s.id, s.domes ?? '']));
  const c1w = (d: DcbEstimate) => d.obs1 === 'C1W' && d.obs2 === 'C2W';
  return {
    ...grid,
    rmsMaps: grid.rms,
    version: 1.0,
    system: 'GPS',
    pgm: 'gnss-js',
    runBy: meta.agency,
    date: created.toISOString().slice(0, 10),
    descriptions: [
      'Regional ionosphere map from a station network: carrier-',
      'levelled geometry-free observations, Sun-fixed Taylor series',
      `of degree ${model.degree} around ${model.centre.latDeg.toFixed(1)}N ${model.centre.lonDeg.toFixed(1)}E, nodes every ${model.nodeIntervalS} s.`,
    ],
    comments: [
      'Modified single-layer mapping (alpha 0.9782); no value (9999)',
      'where no pierce point above 20 deg lies within 500 km.',
      'TEC/RMS values in 0.1 TECU; 9999, if no value available',
    ],
    epochFirst: grid.epochs[0],
    epochLast: grid.epochs[grid.epochs.length - 1],
    interval: step(grid.epochs) / 1000,
    numMaps: grid.epochs.length,
    mappingFunction: 'COSZ',
    elevationCutoff: meta.elevationMaskDeg ?? 10,
    observablesUsed: 'One-way carrier phase leveled to code',
    numStations: meta.stations.length,
    numSatellites: new Set(model.satelliteDcb.map((d) => d.prn)).size,
    baseRadius: 6371,
    mapDimension: 2,
    hgt: {
      from: model.shellHeightM / 1000,
      to: model.shellHeightM / 1000,
      step: 0,
    },
    latDef: {
      from: grid.lats[0]!,
      to: grid.lats[grid.lats.length - 1]!,
      step: step(grid.lats),
    },
    lonDef: {
      from: grid.lons[0]!,
      to: grid.lons[grid.lons.length - 1]!,
      step: step(grid.lons),
    },
    exponent: -1,
    aux: {
      name: 'DIFFERENTIAL CODE BIASES',
      sats: model.satelliteDcb
        .filter(c1w)
        .map((d) => ({ prn: d.prn, biasNs: d.valueNs, rmsNs: d.sigmaNs })),
      stations: model.receiverDcb.filter(c1w).map((d) => ({
        sys: d.system,
        name: d.station.slice(0, 4),
        id: domes.get(d.station) ?? '',
        biasNs: d.valueNs,
        rmsNs: d.sigmaNs,
      })),
      comments: ['DCB values in ns, C1W-C2W (P1-P2); zero-mean satellites'],
    },
  };
}

/**
 * The estimated DCBs as a Bias-SINEX object (DSB records, ns) for
 * `writeBiasSinex`, valid over the model's span.
 */
export function regionalDcbToBiasSinex(
  model: RegionalIonoModel,
  meta: RegionalIonoFileMeta
): BiasSinex {
  const rec = (d: DcbEstimate): BiasRecord => ({
    type: 'DSB',
    prn: d.prn,
    station: d.station,
    obs1: d.obs1,
    obs2: d.obs2,
    startMs: model.startMs,
    endMs: model.endMs,
    value: d.valueNs,
    unit: 'ns',
    std: d.sigmaNs,
  });
  const records = [...model.satelliteDcb, ...model.receiverDcb].map(rec);
  const bySat = new Map<string, BiasRecord[]>();
  for (const r of records)
    if (!r.station) bySat.set(r.prn, [...(bySat.get(r.prn) ?? []), r]);
  return {
    records,
    bySat,
    header: {
      version: '1.00',
      fileAgency: meta.agency,
      createdMs: meta.createdMs ?? Date.now(),
      dataAgency: meta.agency,
      startMs: model.startMs,
      endMs: model.endMs,
      mode: 'R',
      count: records.length,
    },
    reference: [
      { key: 'DESCRIPTION', value: 'Regional ionosphere + DCB estimation' },
      { key: 'SOFTWARE', value: 'gnss-js estimateRegionalIonosphere' },
    ],
    comments: [
      'Satellite DSBs constrained to zero mean per signal pair.',
      'Receiver DSBs in the same datum.',
    ],
  };
}
