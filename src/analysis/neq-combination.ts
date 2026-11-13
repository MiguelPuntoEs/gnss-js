/**
 * Multi-year combination of station-coordinate NEQs (daily or weekly
 * solutions) into positions + velocities per station — the
 * "cumulative solution" used for EPN and ITRF densification:
 *
 *   x(t) = x₀[P-segment] + v[V-segment]·(t − t₀)
 *          (+ Σ_k a_k·sin(2πk·τ) + b_k·cos(2πk·τ), k = 1 annual, 2 semi-annual)
 *
 * Discontinuities split a station into position segments (new solution id
 * each, e.g. an antenna change) while its velocity segment continues — the
 * velocity is shared across equipment changes — and start a new velocity
 * segment only where the motion itself changed (earthquakes); that is the
 * P/V convention of the IGS/EPN discontinuity files. Each input solution
 * may carry its own Helmert parameters (pre-eliminated), so frame
 * differences between weeks don't leak into the velocities; the combined
 * datum then comes from minimum constraints (`solveWithDatum`).
 */
import type { NeqParameter, NormalEquations } from './normal-equations';
import {
  addObservations,
  changeApriori,
  emptyNeq,
  MS_PER_YEAR,
  neqParameterKey,
  preEliminate,
  transformNeq,
  type NeqObservationRow,
} from './neq';
import {
  helmertDesign,
  helmertParameterCount,
  type HelmertModel,
} from './network-alignment';

/** A position ('P') or velocity ('V') segment of a station — the shape of
 *  a SOLUTION/DISCONTINUITY entry (`parseSinexDiscontinuities`). */
export interface StationSegment {
  site: string;
  kind: 'P' | 'V';
  solnId: string;
  /** -Infinity / Infinity for open ends. */
  startMs: number;
  endMs: number;
}

/** A dated event at a station. */
export interface StationEvent {
  site: string;
  tMs: number;
  /** 'equipment' (antenna/receiver/radome): new position segment, same
   *  velocity. 'earthquake': new position and velocity segment. */
  kind: 'equipment' | 'earthquake';
}

/** Segments from a list of events (what a discontinuity file encodes). */
export function segmentsFromEvents(
  events: readonly StationEvent[]
): StationSegment[] {
  const bySite = new Map<string, StationEvent[]>();
  for (const e of events) {
    if (!bySite.has(e.site)) bySite.set(e.site, []);
    bySite.get(e.site)!.push(e);
  }
  const out: StationSegment[] = [];
  for (const [site, evs] of bySite) {
    evs.sort((a, b) => a.tMs - b.tMs);
    for (const kind of ['P', 'V'] as const) {
      const cuts = evs
        .filter((e) => kind === 'P' || e.kind === 'earthquake')
        .map((e) => e.tMs);
      const bounds = [-Infinity, ...cuts, Infinity];
      for (let i = 0; i + 1 < bounds.length; i++)
        out.push({
          site,
          kind,
          solnId: String(i + 1),
          startMs: bounds[i]!,
          endMs: bounds[i + 1]!,
        });
    }
  }
  return out;
}

export interface CombinationOptions {
  /** Reference epoch t₀ of the positions (ms). */
  epochMs: number;
  /** Station segments (P/V); unlisted sites have one of each. */
  segments?: readonly StationSegment[];
  /** Periodic terms per station and coordinate. Default none. */
  periodic?: 'none' | 'annual' | 'annual+semiannual';
  /** Helmert parameters per input solution, pre-eliminated (CATREF
   *  style). Default 'none'. */
  helmertPerSolution?: HelmertModel | 'none';
  /** A-priori position at t₀ and velocity of a site's segments; default:
   *  the first solution's value with zero velocity. */
  apriori?: (
    site: string,
    pSoln: string,
    vSoln: string
  ) => { xyz?: readonly number[]; vel?: readonly number[] } | undefined;
}

const AXES = ['X', 'Y', 'Z'] as const;
const EARTH_RADIUS = 6_371_000;

/**
 * Accumulates station-coordinate NEQs into one position + velocity system.
 * Feed solutions with `add` (any order; non-station parameters are
 * pre-eliminated), then take `result()` and solve it with
 * `solveWithDatum` (velocity conditions as well as position ones).
 */
export class NeqCombination {
  private params: NeqParameter[] = [];
  private index = new Map<string, number>();
  private N = new Float64Array(0);
  private b = new Float64Array(0);
  private cap = 0;
  private ltpl = 0;
  private nObs = 0;
  private nPre = 0;
  private start = Infinity;
  private end = -Infinity;
  private nSolutions = 0;
  private sigma0 = 1;
  /** A-priori position at t₀ / velocity per global parameter key. */
  private apr = new Map<string, number>();

