/**
 * Least-squares adjustment of a GNSS baseline network — what Bernese and
 * survey software do with one session's static baselines: the free points'
 * coordinates from every baseline at once, with their covariance, the
 * a-posteriori variance factor and its χ² test, Baarda's w-test on every
 * baseline component (data snooping: the worst failing baseline is dropped
 * and the network re-adjusted, while every point stays connected), and the
 * misclosure of each independent loop.
 *
 * Observations are baseline vectors (to − from, ECEF) with their 3×3
 * covariances, uncorrelated between baselines; the datum is one or more
 * fixed points. Formal GNSS covariances are optimistic (time-correlated
 * errors), so the coordinate covariance is scaled by σ̂₀² when it exceeds 1.
 */
import { chi2Quantile, normalQuantile } from './quantiles';

type Vec3 = [number, number, number];

export interface BaselineObservation {
  from: string;
  to: string;
  /** to − from, ECEF (m). */
  vector: Vec3;
  /** 3×3 covariance, ECEF (m²). */
  covariance: number[][];
}

export interface BaselineNetworkOptions {
  /** Drop the worst baseline failing the w-test, repeatedly. Default true. */
  snoop?: boolean;
  /** w-test critical value (Baarda's α₀ = 0.001 → 3.29). */
  wCritical?: number;
  /** χ² test significance. Default 0.05. */
  alpha?: number;
}

export interface AdjustedBaseline extends BaselineObservation {
  /** Adjusted − observed (m), ECEF; null when rejected or unused. */
  residual: Vec3 | null;
  /** Largest |w| of its three components (null without redundancy). */
  w: number | null;
  status: 'used' | 'rejected' | 'unconnected';
}

export interface NetworkLoop {
  /** Points around the loop, the first repeated at the end. */
  points: string[];
  /** Sum of the observed baselines around it (m), ECEF. */
  misclosure: Vec3;
  /** Its length (m), and relative to the loop's perimeter (ppm). */
  lengthM: number;
  ppm: number;
}

export interface BaselineNetworkResult {
  /** Every point reached: adjusted ECEF and covariance (fixed: zeros). */
  points: Map<string, { ecef: Vec3; covariance: number[][]; fixed: boolean }>;
  baselines: AdjustedBaseline[];
  /** Degrees of freedom (3 × baselines used − 3 × free points). */
  redundancy: number;
  /** A-posteriori variance factor (1 when there's no redundancy). */
  sigma0sq: number;
  chi2: { value: number; critical: number; pass: boolean } | null;
  loops: NetworkLoop[];
  /** Points no used baseline connects to a fixed point. */
  unconnected: string[];
}

/** Inverse of a symmetric positive-definite matrix (Gauss–Jordan, pivoted). */
function invert(A: number[][]): number[][] | null {
  const n = A.length;
  const M = A.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-300) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    const d = M[c]![c]!;
    for (let k = 0; k < 2 * n; k++) M[c]![k]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]!;
      if (f === 0) continue;
      for (let k = 0; k < 2 * n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row) => row.slice(n));
}

/** Points reachable from the fixed ones through the given baselines. */
function reachable(
  fixed: ReadonlySet<string>,
  obs: readonly BaselineObservation[]
): Set<string> {
  const seen = new Set(fixed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of obs) {
      if (seen.has(b.from) !== seen.has(b.to)) {
        seen.add(seen.has(b.from) ? b.to : b.from);
        grew = true;
      }
    }
  }
  return seen;
}

