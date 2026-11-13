/**
 * Datum definition of a stacked network by minimum constraints — the
 * NNT / NNR / NNS conditions of the EUREF and IGS
 * combinations: the solution may not translate, rotate or scale with
 * respect to the reference coordinates of a set of datum stations,
 *   (BᵀB)⁻¹Bᵀ · (x̂ − x_ref) = 0      (B = Helmert design at the stations)
 * and likewise for velocities. The conditions only fix the directions the
 * data leave free, so the network's shape is not distorted.
 *
 * `solveWithDatum` adds the iterative datum-station check: after each
 * solve the estimated positions of the datum stations are compared with
 * their reference by a Helmert transformation (same model), stations whose
 * horizontal/vertical residual exceeds the limits are dropped, and the
 * solution is repeated — as in the EPN/IGS
 * processing.
 */
import type { NeqParameter, NormalEquations } from './normal-equations';
import {
  addObservations,
  MS_PER_YEAR,
  solveNeq,
  type NeqObservationRow,
  type NeqSolution,
} from './neq';
import {
  estimateHelmert,
  helmertDesign,
  helmertParameterCount,
  horizontalVertical,
  type HelmertFit,
  type HelmertModel,
} from './network-alignment';

/** A reference (e.g. IGS20 / EPN cumulative) coordinate of a site. */
export interface ReferenceCoordinate {
  site: string;
  /** Solution validity (ms); omit for "always". */
  startMs?: number;
  endMs?: number;
  /** Position at `epochMs`, ECEF (m). */
  xyz: readonly [number, number, number];
  /** Velocity, ECEF (m/yr). */
  vel?: readonly [number, number, number];
  epochMs: number;
}

/** A station's coordinate (or velocity) triplet in a NEQ. */
export interface StationTriplet {
  site: string;
  solnId: string;
  pointCode: string;
  /** Indices of X, Y, Z. */
  idx: [number, number, number];
  epochMs: number;
  startMs?: number;
  endMs?: number;
}

/** Group STAX/Y/Z (or VELX/Y/Z) parameters into per-station triplets. */
export function stationTriplets(
  params: readonly NeqParameter[],
  kind: 'STA' | 'VEL' = 'STA'
): StationTriplet[] {
  const m = new Map<string, StationTriplet>();
  params.forEach((p, i) => {
    if (!p.type.startsWith(kind)) return;
    const k = 'XYZ'.indexOf(p.type.slice(3));
    if (k < 0 || p.type.length !== 4) return;
    const key = `${p.site}|${p.pointCode ?? 'A'}|${p.solnId ?? '1'}`;
    let t = m.get(key);
    if (!t)
      m.set(
        key,
        (t = {
          site: p.site,
          solnId: p.solnId ?? '1',
          pointCode: p.pointCode ?? 'A',
          idx: [-1, -1, -1],
          epochMs: p.refEpochMs,
          startMs: p.startMs,
          endMs: p.endMs,
        })
      );
    t.idx[k] = i;
  });
  return [...m.values()].filter((t) => t.idx.every((i) => i >= 0));
}

/** The reference coordinate valid for a triplet (largest overlap of the
 *  triplet's interval — or its epoch — with the reference's validity). */
export function findReference(
  t: StationTriplet,
  refs: readonly ReferenceCoordinate[],
  /** With no valid solution, use the site's latest one that ended before
   *  (a frame not yet updated after an equipment change — what the EUREF
   *  combination does; the residual then shows the offset). */
  latestBefore = false
): ReferenceCoordinate | undefined {
  const a = t.startMs ?? t.epochMs;
  const b = t.endMs ?? t.epochMs;
  let best: ReferenceCoordinate | undefined;
  let bestOverlap = -Infinity;
  for (const r of refs) {
    if (r.site !== t.site) continue;
    const s = r.startMs ?? -Infinity;
    const e = r.endMs ?? Infinity;
    if (e < a || s > b) continue;
    const ov = Math.min(e, b) - Math.max(s, a);
    if (ov > bestOverlap) {
      bestOverlap = ov;
      best = r;
    }
  }
  if (!best && latestBefore) {
    let end = -Infinity;
    for (const r of refs)
      if (r.site === t.site && (r.endMs ?? Infinity) <= a && r.endMs! > end) {
        end = r.endMs!;
        best = r;
      }
  }
  return best;
}

/** Reference position at an epoch (m). */
export function referenceAt(
  r: ReferenceCoordinate,
  epochMs: number
): [number, number, number] {
  const dt = (epochMs - r.epochMs) / MS_PER_YEAR;
  return [0, 1, 2].map((k) => r.xyz[k]! + (r.vel?.[k] ?? 0) * dt) as [
    number,
    number,
    number,
  ];
}

const EARTH_RADIUS = 6_371_000;

/**
 * Minimum-constraint pseudo-observations over `triplets` (positions or
 * velocities): k = 3/6/7 rows (NNT, +NNR, +NNS) of
 *   (BᵀB)⁻¹Bᵀ · (Δx − (x_ref − x₀)) = 0,
 * B evaluated at the stations' a-priori positions (rotation and scale
 * columns scaled by the Earth radius, so σ is in metres at the surface).
 */