  constructor(readonly opts: CombinationOptions) {}

  private segment(site: string, kind: 'P' | 'V', tMs: number): string {
    const s = this.opts.segments?.find(
      (d) =>
        d.site === site && d.kind === kind && d.startMs <= tMs && tMs < d.endMs
    );
    return s?.solnId ?? '1';
  }

  private param(p: NeqParameter): number {
    const key = neqParameterKey(p);
    let i = this.index.get(key);
    if (i !== undefined) return i;
    i = this.params.length;
    this.index.set(key, i);
    this.params.push(p);
    if (i >= this.cap) this.grow(Math.max(16, this.cap * 2));
    return i;
  }

  private grow(cap: number): void {
    const n = this.cap;
    const N = new Float64Array(cap * cap);
    for (let r = 0; r < n; r++)
      N.set(this.N.subarray(r * n, r * n + n), r * cap);
    const b = new Float64Array(cap);
    b.set(this.b);
    this.N = N;
    this.b = b;
    this.cap = cap;
  }

  /** Add one solution's NEQ. Returns the number of stations used. */
  add(
    input: NormalEquations,
    /** Override `helmertPerSolution` for this solution (e.g. 'none' for a
     *  day with fewer stations than the transformation needs). */
    helmert?: HelmertModel | 'none'
  ): number {
    const o = this.opts;
    let neq = preEliminate(
      input,
      (p) => !['STAX', 'STAY', 'STAZ'].includes(p.type)
    );
    if (this.nSolutions === 0) this.sigma0 = neq.sigma0Apriori;
    else if (neq.sigma0Apriori !== this.sigma0) {
      const f = (this.sigma0 / neq.sigma0Apriori) ** 2;
      neq = {
        ...neq,
        N: neq.N.map((v) => v * f),
        b: neq.b.map((v) => v * f),
        ltpl: neq.ltpl * f,
        sigma0Apriori: this.sigma0,
      };
    }
    const n = neq.params.length;
    if (!n) return 0;
    const t0 = o.epochMs;
    // Local parameters (global ones touched by this NEQ + its Helmert).
    const local: NeqParameter[] = [];
    const localIdx = new Map<string, number>();
    const use = (p: NeqParameter) => {
      const k = neqParameterKey(p);
      let i = localIdx.get(k);
      if (i === undefined) {
        i = local.length;
        localIdx.set(k, i);
        local.push(p);
      }
      return i;
    };
    const map: [number, number][][] = [];
    const newApriori = new Float64Array(n);
    const periods =
      o.periodic === 'annual+semiannual'
        ? [1, 2]
        : o.periodic === 'annual'
          ? [1]
          : [];
    for (let i = 0; i < n; i++) {
      const p = neq.params[i]!;
      const ax = p.type.slice(3) as (typeof AXES)[number];
      const k = AXES.indexOf(ax);
      const t = p.refEpochMs;
      const dt = (t - t0) / MS_PER_YEAR;
      const pS = this.segment(p.site, 'P', t);
      const vS = this.segment(p.site, 'V', t);
      const base = { site: p.site, pointCode: p.pointCode ?? 'A' };
      const sta: NeqParameter = {
        ...base,
        type: `STA${ax}`,
        solnId: pS,
        refEpochMs: t0,
        apriori: 0,
        unit: 'm',
      };
      const vel: NeqParameter = {
        ...base,
        type: `VEL${ax}`,
        solnId: vS,
        refEpochMs: t0,
        apriori: 0,
        unit: 'm/y',
      };
      // A-priori at t₀ (first encounter fixes it).
      const ks = neqParameterKey(sta);
      const kv = neqParameterKey(vel);
      if (!this.apr.has(kv))
        this.apr.set(kv, o.apriori?.(p.site, pS, vS)?.vel?.[k] ?? 0);
      const v0 = this.apr.get(kv)!;
      if (!this.apr.has(ks)) {
        const given = o.apriori?.(p.site, pS, vS)?.xyz?.[k];
        this.apr.set(ks, given ?? p.apriori - v0 * dt);
      }
      sta.apriori = this.apr.get(ks)!;
      vel.apriori = v0;
      newApriori[i] = sta.apriori + v0 * dt;
      const terms: [number, number][] = [
        [use(sta), 1],
        [use(vel), dt],
      ];
      for (const h of periods) {
        const w = 2 * Math.PI * h * dt;
        for (const [f, fn] of [
          ['S', Math.sin],
          ['C', Math.cos],
        ] as const)
          terms.push([
            use({
              ...base,
              type: `${f}${h}${ax}`,
              solnId: '1',
              refEpochMs: t0,
              apriori: 0,
              unit: 'm',
            }),
            fn(w),
          ]);
      }
      map.push(terms);
    }
    // Helmert parameters of this solution (positions at their a-priori).
    const hm = helmert ?? o.helmertPerSolution ?? 'none';
    const hIdx: number[] = [];
    if (hm !== 'none') {
      const k = helmertParameterCount(hm);
      for (let j = 0; j < k; j++)
        hIdx.push(
          use({
            type: `HLM${j + 1}`,
            site: `#${this.nSolutions}`,
            refEpochMs: neq.dataStartMs,
            apriori: 0,
            unit: '',
          })
        );
      // Group the solution's coordinates per station.
      const st = new Map<string, number[]>();
      neq.params.forEach((p, i) => {
        const key = `${p.site}|${p.pointCode ?? 'A'}|${p.solnId ?? '1'}`;
        if (!st.has(key)) st.set(key, [-1, -1, -1]);
        st.get(key)![AXES.indexOf(p.type.slice(3) as 'X')] = i;
      });
      for (const ix of st.values()) {
        if (ix.some((i) => i < 0)) continue;
        const x = ix.map((i) => neq.params[i]!.apriori / EARTH_RADIUS);
        const rows = helmertDesign(x, hm);
        ix.forEach((i, c) =>
          rows[c]!.forEach((v, j) => {
            if (v) map[i]!.push([hIdx[j]!, v]);
          })
        );
      }
    }
    neq = changeApriori(neq, newApriori);
    let q = transformNeq(neq, local, map);
    if (hIdx.length) {
      const h = new Set(hIdx);
      q = preEliminate(q, (_, i) => h.has(i));
    }
    // Accumulate.
    const g = q.params.map((p) => {
      const i = this.param({ ...p, startMs: undefined, endMs: undefined });
      const gp = this.params[i]!;
      // Data span of position / velocity segments, for reference matching.
      if (p.type.startsWith('STA') || p.type.startsWith('VEL')) {
        gp.startMs = Math.min(gp.startMs ?? Infinity, neq.dataStartMs);
        gp.endMs = Math.max(gp.endMs ?? -Infinity, neq.dataEndMs);
      }
      return i;
    });
    const m = q.params.length;
    const cap = this.cap;
    for (let i = 0; i < m; i++) {
      this.b[g[i]!] += q.b[i]!;
      const gi = g[i]! * cap;
      for (let j = 0; j < m; j++) this.N[gi + g[j]!] += q.N[i * m + j]!;
    }
    this.ltpl += q.ltpl;
    this.nObs += q.nObs;
    this.nPre += q.nPreEliminated;
    this.start = Math.min(this.start, neq.dataStartMs);
    this.end = Math.max(this.end, neq.dataEndMs);
    this.nSolutions++;
    return n / 3;
  }

