/**
 * Code multipath as other QC tools average it, for comparison with their
 * reports. The graded figure stays {@link MultipathAccumulator}'s (arc
 * mean removed, sigma-edited); these read the same combinations the way
 * operators' histories were made. Both are fitted to the tools' own
 * per-satellite output, not only their summaries.
 *
 * **Anubis** (G-Nut, the EUREF/IGS QC tool): every code signal on its own
 * (`M1C`, `M2W`, `M2L`, …), each combined with one dual-frequency phase
 * pair per satellite (GPS L1/L2, Galileo E1/E5a — the first of
 * {@link DUAL_FREQ_PAIRS} it carries):
 *
 *   MP_k = P_k + α·L_i + β·L_j,
 *   α = −(f_j² + f_k²)·f_i² / ((f_i² − f_j²)·f_k²),
 *   β =  (f_i² + f_k²)·f_j² / ((f_i² − f_j²)·f_k²)      (manual eq. 4.3–4.4)
 *
 * then a moving RMS: the sample standard deviation of each 20-epoch window
 * inside a continuous arc (`mpx_nep`, default 20), averaged per satellite;
 * a signal's value is the mean over its satellites, a band's (`mpX` in the
 * summary) the mean over its signals. Every elevation counts (its `ele_cut`
 * shapes only the expected-observation counts). Arcs end at a missing epoch
 * or a phase cycle slip — not at code jumps, and not in an arc's first
 * window (its 3σ test has no σ yet), which is where most of the spread
 * against Anubis is. Against Anubis 3.11 (`:qc:sec_mpx=1`) on seven
 * IGS/EUREF stations of 2026/313, 153 signal means: median ratio 0.98, 80 %
 * within 0.91–1.10; clean satellites match to the centimetre.
 *
 * **teqc** (UNAVCO, 2019Feb25): MP12, MP21 (and MP15, MP51 with L5) — the
 * code on the first band against the phases of the pair, as above — minus
 * the mean of its last 50 values in the arc (fewer at the start of an arc),
 * the residual's RMS per satellite above the elevation mask, and the mean
 * over satellites; teqc's summary pools GPS and GLONASS. On WTZR 2026/313
 * that form reproduces 87 % of teqc's plotted MP12 values to the
 * centimetre; the rest is where teqc's own slip detection restarts an arc
 * differently. Its summaries on the seven 2026/313 stations: MP12 within
 * 0.87–1.06, MP21 within 0.98–1.21 — arc restarts are where the two differ
 * (equatorial KOUR's ionosphere moves the phases most).
 */
import type { RinexHeader } from '../rinex/parser';
import {
  DUAL_FREQ_PAIRS,
  buildGloChannelMap,
  getFreq,
} from '../constants/gnss';

/** Anubis window (epochs) — its `mpx_nep` default. */
const ANUBIS_WINDOW = 20;
/** teqc moving-average length (points). */
const TEQC_WINDOW = 50;
/** Geometry-free phase step (m) Anubis's arcs end at. */
const GF_SLIP_M = 0.2;
/** …and teqc's: it restarts far less often (about its IOD slip test at
 *  30 s). One value for MP12 and MP21 — 3 m suits MP12, 2 m MP21. */
const TEQC_SLIP_M = 2.5;
/** Systems teqc's QC reports. */
const TEQC_SYSTEMS = 'GR';
const C_LIGHT = 299_792_458;

export interface ReferenceMpSignal {
  system: string;
  /** RINEX code, e.g. "C1C". */
  code: string;
  /** Anubis-style label, e.g. "GPS M1C". */
  label: string;
  band: string;
  /** Mean over satellites (m). */
  mean: number;
  /** Per satellite (m). */
  satellites: Record<string, number>;
}

export interface TeqcMpCombination {
  system: string;
  /** "MP12": code on band 1, phases of bands 1 and 2. */
  name: string;
  /** Mean over satellites of each satellite's RMS (m). */
  mean: number;
  satellites: Record<string, number>;
}

export interface ReferenceMultipath {
  anubis: {
    signals: ReferenceMpSignal[];
    /** Per band over all systems: the mean of its signals (m), as Anubis's
     *  summary mp1…mp8. */
    bands: { band: string; mean: number }[];
  };
  teqc: {
    combinations: TeqcMpCombination[];
    /** As teqc's "Moving average MP12": GPS and GLONASS satellites pooled. */
    summary: { name: string; mean: number }[];
    maskDeg: number;
  };
}

