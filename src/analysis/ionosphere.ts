/**
 * Slant ionospheric delay from dual-frequency observations.
 *
 * Geometry-free phase combination levelled to the geometry-free code,
 * per continuous arc:
 *   L4 = λi·Li − λj·Lj = (γ−1)·I_i + B      (phase; B = ambiguity bias)
 *   P4 = C_j − C_i    = (γ−1)·I_i + DCBs    (code)
 * with γ = (f_i/f_j)² and I_i the slant ionospheric delay on band i.
 * The arc levelling constant B̂ = median(L4 − P4) transfers the code's
 * absolute level onto the low-noise phase; slant TEC follows as
 *   STEC [TECU] = (L4 − B̂)/(γ−1) · f_i² / 40.3e16.
 *
 * The result carries the receiver+satellite differential code biases
 * (not removed here — several TECU per satellite), so series are
 * DCB-biased but shape-faithful: diurnal variation, gradients and
 * disturbances read correctly.
 *
 * The geometry-free phase is also a sensitive cycle-slip detector:
 * arcs split on epoch-to-epoch L4 jumps beyond GF_JUMP_M, in addition
 * to time gaps and external slip notifications.
 */

import type { RinexHeader } from '../rinex/parser';
import { MIN_ARC_LENGTH, median } from './stats-util';
import {
  C_LIGHT,
  BAND_LABELS,
  DUAL_FREQ_PAIRS,
  ARC_GAP_FACTOR,
  buildGloChannelMap,
  getFreq,
  buildObsIndices,
} from '../constants/gnss';

/* ================================================================== */
/*  Public types                                                       */
/* ================================================================== */

export interface IonoPoint {
  /** Epoch time in milliseconds. */
  time: number;
  /** Slant TEC in TECU (DCB-biased). */
  stec: number;
}

export interface IonoSeries {
  /** Satellite PRN, e.g. "G01". */
  prn: string;
  /** System letter, e.g. "G". */
  system: string;
  /** Band pair used, e.g. "L1-L2". */
  label: string;
  /** Observation codes of the pair, e.g. ["C1C", "C2W"] — the key for
   *  matching differential code bias products. */
  codes: [string, string];
  /** TECU shift caused by 1 ns of geometry-free code bias (B_i − B_j);
   *  multiply a product DCB in ns by this to correct the series. */
  tecuPerNs: number;
  /** Time series of slant TEC values (TECU, DCB-biased). */
  points: IonoPoint[];
  /**
   * Indices into `points` where a new continuous arc begins (gap,
   * cycle slip, or geometry-free jump). Differencing and per-arc
   * detrending must not cross these boundaries.
   */
  arcStarts: number[];
}

export interface IonoResult {
  /** Per-satellite slant TEC time series. */
  series: IonoSeries[];
  /** Highest single STEC sample across all series (TECU). */
  maxStec: number;
  /** Mean STEC across all samples (TECU). */
  meanStec: number;
}

/* ================================================================== */
/*  Constants                                                          */
/* ================================================================== */

/** 40.3e16: TEC→delay factor for TECU (1 TECU = 1e16 el/m²). */
const TEC_FACTOR = 40.3e16;

/** Intra-arc geometry-free jump threshold (m) — matches the external
 *  cycle-slip detector's GF criterion. The iono itself rarely moves
 *  more than a few cm between 30 s epochs. */
const GF_JUMP_M = 0.15;

/* ================================================================== */
/*  Arc state                                                          */
/* ================================================================== */

interface IonoArc {
  times: number[];
  l4: number[];
  p4: number[];
  /** Band-i frequency (Hz), fixed per arc. */
  fi: number;
  gamma: number;
}

interface PairState {
  arc: IonoArc;
  lastTime: number;
  lastL4: number;
}

/* ================================================================== */
/*  Accumulator                                                        */
/* ================================================================== */

export class IonoAccumulator {
  private state = new Map<string, Map<string, PairState>>();
  private closed = new Map<string, Map<string, IonoPoint[]>>();
  private closedArcStarts = new Map<string, Map<string, number[]>>();
  private interval: number;
  private obsIndices: Map<string, Map<string, { L: number; C: number | null }>>;
  private gloChannels: Record<string, number>;
  private pairLabel = new Map<string, string>();
  private pairCodes = new Map<string, [string, string]>();
  private pairMeta = new Map<string, { fi: number; gamma: number }>();

