/**
 * SINEX 2.02 as a carrier of normal equations and full covariances —
 * what EPN/IGS analysis centres exchange and combination centres stack:
 *
 *  - `parseSinex`: every parameter block (SOLUTION/ESTIMATE, /APRIORI,
 *    /NORMAL_EQUATION_VECTOR), every matrix (MATRIX_ESTIMATE, MATRIX_APRIORI,
 *    NORMAL_EQUATION_MATRIX; L or U, COVA / CORR / INFO), SOLUTION/STATISTICS,
 *    SITE/ID and SOLUTION/EPOCHS.
 *  - `sinexToNeq`: the file as `NormalEquations` — directly from the NEQ
 *    blocks when present, otherwise by removing the constraints from the
 *    covariance (N = C⁻¹ − C_apriori⁻¹).
 *  - `writeSinexNeq` / `writeSinexCovariance`: the reverse, with full
 *    (cross-)covariance.
 *  - `parseSinexDiscontinuities`: the IGS/EPN SOLUTION/DISCONTINUITY files.
 */
import type {
  NeqParameter,
  NormalEquations,
} from '../analysis/normal-equations';
import { neqFromCovariance, preEliminate, scaleNeq } from '../analysis/neq';
import { invertSymmetric as invert } from '../analysis/neq-linalg';
import { dms, geodetic, parseSinexEpoch, sinexEpoch } from './sinex-format';

export interface SinexParameterLine {
  /** INDEX (1-based) as in the file. */
  index: number;
  type: string;
  site: string;
  pointCode: string;
  solnId: string;
  refEpochMs: number;
  unit: string;
  /** Constraint code column (0 tight, 1 significant, 2 unconstrained). */
  constraint: string;
  value: number;
  sigma: number;
}

export interface SinexMatrix {
  /** COVA, CORR, INFO, or NEQ (NORMAL_EQUATION_MATRIX). */
  kind: 'COVA' | 'CORR' | 'INFO' | 'NEQ';
  /** Largest index seen; `data` is n×n over indices 1…n (row-major). */
  n: number;
  /** Full symmetric matrix; CORR is converted to COVA. */
  data: Float64Array;
}

export interface SinexSite {
  site: string;
  pointCode: string;
  domes: string;
  description: string;
}

export interface SinexSolutionEpoch {
  site: string;
  pointCode: string;
  solnId: string;
  startMs: number | null;
  endMs: number | null;
  meanMs: number | null;
}

export interface SinexFile {
  version: string;
  agency: string;
  startMs: number | null;
  endMs: number | null;
  estimate: SinexParameterLine[];
  apriori: SinexParameterLine[];
  neqVector: SinexParameterLine[];
  matrixEstimate?: SinexMatrix;
  matrixApriori?: SinexMatrix;
  neqMatrix?: SinexMatrix;
  /** SOLUTION/STATISTICS, keyed by the upper-case label. */
  statistics: Map<string, number>;
  sites: SinexSite[];
  epochs: SinexSolutionEpoch[];
}

/** Find the blocks of a SINEX file: name (with options) → body lines. */
function blocks(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('+')) {
      cur = [];
      out.set(line.slice(1).trim(), cur);
    } else if (line.startsWith('-')) cur = null;
    else if (cur && !line.startsWith('*') && line.trim()) cur.push(line);
  }
  return out;
}

function parameterLines(lines: string[] | undefined): SinexParameterLine[] {
  if (!lines) return [];
  return lines.map((l) => {
    const rest = l.slice(47).trim().split(/\s+/);
    return {
      index: Number(l.slice(1, 6)),
      type: l.slice(7, 13).trim(),
      site: l.slice(14, 18).trim(),
      pointCode: l.slice(19, 21).trim() || 'A',
      solnId: l.slice(22, 26).trim() || '1',
      refEpochMs: parseSinexEpoch(l.slice(27, 39)) ?? 0,
      unit: l.slice(40, 44).trim(),
      constraint: l.slice(45, 46).trim(),
      value: Number(rest[0]),
      sigma: rest[1] !== undefined ? Number(rest[1]) : 0,
    };
  });
}