/** A running window over an arc's values, relative to the arc's first
 *  value so the running sums stay small. */
interface Win {
  ref: number;
  lastGf: number;
  lastTime: number;
  buf: Float64Array;
  head: number;
  n: number;
  sum: number;
  sum2: number;
  /** Anubis: sum and count of window standard deviations. */
  acc: number;
  accN: number;
}

type Track = Win & { key: string; ss: number; ssN: number };

const newWin = (size: number, mp: number, gf: number, time: number): Win => ({
  ref: mp,
  lastGf: gf,
  lastTime: time,
  buf: new Float64Array(size),
  head: 0,
  n: 0,
  sum: 0,
  sum2: 0,
  acc: 0,
  accN: 0,
});

function restart(w: Win, mp: number) {
  w.ref = mp;
  w.head = 0;
  w.n = 0;
  w.sum = 0;
  w.sum2 = 0;
}

/** Add a value; returns it relative to the arc reference. */
function add(w: Win, mp: number): number {
  const size = w.buf.length;
  const x = mp - w.ref;
  if (w.n === size) {
    const old = w.buf[w.head]!;
    w.sum -= old;
    w.sum2 -= old * old;
  } else w.n++;
  w.buf[w.head] = x;
  w.head = (w.head + 1) % size;
  w.sum += x;
  w.sum2 += x * x;
  return x;
}

/** Anubis's three-letter system names (=GPSM1C, =GLOM1C, …). */
const ANUBIS_SYS: Record<string, string> = {
  G: 'GPS',
  R: 'GLO',
  E: 'GAL',
  C: 'BDS',
  J: 'QZS',
  I: 'IRN',
  S: 'SBS',
};

/** teqc's code per band: C/A on L1, P(Y) on L2, then whatever exists. */
const TEQC_CODE_PREF: Record<string, string[]> = {
  '1': ['C1C', 'C1'],
  '2': ['C2W', 'P2', 'C2P', 'C2C'],
};

const ORDER = 'GRECJIS';
const rank = (s: string) =>
  ORDER.includes(s) ? ORDER.indexOf(s) : ORDER.length;

interface CodeIdx {
  /** Distinguishes code lists in the numeric track keys. */
  id: number;
  L: Map<string, number[]>;
  C: { code: string; i: number }[];
  /** teqc's code per band, best first. */
  teqc: Map<string, number[]>;
}

export class ReferenceMultipathAccumulator {
  /** Per satellite: its tracks under small numeric keys (no strings per
   *  observation); each knows its "A|G05|C1C" / "T|G05|MP12" key. */
  private per = new Map<string, Map<number, Track>>();
  private phBuf = new Float64Array(10);
  private phSeen = new Uint8Array(10);
  private nextId = 0;
  private gloChannels: Record<string, number>;
  private intervalMs: number;
  private idx = new Map<string[], CodeIdx>();

  /** `maskDeg`: teqc's elevation mask for its RMS (Anubis uses none). */
  constructor(
    header: RinexHeader,
    private maskDeg = 10
  ) {
    this.gloChannels = buildGloChannelMap(header.glonassSlots);
    this.intervalMs = (header.interval ?? 30) * 1000;
  }

  private indices(codes: string[]): CodeIdx {
    let x = this.idx.get(codes);
    if (!x) {
      const L = new Map<string, number[]>();
      const C: { code: string; i: number }[] = [];
      const teqc = new Map<string, number[]>();
      codes.forEach((c, i) => {
        const b = c[1]!;
        if (c[0] === 'L') {
          if (!L.has(b)) L.set(b, []);
          L.get(b)!.push(i);
        } else if (c[0] === 'C' || c[0] === 'P') {
          C.push({ code: c, i });
          if (!teqc.has(b)) teqc.set(b, []);
          teqc.get(b)!.push(i);
        }
      });
      for (const [b, list] of teqc) {
        const pref = TEQC_CODE_PREF[b] ?? [];
        const r = (i: number) => {
          const k = pref.indexOf(codes[i]!);
          return k < 0 ? pref.length : k;
        };
        list.sort((a, c) => r(a) - r(c));
      }
      this.idx.set(codes, (x = { id: this.nextId++, L, C, teqc }));
    }
    return x;
  }

