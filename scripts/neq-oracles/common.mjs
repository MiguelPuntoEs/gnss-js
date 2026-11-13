// Shared helpers for the NEQ oracle scripts (run after `pnpm build`).
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as rinex from '../../dist/rinex.js';

export const DATA =
  process.env.NEQ_DATA ?? join(homedir(), '.cache', 'neq-oracle-data');

export function readText(path) {
  if (existsSync(path)) return readFileSync(path, 'latin1');
  if (existsSync(path + '.gz'))
    return gunzipSync(readFileSync(path + '.gz')).toString('latin1');
  throw new Error(`missing ${path}`);
}

/** IGS20 reference coordinates (positions + velocities, soln windows). */
export function igs20() {
  const est = rinex.parseSinex(readText(join(DATA, 'IGS20', 'IGS20_est.snx')));
  const disc = rinex.parseSinexDiscontinuities(
    readText(join(DATA, 'IGS20', 'soln_IGS20.snx'))
  );
  return rinex.sinexCoordinates(est, disc);
}

export function c2415() {
  return rinex.parseSsc(
    readText(join(DATA, 'C2415', 'EUR0OPSSNX_1996001_2026115_00U_SOL.SSC'))
  );
}

/** ECEF difference → North, East, Up (m) at x. */
export function neu(x, d) {
  const lon = Math.atan2(x[1], x[0]);
  const lat = Math.atan2(x[2], Math.hypot(x[0], x[1]) * (1 - 0.00669438));
  const sl = Math.sin(lat), cl = Math.cos(lat), so = Math.sin(lon), co = Math.cos(lon);
  return [
    -sl * co * d[0] - sl * so * d[1] + cl * d[2],
    -so * d[0] + co * d[1],
    cl * co * d[0] + cl * so * d[1] + sl * d[2],
  ];
}

export const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN;
};
export const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

/** Station positions (X, Y, Z at the param epoch) of a solution keyed by site|soln. */
export function stationsOf(params, estimate) {
  const m = new Map();
  params.forEach((p, i) => {
    const k = ['STAX', 'STAY', 'STAZ'].indexOf(p.type);
    if (k < 0) return;
    const key = p.site;
    if (!m.has(key)) m.set(key, { xyz: [0, 0, 0], epochMs: p.refEpochMs, idx: [0, 0, 0] });
    m.get(key).xyz[k] = estimate[i];
    m.get(key).idx[k] = i;
  });
  return m;
}

/** The 42 IGS20 datum stations of the EUREF weekly report (Table 2.2). */
export function eurefDatumStations(sumText) {
  const out = [];
  for (const l of sumText.split(/\r?\n/)) {
    const f = l.trim().split(/\s+/);
    if (/^[A-Z0-9]{4}00[A-Z]{3}$/.test(f[0] ?? '') && f.length >= 9 && /^[+X-]{7}$/.test(f[2]))
      out.push({ site: f[0].slice(0, 4), rejected: f[9] === 'R', neu: f.slice(6, 9).map(Number) });
  }
  return out;
}

/** Station-days EUREF excluded from the weekly stack ("X" in Table 2.2). */
export function eurefExcludedDays(sumText) {
  const out = new Map();
  for (const l of sumText.split(/\r?\n/)) {
    const f = l.trim().split(/\s+/);
    if (/^[A-Z0-9]{4}00[A-Z]{3}$/.test(f[0] ?? '') && /^[+X-]{7}$/.test(f[2] ?? '')) {
      const days = [...f[2]].flatMap((c, i) => (c === 'X' ? [i] : []));
      if (days.length) out.set(f[0].slice(0, 4), days);
    }
  }
  return out;
}
