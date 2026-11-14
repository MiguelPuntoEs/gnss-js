// Oracle B: combine the LACs' weekly SINEX (NEQ blocks, or
// covariance files un-constrained) like the EUREF combination — rescale each
// AC by its own variance factor, stack, reject AC-station outliers by
// comparison with the combination, NNT on IGS20 — vs the official EUR0 weekly.
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import * as an from '../../dist/analysis.js';
import * as rinex from '../../dist/rinex.js';
import {
  DATA,
  readText,
  igs20,
  c2415,
  neu,
  median,
  rms,
  stationsOf,
  eurefDatumStations,
} from './common.mjs';

const week = Number(process.argv[2] ?? 2297);
const weighting = process.env.WEIGHTING ?? 'vf'; // 'vf' | 'raw'
// Per-AC Helmert parameters, pre-eliminated: 'none' | 'translation' | 'rigid' | 'similarity'.
const perAc = process.env.HELMERT ?? 'none';
const maxIter = Number(process.env.ITER ?? 6);
const dir = join(DATA, String(week));
const files = readdirSync(dir).filter((f) =>
  /^[A-Z]{3}0EPNFIN_\d+_07D_07D_SOL\.SNX$/.test(f)
);
const weeklyName = readdirSync(dir).find((f) =>
  /^EUR0OPSSNX_\d+_07D_07D_SOL\.SNX$/.test(f)
);
const weekly = rinex.parseSinex(readText(join(dir, weeklyName)));
const W = new Map();
for (const p of weekly.estimate) {
  const k = ['STAX', 'STAY', 'STAZ'].indexOf(p.type);
  if (k < 0) continue;
  if (!W.has(p.site)) W.set(p.site, { xyz: [0, 0, 0], epochMs: p.refEpochMs });
  W.get(p.site).xyz[k] = p.value;
}
const refs = igs20();
const ssc = c2415();
const latest = (list) => {
  const m = new Map();
  for (const r of list)
    if (!m.has(r.site) || r.endMs > m.get(r.site).endMs) m.set(r.site, r);
  return m;
};
const v1 = latest(refs),
  v2 = latest(ssc);
const vel = (s) => (v1.get(s) ?? v2.get(s))?.vel;
const sumText = readText(join(dir, weeklyName.replace('_SOL.SNX', '_SUM.SUM')));
const datumSites = eurefDatumStations(sumText).map((d) => d.site);
const datumOpts = {
  reference: refs,
  sites: datumSites,
  position:
    (process.env.HELMERT ?? 'none') === 'none'
      ? 'translation'
      : process.env.HELMERT,
  maxResidualHorizontalM: 0.01,
  maxResidualVerticalM: 0.015,
  latestReference: true,
};

// Each AC: NEQ (station coordinates only), moved to the weekly epochs.
const acs = [];
for (const f of files) {
  const ac = f.slice(0, 3);
  let q = rinex.sinexToNeq(rinex.parseSinex(readText(join(dir, f))), {
    types: ['STAX', 'STAY', 'STAZ'],
  });
  q = an.moveToEpoch(
    q,
    (p) => W.get(p.site)?.epochMs ?? p.refEpochMs,
    (s) => vel(s)
  );
  // Its own minimum-constraint solution: σ̂0 for the weights, estimates for the outlier test.
  let own;
  try {
    own = an.solveWithDatum(q, {
      ...datumOpts,
      iterate: false,
      minStations: 1,
    });
  } catch (e) {
    console.log(ac, 'own solve failed', e.message);
    continue;
  }
  const vf = own.sigma0 ? (own.sigma0 / q.sigma0Apriori) ** 2 : 1;
  acs.push({ ac, q, vf, own });
  console.log(
    `${ac}: ${q.params.length / 3} stations, σ0 apriori ${q.sigma0Apriori}, σ̂0/σ0 ${Math.sqrt(vf).toFixed(3)}, dof ${own.dof}`
  );
}
// Rescale each AC: unit weight of its own fit ('vf'), as combinations
// of AC NEQs do; 'raw' stacks them as delivered.
const scaled = (a) =>
  weighting === 'vf'
    ? an.scaleNeq(a.q, 1 / a.vf / a.q.sigma0Apriori ** 2)
    : a.q;