function solve(
  fixed: ReadonlyMap<string, Vec3>,
  obs: readonly BaselineObservation[]
) {
  const free = [
    ...new Set(obs.flatMap((b) => [b.from, b.to]).filter((p) => !fixed.has(p))),
  ].sort();
  const col = new Map(free.map((p, i) => [p, 3 * i]));
  const nu = 3 * free.length;
  const N = Array.from({ length: nu }, () => new Array<number>(nu).fill(0));
  const u = new Array<number>(nu).fill(0);
  const W = obs.map((b) => invert(b.covariance));
  if (W.some((w) => !w)) throw new Error('A baseline covariance is singular.');
  // Observation: to − from = vector. Unknowns: free coordinates.
  obs.forEach((b, k) => {
    const w = W[k]!;
    // Reduced observation: vector − (fixed to) + (fixed from).
    const l = [0, 1, 2].map(
      (i) =>
        b.vector[i]! -
        (fixed.get(b.to)?.[i] ?? 0) +
        (fixed.get(b.from)?.[i] ?? 0)
    );
    const terms: [number, number][] = []; // [column, sign]
    if (col.has(b.to)) terms.push([col.get(b.to)!, 1]);
    if (col.has(b.from)) terms.push([col.get(b.from)!, -1]);
    for (const [ca, sa] of terms) {
      for (const [cb, sb] of terms)
        for (let i = 0; i < 3; i++)
          for (let j = 0; j < 3; j++)
            N[ca + i]![cb + j]! += sa * sb * w[i]![j]!;
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) u[ca + i]! += sa * w[i]![j]! * l[j]!;
    }
  });
  const Ninv = nu ? invert(N) : [];
  if (!Ninv) throw new Error('The network is singular.');
  const x = Ninv.map((row) => row.reduce((s, v, j) => s + v * u[j]!, 0));
  const coord = (p: string): Vec3 =>
    fixed.get(p) ?? ([0, 1, 2].map((i) => x[col.get(p)! + i]!) as Vec3);
  // Residuals and their cofactors: Qv = C − A·N⁻¹·Aᵀ (per baseline block).
  let vWv = 0;
  const per = obs.map((b, k) => {
    const a = coord(b.to);
    const f = coord(b.from);
    const v = [0, 1, 2].map((i) => a[i]! - f[i]! - b.vector[i]!) as Vec3;
    const w = W[k]!;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) vWv += v[i]! * w[i]![j]! * v[j]!;
    const blk = (p: string, q: string, i: number, j: number) =>
      col.has(p) && col.has(q) ? Ninv[col.get(p)! + i]![col.get(q)! + j]! : 0;
    const Qv = [0, 1, 2].map((i) =>
      [0, 1, 2].map(
        (j) =>
          b.covariance[i]![j]! -
          (blk(b.to, b.to, i, j) -
            blk(b.to, b.from, i, j) -
            blk(b.from, b.to, i, j) +
            blk(b.from, b.from, i, j))
      )
    );
    return { v, Qv };
  });
  const redundancy = 3 * obs.length - nu;
  return { free, col, Ninv, coord, per, vWv, redundancy };
}

export function adjustBaselineNetwork(
  fixedPoints: ReadonlyMap<string, Vec3>,
  baselines: readonly BaselineObservation[],
  opts: BaselineNetworkOptions = {}
): BaselineNetworkResult {
  const wCrit = opts.wCritical ?? -normalQuantile(0.0005);
  const fixedSet = new Set(fixedPoints.keys());
  const status = baselines.map((): AdjustedBaseline['status'] => 'used');
  // Baselines between two fixed points carry no information on the
  // unknowns; keep them out (they still close loops below).
  const connected = reachable(fixedSet, baselines);
  baselines.forEach((b, k) => {
    if (!connected.has(b.from) || !connected.has(b.to))
      status[k] = 'unconnected';
  });

  for (;;) {
    const used = baselines.filter((_, k) => status[k] === 'used');
    const sol = solve(fixedPoints, used);
    const s0 = sol.redundancy > 0 ? sol.vWv / sol.redundancy : 1;
    // w-test on normalised residuals |v|/√Qv, scaled by their robust
    // spread (1.4826 × median): the a-priori σ₀ = 1 would flag nearly
    // everything (GNSS covariances are optimistic) and σ̂₀ itself is
    // inflated by the very blunder being looked for.
    const norm = sol.per.map(({ v, Qv }) =>
      [0, 1, 2].map((i) =>
        Qv[i]![i]! > 1e-20 ? Math.abs(v[i]!) / Math.sqrt(Qv[i]![i]!) : null
      )
    );
    const flat = norm.flat().filter((x): x is number => x != null);
    const sorted = [...flat].sort((a, b) => a - b);
    const med = sorted.length ? sorted[sorted.length >> 1]! : 0;
    // Floored at half the a-priori σ₀: noise-free (or over-smooth) data
    // would otherwise turn rounding noise into "outliers".
    const scaleW = Math.max(1.4826 * med, 0.5);
    const ws = norm.map((n) =>
      sol.redundancy > 0 ? Math.max(...n.map((x) => (x ?? 0) / scaleW)) : null
    );
    // Data snooping: drop the worst failing baseline if the rest still
    // connects every point.
    if ((opts.snoop ?? true) && sol.redundancy > 0) {
      const order = ws
        .map((w, i) => ({ w: w ?? 0, i }))
        .filter((x) => x.w > wCrit)
        .sort((a, b) => b.w - a.w);
      let dropped = false;
      for (const { i } of order) {
        const rest = used.filter((_, j) => j !== i);
        const reach = reachable(fixedSet, rest);
        if ([...connected].every((p) => reach.has(p))) {
          status[baselines.indexOf(used[i]!)] = 'rejected';
          dropped = true;
          break;
        }
      }
      if (dropped) continue;
    }

    const scale = Math.max(1, s0);
    const points = new Map<
      string,
      { ecef: Vec3; covariance: number[][]; fixed: boolean }
    >();
    for (const [p, xyz] of fixedPoints)
      points.set(p, {
        ecef: xyz,
        covariance: [0, 1, 2].map(() => [0, 0, 0]),
        fixed: true,
      });
    for (const p of sol.free) {
      const c = sol.col.get(p)!;
      points.set(p, {
        ecef: sol.coord(p),
        covariance: [0, 1, 2].map((i) =>
          [0, 1, 2].map((j) => scale * sol.Ninv[c + i]![c + j]!)
        ),
        fixed: false,
      });
    }
    let u = 0;
    const out: AdjustedBaseline[] = baselines.map((b, k) => {
      if (status[k] !== 'used')
        return { ...b, residual: null, w: null, status: status[k]! };
      const r = {
        ...b,
        residual: sol.per[u]!.v,
        w: ws[u]!,
        status: 'used' as const,
      };
      u++;
      return r;
    });
    const critical =
      sol.redundancy > 0
        ? chi2Quantile(1 - (opts.alpha ?? 0.05), sol.redundancy)
        : 0;
    return {
      points,
      baselines: out,
      redundancy: sol.redundancy,
      sigma0sq: s0,
      chi2:
        sol.redundancy > 0
          ? { value: sol.vWv, critical, pass: sol.vWv <= critical }
          : null,
      loops: loopMisclosures(baselines),
      unconnected: [
        ...new Set(baselines.flatMap((b) => [b.from, b.to])),
      ].filter((p) => !connected.has(p)),
    };
  }
}

