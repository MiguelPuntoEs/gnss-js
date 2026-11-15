/**
 * Between-receiver double differences of carrier phase on a short baseline
 * (two receivers at one site), after removing the geometry with the
 * precise orbit and known coordinates: what is left is an integer plus any
 * receiver tracking bias between satellites. Prints the fractional part of
 * each satellite's double difference against a reference of the same
 * constellation, per band, as a circular mean over the day.
 *
 *   node dd.mjs obsA obsB sp3 xA,yA,zA xB,yB,zB [systems] [bands]
 *
 * bands: JSON per constellation, e.g. '{"C":"15","E":"15","G":"12"}'.
 */
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { parseRinexStream } from '../../src/rinex';
import { parseSp3, sp3Position } from '../../src/rinex/sp3';
import { FREQ } from '../../src/constants/gnss';

const C = 299792458;
const OMEGA = 7.2921151467e-5;
const [aP, bP, sp3P, aS, bS, systems = 'GEC', bandsS = '{}'] =
  process.argv.slice(2);
const bands: Record<string, string> = {
  G: '12',
  E: '15',
  C: '15',
  ...JSON.parse(bandsS),
};
const txt = (p: string) => {
  const b = readFileSync(p);
  return (b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b).toString(
    'latin1'
  );
};
const sp3 = parseSp3(txt(sp3P!));

type Obs = Map<number, Map<string, Record<string, number>>>;
async function load(path: string) {
  let bytes: Uint8Array = new Uint8Array(readFileSync(path));
  let name = path.split('/').pop()!;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = new Uint8Array(gunzipSync(bytes));
    name = name.replace(/\.gz$/, '');
  }
  const obs: Obs = new Map();
  const res = await parseRinexStream(
    new File([bytes as BlobPart], name),
    undefined,
    undefined,
    (t, prn, codes, values) => {
      if (!systems.includes(prn[0]!)) return;
      const rec: Record<string, number> = {};
      codes.forEach((c, i) => {
        const v = values[i];
        if ((c[0] === 'L' || c[0] === 'C') && v) rec[c] = v;
      });
      let e = obs.get(t);
      if (!e) obs.set(t, (e = new Map()));
      e.set(prn, rec);
    },
    true
  );
  return { obs, header: res.header };
}

const A = await load(aP!);
const B = await load(bP!);
// Marker → antenna reference point (up only; same antenna type at both).
const arp = (s: string, h: { antDelta?: number[] }) => {
  const m = s.split(',').map(Number) as [number, number, number];
  const up = h.antDelta?.[0] ?? 0;
  const r = Math.hypot(...m);
  return m.map((v) => v + (up * v) / r) as [number, number, number];
};
const pA = arp(aS!, A.header);
const pB = arp(bS!, B.header);
const clkA = rcvClock(A.obs, pA);
const clkB = rcvClock(B.obs, pB);

/** Receiver clock offset (s) per epoch from GPS pseudoranges: the
 *  nominal epoch is the receiver's time, the true reception time is
 *  t − δ, and δ·(range rate) does not cancel between receivers. */
function rcvClock(obs: Obs, p: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const [t, e] of obs) {
    const v: number[] = [];
    for (const [prn, r] of e) {
      if (prn[0] !== 'G') continue;
      const pr = r.C1C ?? r.C1W;
      const s = sp3Position(sp3, prn, t - 75);
      if (!pr || !s || s.clk == null) continue;
      v.push(
        (pr - Math.hypot(s.x - p[0]!, s.y - p[1]!, s.z - p[2]!)) / C + s.clk
      );
    }
    if (v.length >= 4) out.set(t, v.sort((a, b) => a - b)[v.length >> 1]!);
  }
  return out;
}
const range = (p: readonly number[], prn: string, t: number) => {
  let tau = 0.075;
  let s = sp3Position(sp3, prn, t - tau * 1000);
  for (let k = 0; k < 2 && s; k++) {
    const ang = OMEGA * tau;
    const x = s.x * Math.cos(ang) + s.y * Math.sin(ang);
    const y = -s.x * Math.sin(ang) + s.y * Math.cos(ang);
    const d = Math.hypot(x - p[0]!, y - p[1]!, s.z - p[2]!);
    tau = d / C;
    if (k === 1) return d;
    s = sp3Position(sp3, prn, t - tau * 1000);
  }
  return null;
};
/** First carrier of the band present in both files. */
// CODE=1: pseudoranges (in cycles of the band, for the same machinery).
const OBS = process.env.CODE ? 'C' : 'L';
const phase = (
  ra: Record<string, number>,
  rb: Record<string, number>,
  band: string
) => {
  for (const a of 'PXDCWILQSB') {
    const c = `${OBS}${band}${a}`;
    if (ra[c] !== undefined && rb[c] !== undefined) return [ra[c]!, rb[c]!];
  }
  return null;
};

