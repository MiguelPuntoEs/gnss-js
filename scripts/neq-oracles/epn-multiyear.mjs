// Oracle C: multi-year combination of EUR0 weekly solutions (IGS20 era) into
// positions + velocities with the EPN discontinuities, per-week Helmert
// parameters and NNT/NNR/NNS on C2415 — velocities vs the EPN cumulative
// solution C2415.
import { join } from 'node:path';
import {
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import * as an from '../../dist/analysis.js';
import * as rinex from '../../dist/rinex.js';
import { DATA, readText, c2415, neu, median, rms } from './common.mjs';

const maxStations = Number(process.env.MAX_STATIONS ?? 100);
const periodic = process.env.PERIODIC ?? 'annual+semiannual';
const helmert = process.env.HELMERT ?? 'similarity';
const wdir = join(DATA, 'weekly');
const files = readdirSync(wdir)
  .filter((f) => f.endsWith('_SOL.SNX.gz'))
  .sort()
  .map((f) => f.replace(/\.gz$/, ''));
const ssc = c2415();
const disc = rinex.parseSinexDiscontinuities(
  readText(join(DATA, 'C2415', 'EPN_discontinuities.snx'))
);
const t0 = Date.UTC(2020, 0, 1);
const T = Date.now();
// Pass 1: parse each week, reduce it (Schur) to the station subset —
// cached as SINEX NEQ so reruns skip the 1179-parameter un-constraining.
const cacheDir = join(DATA, 'weekly-reduced');
mkdirSync(cacheDir, { recursive: true });
const metaPath = join(cacheDir, 'meta.json');
let subset, weeks;
if (existsSync(metaPath)) {
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  subset = meta.subset;
  weeks = meta.weeks.map((w) => ({
    ...w,
    est: new Map(w.est),
    neq: rinex.sinexToNeq(
      rinex.parseSinex(readFileSync(join(cacheDir, w.f), 'utf8'))
    ),
  }));
} else {
  const full = [];
  for (const f of files) {
    const file = rinex.parseSinex(readText(join(wdir, f)));
    const neq = rinex.sinexToNeq(file, { types: ['STAX', 'STAY', 'STAZ'] });
    const est = new Map();
    for (const p of file.estimate) {
      const k = ['STAX', 'STAY', 'STAZ'].indexOf(p.type);
      if (k < 0) continue;
      if (!est.has(p.site))
        est.set(p.site, { xyz: [0, 0, 0], t: p.refEpochMs });
      est.get(p.site).xyz[k] = p.value;
    }
    full.push({ f, neq, est });
    process.stdout.write('.');
  }
  // Station subset: in ≥ 90 % of the weeks and in C2415.
  const count = new Map();
  for (const w of full)
    for (const s of w.est.keys()) count.set(s, (count.get(s) ?? 0) + 1);
  const inC = new Set(ssc.map((r) => r.site));
  subset = [...count]
    .filter(([s, c]) => c >= 0.9 * full.length && inC.has(s))
    .map(([s]) => s)
    .sort();
  if (subset.length > maxStations) {
    const k = subset.length / maxStations;
    subset = subset
      .filter((_, i) => Math.floor(i % k) === 0)
      .slice(0, maxStations);
  }
  const keep0 = new Set(subset);
  weeks = full.map((w) => ({
    ...w,
    neq: an.preEliminate(w.neq, (p) => !keep0.has(p.site)),
  }));
  for (const w of weeks)
    writeFileSync(
      join(cacheDir, w.f),
      rinex.writeSinexNeq(w.neq, { agency: 'EUR' })
    );
  writeFileSync(
    metaPath,
    JSON.stringify({
      subset,
      weeks: weeks.map((w) => ({ f: w.f, est: [...w.est] })),
    })
  );
}
console.log(
  `\n${weeks.length} weekly solutions, ${subset.length} stations, ${((Date.now() - T) / 1000).toFixed(0)} s`
);
const keep = new Set(subset);
const reduced = weeks;
const refs = ssc.filter((r) => keep.has(r.site));
// The C2415 solution for each segment as a-priori (else first week's value).
const segOf = (site, kind, t) =>
  rinex.discontinuitySolution(disc, site, kind, t);
const aprioriFor = (site, pSoln) => {
  const d = disc.find(
    (x) => x.site === site && x.kind === 'P' && x.solnId === pSoln
  );
  if (!d) return undefined;
  const mid = Math.max(d.startMs, Date.UTC(2022, 10, 1));
  const r =
    refs.find(
      (x) =>
        x.site === site &&
        x.startMs <= mid + 30 * 864e5 &&
        mid - 30 * 864e5 <= x.endMs
    ) ?? refs.filter((x) => x.site === site).at(-1);
  return r ? { xyz: r.xyz, vel: r.vel } : undefined;
};

function combine(removed) {
  const comb = new an.NeqCombination({
    epochMs: t0,
    segments: disc,
    periodic,
    helmertPerSolution: helmert,
    apriori: (site, pSoln) => aprioriFor(site, pSoln),
  });
  reduced.forEach((w, i) => {
    const rm = removed.get(i);
    comb.add(rm ? an.preEliminate(w.neq, (p) => rm.has(p.site)) : w.neq);
  });
  const q = comb.result();
  return an.solveWithDatum(q, {
    reference: refs,
    position: helmert === 'none' ? 'translation' : helmert,
    velocity: helmert === 'none' ? 'translation' : helmert,
    maxResidualHorizontalM: 0.005,
    maxResidualVerticalM: 0.015,
    maxVelocityResidualHorizontal: 0.0005,
    maxVelocityResidualVertical: 0.0015,
    latestReference: true,
    minStations: 10,
  });
}

let removed = new Map();
let sol;
for (let pass = 0; pass < 3; pass++) {
  const T1 = Date.now();
  sol = combine(removed);
  console.log(
    `pass ${pass}: n=${sol.params.length}, σ0=${sol.sigma0?.toFixed(3)}, datum ${sol.datum.filter((d) => d.used).length}/${sol.datum.length}, ${((Date.now() - T1) / 1000).toFixed(0)} s`
  );
  // Residuals of each week's own estimates vs the model (7-par Helmert per
  // week); drop station-weeks beyond 10 mm horizontal / 25 mm up.
  const idx = new Map(
    sol.params.map((p, i) => [`${p.type}|${p.site}|${p.solnId}`, i])
  );
  const model = (site, t) => {
    const pS = segOf(site, 'P', t)?.solnId ?? '1',
      vS = segOf(site, 'V', t)?.solnId ?? '1';
    const dt = (t - t0) / an.MS_PER_YEAR;
    return ['X', 'Y', 'Z'].map((ax) => {
      const g = (ty, s) => {
        const i = idx.get(`${ty}|${site}|${s}`);
        return i === undefined ? 0 : sol.estimate[i];
      };
      let v = g(`STA${ax}`, pS) + g(`VEL${ax}`, vS) * dt;
      for (const h of [1, 2])
        v +=
          g(`S${h}${ax}`, '1') * Math.sin(2 * Math.PI * h * dt) +
          g(`C${h}${ax}`, '1') * Math.cos(2 * Math.PI * h * dt);
      return v;
    });
  };
  const next = new Map();
  let n = 0;
  reduced.forEach((w, i) => {
    const sites = subset.filter((s) => w.est.has(s));
    const from = sites.map((s) => w.est.get(s).xyz);
    const to = sites.map((s) => model(s, w.est.get(s).t));
    const h = an.estimateHelmert(from, to, {
      model: 'similarity',
      maxResidualM: Infinity,
    });
    h.residuals.forEach((d, k) => {
      const r = neu(to[k], d);
      if (Math.hypot(r[0], r[1]) > 0.01 || Math.abs(r[2]) > 0.025) {
        if (!next.has(i)) next.set(i, new Set());
        next.get(i).add(sites[k]);
        n++;
      }
    });
  });
  console.log(`  station-weeks beyond 10/25 mm: ${n}`);
  if (n === [...removed.values()].reduce((s, x) => s + x.size, 0)) break;
  removed = next;
}

// Velocities vs C2415 (the solution valid in 2024), N/E/U mm/yr.
const out = [];
const at = Date.UTC(2024, 6, 1);
for (const site of subset) {
  const vS = segOf(site, 'V', at)?.solnId ?? '1';
  const vi = ['X', 'Y', 'Z'].map((ax) =>
    sol.params.findIndex(
      (p) => p.site === site && p.type === `VEL${ax}` && p.solnId === vS
    )
  );
  if (vi.some((i) => i < 0)) continue;
  const r =
    refs.find((x) => x.site === site && x.startMs <= at && at <= x.endMs) ??
    refs.filter((x) => x.site === site).at(-1);
  if (!r) continue;
  const dv = neu(
    r.xyz,
    vi.map((i, k) => sol.estimate[i] - r.vel[k])
  ).map((v) => v * 1000);
  const datum = sol.datum.find((d) => d.site === site && d.used);
  out.push({ site, dv, datum: !!datum });
}
const f = (a) =>
  `med ${median(a.map(Math.abs)).toFixed(2)} rms ${rms(a).toFixed(2)}`;
for (const [label, set] of [
  ['all', out],
  ['datum', out.filter((x) => x.datum)],
  ['non-datum', out.filter((x) => !x.datum)],
]) {
  if (!set.length) continue;
  console.log(
    `velocity − C2415 (${label}, ${set.length} stations, mm/yr): N ${f(set.map((x) => x.dv[0]))} | E ${f(set.map((x) => x.dv[1]))} | U ${f(set.map((x) => x.dv[2]))}`
  );
}
const hz = out.map((x) => Math.hypot(x.dv[0], x.dv[1]));
console.log(
  `horizontal |Δv|: median ${median(hz).toFixed(2)} mm/yr, ≤0.2: ${hz.filter((v) => v <= 0.2).length}/${hz.length}`
);
console.log(
  'worst:',
  out
    .sort((a, b) => Math.hypot(b.dv[0], b.dv[1]) - Math.hypot(a.dv[0], a.dv[1]))
    .slice(0, 8)
    .map((x) => `${x.site}(${x.dv.map((v) => v.toFixed(2)).join('/')})`)
    .join(' ')
);