  onObservation(
    time: number,
    prn: string,
    codes: string[],
    values: (number | null)[],
    elevationDeg: number | null
  ) {
    // Unknown elevation (no orbits) counts, as both tools without nav.
    if (elevationDeg !== null && elevationDeg < 0) return;
    const sys = prn[0]!;
    const ci = this.indices(codes);
    const { L, C, teqc } = ci;
    const first = (idx: number[] | undefined) => {
      if (idx)
        for (const i of idx) {
          const v = values[i];
          if (v != null && v !== 0) return v;
        }
      return null;
    };
    // Phase per band in metres (NaN when missing), computed once per call.
    const ph = this.phBuf.fill(NaN);
    const seen = this.phSeen.fill(0);
    const phase = (b: string) => {
      const k = b.charCodeAt(0) - 48;
      if (!seen[k]) {
        seen[k] = 1;
        const v = first(L.get(b));
        const f = v === null ? 0 : getFreq(this.gloChannels, prn, b);
        ph[k] = v !== null && f ? (v * C_LIGHT) / f : NaN;
      }
      return ph[k]!;
    };
    const mpOf = (p: number, fk: number, bi: string, bj: string) => {
      const fi = getFreq(this.gloChannels, prn, bi)!;
      const fj = getFreq(this.gloChannels, prn, bj)!;
      const fi2 = fi * fi;
      const fj2 = fj * fj;
      const fk2 = fk * fk;
      const d = (fi2 - fj2) * fk2;
      return (
        p -
        ((fj2 + fk2) * fi2 * phase(bi)) / d +
        ((fi2 + fk2) * fj2 * phase(bj)) / d
      );
    };
    const pairs = DUAL_FREQ_PAIRS[sys] ?? [];
    let sat = this.per.get(prn);
    if (!sat) this.per.set(prn, (sat = new Map()));

    // Anubis: every code, one phase pair (the first the satellite has).
    // One track per phase pair: a satellite that switches pair (L2 missing
    // for a while) must not mix two combinations in a window.
    const pi = pairs.findIndex(
      ([a, b]) => !isNaN(phase(a)) && !isNaN(phase(b))
    );
    if (pi >= 0) {
      const [bi, bj] = pairs[pi]!;
      const gf = phase(bi) - phase(bj);
      for (const { code, i } of C) {
        const p = values[i];
        if (p == null || p === 0) continue;
        const fk = getFreq(this.gloChannels, prn, code[1]!);
        if (!fk) continue;
        const mp = mpOf(p, fk, bi, bj);
        const num = ci.id * 65536 + pi * 256 + i;
        let w = sat.get(num);
        if (!w) {
          sat.set(
            num,
            (w = {
              ...newWin(ANUBIS_WINDOW, mp, gf, time),
              key: `A|${prn}|${code}`,
              ss: 0,
              ssN: 0,
            })
          );
        }
        this.pushAnubis(w, time, mp, gf);
      }
    }

    // teqc: MPij and MPji on each pair, GPS and GLONASS, above the mask.
    if (!TEQC_SYSTEMS.includes(sys)) return;
    const counted = elevationDeg === null || elevationDeg >= this.maskDeg;
    for (let q = 0; q < pairs.length; q++) {
      const [bi, bj] = pairs[q]!;
      if (isNaN(phase(bi)) || isNaN(phase(bj))) continue;
      const gf = phase(bi) - phase(bj);
      for (let dir = 0; dir < 2; dir++) {
        const k = dir === 0 ? bi : bj;
        const other = dir === 0 ? bj : bi;
        const p = first(teqc.get(k));
        const fk = getFreq(this.gloChannels, prn, k);
        if (p === null || !fk) continue;
        const mp = mpOf(p, fk, bi, bj);
        const num = -(q * 2 + dir + 1);
        let w = sat.get(num);
        if (!w) {
          sat.set(
            num,
            (w = {
              ...newWin(TEQC_WINDOW, mp, gf, time),
              key: `T|${prn}|MP${k}${other}`,
              ss: 0,
              ssN: 0,
            })
          );
        }
        this.pushTeqc(w, time, mp, gf, counted);
      }
    }
  }

  private broken(w: Win, time: number, gf: number) {
    return (
      time - w.lastTime > 1.5 * this.intervalMs ||
      Math.abs(gf - w.lastGf) > TEQC_SLIP_M
    );
  }