function matrix(
  name: string,
  lines: string[],
  maxIndex: number
): SinexMatrix | undefined {
  const opts = name.split(/\s+/).slice(1);
  const tri = opts.includes('U') ? 'U' : 'L';
  let kind: SinexMatrix['kind'] = name.includes('NORMAL_EQUATION')
    ? 'NEQ'
    : opts.includes('CORR')
      ? 'CORR'
      : opts.includes('INFO')
        ? 'INFO'
        : 'COVA';
  let n = maxIndex;
  const entries: [number, number, number][] = [];
  for (const l of lines) {
    const f = l.trim().split(/\s+/);
    const r = Number(f[0]);
    const c = Number(f[1]);
    for (let k = 2; k < f.length; k++) {
      const v = Number(f[k]);
      entries.push([r, c + k - 2, v]);
      n = Math.max(n, r, c + k - 2);
    }
  }
  if (!entries.length) return undefined;
  const data = new Float64Array(n * n);
  for (const [r0, c0, v] of entries) {
    // L: row ≥ col; U: row ≤ col — either way fill both triangles.
    const r = tri === 'L' ? r0 : c0;
    const c = tri === 'L' ? c0 : r0;
    data[(r - 1) * n + (c - 1)] = v;
    data[(c - 1) * n + (r - 1)] = v;
  }
  if (kind === 'CORR') {
    const s = new Float64Array(n);
    for (let i = 0; i < n; i++) s[i] = data[i * n + i]!;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        data[i * n + j] =
          i === j ? s[i]! * s[i]! : data[i * n + j]! * s[i]! * s[j]!;
    kind = 'COVA';
  }
  return { kind, n, data };
}

/** Parse the solution blocks of a SINEX file. */
export function parseSinex(text: string): SinexFile {
  const head = text.slice(0, text.indexOf('\n')).replace(/\r$/, '');
  const b = blocks(text);
  const get = (prefix: string) => {
    for (const [k, v] of b)
      if (k === prefix || k.startsWith(prefix + ' ')) return [k, v] as const;
    return undefined;
  };
  const estimate = parameterLines(get('SOLUTION/ESTIMATE')?.[1]);
  const apriori = parameterLines(get('SOLUTION/APRIORI')?.[1]);
  const neqVector = parameterLines(get('SOLUTION/NORMAL_EQUATION_VECTOR')?.[1]);
  const maxIdx = (ls: SinexParameterLine[]) =>
    ls.reduce((m, p) => Math.max(m, p.index), 0);
  const me = get('SOLUTION/MATRIX_ESTIMATE');
  const ma = get('SOLUTION/MATRIX_APRIORI');
  const mn = get('SOLUTION/NORMAL_EQUATION_MATRIX');
  const statistics = new Map<string, number>();
  for (const l of get('SOLUTION/STATISTICS')?.[1] ?? []) {
    const label = l.slice(1, 31).trim().toUpperCase();
    const v = Number(l.slice(31).trim().replace(/[dD]/, 'E'));
    if (label && Number.isFinite(v)) statistics.set(label, v);
  }
  const sites = (get('SITE/ID')?.[1] ?? []).map((l) => ({
    site: l.slice(1, 5).trim(),
    pointCode: l.slice(6, 8).trim() || 'A',
    domes: l.slice(9, 18).trim(),
    description: l.slice(21, 43).trim(),
  }));
  const epochs = (get('SOLUTION/EPOCHS')?.[1] ?? []).map((l) => ({
    site: l.slice(1, 5).trim(),
    pointCode: l.slice(6, 8).trim() || 'A',
    solnId: l.slice(9, 13).trim() || '1',
    startMs: parseSinexEpoch(l.slice(16, 28)),
    endMs: parseSinexEpoch(l.slice(29, 41)),
    meanMs: parseSinexEpoch(l.slice(42, 54)),
  }));
  const hf = head.split(/\s+/);
  return {
    version: hf[1] ?? '',
    agency: hf[2] ?? '',
    startMs: parseSinexEpoch(hf[5] ?? ''),
    endMs: parseSinexEpoch(hf[6] ?? ''),
    estimate,
    apriori,
    neqVector,
    matrixEstimate: me && matrix(me[0], me[1], maxIdx(estimate)),
    matrixApriori: ma && matrix(ma[0], ma[1], maxIdx(apriori)),
    neqMatrix: mn && matrix(mn[0], mn[1], maxIdx(neqVector)),
    statistics,
    sites,
    epochs,
  };
}