  constructor(header: RinexHeader) {
    this.interval = header.interval ?? 30;
    this.obsIndices = buildObsIndices(header);
    this.gloChannels = buildGloChannelMap(header.glonassSlots);
  }

  /** Observation callback — wire this into parseRinexStream. */
  onObservation = (
    time: number,
    prn: string,
    codes: string[],
    values: (number | null)[]
  ) => {
    const sys = prn[0]!;
    const bandMap = this.obsIndices.get(sys) ?? this.obsIndices.get('_v2');
    if (!bandMap) return;

    const bandData = new Map<
      string,
      { C: number; L: number; f: number; code: string }
    >();
    for (const [band, { C, L }] of bandMap) {
      if (C === null) continue;
      const cVal = values[C];
      const lVal = values[L];
      const freq = getFreq(this.gloChannels, prn, band);
      if (cVal != null && cVal !== 0 && lVal != null && lVal !== 0 && freq) {
        bandData.set(band, {
          C: cVal,
          L: lVal,
          f: freq,
          code: codes[C] ?? `C${band}`,
        });
      }
    }
    if (bandData.size < 2) return;

    // First configured pair with data — one series per satellite.
    const pairs = DUAL_FREQ_PAIRS[sys] ?? [];
    for (const [bi, bj] of pairs) {
      const di = bandData.get(bi);
      const dj = bandData.get(bj);
      if (!di || !dj) continue;

      const λi = C_LIGHT / di.f;
      const λj = C_LIGHT / dj.f;
      const gamma = (di.f * di.f) / (dj.f * dj.f);
      const l4 = di.L * λi - dj.L * λj;
      const p4 = dj.C - di.C;

      const pairKey = `${bi}-${bj}`;
      if (!this.pairLabel.has(`${sys}:${pairKey}`)) {
        const bLabel = BAND_LABELS[sys]?.[bi] ?? bi;
        const rLabel = BAND_LABELS[sys]?.[bj] ?? bj;
        this.pairLabel.set(`${sys}:${pairKey}`, `${bLabel}-${rLabel}`);
        this.pairCodes.set(`${sys}:${pairKey}`, [di.code, dj.code]);
      }
      this.pairMeta.set(`${prn}:${pairKey}`, { fi: di.f, gamma });
      this.push(prn, pairKey, time, l4, p4, di.f, gamma);
      break;
    }
  };

  private push(
    prn: string,
    pairKey: string,
    time: number,
    l4: number,
    p4: number,
    fi: number,
    gamma: number
  ) {
    if (!isFinite(l4) || !isFinite(p4)) return;

    let satStates = this.state.get(prn);
    if (!satStates) {
      satStates = new Map();
      this.state.set(prn, satStates);
    }
    let ps = satStates.get(pairKey);
    if (!ps) {
      ps = {
        arc: { times: [], l4: [], p4: [], fi, gamma },
        lastTime: 0,
        lastL4: 0,
      };
      satStates.set(pairKey, ps);
    }

    const gap = ps.lastTime > 0 ? (time - ps.lastTime) / 1000 : 0;
    if (ps.lastTime > 0 && gap > this.interval * ARC_GAP_FACTOR) {
      this.closeArc(prn, pairKey, ps);
    } else if (
      ps.arc.times.length > 0 &&
      Math.abs(l4 - ps.lastL4) > GF_JUMP_M
    ) {
      // Geometry-free jump: cycle slip on one of the phases.
      this.closeArc(prn, pairKey, ps);
    }

    if (ps.arc.times.length === 0) {
      ps.arc.fi = fi;
      ps.arc.gamma = gamma;
    }
    ps.arc.times.push(time);
    ps.arc.l4.push(l4);
    ps.arc.p4.push(p4);
    ps.lastTime = time;
    ps.lastL4 = l4;
  }

