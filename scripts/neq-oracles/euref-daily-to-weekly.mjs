// Oracle A: the 7 EUREF combined daily SINEX of a week, un-constrained,
// stacked and NNT-aligned to IGS20 like EUREF, vs the official EUR0 weekly.
import { join } from 'node:path';
import * as an from '../../dist/analysis.js';
import * as rinex from '../../dist/rinex.js';
import {
  DATA,
  readText,
  igs20,
  neu,
  median,
  rms,
  stationsOf,
  eurefDatumStations,
  eurefExcludedDays,
} from './common.mjs';

const week = Number(process.argv[2] ?? 2297);
const dir = join(DATA, String(week));
const t0 = Date.UTC(1980, 0, 6) + week * 7 * 86400000;
const name = (t, span) => {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const doy = Math.floor((t - Date.UTC(y, 0, 1)) / 86400000) + 1;
  return `EUR0OPSSNX_${y}${String(doy).padStart(3, '0')}0000_${span}_${span}_SOL.SNX`;
};
const T = Date.now();
const daily = [];
for (let d = 0; d < 7; d++) {
  const f = rinex.parseSinex(
    readText(join(dir, name(t0 + d * 86400000, '01D')))
  );
  daily.push(rinex.sinexToNeq(f));
}
console.log(
  `parsed+unconstrained 7 daily in ${((Date.now() - T) / 1000).toFixed(1)} s; n =`,
  daily.map((q) => q.params.length).join(' ')
);
const weeklyFile = rinex.parseSinex(readText(join(dir, name(t0, '07D'))));
const W = new Map();
for (const p of weeklyFile.estimate) {
  const k = ['STAX', 'STAY', 'STAZ'].indexOf(p.type);
  if (k < 0) continue;
  if (!W.has(p.site))
    W.set(p.site, {
      xyz: [0, 0, 0],
      epochMs: p.refEpochMs,
      apriori: [0, 0, 0],
    });
  W.get(p.site).xyz[k] = p.value;
}
for (const p of weeklyFile.apriori) {
  const k = ['STAX', 'STAY', 'STAZ'].indexOf(p.type);
  if (k >= 0 && W.has(p.site)) W.get(p.site).apriori[k] = p.value;
}
// Velocities to move the daily coordinates to the weekly epoch: IGS20, else
// the station's own a-priori drift is unknown → take C2415-free fallback 0.
const refs = igs20();
const velOf = new Map();
for (const r of refs)
  if (!velOf.has(r.site) || r.endMs > velOf.get(r.site).endMs)
    velOf.set(r.site, r);