const toParam = (
  p: SinexParameterLine,
  apriori: number,
  ep?: SinexSolutionEpoch
): NeqParameter => ({
  type: p.type,
  site: p.site,
  pointCode: p.pointCode,
  solnId: p.solnId,
  refEpochMs: p.refEpochMs,
  apriori,
  unit: p.unit,
  ...(ep?.startMs != null ? { startMs: ep.startMs } : {}),
  ...(ep?.endMs != null ? { endMs: ep.endMs } : {}),
});

export interface SinexToNeqOptions {
  /** Keep only these parameter types (others are pre-eliminated). */
  types?: readonly string[];
  /** Which source to use when a file has both: default 'neq' if present. */
  source?: 'neq' | 'covariance';
  /**
   * A covariance file is scaled by its a-posteriori VARIANCE FACTOR σ̂₀².
   * 'remove' (default) multiplies the NEQ back by it — the original
   * normal equations at the a-priori σ₀, as an analysis centre's NEQ file would be,
   * so stacked solutions keep their original relative weights (what the
   * EUREF weekly stack of daily NEQs does). 'keep' leaves each solution
   * at unit weight of its own fit (weights each by 1/σ̂₀²).
   */
  varianceFactor?: 'remove' | 'keep';
}

/**
 * A SINEX file as normal equations. With NORMAL_EQUATION_VECTOR/MATRIX the
 * NEQ is taken as is (convention: lᵀPl = "WEIGHTED SQUARE SUM OF
 * O-C", σ₀ a-priori = "PHASE MEASUREMENTS SIGMA"); otherwise the
 * constraints of MATRIX_APRIORI (or the APRIORI std devs) are removed
 * from the covariance and the NEQ is at unit weight. Station parameters
 * carry the SOLUTION/EPOCHS data interval as startMs/endMs.
 */