  /** External cycle-slip notification — close affected arcs. */
  notifySlip(_time: number, prn: string, bands: Set<string>) {
    const satStates = this.state.get(prn);
    if (!satStates) return;
    for (const [pairKey, ps] of satStates) {
      const [bi, bj] = pairKey.split('-');
      if (bands.has(bi!) || bands.has(bj!)) {
        this.closeArc(prn, pairKey, ps);
      }
    }
  }

  private closeArc(prn: string, pairKey: string, ps: PairState) {
    const arc = ps.arc;
    if (arc.times.length >= MIN_ARC_LENGTH) {
      // Median levelling resists code multipath and outliers.
      const level = median(arc.l4.map((v, k) => v - arc.p4[k]!));
      const toTecu = (arc.fi * arc.fi) / TEC_FACTOR / (arc.gamma - 1);

      let satArcs = this.closed.get(prn);
      if (!satArcs) {
        satArcs = new Map();
        this.closed.set(prn, satArcs);
      }
      let points = satArcs.get(pairKey);
      if (!points) {
        points = [];
        satArcs.set(pairKey, points);
      }
      let satStarts = this.closedArcStarts.get(prn);
      if (!satStarts) {
        satStarts = new Map();
        this.closedArcStarts.set(prn, satStarts);
      }
      let starts = satStarts.get(pairKey);
      if (!starts) {
        starts = [];
        satStarts.set(pairKey, starts);
      }
      starts.push(points.length);
      for (let k = 0; k < arc.times.length; k++) {
        points.push({
          time: arc.times[k]!,
          stec: (arc.l4[k]! - level) * toTecu,
        });
      }
    }
    ps.arc = { times: [], l4: [], p4: [], fi: arc.fi, gamma: arc.gamma };
  }

  /** Finalize: close remaining arcs, keep one pair per satellite. */
  finalize(): IonoResult {
    for (const [prn, satStates] of this.state) {
      for (const [pairKey, ps] of satStates) {
        this.closeArc(prn, pairKey, ps);
      }
    }

    const series: IonoSeries[] = [];
    let sum = 0;
    let count = 0;
    let maxStec = -Infinity;
    for (const [prn, satArcs] of this.closed) {
      // The pair with the most samples wins (band availability can
      // differ between satellites of the same system).
      let bestKey: string | null = null;
      let bestLen = 0;
      for (const [pairKey, points] of satArcs) {
        if (points.length > bestLen) {
          bestLen = points.length;
          bestKey = pairKey;
        }
      }
      if (!bestKey) continue;
      const points = satArcs.get(bestKey)!;
      const arcStarts = this.closedArcStarts.get(prn)?.get(bestKey) ?? [0];
      const sys = prn[0]!;
      for (const p of points) {
        sum += p.stec;
        count++;
        if (p.stec > maxStec) maxStec = p.stec;
      }
      const meta = this.pairMeta.get(`${prn}:${bestKey}`);
      const tecuPerNs = meta
        ? ((C_LIGHT * 1e-9) / (meta.gamma - 1)) *
          ((meta.fi * meta.fi) / TEC_FACTOR)
        : 0;
      series.push({
        prn,
        system: sys,
        label: this.pairLabel.get(`${sys}:${bestKey}`) ?? bestKey,
        codes: this.pairCodes.get(`${sys}:${bestKey}`) ?? ['', ''],
        tecuPerNs,
        points,
        arcStarts,
      });
    }
    series.sort((a, b) => a.prn.localeCompare(b.prn));

    return {
      series,
      maxStec: count > 0 ? maxStec : 0,
      meanStec: count > 0 ? sum / count : 0,
    };
  }
}

/* ================================================================== */
/*  Time-differenced ionosphere (rate of TEC)                          */
/* ================================================================== */

export interface IonoRatePoint {
  /** Epoch time (ms) — the later epoch of the differenced pair. */
  time: number;
  /** ROT in TECU/min (order 1) or undivided ΔΔSTEC in TECU (order 2). */
  value: number;
}

export interface IonoRateSeries {
  prn: string;
  system: string;
  points: IonoRatePoint[];
}

