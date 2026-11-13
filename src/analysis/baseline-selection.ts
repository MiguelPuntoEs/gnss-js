/**
 * Independent baselines for a network double-difference solution: n − 1 baselines forming a spanning tree, so every station is
 * connected and no observation is used twice.
 *
 *  - 'obs-max': the tree maximising the number of common
 *    observations (station pairs that see the same satellites at the same
 *    epochs the most), ties broken by the shorter baseline. Kruskal on the
 *    common-observation counts.
 *  - 'shortest': the minimum spanning tree by length.
 *
 * Station pairs with no common observation are never selected; a network
 * that splits into disconnected groups yields a forest (`components` > 1).
 */

export interface BaselineStation {
  id: string;
  /** ECEF (m). */
  ecef: readonly [number, number, number];
}

export interface SelectedBaseline {
  a: string;
  b: string;
  lengthM: number;
  /** Common observations (epoch × satellite), when counted. */
  commonObs: number;
}

export interface BaselineSelectionOptions {
  strategy?: 'obs-max' | 'shortest';
  /** Common observations of a pair (OBS-MAX needs it; otherwise only
   *  used to skip pairs with none). */
  commonObs?: (a: string, b: string) => number;
  /** Never select pairs longer than this (m). Default: no limit. */
  maxLengthM?: number;
}

export interface BaselineSelection {
  baselines: SelectedBaseline[];
  /** Connected groups (1 = one network). */
  components: number;
}

/** Choose n − 1 independent baselines (a spanning tree / forest). */
export function selectBaselines(
  stations: readonly BaselineStation[],
  opts: BaselineSelectionOptions = {}
): BaselineSelection {
  const strategy = opts.strategy ?? 'obs-max';
  const edges: SelectedBaseline[] = [];
  for (let i = 0; i < stations.length; i++)
    for (let j = i + 1; j < stations.length; j++) {
      const a = stations[i]!;
      const b = stations[j]!;
      const lengthM = Math.hypot(
        a.ecef[0] - b.ecef[0],
        a.ecef[1] - b.ecef[1],
        a.ecef[2] - b.ecef[2]
      );
      if (opts.maxLengthM !== undefined && lengthM > opts.maxLengthM) continue;
      const commonObs = opts.commonObs ? opts.commonObs(a.id, b.id) : 1;
      if (commonObs <= 0) continue;
      edges.push({ a: a.id, b: b.id, lengthM, commonObs });
    }
  edges.sort((x, y) =>
    strategy === 'obs-max'
      ? y.commonObs - x.commonObs || x.lengthM - y.lengthM
      : x.lengthM - y.lengthM
  );

  // Kruskal with union–find.
  const parent = new Map<string, string>(stations.map((s) => [s.id, s.id]));
  const root = (s: string): string => {
    let r = s;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = s;
    while (c !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const baselines: SelectedBaseline[] = [];
  for (const e of edges) {
    const ra = root(e.a);
    const rb = root(e.b);
    if (ra === rb) continue;
    parent.set(ra, rb);
    baselines.push(e);
    if (baselines.length === stations.length - 1) break;
  }
  return {
    baselines,
    components: stations.length - baselines.length,
  };
}