const removed = new Map(acs.map((a) => [a.ac, new Set()]));
let comb;
for (let it = 0; it < maxIter; it++) {
  const parts = acs.map((a) => {
    const s = { ...scaled(a), sigma0Apriori: 1 };
    const rm = removed.get(a.ac);
    let x = rm.size ? an.preEliminate(s, (p) => rm.has(p.site)) : s;
    if (perAc !== 'none')
      x = an.preEliminate(an.withHelmertParameters(x, perAc, a.ac), (p) =>
        p.type.startsWith('HLM')
      );
    return x;
  });
  comb = an.solveWithDatum(an.stackNeqs(parts), datumOpts);
  // Compare each AC with the combination (7-parameter Helmert) and drop
  // station outliers > 5 mm horizontal / 15 mm vertical, worst per AC.
  const C = stationsOf(comb.params, comb.estimate);
  let changed = 0;
  for (const a of acs) {
    const S = stationsOf(a.own.params, a.own.estimate);
    const sites = [...S.keys()].filter(
      (s) => C.has(s) && !removed.get(a.ac).has(s)
    );
    const h = an.estimateHelmert(
      sites.map((s) => S.get(s).xyz),
      sites.map((s) => C.get(s).xyz),
      { model: 'similarity', maxResidualM: Infinity }
    );
    let worst = null;
    h.residuals.forEach((d, i) => {
      const r = neu(C.get(sites[i]).xyz, d);
      const score = Math.max(
        Math.hypot(r[0], r[1]) / 0.005,
        Math.abs(r[2]) / 0.015
      );
      if (score > 1 && (!worst || score > worst.score))
        worst = { score, site: sites[i] };
    });
    if (worst) {
      removed.get(a.ac).add(worst.site);
      changed++;
    }
  }
  console.log(
    `iteration ${it}: σ0 ${comb.sigma0?.toFixed(3)}, outliers removed so far ${[...removed.values()].reduce((s, x) => s + x.size, 0)}`
  );
  if (!changed) break;
}
console.log(
  'datum rejected:',
  comb.datum
    .filter((d) => !d.used)
    .map((d) => d.site)
    .join(' ') || '-'
);
const est = stationsOf(comb.params, comb.estimate);
const rows = [];
for (const [site, s] of est) {
  const w = W.get(site);
  if (w)
    rows.push({
      site,
      r: neu(
        w.xyz,
        s.xyz.map((v, k) => v - w.xyz[k])
      ).map((v) => v * 1000),
      xyz: s.xyz,
      w: w.xyz,
    });
}
const f = (a) =>
  `med ${median(a.map(Math.abs)).toFixed(2)} rms ${rms(a).toFixed(2)}`;
console.log(
  `vs EUR0 weekly: ${rows.length} common stations (EUR0 ${W.size}, ours ${est.size}), mm, no Helmert`
);
console.log(
  `  N ${f(rows.map((x) => x.r[0]))} | E ${f(rows.map((x) => x.r[1]))} | U ${f(rows.map((x) => x.r[2]))}`
);
for (const model of ['translation', 'similarity']) {
  const h = an.estimateHelmert(
    rows.map((x) => x.xyz),
    rows.map((x) => x.w),
    { model, maxResidualM: Infinity, minRefs: 3 }
  );
  const r2 = h.residuals.map((d, i) => neu(rows[i].w, d).map((v) => v * 1000));
  console.log(
    `  after ${model} (t mm ${h.t.map((v) => (v * 1000).toFixed(2)).join(' ')}, scale ${(h.d * 1e9).toFixed(2)} ppb): N ${f(r2.map((x) => x[0]))} | E ${f(r2.map((x) => x[1]))} | U ${f(r2.map((x) => x[2]))}`
  );
}
const big = rows.filter(
  (x) => Math.abs(x.r[2]) > 3 || Math.hypot(x.r[0], x.r[1]) > 1.5
);
console.log(
  `  stations > 1.5 mm horizontal or 3 mm up: ${big.length}`,
  big
    .slice(0, 12)
    .map((x) => `${x.site}(${x.r.map((v) => v.toFixed(1)).join('/')})`)
    .join(' ')
);