  /** The combined system (positions at t₀, velocities, periodic terms). */
  result(): NormalEquations {
    const n = this.params.length;
    const out = emptyNeq(
      this.params.map((p) => ({ ...p })),
      this.sigma0
    );
    for (let r = 0; r < n; r++)
      out.N.set(this.N.subarray(r * this.cap, r * this.cap + n), r * n);
    out.b.set(this.b.subarray(0, n));
    out.ltpl = this.ltpl;
    out.nObs = this.nObs;
    out.nPreEliminated = this.nPre;
    out.dataStartMs = this.start;
    out.dataEndMs = this.end;
    return out;
  }
}

/**
 * Pseudo-observations tying the velocities of a site's consecutive
 * velocity segments (v_k − v_{k+1} = 0 ± σ m/yr) — for discontinuity
 * lists that split the velocity at every equipment change, or to keep a
 * post-seismic segment from drifting freely.
 */
export function tieVelocities(
  neq: NormalEquations,
  sigma: number,
  sites?: readonly string[]
): NormalEquations {
  const only = sites ? new Set(sites) : null;
  const groups = new Map<string, number[]>();
  neq.params.forEach((p, i) => {
    if (!p.type.startsWith('VEL') || (only && !only.has(p.site))) return;
    const k = `${p.site}|${p.pointCode ?? 'A'}|${p.type}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(i);
  });
  const rows: NeqObservationRow[] = [];
  for (const idx of groups.values()) {
    idx.sort(
      (a, b) =>
        Number(neq.params[a]!.solnId ?? 1) - Number(neq.params[b]!.solnId ?? 1)
    );
    for (let j = 0; j + 1 < idx.length; j++) {
      const a = idx[j]!;
      const c = idx[j + 1]!;
      rows.push({
        terms: [
          [a, 1],
          [c, -1],
        ],
        value: neq.params[c]!.apriori - neq.params[a]!.apriori,
        sigma,
      });
    }
  }
  return rows.length ? addObservations(neq, rows) : neq;
}