// Single differences (cycles) per epoch, satellite, band.
const sd = new Map<string, Map<number, number>>();
const grad = new Map<string, Map<number, number[]>>();
for (const [t, ea] of A.obs) {
  const eb = B.obs.get(t);
  if (!eb) continue;
  for (const [prn, ra] of ea) {
    const rb = eb.get(prn);
    if (!rb) continue;
    const cA = clkA.get(t);
    const cB = clkB.get(t);
    if (cA === undefined || cB === undefined) continue;
    const tA = t - cA * 1000;
    const tB = t - cB * 1000;
    const dA = range(pA, prn, tA);
    const dB = range(pB, prn, tB);
    if (dA === null || dB === null) continue;
    for (const band of bands[prn[0]!] ?? '') {
      const ph = phase(ra, rb, band);
      const f = FREQ[prn[0]!]?.[band];
      if (!ph || !f) continue;
      const lam = C / f;
      const key = `${prn}:${band}`;
      let m = sd.get(key);
      if (!m) sd.set(key, (m = new Map()));
      m.set(
        t,
        OBS === 'C'
          ? (ph[0]! - ph[1]!) / lam - (dA - dB) / lam
          : ph[0]! - ph[1]! - (dA - dB) / lam
      );
      // ∂(single difference)/∂(receiver A position), cycles per metre.
      let gm = grad.get(key);
      if (!gm) grad.set(key, (gm = new Map()));
      gm.set(
        t,
        [0, 1, 2].map((i) => {
          const q = [...pA];
          q[i]! += 1;
          return -((range(q, prn, tA) ?? dA) - dA) / lam;
        })
      );
    }
  }
}

if (process.env.MW) {
  // Melbourne–Wübbena per receiver (wide-lane cycles), between-receiver
  // double differences per satellite: geometry-free, so the scatter is
  // code noise + multipath, the mean's fraction a wide-lane bias.
  const mwOf = (r: Record<string, number>, sys: string) => {
    const [b1, b2] = [bands[sys]![0]!, bands[sys]![1]!];
    const f1 = FREQ[sys]?.[b1];
    const f2 = FREQ[sys]?.[b2];
    if (!f1 || !f2) return null;
    const pick = (t: string, b: string) => {
      for (const a of 'PXDCWILQSB')
        if (r[`${t}${b}${a}`]) return r[`${t}${b}${a}`]!;
      return null;
    };
    const L1 = pick('L', b1);
    const L2 = pick('L', b2);
    const P1 = pick('C', b1);
    const P2 = pick('C', b2);
    if (L1 === null || L2 === null || P1 === null || P2 === null) return null;
    const lw = C / (f1 - f2);
    return L1 - L2 - (f1 * P1 + f2 * P2) / (f1 + f2) / lw;
  };
  for (const sys of systems) {
    const per = new Map<string, Map<number, number>>();
    for (const [t, ea] of A.obs) {
      const eb = B.obs.get(t);
      if (!eb) continue;
      for (const [prn, ra] of ea) {
        if (prn[0] !== sys) continue;
        const rb = eb.get(prn);
        if (!rb) continue;
        const a = mwOf(ra, sys);
        const b = mwOf(rb, sys);
        if (a === null || b === null) continue;
        let m = per.get(prn);
        if (!m) per.set(prn, (m = new Map()));
        m.set(t, a - b);
      }
    }
    const ref = [...per.keys()].reduce((p, q) =>
      per.get(q)!.size > per.get(p)!.size ? q : p
    );
    const rows: string[] = [];
    for (const [prn, m] of [...per].sort()) {
      if (prn === ref) continue;
      // Arc-wise (gaps > 60 s) deviations from the arc mean.
      const dev: number[] = [];
      let arc: number[] = [];
      let last = -Infinity;
      const flush = () => {
        if (arc.length >= 20) {
          const mu = arc.reduce((x, y) => x + y, 0) / arc.length;
          for (const v of arc) dev.push(v - mu);
        }
        arc = [];
      };
      for (const t of [...m.keys()].sort((x, y) => x - y)) {
        const r = per.get(ref)!.get(t);
        if (r === undefined) continue;
        if (t - last > 60e3) flush();
        arc.push(m.get(t)! - r);
        last = t;
      }
      flush();
      if (dev.length < 60) continue;
      // Robust to slips: from the median epoch-to-epoch change.
      const d1: number[] = [];
      for (let i = 1; i < dev.length; i++)
        d1.push(Math.abs(dev[i]! - dev[i - 1]!));
      d1.sort((x, y) => x - y);
      const sd = (1.4826 * d1[d1.length >> 1]!) / Math.SQRT2;
      rows.push(`${prn} ${sd.toFixed(2)}`);
    }
    console.log(`${sys} MW DD scatter (wide-lane cycles), ref ${ref}:`);
    console.log('  ' + rows.join('  '));
  }
  process.exit(0);
}
if (OBS === 'C') {
  // Code: the mean double difference per satellite (m) and its standard
  // error; a receiver code bias between satellite groups shows as an offset.
  for (const sys of systems)
    for (const band of bands[sys] ?? '') {
      const f = FREQ[sys]?.[band];
      if (!f) continue;
      const lam = C / f;
      const keys = [...sd.keys()].filter(
        (k) => k[0] === sys && k.endsWith(`:${band}`)
      );
      if (keys.length < 2) continue;
      const ref = keys.reduce((p, q) =>
        sd.get(q)!.size > sd.get(p)!.size ? q : p
      );
      const rs = sd.get(ref)!;
      const rows: string[] = [];
      for (const k of keys.sort()) {
        if (k === ref) continue;
        const v: number[] = [];
        for (const [t, x] of sd.get(k)!) {
          const r = rs.get(t);
          if (r !== undefined) v.push((x - r) * lam);
        }
        if (v.length < 60) continue;
        const m = v.reduce((a, b) => a + b, 0) / v.length;
        const sdv = Math.sqrt(
          v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)
        );
        rows.push(
          `${k.split(':')[0]} ${(m * 100).toFixed(1).padStart(6)} ± ${((100 * sdv) / Math.sqrt(v.length)).toFixed(1)} cm`
        );
      }
      console.log(`${sys} code band ${band}, ref ${ref.split(':')[0]}:`);
      console.log('  ' + rows.join('   '));
    }
  process.exit(0);
}
// Double differences against a per-(constellation, band) reference, split
// into continuous arcs (gap > 60 s or a jump > 0.3 cycles = new arc).
interface Arc {
  key: string;
  y: number[];
  g: number[][];
}
const arcs: Arc[] = [];
const refs = new Map<string, string>();
for (const sys of systems)
  for (const band of bands[sys] ?? '') {
    const keys = [...sd.keys()].filter(
      (k) => k[0] === sys && k.endsWith(`:${band}`)
    );
    if (keys.length < 2) continue;
    const ref = keys.reduce((p, q) =>
      sd.get(q)!.size > sd.get(p)!.size ? q : p
    );
    refs.set(`${sys}${band}`, ref);
    const rs = sd.get(ref)!;
    const rg = grad.get(ref)!;
    for (const k of keys) {
      if (k === ref) continue;
      const s = sd.get(k)!;
      const gs = grad.get(k)!;
      let arc: Arc | null = null;
      let lastT = -Infinity;
      let lastY = 0;
      let base = 0;
      for (const t of [...s.keys()].sort((a, b) => a - b)) {
        const r = rs.get(t);
        if (r === undefined) continue;
        const dd = s.get(t)! - r;
        if (!arc || t - lastT > 60e3 || Math.abs(dd - base - lastY) > 0.3) {
          arc = { key: k, y: [], g: [] };
          arcs.push(arc);
          base = Math.round(dd);
        }
        const y = dd - base;
        arc.y.push(y);
        arc.g.push([0, 1, 2].map((i) => gs.get(t)![i]! - rg.get(t)![i]!));
        lastT = t;
        lastY = y;
      }
    }
  }
