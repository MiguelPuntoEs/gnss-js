/**
 * Differential code bias (DCB) products and their application to the
 * slant-TEC series from the ionosphere module.
 *
 * Satellite DCBs come from SINEX_BIAS files published by the IGS
 * analysis centres (e.g. CAS `CAS0MGXRAP_*_DCB.BSX`). The levelled
 * geometry-free combination carries B_i − B_j (satellite) plus the
 * receiver bias; subtracting the product value per satellite and then
 * estimating the receiver bias from the night-time floor (the levelled
 * combination is low-noise and TEC is near zero at night — Hans van
 * der Marel's "no negative values" criterion) yields calibrated STEC.
 */

import type { IonoResult, IonoSeries } from './ionosphere';

/** PRN → "C1C-C2W" → bias (ns), satellite entries only. */
export type SatDcbMap = Map<string, Map<string, number>>;

const PRN_RE = /^[A-Z]\d{2}$/;
const SVN_RE = /^[A-Z]\d{3}$/;
const OBS_RE = /^[CL]\d[A-Z]$/;

/** SINEX epoch "YYYY:DDD:SSSSS" → Unix ms; year 0000 means open-ended. */
function sinexEpochMs(s: string): number {
  const [y, d, sec] = s.split(':').map(Number);
  if (!y) return Infinity;
  return Date.UTC(y, 0, 1) + ((d ?? 1) - 1) * 86400_000 + (sec ?? 0) * 1000;
}

/**
 * Parse satellite DSB entries from a SINEX_BIAS file (ESA .BIA,
 * CAS/GFZ .BSX). Station entries (which carry a site name between PRN
 * and the codes) are skipped. Long-history files publish several
 * validity windows per satellite/pair — with values differing by many
 * ns across SVN swaps — so pass the observation epoch to select the
 * covering window; without it, the latest window wins. Values are
 * returned in ns as published.
 */
export function parseSinexBiasDcb(text: string, epochMs?: number): SatDcbMap {
  interface Row {
    value: number;
    end: number;
    covers: boolean;
  }
  const rows = new Map<string, Map<string, Row>>();

  for (const line of text.split('\n')) {
    if (!line.startsWith(' DSB') && !line.startsWith('DSB')) continue;
    const t = line.trim().split(/\s+/);
    // Satellite entry: DSB <SVN> <PRN> <OBS1> <OBS2> <start> <end> <unit> <value> [std]
    if (
      t.length < 9 ||
      !SVN_RE.test(t[1]!) ||
      !PRN_RE.test(t[2]!) ||
      !OBS_RE.test(t[3]!) ||
      !OBS_RE.test(t[4]!)
    ) {
      continue;
    }
    const unitIdx = t.indexOf('ns');
    if (unitIdx < 0 || unitIdx + 1 >= t.length) continue;
    const value = parseFloat(t[unitIdx + 1]!);
    if (!isFinite(value)) continue;

    const start = sinexEpochMs(t[5] ?? '');
    const end = sinexEpochMs(t[6] ?? '');
    const covers = epochMs !== undefined && epochMs >= start && epochMs < end;

    const prn = t[2]!;
    const pair = `${t[3]}-${t[4]}`;
    let sat = rows.get(prn);
    if (!sat) {
      sat = new Map();
      rows.set(prn, sat);
    }
    const prev = sat.get(pair);
    if (
      !prev ||
      (covers && !prev.covers) ||
      (covers === prev.covers && end > prev.end)
    ) {
      sat.set(pair, { value, end, covers });
    }
  }

  const out: SatDcbMap = new Map();
  for (const [prn, sat] of rows) {
    const m = new Map<string, number>();
    for (const [pair, row] of sat) m.set(pair, row.value);
    out.set(prn, m);
  }
  return out;
}

export interface IonoDcbResult {
  result: IonoResult;
  /** Satellites whose product DCB was found and applied. */
  satellitesCorrected: number;
  /** PRNs with no matching product entry (left sat-DCB-biased). */
  satellitesMissing: string[];
  /** Estimated receiver bias per "system label" group (TECU). */
  receiverDcbTecu: Record<string, number>;
}

/** Low percentile of a sample array (robust minimum). */
function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
}

/**
 * Apply satellite DCBs from a product file to an ionosphere result and
 * estimate the receiver bias per system/pair group from the night-time
 * floor (1st percentile → 0). Series without a product entry get the
 * satellite part left in; they are reported in `satellitesMissing`.
 */
export function applyIonoDcb(
  iono: IonoResult,
  satDcb: SatDcbMap
): IonoDcbResult {
  const missing: string[] = [];
  let corrected = 0;

  /** Product DCB (ns) for a series, trying both key orders. */
  const dcbFor = (s: IonoSeries): number | null => {
    const sat = satDcb.get(s.prn);
    if (!sat) return null;
    const fwd = sat.get(`${s.codes[0]}-${s.codes[1]}`);
    if (fwd !== undefined) return fwd;
    const rev = sat.get(`${s.codes[1]}-${s.codes[0]}`);
    if (rev !== undefined) return -rev;
    return null;
  };

  // Pass 1: subtract the satellite bias. The levelled series carries
  // −(B_i − B_j)-worth of TECU, so a product DCB = B_i − B_j (ns) is
  // *added* via tecuPerNs (verified against synthetic ground truth).
  const series: IonoSeries[] = iono.series.map((s) => {
    const dcbNs = dcbFor(s);
    if (dcbNs === null) {
      missing.push(s.prn);
      return s;
    }
    corrected++;
    const shift = dcbNs * s.tecuPerNs;
    return {
      ...s,
      points: s.points.map((p) => ({ time: p.time, stec: p.stec + shift })),
    };
  });

  // Pass 2: receiver bias per system/pair group — only from satellites
  // that got a product correction, then applied to the whole group.
  const missingSet = new Set(missing);
  const receiverDcbTecu: Record<string, number> = {};
  const groups = new Map<string, IonoSeries[]>();
  for (const s of series) {
    const key = `${s.system} ${s.label}`;
    let g = groups.get(key);
    if (!g) {
      g = [];
      groups.set(key, g);
    }
    g.push(s);
  }
  const out: IonoSeries[] = [];
  for (const [key, group] of groups) {
    const samples: number[] = [];
    for (const s of group) {
      if (missingSet.has(s.prn)) continue;
      for (const p of s.points) samples.push(p.stec);
    }
    if (samples.length >= 100) {
      const rx = percentile(samples, 0.01);
      receiverDcbTecu[key] = rx;
      for (const s of group) {
        out.push({
          ...s,
          points: s.points.map((p) => ({
            time: p.time,
            stec: p.stec - rx,
          })),
        });
      }
    } else {
      out.push(...group);
    }
  }
  out.sort((a, b) => a.prn.localeCompare(b.prn));

  let sum = 0;
  let count = 0;
  let maxStec = 0;
  for (const s of out) {
    for (const p of s.points) {
      sum += p.stec;
      count++;
      if (p.stec > maxStec) maxStec = p.stec;
    }
  }

  return {
    result: { series: out, maxStec, meanStec: count > 0 ? sum / count : 0 },
    satellitesCorrected: corrected,
    satellitesMissing: [...new Set(missing)].sort(),
    receiverDcbTecu,
  };
}