export function sinexToNeq(
  file: SinexFile,
  opts: SinexToNeqOptions = {}
): NormalEquations {
  const st = file.statistics;
  const nObs = st.get('NUMBER OF OBSERVATIONS') ?? 0;
  const nUnknowns = st.get('NUMBER OF UNKNOWNS') ?? 0;
  const epochOf = new Map(
    file.epochs.map((e) => [`${e.site}|${e.pointCode}|${e.solnId}`, e])
  );
  const ep = (p: SinexParameterLine) =>
    epochOf.get(`${p.site}|${p.pointCode}|${p.solnId}`);
  // APRIORI lines match the ESTIMATE / NEQ lines by parameter (type, site,
  // point, solution, epoch-independent) — not necessarily by INDEX (GIPSY
  // conversions order them differently).
  const pkey = (p: SinexParameterLine) =>
    `${p.type}|${p.site}|${p.pointCode}|${p.solnId}`;
  const aprioriByKey = new Map(file.apriori.map((p) => [pkey(p), p]));
  const aprioriOf = (p: SinexParameterLine) => aprioriByKey.get(pkey(p));
  const span = {
    dataStartMs: file.startMs ?? 0,
    dataEndMs: file.endMs ?? 0,
  };
  let neq: NormalEquations;
  const useNeq =
    file.neqMatrix && file.neqVector.length && (opts.source ?? 'neq') === 'neq';
  if (useNeq) {
    const M = file.neqMatrix!;
    const lines = file.neqVector;
    const n = lines.length;
    const N = new Float64Array(n * n);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        N[i * n + j] =
          M.data[(lines[i]!.index - 1) * M.n + lines[j]!.index - 1]!;
    const params = lines.map((p) =>
      toParam(p, aprioriOf(p)?.value ?? 0, ep(p))
    );
    neq = {
      params,
      N,
      b: Float64Array.from(lines.map((p) => p.value)),
      ltpl:
        st.get('WEIGHTED SQUARE SUM OF O-C') ??
        st.get('SQUARED SUM OF RESIDUALS') ??
        0,
      nObs,
      nPreEliminated: Math.max(nUnknowns - n, 0),
      sigma0Apriori: st.get('PHASE MEASUREMENTS SIGMA') ?? 1,
      ...span,
    };
  } else {
    const lines = file.estimate;
    const C = file.matrixEstimate;
    if (!C || !lines.length)
      throw new Error('sinexToNeq: neither NEQ blocks nor a covariance');
    const n = lines.length;
    const pick = (m: SinexMatrix, info: boolean, idx: number[]) => {
      const out = new Float64Array(n * n);
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
          out[i * n + j] = m.data[(idx[i]! - 1) * m.n + idx[j]! - 1]!;
      if (!info) return out;
      // INFO = C⁻¹: hand over its inverse.
      const inv = invert(out, n);
      if (!inv) throw new Error('sinexToNeq: INFO matrix singular');
      return inv;
    };
    const cov = pick(
      C,
      C.kind === 'INFO',
      lines.map((p) => p.index)
    );
    // Constraints: the MATRIX_APRIORI, or the APRIORI std devs.
    let aprioriCov: Float64Array | undefined;
    const A = file.matrixApriori;
    if (A)
      aprioriCov = pick(
        A,
        A.kind === 'INFO',
        lines.map((p) => aprioriOf(p)?.index ?? p.index)
      );
    else if (file.apriori.some((p) => p.sigma > 0))
      aprioriCov = Float64Array.from(lines, (p) => {
        const s = aprioriOf(p)?.sigma ?? 0;
        return s > 0 ? s * s : 0;
      });
    neq = neqFromCovariance({
      params: lines.map((p) => {
        // A-priori values more than 1 km from the estimate are a writer's
        // error (seen: ASI 2297 APRIORI with a wrong exponent); under loose
        // constraints the estimate itself is as good a linearisation point.
        const a = aprioriOf(p)?.value;
        const ok = a !== undefined && Math.abs(a - p.value) < 1000;
        return toParam(p, ok ? a : p.value, ep(p));
      }),
      estimate: lines.map((p) => p.value),
      cov,
      aprioriCov,
      nObs,
      nPreEliminated: Math.max(nUnknowns - n, 0),
      ...span,
    });
    const vf = st.get('VARIANCE FACTOR');
    if (vf && vf > 0 && (opts.varianceFactor ?? 'remove') === 'remove')
      neq = scaleNeq(neq, vf);
  }
  if (opts.types) {
    const keep = new Set(opts.types);
    if (neq.params.some((p) => !keep.has(p.type)))
      neq = preEliminate(neq, (p) => !keep.has(p.type));
  }
  return neq;
}

// ─── writers ────────────────────────────────────────────────────────────

/** Fortran E with an upper-case exponent: "-0.123456789012345E+01" style
 *  is not needed by readers; this writes "-1.23456789012345E+00". */
function e(v: number, digits: number, width: number): string {
  const [m, x] = v.toExponential(digits).split('e') as [string, string];
  const ex = Number(x);
  return `${m}E${ex < 0 ? '-' : '+'}${String(Math.abs(ex)).padStart(2, '0')}`.padStart(
    width
  );
}

export interface SinexWriteMeta {
  /** 3-character agency code. */
  agency: string;
  description?: string;
  software?: string;
  input?: string;
  /** Site metadata for SITE/ID. */
  sites?: ReadonlyMap<string, { domes?: string; description?: string }>;
  createdMs?: number;
  /** Extra SOLUTION/STATISTICS entries. */
  statistics?: readonly (readonly [string, number])[];
}

const RULE =
  '*-------------------------------------------------------------------------------';