export function minimumConstraintRows(
  neq: NormalEquations,
  triplets: readonly StationTriplet[],
  target: readonly (readonly [number, number, number])[],
  model: HelmertModel,
  sigma: number,
  /** A-priori positions for the design (defaults to the triplets' a-priori
   *  values — pass positions when the triplets are velocities). */
  positions?: readonly (readonly [number, number, number])[],
  /** Weight per triplet (default equal): (BᵀWB)⁻¹BᵀW. */
  weights?: readonly number[]
): NeqObservationRow[] {
  const k = helmertParameterCount(model);
  const B: number[][] = [];
  const idx: number[] = [];
  const l: number[] = [];
  const w: number[] = [];
  triplets.forEach((t, s) => {
    const x0 = positions?.[s] ?? t.idx.map((i) => neq.params[i]!.apriori);
    const rows = helmertDesign(
      x0.map((v) => v / EARTH_RADIUS),
      model
    );
    for (let c = 0; c < 3; c++) {
      B.push(rows[c]!);
      idx.push(t.idx[c]!);
      w.push(weights?.[s] ?? 1);
      l.push(target[s]![c]! - neq.params[t.idx[c]!]!.apriori);
    }
  });
  // (BᵀB)⁻¹Bᵀ
  const BtB = Array.from({ length: k }, (_, a) =>
    Array.from({ length: k }, (_, c) =>
      B.reduce((s, r, m) => s + w[m]! * r[a]! * r[c]!, 0)
    )
  );
  const inv = invertSmall(BtB);
  if (!inv) throw new Error('minimumConstraintRows: datum stations degenerate');
  const out: NeqObservationRow[] = [];
  for (let a = 0; a < k; a++) {
    const terms: [number, number][] = B.map((r, m) => [
      idx[m]!,
      w[m]! * r.reduce((s, v, c) => s + inv[a]![c]! * v, 0),
    ]);
    out.push({
      terms,
      value: terms.reduce((s, [, c], m) => s + c * l[m]!, 0),
      sigma,
    });
  }
  return out;
}

function invertSmall(A: number[][]): number[][] | null {
  const n = A.length;
  const M = A.map((r, i) => [
    ...r,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-14) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    const d = M[c]![c]!;
    for (let k = 0; k < 2 * n; k++) M[c]![k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]!;
      if (f) for (let k = 0; k < 2 * n; k++) M[r]![k] -= f * M[c]![k]!;
    }
  }
  return M.map((r) => r.slice(n));
}

export interface DatumOptions {
  reference: readonly ReferenceCoordinate[];
  /** Sites eligible as datum stations (default: every site with a
   *  reference coordinate). */
  sites?: readonly string[];
  /** Conditions on positions: NNT ('translation', EUREF's choice), NNT+NNR
   *  ('rigid') or NNT+NNR+NNS ('similarity'). Default 'translation'. */
  position?: HelmertModel;
  /** Conditions on velocities when the NEQ has them (default: as
   *  `position`); false for none. */
  velocity?: HelmertModel | false;
  /** σ of each condition (m, m/yr at the surface). Default 1e-5. */
  sigma?: number;
  /** Datum-station check limits (m). Default 0.005 / 0.015. Set
   *  `iterate: false` to skip the check. */
  maxResidualHorizontalM?: number;
  maxResidualVerticalM?: number;
  /** Velocity check limits (m/yr). Default 0.003 / 0.006 (only with
   *  velocities). */
  maxVelocityResidualHorizontal?: number;
  maxVelocityResidualVertical?: number;
  iterate?: boolean;
  /** Fall back to a site's latest reference solution when none covers the
   *  epoch (see `findReference`). Default false. */
  latestReference?: boolean;
  /** Stop rejecting at this many datum stations. Default 4. */
  minStations?: number;
}

export interface DatumStation {
  site: string;
  solnId: string;
  /** Reference − estimate after the final Helmert fit, ECEF (m). */
  residual: [number, number, number];
  horizontal: number;
  vertical: number;
  /** Velocity residual (m/yr), with velocities. */
  velResidual?: [number, number, number];
  used: boolean;
}

export interface DatumSolution extends NeqSolution {
  datum: DatumStation[];
  /** Helmert transformation estimate → reference over the used stations. */
  helmert: HelmertFit | null;
  iterations: number;
}

/** A Helmert fit of estimate → reference for triplets, rejecting nothing. */
function fitAll(
  est: [number, number, number][],
  ref: [number, number, number][],
  model: HelmertModel
): HelmertFit | null {
  return estimateHelmert(est, ref, {
    model,
    maxResidualM: Infinity,
    minRefs: model === 'translation' ? 1 : 3,
  });
}

/**
 * Solve a NEQ with minimum constraints on the reference stations it
 * contains, iterating the datum-station check.
 */