  private pushAnubis(w: Track, time: number, mp: number, gf: number) {
    // A slip ends the arc only once a full window exists (see header).
    if (
      w.n > 0 &&
      (time - w.lastTime > 1.5 * this.intervalMs ||
        (w.n >= ANUBIS_WINDOW && Math.abs(gf - w.lastGf) > GF_SLIP_M))
    )
      restart(w, mp);
    w.lastGf = gf;
    w.lastTime = time;
    add(w, mp);
    if (w.n === ANUBIS_WINDOW) {
      const v =
        (w.sum2 - (w.sum * w.sum) / ANUBIS_WINDOW) / (ANUBIS_WINDOW - 1);
      w.acc += Math.sqrt(Math.max(0, v));
      w.accN++;
    }
  }

  private pushTeqc(
    w: Track,
    time: number,
    mp: number,
    gf: number,
    counted: boolean
  ) {
    if (w.n > 0 && this.broken(w, time, gf)) restart(w, mp);
    w.lastGf = gf;
    w.lastTime = time;
    const x = add(w, mp);
    if (counted) {
      const r = x - w.sum / w.n;
      w.ss += r * r;
      w.ssN++;
    }
  }

  finalize(): ReferenceMultipath {
    // Anubis: "G05|C1C|12" → per signal → per satellite (its pairs pooled).
    const tracks = [...this.per.values()].flatMap((m) => [...m.values()]);
    const bySignal = new Map<string, Map<string, [number, number]>>();
    for (const w of tracks) {
      if (w.key[0] !== 'A' || w.accN === 0) continue;
      const [, prn, code] = w.key.split('|') as [string, string, string];
      const sig = `${prn[0]}|${code}`;
      if (!bySignal.has(sig)) bySignal.set(sig, new Map());
      const m = bySignal.get(sig)!;
      const a = m.get(prn) ?? [0, 0];
      a[0] += w.acc;
      a[1] += w.accN;
      m.set(prn, a);
    }
    const signals: ReferenceMpSignal[] = [...bySignal].map(([sig, sums]) => {
      const [system, code] = sig.split('|') as [string, string];
      const m = new Map([...sums].map(([prn, [s, n]]) => [prn, s / n]));
      const satellites = Object.fromEntries(m);
      return {
        system,
        code,
        label: `${ANUBIS_SYS[system] ?? system} M${code.slice(1)}`,
        band: code[1]!,
        mean: mean([...m.values()]),
        satellites,
      };
    });
    signals.sort(
      (a, b) => rank(a.system) - rank(b.system) || a.code.localeCompare(b.code)
    );
    const byBand = new Map<string, number[]>();
    for (const s of signals) {
      if (!byBand.has(s.band)) byBand.set(s.band, []);
      byBand.get(s.band)!.push(s.mean);
    }
    const bands = [...byBand]
      .map(([band, v]) => ({ band, mean: mean(v) }))
      .sort((a, b) => a.band.localeCompare(b.band));

    // teqc: "G05|MP12" → per system and combination → per satellite.
    const byCombo = new Map<string, Map<string, number>>();
    for (const w of tracks) {
      if (w.key[0] !== 'T' || w.ssN === 0) continue;
      const [, prn, name] = w.key.split('|') as [string, string, string];
      const k = `${prn[0]}|${name}`;
      if (!byCombo.has(k)) byCombo.set(k, new Map());
      byCombo.get(k)!.set(prn, Math.sqrt(w.ss / w.ssN));
    }
    const combinations: TeqcMpCombination[] = [...byCombo]
      .map(([k, m]) => {
        const [system, name] = k.split('|') as [string, string];
        return {
          system,
          name,
          mean: mean([...m.values()]),
          satellites: Object.fromEntries(m),
        };
      })
      .sort(
        (a, b) =>
          rank(a.system) - rank(b.system) || a.name.localeCompare(b.name)
      );
    const pooled = new Map<string, number[]>();
    for (const c of combinations) {
      if (!pooled.has(c.name)) pooled.set(c.name, []);
      pooled.get(c.name)!.push(...Object.values(c.satellites));
    }
    const summary = [...pooled]
      .map(([name, v]) => ({ name, mean: mean(v) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      anubis: { signals, bands },
      teqc: { combinations, summary, maskDeg: this.maskDeg },
    };
  }
}

const mean = (v: number[]) => v.reduce((a, x) => a + x, 0) / v.length;