/**
 * Sequential time differences of the slant TEC series — the biases
 * (ambiguities, DCBs) cancel, leaving ionospheric rate of TEC, phase
 * noise, and scintillation. Differences never cross arc boundaries,
 * so cycle slips do not appear as outliers (arcs split there).
 *
 * @param intervalSec Standardized differencing baseline in seconds.
 *   Omit for native-rate sequential differences; set e.g. 60 for a
 *   sample-rate-independent picture (all pairs ~1 min apart are used).
 * @param order 1 (default) = first difference in TECU/min;
 *   2 = second undivided difference in TECU (native rate only,
 *   gradients removed, noise and scintillation amplified).
 */
export function computeIonoRate(
  result: IonoResult,
  intervalSec?: number,
  order: 1 | 2 = 1
): IonoRateSeries[] {
  const out: IonoRateSeries[] = [];
  for (const s of result.series) {
    const pts: IonoRatePoint[] = [];
    const bounds = [...s.arcStarts, s.points.length];
    for (let a = 0; a < bounds.length - 1; a++) {
      const lo = bounds[a]!;
      const hi = bounds[a + 1]!;
      if (order === 2) {
        // Second undivided difference on (approximately) uniform spacing
        for (let i = lo + 2; i < hi; i++) {
          const dt1 = s.points[i - 1]!.time - s.points[i - 2]!.time;
          const dt2 = s.points[i]!.time - s.points[i - 1]!.time;
          if (Math.abs(dt1 - dt2) > 0.1 * Math.max(dt1, dt2)) continue;
          pts.push({
            time: s.points[i]!.time,
            value:
              s.points[i]!.stec -
              2 * s.points[i - 1]!.stec +
              s.points[i - 2]!.stec,
          });
        }
        continue;
      }
      if (intervalSec === undefined) {
        for (let i = lo + 1; i < hi; i++) {
          const dtMin = (s.points[i]!.time - s.points[i - 1]!.time) / 60_000;
          if (dtMin <= 0) continue;
          pts.push({
            time: s.points[i]!.time,
            value: (s.points[i]!.stec - s.points[i - 1]!.stec) / dtMin,
          });
        }
      } else {
        // All pairs ~intervalSec apart (two-pointer over the arc)
        const targetMs = intervalSec * 1000;
        let j = lo;
        for (let i = lo; i < hi; i++) {
          if (j <= i) j = i + 1;
          while (j < hi && s.points[j]!.time - s.points[i]!.time < targetMs)
            j++;
          if (j >= hi) break;
          const dtMs = s.points[j]!.time - s.points[i]!.time;
          if (dtMs > 1.5 * targetMs) continue; // gap-ish, not a clean pair
          pts.push({
            time: s.points[j]!.time,
            value: ((s.points[j]!.stec - s.points[i]!.stec) / dtMs) * 60_000,
          });
        }
      }
    }
    if (pts.length > 0) out.push({ prn: s.prn, system: s.system, points: pts });
  }
  return out;
}

/**
 * Remove the per-arc bias from a slant TEC result — each arc is
 * shifted so its first observation reads zero, leaving only the TEC
 * *variation* along the arc (Hans van der Marel's suggestion; using
 * the first observation keeps the shape untouched at the small risk
 * of anchoring on an outlier).
 */
export function detrendIonoArcs(result: IonoResult): IonoResult {
  let sum = 0;
  let count = 0;
  let maxStec = -Infinity;
  const series = result.series.map((s) => {
    const bounds = [...s.arcStarts, s.points.length];
    const points: IonoPoint[] = new Array<IonoPoint>(s.points.length);
    for (let a = 0; a < bounds.length - 1; a++) {
      const lo = bounds[a]!;
      const hi = bounds[a + 1]!;
      const anchor = s.points[lo]?.stec ?? 0;
      for (let i = lo; i < hi; i++) {
        points[i] = {
          time: s.points[i]!.time,
          stec: s.points[i]!.stec - anchor,
        };
      }
    }
    for (const p of points) {
      sum += p.stec;
      count++;
      if (p.stec > maxStec) maxStec = p.stec;
    }
    return { ...s, points };
  });
  return {
    series,
    maxStec: count > 0 ? maxStec : 0,
    meanStec: count > 0 ? sum / count : 0,
  };
}