export function solveWithDatum(
  neq: NormalEquations,
  opts: DatumOptions
): DatumSolution {
  const posModel = opts.position ?? 'translation';
  const velModel = opts.velocity === undefined ? posModel : opts.velocity;
  const sigma = opts.sigma ?? 1e-5;
  const maxH = opts.maxResidualHorizontalM ?? 0.005;
  const maxV = opts.maxResidualVerticalM ?? 0.015;
  const maxVH = opts.maxVelocityResidualHorizontal ?? 0.003;
  const maxVV = opts.maxVelocityResidualVertical ?? 0.006;
  const minStations = opts.minStations ?? 4;
  const eligible = opts.sites ? new Set(opts.sites) : null;

  const sta = stationTriplets(neq.params, 'STA');
  const vel = stationTriplets(neq.params, 'VEL');
  // Datum candidates: position triplets with a reference.
  const cands = sta.flatMap((t) => {
    if (eligible && !eligible.has(t.site)) return [];
    const r = findReference(t, opts.reference, opts.latestReference);
    if (!r) return [];
    // The station's velocity triplet: same site, solution covering it.
    const v = vel.find(
      (u) =>
        u.site === t.site &&
        u.pointCode === t.pointCode &&
        (u.startMs ?? -Infinity) <= (t.startMs ?? t.epochMs) &&
        (u.endMs ?? Infinity) >= (t.endMs ?? t.epochMs)
    );
    return [{ t, r, v }];
  });
  const used = cands.map(() => true);
  const hasVel = vel.length > 0 && velModel !== false;

  for (let iter = 1; ; iter++) {
    const on = cands.filter((_, i) => used[i]);
    const rows: NeqObservationRow[] = minimumConstraintRows(
      neq,
      on.map((c) => c.t),
      on.map((c) => referenceAt(c.r, c.t.epochMs)),
      posModel,
      sigma
    );
    if (hasVel) {
      const withV = on.filter((c) => c.v && c.r.vel);
      // Several position segments can share a velocity: constrain it once.
      const seen = new Set<StationTriplet>();
      const vs = withV.filter((c) =>
        seen.has(c.v!) ? false : (seen.add(c.v!), true)
      );
      if (vs.length)
        rows.push(
          ...minimumConstraintRows(
            neq,
            vs.map((c) => c.v!),
            vs.map((c) => [...c.r.vel!] as [number, number, number]),
            velModel as HelmertModel,
            sigma,
            vs.map(
              (c) =>
                c.t.idx.map((i) => neq.params[i]!.apriori) as [
                  number,
                  number,
                  number,
                ]
            )
          )
        );
    }
    const sol = solveNeq(addObservations(neq, rows));
    // The k condition rows count as observations: they remove the k-fold
    // datum defect, so dof = nObs − rank(N) as it should.
    const est = (t: StationTriplet) =>
      t.idx.map((i) => sol.estimate[i]!) as [number, number, number];
    const estAll = cands.map((c) => est(c.t));
    const refAll = cands.map((c) => referenceAt(c.r, c.t.epochMs));
    const idxOn = cands.flatMap((_, i) => (used[i] ? [i] : []));
    const fit = fitAll(
      idxOn.map((i) => estAll[i]!),
      idxOn.map((i) => refAll[i]!),
      posModel
    );
    const apply = (x: [number, number, number]) =>
      fit
        ? ([0, 1, 2].map(
            (k) =>
              x[k]! +
              fit.t[k]! +
              fit.d * x[k]! +
              (k === 0
                ? -fit.r[2] * x[1] + fit.r[1] * x[2]
                : k === 1
                  ? fit.r[2] * x[0] - fit.r[0] * x[2]
                  : -fit.r[1] * x[0] + fit.r[0] * x[1])
          ) as [number, number, number])
        : x;
    const datum: DatumStation[] = cands.map((c, i) => {
      const y = apply(estAll[i]!);
      const residual = [0, 1, 2].map((k) => refAll[i]![k]! - y[k]!) as [
        number,
        number,
        number,
      ];
      const hv = horizontalVertical(estAll[i]!, residual);
      let velResidual: [number, number, number] | undefined;
      if (hasVel && c.v && c.r.vel)
        velResidual = [0, 1, 2].map(
          (k) => c.r.vel![k]! - sol.estimate[c.v!.idx[k]!]!
        ) as [number, number, number];
      return {
        site: c.t.site,
        solnId: c.t.solnId,
        residual,
        ...hv,
        velResidual,
        used: used[i]!,
      };
    });
    if (opts.iterate !== false && idxOn.length > minStations) {
      // Worst ratio to the limits among the used stations.
      let worst = -1;
      let worstScore = 1;
      for (const i of idxOn) {
        const d = datum[i]!;
        let score = Math.max(d.horizontal / maxH, d.vertical / maxV);
        if (d.velResidual) {
          // Raw reference − estimate: the velocity conditions already
          // remove the common rate.
          const hv = horizontalVertical(estAll[i]!, d.velResidual);
          score = Math.max(score, hv.horizontal / maxVH, hv.vertical / maxVV);
        }
        if (score > worstScore) {
          worstScore = score;
          worst = i;
        }
      }
      if (worst >= 0) {
        used[worst] = false;
        continue;
      }
    }
    return { ...sol, datum, helmert: fit, iterations: iter };
  }
}