/**
 * Misclosure of every independent loop of observed baselines: a spanning
 * tree, and for each baseline outside it the loop it closes.
 */
export function loopMisclosures(
  baselines: readonly BaselineObservation[]
): NetworkLoop[] {
  const parent = new Map<string, { via: number; from: string } | null>();
  const adj = new Map<string, { k: number; other: string }[]>();
  for (const [k, b] of baselines.entries()) {
    for (const [p, q] of [
      [b.from, b.to],
      [b.to, b.from],
    ] as const) {
      const l = adj.get(p);
      if (l) l.push({ k, other: q });
      else adj.set(p, [{ k, other: q }]);
    }
  }
  const inTree = new Set<number>();
  for (const root of adj.keys()) {
    if (parent.has(root)) continue;
    parent.set(root, null);
    const queue = [root];
    while (queue.length) {
      const p = queue.shift()!;
      for (const { k, other } of adj.get(p)!) {
        if (parent.has(other)) continue;
        parent.set(other, { via: k, from: p });
        inTree.add(k);
        queue.push(other);
      }
    }
  }
  /** Tree path to the root as [point, baseline index, sign][]. */
  const pathUp = (p: string) => {
    const out: { p: string; k: number; sign: number }[] = [];
    let cur = p;
    for (let e = parent.get(cur); e; e = parent.get(cur)) {
      // Walking cur → parent: + if the baseline points parent → cur.
      const b = baselines[e.via]!;
      out.push({ p: cur, k: e.via, sign: b.to === cur ? -1 : 1 });
      cur = e.from;
    }
    return { out, root: cur };
  };
  const loops: NetworkLoop[] = [];
  for (const [k, b] of baselines.entries()) {
    if (inTree.has(k)) continue;
    // Loop: from → to along b, then to → … → from through the tree.
    const up1 = pathUp(b.to).out;
    const up2 = pathUp(b.from).out;
    const on2 = new Map(up2.map((x, i) => [x.p, i]));
    let i1 = up1.findIndex((x) => on2.has(x.p));
    // Common ancestor: first point of up1 also on up2's path (or the root).
    const lca = i1 >= 0 ? up1[i1]!.p : (pathUp(b.to).root as string);
    if (i1 < 0) i1 = up1.length;
    const i2 = on2.get(lca) ?? up2.length;
    const sum: Vec3 = [...b.vector] as Vec3;
    let perim = Math.hypot(...b.vector);
    const pts = [b.from, b.to];
    for (const x of up1.slice(0, i1)) {
      const v = baselines[x.k]!.vector;
      for (let i = 0; i < 3; i++) sum[i] += x.sign * v[i]!;
      perim += Math.hypot(...v);
      pts.push(parent.get(x.p)!.from);
    }
    // … down from the common point to `from` (reverse of from's climb).
    for (const x of up2.slice(0, i2).reverse()) {
      const v = baselines[x.k]!.vector;
      for (let i = 0; i < 3; i++) sum[i] -= x.sign * v[i]!;
      perim += Math.hypot(...v);
      pts.push(x.p);
    }
    const len = Math.hypot(...sum);
    loops.push({
      points: pts,
      misclosure: sum,
      lengthM: len,
      ppm: perim > 0 ? (len / perim) * 1e6 : 0,
    });
  }
  return loops;
}