// Baseline correction δ (m) from the within-arc variation (arc means out).
const N = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];
const b = [0, 0, 0];
for (const a of arcs) {
  if (a.y.length < 20) continue;
  const my = a.y.reduce((p, q) => p + q, 0) / a.y.length;
  const mg = [0, 1, 2].map(
    (i) => a.g.reduce((p, q) => p + q[i]!, 0) / a.g.length
  );
  a.y.forEach((y, j) => {
    const g = a.g[j]!.map((v, i) => v - mg[i]!);
    for (let i = 0; i < 3; i++) {
      b[i]! += g[i]! * (y - my);
      for (let k = 0; k < 3; k++) N[i]![k]! += g[i]! * g[k]!;
    }
  });
}
const det = (m: number[][]) =>
  m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) -
  m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) +
  m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
const D = det(N);
const delta = [0, 1, 2].map(
  (k) => det(N.map((row, i) => row.map((v, j) => (j === k ? b[i]! : v)))) / D
);
console.log(
  'baseline correction (m):',
  delta.map((v) => v.toFixed(4)).join(' ')
);
// Fractional part per satellite: circular mean over its arcs after the
// correction, weighted by arc length.
for (const [sb, ref] of refs) {
  console.log(`${sb[0]} band ${sb.slice(1)}, ref ${ref.split(':')[0]}:`);
  const per = new Map<string, { c: number; s: number; n: number }>();
  for (const a of arcs) {
    if (!a.key.startsWith(sb[0]!) || !a.key.endsWith(`:${sb.slice(1)}`))
      continue;
    if (a.y.length < 20) continue;
    const acc = per.get(a.key) ?? { c: 0, s: 0, n: 0 };
    a.y.forEach((y, j) => {
      const v = y - a.g[j]!.reduce((p, q, i) => p + q * delta[i]!, 0);
      acc.c += Math.cos(2 * Math.PI * v);
      acc.s += Math.sin(2 * Math.PI * v);
      acc.n++;
    });
    per.set(a.key, acc);
  }
  for (const [k, a] of [...per].sort()) {
    const mean = Math.atan2(a.s, a.c) / (2 * Math.PI);
    console.log(
      `  ${k.split(':')[0]} ${mean >= 0 ? '+' : ''}${mean.toFixed(3)} (R ${(Math.hypot(a.c, a.s) / a.n).toFixed(2)}, n ${a.n})`
    );
  }
}