function header(
  meta: SinexWriteMeta,
  params: readonly NeqParameter[],
  startMs: number,
  endMs: number,
  constraint: string
): string[] {
  const ag = meta.agency.slice(0, 3).padEnd(3);
  const types = [
    params.some((p) => p.type.startsWith('STA')) ? 'S' : '',
    params.some((p) => p.type.startsWith('VEL')) ? 'V' : '',
    params.some((p) => p.type.startsWith('TRO') || p.type.startsWith('TG'))
      ? 'T'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  const L = [
    `%=SNX 2.02 ${ag} ${sinexEpoch(meta.createdMs ?? Date.now())} ${ag} ${sinexEpoch(startMs)} ${sinexEpoch(endMs)} P ${String(params.length).padStart(5, '0')} ${constraint} ${types}`,
    RULE,
    '+FILE/REFERENCE',
  ];
  const ref = (k: string, v?: string) => {
    if (v) L.push(` ${k.padEnd(18)} ${v.slice(0, 60)}`);
  };
  ref('DESCRIPTION', meta.description);
  ref('SOFTWARE', meta.software);
  ref('INPUT', meta.input);
  L.push('-FILE/REFERENCE', RULE);
  // SITE/ID and SOLUTION/EPOCHS from the position parameters.
  const seen = new Map<string, NeqParameter[]>();
  for (const p of params)
    if (p.type.startsWith('STA')) {
      const k = `${p.site}|${p.pointCode ?? 'A'}|${p.solnId ?? '1'}`;
      if (!seen.has(k)) seen.set(k, []);
      seen.get(k)!.push(p);
    }
  if (seen.size) {
    L.push(
      '+SITE/ID',
      '*CODE PT __DOMES__ T _STATION DESCRIPTION__ _LONGITUDE_ _LATITUDE__ HEIGHT_'
    );
    const sites = new Set<string>();
    for (const ps of seen.values()) {
      const p0 = ps[0]!;
      if (sites.has(p0.site)) continue;
      sites.add(p0.site);
      const xyz = ['STAX', 'STAY', 'STAZ'].map(
        (t) => ps.find((p) => p.type === t)?.apriori ?? 0
      ) as [number, number, number];
      const [lat, lon, h] = geodetic(...xyz);
      const m = meta.sites?.get(p0.site);
      L.push(
        ` ${p0.site.padEnd(4)}  ${(p0.pointCode ?? 'A').padStart(1)} ${(m?.domes ?? '').padEnd(9)} P ${(m?.description ?? p0.site).slice(0, 22).padEnd(22)} ${dms((lon + 360) % 360, 11)} ${dms(lat, 11)} ${h.toFixed(1).padStart(7)}`
      );
    }
    L.push('-SITE/ID', RULE);
    L.push(
      '+SOLUTION/EPOCHS',
      '*CODE PT SOLN T _DATA_START_ __DATA_END__ _MEAN_EPOCH_'
    );
    for (const ps of seen.values()) {
      const p = ps[0]!;
      L.push(
        ` ${p.site.padEnd(4)}  ${p.pointCode ?? 'A'} ${(p.solnId ?? '1').padStart(4)} P ${sinexEpoch(p.startMs ?? startMs)} ${sinexEpoch(p.endMs ?? endMs)} ${sinexEpoch(p.refEpochMs)}`
      );
    }
    L.push('-SOLUTION/EPOCHS', RULE);
  }
  return L;
}

function statistics(
  L: string[],
  rows: readonly (readonly [string, number])[]
): void {
  L.push(
    '+SOLUTION/STATISTICS',
    '*_STATISTICAL PARAMETER________ __VALUE(S)____________'
  );
  for (const [k, v] of rows) {
    const s = Number.isInteger(v) ? String(v) : e(v, 14, 22);
    L.push(` ${k.padEnd(30)} ${s.padStart(22)}`);
  }
  L.push('-SOLUTION/STATISTICS', RULE);
}

function paramBlock(
  L: string[],
  name: string,
  title: string,
  params: readonly NeqParameter[],
  value: (i: number) => number,
  sigma: ((i: number) => number) | null,
  constraint: string
): void {
  L.push(
    `+${name}`,
    `*INDEX TYPE__ CODE PT SOLN _REF_EPOCH__ UNIT S ${title}${sigma ? ' _STD_DEV___' : ''}`
  );
  params.forEach((p, i) => {
    L.push(
      ` ${String(i + 1).padStart(5)} ${p.type.padEnd(6)} ${p.site.padEnd(4)} ${(p.pointCode ?? 'A').padStart(2)} ${(p.solnId ?? '1').padStart(4)} ${sinexEpoch(p.refEpochMs)} ${p.unit.padEnd(4)} ${constraint} ${e(value(i), 14, 21)}${sigma ? ' ' + e(sigma(i), 5, 11) : ''}`
    );
  });
  L.push(`-${name}`, RULE);
}

function matrixBlock(
  L: string[],
  name: string,
  n: number,
  M: ArrayLike<number>,
  diagonalOnly = false
): void {
  L.push(
    `+${name}`,
    '*PARA1 PARA2 ____PARA2+0__________ ____PARA2+1__________ ____PARA2+2__________'
  );
  for (let r = 0; r < n; r++) {
    if (diagonalOnly) {
      L.push(
        ` ${String(r + 1).padStart(5)} ${String(r + 1).padStart(5)} ${e(M[r]!, 14, 21)}`
      );
      continue;
    }
    // Skip leading zeros of the row (SINEX allows sparse rows).
    let first = 0;
    while (first < r && M[r * n + first] === 0) first++;
    first -= first % 3;
    for (let c0 = first; c0 <= r; c0 += 3) {
      const cols: string[] = [];
      let nz = false;
      for (let c = c0; c <= Math.min(r, c0 + 2); c++) {
        const v = M[r * n + c]!;
        if (v !== 0) nz = true;
        cols.push(e(v, 14, 21));
      }
      if (nz || c0 + 2 >= r)
        L.push(
          ` ${String(r + 1).padStart(5)} ${String(c0 + 1).padStart(5)} ${cols.join(' ')}`
        );
    }
  }
  L.push(`-${name}`, RULE);
}

/**
 * Normal equations as SINEX 2.02: SOLUTION/STATISTICS, /APRIORI,
 * /NORMAL_EQUATION_VECTOR and /NORMAL_EQUATION_MATRIX L (free of
 * constraints, constraint code 2) — readable by combination software
 * (e.g. CATREF) and `sinexToNeq`.
 */
export function writeSinexNeq(
  neq: NormalEquations,
  meta: SinexWriteMeta
): string {
  const n = neq.params.length;
  const L = header(meta, neq.params, neq.dataStartMs, neq.dataEndMs, '2');
  statistics(L, [
    ['NUMBER OF OBSERVATIONS', neq.nObs],
    ['NUMBER OF UNKNOWNS', n + neq.nPreEliminated],
    ['NUMBER OF DEGREES OF FREEDOM', neq.nObs - n - neq.nPreEliminated],
    ['PHASE MEASUREMENTS SIGMA', neq.sigma0Apriori],
    ['WEIGHTED SQUARE SUM OF O-C', neq.ltpl],
    ...(meta.statistics ?? []),
  ]);
  paramBlock(
    L,
    'SOLUTION/APRIORI',
    '__APRIORI VALUE______',
    neq.params,
    (i) => neq.params[i]!.apriori,
    () => 0,
    '2'
  );
  paramBlock(
    L,
    'SOLUTION/NORMAL_EQUATION_VECTOR',
    '__RIGHT_HAND_SIDE____',
    neq.params,
    (i) => neq.b[i]!,
    null,
    '2'
  );
  matrixBlock(L, 'SOLUTION/NORMAL_EQUATION_MATRIX L', n, neq.N);
  L.push('%ENDSNX');
  return L.join('\n') + '\n';
}

/**
 * A solution with its full covariance as SINEX 2.02: SOLUTION/ESTIMATE,
 * /APRIORI, /MATRIX_ESTIMATE L COVA (every cross-covariance) and, when the
 * solution carries constraints, /MATRIX_APRIORI L COVA — so a reader can
 * remove them again (`sinexToNeq`).
 */
export function writeSinexCovariance(
  sol: {
    params: readonly NeqParameter[];
    estimate: ArrayLike<number>;
    cov: ArrayLike<number>;
    /** Constraint covariance: n×n, or its diagonal (n). */
    aprioriCov?: ArrayLike<number>;
    dataStartMs: number;
    dataEndMs: number;
    nObs?: number;
    nUnknowns?: number;
    sigma0?: number | null;
  },
  meta: SinexWriteMeta
): string {
  const n = sol.params.length;
  const constraint = sol.aprioriCov ? '1' : '2';
  const L = header(
    meta,
    sol.params,
    sol.dataStartMs,
    sol.dataEndMs,
    constraint
  );
  const stats: (readonly [string, number])[] = [];
  if (sol.nObs) stats.push(['NUMBER OF OBSERVATIONS', sol.nObs]);
  if (sol.nUnknowns) stats.push(['NUMBER OF UNKNOWNS', sol.nUnknowns]);
  if (sol.nObs && sol.nUnknowns)
    stats.push(['NUMBER OF DEGREES OF FREEDOM', sol.nObs - sol.nUnknowns]);
  if (sol.sigma0 != null) stats.push(['VARIANCE FACTOR', sol.sigma0 ** 2]);
  stats.push(...(meta.statistics ?? []));
  if (stats.length) statistics(L, stats);
  const ac = sol.aprioriCov;
  const acDiag = ac && ac.length === n;
  paramBlock(
    L,
    'SOLUTION/ESTIMATE',
    '__ESTIMATED VALUE____',
    sol.params,
    (i) => sol.estimate[i]!,
    (i) => Math.sqrt(Math.max(sol.cov[i * n + i]!, 0)),
    constraint
  );
  paramBlock(
    L,
    'SOLUTION/APRIORI',
    '__APRIORI VALUE______',
    sol.params,
    (i) => sol.params[i]!.apriori,
    (i) => (ac ? Math.sqrt(Math.max(acDiag ? ac[i]! : ac[i * n + i]!, 0)) : 0),
    constraint
  );
  matrixBlock(L, 'SOLUTION/MATRIX_ESTIMATE L COVA', n, sol.cov);
  if (ac) matrixBlock(L, 'SOLUTION/MATRIX_APRIORI L COVA', n, ac, !!acDiag);
  L.push('%ENDSNX');
  return L.join('\n') + '\n';
}

// ─── discontinuities ────────────────────────────────────────────────────

/** One solution segment of a site, from a SOLUTION/DISCONTINUITY file. */
export interface SinexDiscontinuity {
  site: string;
  pointCode: string;
  solnId: string;
  /** 'P' position segment, 'V' velocity segment. */
  kind: 'P' | 'V';
  /** -Infinity / Infinity for open ends ("00:000:00000"). */
  startMs: number;
  endMs: number;
  comment: string;
}

/** Parse an IGS/EPN discontinuity file (e.g. EPN_discontinuities.snx). */
export function parseSinexDiscontinuities(text: string): SinexDiscontinuity[] {
  const lines = blocks(text).get('SOLUTION/DISCONTINUITY') ?? [];
  return lines.map((l) => ({
    site: l.slice(1, 5).trim(),
    pointCode: l.slice(6, 8).trim() || 'A',
    solnId: l.slice(9, 13).trim(),
    startMs: parseSinexEpoch(l.slice(16, 28)) ?? -Infinity,
    endMs: parseSinexEpoch(l.slice(29, 41)) ?? Infinity,
    kind: l.slice(42, 43) === 'V' ? 'V' : 'P',
    comment: l.slice(46).trim(),
  }));
}

/** The segment of `site` ('P' or 'V') valid at an epoch, if listed. */
export function discontinuitySolution(
  discs: readonly SinexDiscontinuity[],
  site: string,
  kind: 'P' | 'V',
  tMs: number
): SinexDiscontinuity | undefined {
  return discs.find(
    (d) =>
      d.site === site && d.kind === kind && d.startMs <= tMs && tMs < d.endMs
  );
}

// ─── reference coordinates ──────────────────────────────────────────────

/** A coordinate solution (position + velocity) with its validity. */
export interface SscCoordinate {
  site: string;
  domes: string;
  solnId: string;
  xyz: [number, number, number];
  vel: [number, number, number];
  sigmaXyz: [number, number, number];
  sigmaVel: [number, number, number];
  /** Reference epoch of the position (ms). */
  epochMs: number;
  /** Data span of the solution; -Infinity/Infinity when open. */
  startMs: number;
  endMs: number;
}

/**
 * Parse an SSC file (ITRF / IGS / EPN cumulative solutions, e.g.
 * EUR0OPSSNX_…_SOL.SSC): two lines per solution — position with σ, soln
 * number, data start/end and reference epoch; then the velocity.
 */
export function parseSsc(text: string): SscCoordinate[] {
  const out: SscCoordinate[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const l = lines[i]!;
    if (!/^\d{5}[MS]\d{3}\s/.test(l)) continue;
    const f = l.trim().split(/\s+/);
    if (f.length < 12) continue;
    const ep = f.slice(-3);
    const nums = f.slice(-10, -3).map(Number);
    if (nums.some((v) => !Number.isFinite(v))) continue;
    const v = lines[i + 1]!.trim().split(/\s+/);
    if (v[0] !== f[0] || v.length < 7) continue;
    const vn = v.slice(1, 7).map(Number);
    const site = f[f.length - 11]!;
    out.push({
      site: site.slice(0, 4),
      domes: f[0]!,
      solnId: String(nums[6]),
      xyz: [nums[0]!, nums[1]!, nums[2]!],
      sigmaXyz: [nums[3]!, nums[4]!, nums[5]!],
      vel: [vn[0]!, vn[1]!, vn[2]!],
      sigmaVel: [vn[3]!, vn[4]!, vn[5]!],
      startMs: parseSinexEpoch(ep[0]!) ?? -Infinity,
      endMs: parseSinexEpoch(ep[1]!) ?? Infinity,
      epochMs: parseSinexEpoch(ep[2]!) ?? 0,
    });
    i++;
  }
  return out;
}

/**
 * Coordinate solutions of a SINEX file (STA* + VEL* per site and solution
 * id, e.g. IGS20.snx), with each solution's validity from a discontinuity
 * file when given (else from SOLUTION/EPOCHS, else open).
 */
export function sinexCoordinates(
  file: SinexFile,
  discontinuities?: readonly SinexDiscontinuity[]
): SscCoordinate[] {
  const m = new Map<string, SscCoordinate>();
  for (const p of file.estimate) {
    const k = ['STAX', 'STAY', 'STAZ', 'VELX', 'VELY', 'VELZ'].indexOf(p.type);
    if (k < 0) continue;
    const key = `${p.site}|${p.pointCode}|${p.solnId}`;
    let c = m.get(key);
    if (!c) {
      const d = discontinuities?.find(
        (x) => x.site === p.site && x.kind === 'P' && x.solnId === p.solnId
      );
      const ep = file.epochs.find(
        (x) => x.site === p.site && x.solnId === p.solnId
      );
      m.set(
        key,
        (c = {
          site: p.site,
          domes: file.sites.find((s) => s.site === p.site)?.domes ?? '',
          solnId: p.solnId,
          xyz: [0, 0, 0],
          vel: [0, 0, 0],
          sigmaXyz: [0, 0, 0],
          sigmaVel: [0, 0, 0],
          epochMs: p.refEpochMs,
          startMs: d?.startMs ?? ep?.startMs ?? -Infinity,
          endMs: d?.endMs ?? ep?.endMs ?? Infinity,
        })
      );
    }
    if (k < 3) {
      c.xyz[k] = p.value;
      c.sigmaXyz[k] = p.sigma;
      c.epochMs = p.refEpochMs;
    } else {
      c.vel[k - 3] = p.value;
      c.sigmaVel[k - 3] = p.sigma;
    }
  }
  return [...m.values()];
}
