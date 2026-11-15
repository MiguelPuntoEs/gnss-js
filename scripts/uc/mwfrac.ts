/**
 * Wide-lane check of a product's satellite biases at one receiver: per
 * continuous arc, the Melbourne–Wübbena average after removing the
 * satellites' code and phase OSBs, differenced between satellites of the
 * same group (default constellation; GROUP=bds-maker splits BeiDou-3 by
 * manufacturer). With consistent biases the differences are integers.
 *
 *   node mwfrac.mjs obs bia [system] [bands] [atx]
 */
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { parseRinexStream } from '../../src/rinex';
import { parseBiasSinex, SatOsbTable } from '../../src/rinex/bias-sinex';
import { FREQ } from '../../src/constants/gnss';
import {
  builtinSatelliteBlocks,
  clockGroupFromBlocks,
} from '../../src/positioning/clock-groups';

const C = 299792458;
const [obsP, biaP, sys = 'C', bandsS = '15'] = process.argv.slice(2);
const txt = (p: string) => {
  const b = readFileSync(p);
  return (b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b).toString(
    'latin1'
  );
};
const osb = new SatOsbTable(parseBiasSinex(txt(biaP!)));
const [b1, b2] = [bandsS[0]!, bandsS[1]!];
const f1 = FREQ[sys]![b1]!;
const f2 = FREQ[sys]![b2]!;
const lw = C / (f1 - f2);

let bytes: Uint8Array = new Uint8Array(readFileSync(obsP!));
let name = obsP!.split('/').pop()!;
if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
  bytes = new Uint8Array(gunzipSync(bytes));
  name = name.replace(/\.gz$/, '');
}
const series = new Map<string, [number, number][]>();
let t0 = 0;
await parseRinexStream(
  new File([bytes as BlobPart], name),
  undefined,
  undefined,
  (t, prn, codes, values) => {
    if (prn[0] !== sys) return;
    t0 ||= t;
    const get = (type: string, band: string) => {
      for (const a of 'PXDIQC') {
        const i = codes.indexOf(`${type}${band}${a}`);
        if (i >= 0 && values[i]) return { v: values[i]!, code: `${band}${a}` };
      }
      return null;
    };
    const L1 = get('L', b1);
    const L2 = get('L', b2);
    const P1 = get('C', b1);
    const P2 = get('C', b2);
    if (!L1 || !L2 || !P1 || !P2) return;
    const ob = (o: string) => osb.get(prn, o, t);
    const bl1 = ob('L' + L1.code);
    const bl2 = ob('L' + L2.code);
    const bc1 = ob('C' + P1.code) ?? 0;
    const bc2 = ob('C' + P2.code) ?? 0;
    if (bl1 == null || bl2 == null) return;
    const l1 = L1.v - (bl1 * f1) / C;
    const l2 = L2.v - (bl2 * f2) / C;
    const p1 = P1.v - bc1;
    const p2 = P2.v - bc2;
    const mw = l1 - l2 - (f1 * p1 + f2 * p2) / (f1 + f2) / lw;
    let s = series.get(prn);
    if (!s) series.set(prn, (s = []));
    s.push([t, mw]);
  },
  true
);
const group = process.env.GROUP
  ? clockGroupFromBlocks(builtinSatelliteBlocks(t0), 'bds-maker')
  : (p: string) => p[0]!;

// Arcs: gaps > 60 s or MW jumps > 3 cycles (slips) start a new arc.
interface Arc {
  prn: string;
  t0: number;
  t1: number;
  mean: number;
  n: number;
}
const arcs: Arc[] = [];
for (const [prn, s] of series) {
  let cur: [number, number][] = [];
  const flush = () => {
    if (cur.length >= 40) {
      const v = cur.map((q) => q[1]).sort((a, b) => a - b);
      arcs.push({
        prn,
        t0: cur[0]![0],
        t1: cur[cur.length - 1]![0],
        mean: v[v.length >> 1]!,
        n: cur.length,
      });
    }
    cur = [];
  };
  for (const q of s) {
    const last = cur[cur.length - 1];
    if (last && (q[0] - last[0] > 60e3 || Math.abs(q[1] - last[1]) > 3))
      flush();
    cur.push(q);
  }
  flush();
}
// Between-satellite fractions against every overlapping arc of the same
// group: the receiver's wide-lane bias cancels.
const frac = new Map<string, number[]>();
for (const a of arcs)
  for (const b of arcs) {
    if (a.prn >= b.prn || group(a.prn) !== group(b.prn)) continue;
    if (Math.min(a.t1, b.t1) - Math.max(a.t0, b.t0) < 1800e3) continue;
    const d = a.mean - b.mean;
    const f = d - Math.round(d);
    for (const p of [a.prn, b.prn]) {
      const l = frac.get(p) ?? [];
      l.push(Math.abs(f));
      frac.set(p, l);
    }
  }
const rows = [...frac].sort().map(([p, l]) => {
  l.sort((x, y) => x - y);
  return `${p}(${group(p)}) med|frac| ${l[l.length >> 1]!.toFixed(2)} n${l.length}`;
});
console.log(rows.join('\n'));