import('./common.mjs').then(async ({ c2415 }) => {
  const ssc = c2415();
  const sscVel = new Map();
  for (const r of ssc)
    if (!sscVel.has(r.site) || r.endMs > sscVel.get(r.site).endMs)
      sscVel.set(r.site, r);
  const vel = (site) => (velOf.get(site) ?? sscVel.get(site))?.vel;
  // Each station to its weekly epoch (as EUR0 tabulates it).
  const sumText0 = readText(
    join(dir, name(t0, '07D').replace('_SOL.SNX', '_SUM.SUM'))
  );
  const excl = process.argv.includes('--keep-outliers')
    ? new Map()
    : eurefExcludedDays(sumText0);
  console.log(
    `excluding ${[...excl.values()].reduce((s, d) => s + d.length, 0)} station-days EUREF flagged`
  );
  // Deleting a station-day from a NEQ = pre-eliminating its coordinates.
  const cleaned = daily.map((q, d) =>
    an.preEliminate(q, (p) => (excl.get(p.site) ?? []).includes(d))
  );
  const moved = cleaned.map((q) =>
    an.moveToEpoch(
      q,
      (p) => W.get(p.site)?.epochMs ?? p.refEpochMs,
      (s) => vel(s)
    )
  );
  const T1 = Date.now();
  const stacked = an.stackNeqs(moved);
  console.log(
    `stacked n=${stacked.params.length} in ${((Date.now() - T1) / 1000).toFixed(1)} s`
  );

  const sumText = readText(
    join(dir, name(t0, '07D').replace('_SOL.SNX', '_SUM.SUM'))
  );
  const datum = eurefDatumStations(sumText);
  const mode = process.argv[3] ?? 'nnt';
  const T2 = Date.now();
  let sol;
  if (mode === 'free') {
    sol = an.solveNeq(stacked); // relies on the NNT left inside the daily covariances
  } else {
    sol = an.solveWithDatum(stacked, {
      reference: refs.map((r) => ({ ...r })),
      sites: datum.map((d) => d.site),
      position: 'translation',
      maxResidualHorizontalM: 0.01,
      maxResidualVerticalM: 0.015,
      latestReference: true,
    });
  }
  console.log(
    `solved in ${((Date.now() - T2) / 1000).toFixed(1)} s, σ0=${sol.sigma0?.toFixed(3)} dof=${sol.dof}`
  );
  if (sol.datum) {
    const rej = sol.datum.filter((d) => !d.used).map((d) => d.site);
    const have = new Set(sol.datum.map((d) => d.site));
    console.log(
      'datum stations without an IGS20 match:',
      datum
        .filter((d) => !have.has(d.site))
        .map((d) => d.site)
        .join(' ')
    );
    console.log(
      `datum: ${sol.datum.filter((d) => d.used).length} used, rejected: ${rej.join(' ') || '-'} (EUREF rejected: ${datum
        .filter((d) => d.rejected)
        .map((d) => d.site)
        .join(' ')})`
    );
    // Residuals vs EUREF's table (N, E, U mm).
    const diffs = [];
    for (const d of sol.datum) {
      const e = datum.find((x) => x.site === d.site);
      const r = neu(
        W.get(d.site)?.xyz ?? [1, 0, 0],
        d.residual.map((v) => -v)
      ).map((v) => v * 1000);
      if (e) diffs.push(r.map((v, k) => v - e.neu[k]));
      if (e && process.env.VERBOSE)
        console.log(
          d.site,
          d.used ? ' ' : 'R',
          r.map((v) => v.toFixed(1)).join(' '),
          '| EUREF',
          e.neu.join(' ')
        );
    }
    console.log(
      'datum residuals − EUREF table (N E U mm): max |Δ|',
      [0, 1, 2]
        .map((k) => Math.max(...diffs.map((d) => Math.abs(d[k]))).toFixed(2))
        .join(' ')
    );
  }
  const est = stationsOf(sol.params, sol.estimate);
  const dN = [],
    dE = [],
    dU = [];
  let worst = null;
  for (const [site, s] of est) {
    const w = W.get(site);
    if (!w) continue;
    const r = neu(
      w.xyz,
      s.xyz.map((v, k) => v - w.xyz[k])
    ).map((v) => v * 1000);
    dN.push(r[0]);
    dE.push(r[1]);
    dU.push(r[2]);
    const m = Math.hypot(...r);
    if (!worst || m > worst.m) worst = { site, m, r };
  }
  const f = (a) =>
    `med ${median(a.map(Math.abs)).toFixed(3)} rms ${rms(a).toFixed(3)} max ${Math.max(...a.map(Math.abs)).toFixed(3)}`;
  console.log(
    `vs EUR0 weekly (${dN.length} stations, mm, no Helmert):\n  N ${f(dN)}\n  E ${f(dE)}\n  U ${f(dU)}`
  );
  {
    const from = [],
      to = [],
      sites = [];
    for (const [site, s] of est) {
      const w = W.get(site);
      if (w) {
        from.push(s.xyz);
        to.push(w.xyz);
        sites.push(site);
      }
    }
    for (const model of ['translation', 'similarity']) {
      const h = an.estimateHelmert(from, to, {
        model,
        maxResidualM: Infinity,
        minRefs: 3,
      });
      const r = h.residuals.map((d, i) => neu(to[i], d).map((v) => v * 1000));
      const g = (k) =>
        `med ${median(r.map((x) => Math.abs(x[k]))).toFixed(3)} rms ${rms(r.map((x) => x[k])).toFixed(3)}`;
      console.log(
        `after ${model} Helmert (t mm ${h.t.map((v) => (v * 1000).toFixed(2)).join(' ')}, scale ppb ${(h.d * 1e9).toFixed(3)}): N ${g(0)} | E ${g(1)} | U ${g(2)}`
      );
    }
  }
  console.log('worst', worst.site, worst.r.map((v) => v.toFixed(3)).join(' '));
  // σ comparison
  const sigRatio = [];
  for (const p of weeklyFile.estimate) {
    if (p.type !== 'STAZ') continue;
    const s = est.get(p.site);
    if (s)
      sigRatio.push(
        Math.sqrt(sol.cov[s.idx[2] * sol.params.length + s.idx[2]]) / p.sigma
      );
  }
  console.log('σ(Z) ours/EUR0: median', median(sigRatio).toFixed(3));
});
