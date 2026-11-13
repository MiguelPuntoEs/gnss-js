/**
 * Bias-SINEX (`.BIA`) parser — GNSS code/phase biases published by the IGS
 * analysis centres. Two record kinds matter here:
 *
 *   - **DSB** differential signal bias (OBS1−OBS2), the classic inter-code
 *     bias used for ionosphere/DCB corrections in SPP.
 *   - **OSB** observable-specific (absolute) bias for a single OBS, the
 *     ingredient PPP-AR needs: the *phase* OSBs are the satellite
 *     fractional-cycle biases that make the ambiguities integer-recoverable.
 *
 * Values keep their file unit (`ns` for code/most phase biases, `cyc` for
 * cycle-based phase biases); `biasMetres` converts ns → m via c.
 */

import { C_LIGHT } from '../constants/gnss';

export interface BiasRecord {
  /** 'DSB' | 'OSB' | 'ISB' | … */
  type: string;
  /** Satellite PRN (e.g. 'G01', 'E11'); '' for a pure station bias. */
  prn: string;
  /** Station (9-char), '' for satellite biases. */
  station: string;
  /** First observable code (e.g. 'C1W', 'L1C'). */
  obs1: string;
  /** Second observable (DSB only; '' for OSB). */
  obs2: string;
  /** Validity start / end (GPS-scale ms); ±Infinity when open. */
  startMs: number;
  endMs: number;
  /** Estimated value in the file unit. */
  value: number;
  /** File unit ('ns' | 'cyc' | …). */
  unit: string;
  /** Satellite SVN ("CNNN", e.g. 'E210'); '' or absent when not given. */
  svn?: string;
  /** Standard deviation of `value` (file unit); absent when blank. */
  std?: number;
  /** Slope (unit/s: ns/s or cyc/s); `value` then refers to the middle of
   *  the interval. Absent when blank. */
  slope?: number;
  /** Standard deviation of `slope`; absent when blank. */
  slopeStd?: number;
}

/** The `%=BIA` header line (Bias-SINEX 1.00 §4.1). */
export interface BiasSinexHeader {
  /** Format version as written ('1.00'). */
  version: string;
  /** Agency creating the file. */
  fileAgency: string;
  /** Creation time (GPS-scale ms). */
  createdMs: number;
  /** Agency providing the data. */
  dataAgency: string;
  /** Solution start / end (ms; ±Infinity for 0000:000:00000). */
  startMs: number;
  endMs: number;
  /** Bias mode: 'R' relative, 'A' absolute (kept as written). */
  mode: string;
  /** Number of estimates as written (a writer recounts). */
  count: number;
}

/** A keyed line of FILE/REFERENCE or BIAS/DESCRIPTION, or a `*` comment
 *  line kept in place (the whole line, '*' included). */
export type BiasSinexEntry =
  { key: string; value: string } | { comment: string };

/** One BIAS/RECEIVER_INFORMATION record (§4.7). */
export interface BiasReceiverInfo {
  station: string;
  /** Constellation letter; '' when not constellation-specific. */
  system: string;
  /** Receiver group ('@MP0'), '' when none. */
  group: string;
  startMs: number;
  endMs: number;
  receiverType: string;
  firmware: string;
}

export interface BiasSinex {
  records: BiasRecord[];
  /** All satellite records grouped by PRN (station === ''). */
  bySat: Map<string, BiasRecord[]>;
  /** The rest of the file, for {@link writeBiasSinex}; absent in files
   *  without a `%=BIA` header line. */
  header?: BiasSinexHeader;
  /** Comment lines between the header line and the first block. */
  preamble?: string[];
  /** The comment line between blocks (e.g. '*-----…'); '' for none. */
  separator?: string;
  /** FILE/REFERENCE (§4.2): key (A18) + information. */
  reference?: BiasSinexEntry[];
  /** FILE/COMMENT (§4.3): the text after column 1 of each line. */
  comments?: string[];
  /** INPUT/ACKNOWLEDGMENTS (§4.4): agency code + description ('' agency
   *  for a continuation line). */
  acknowledgments?: { agency: string; description: string }[];
  /** BIAS/DESCRIPTION (§4.6): key (A39) + value, as written. */
  description?: BiasSinexEntry[];
  /** BIAS/RECEIVER_INFORMATION (§4.7) with its LEGEND comment lines. */
  receivers?: (BiasReceiverInfo | { comment: string })[];
  /** Comment lines in BIAS/SOLUTION, each placed before records[before]. */
  solutionComments?: { before: number; text: string }[];
}

/** Parse a `YYYY:DDD:SSSSS` epoch to GPS-scale ms; 0000:000:00000 → open. */
function parseEpoch(s: string, openTo: number): number {
  const m = /^(\d{4}):(\d{3}):(\d{5})$/.exec(s.trim());
  if (!m) return openTo;
  const y = +m[1]!;
  if (y === 0) return openTo;
  const doy = +m[2]!;
  const sod = +m[3]!;
  return Date.UTC(y, 0, 1) + (doy - 1) * 86400_000 + sod * 1000;
}

const num = (s: string | undefined): number | undefined => {
  if (s == null || s === '') return undefined;
  const v = Number(s.replace(/[dD]/, 'E'));
  return Number.isFinite(v) ? v : undefined;
};

/** Parse a Bias-SINEX file. */
export function parseBiasSinex(text: string): BiasSinex {
  const records: BiasRecord[] = [];
  const out: Omit<BiasSinex, 'records' | 'bySat'> = {};
  let block = '';
  let seenBlock = false;
  let afterBlock = false;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (block === 'BIAS/SOLUTION') {
      if (line.startsWith('-BIAS/SOLUTION')) {
        block = '';
        afterBlock = true;
        continue;
      }
      if (line.startsWith('*')) {
        (out.solutionComments ??= []).push({
          before: records.length,
          text: line.trimEnd(),
        });
        continue;
      }
      if (line.length < 65) continue;
      const type = line.slice(1, 4).trim();
      if (type !== 'DSB' && type !== 'OSB' && type !== 'ISB') continue;
      // Fixed columns (Bias-SINEX v1.00 §4.8); the numeric tail
      // (UNIT, VALUE, STD, SLOPE, SLOPE STD) is whitespace-split.
      const tail = line.slice(65).trim().split(/\s+/);
      if (tail.length < 2) continue;
      const value = Number(tail[1]);
      if (!Number.isFinite(value)) continue;
      const r: BiasRecord = {
        type,
        prn: line.slice(11, 14).trim(),
        station: line.slice(15, 24).trim(),
        obs1: line.slice(25, 29).trim(),
        obs2: line.slice(30, 34).trim(),
        startMs: parseEpoch(line.slice(35, 49), -Infinity),
        endMs: parseEpoch(line.slice(50, 64), Infinity),
        value,
        unit: tail[0]!,
      };
      const svn = line.slice(6, 10).trim();
      if (svn) r.svn = svn;
      const std = num(tail[2]);
      if (std !== undefined) r.std = std;
      const slope = num(tail[3]);
      if (slope !== undefined) r.slope = slope;
      const slopeStd = num(tail[4]);
      if (slopeStd !== undefined) r.slopeStd = slopeStd;
      records.push(r);
      continue;
    }
    if (line.startsWith('%=BIA') && !out.header) {
      const t = line.split(/\s+/);
      out.header = {
        version: t[1] ?? '',
        fileAgency: t[2] ?? '',
        createdMs: parseEpoch(t[3] ?? '', NaN),
        dataAgency: t[4] ?? '',
        startMs: parseEpoch(t[5] ?? '', -Infinity),
        endMs: parseEpoch(t[6] ?? '', Infinity),
        mode: t[7] ?? '',
        count: Number(t[8]),
      };
      continue;
    }
    if (line.startsWith('+')) {
      block = line.slice(1).trim();
      seenBlock = true;
      afterBlock = false;
      if (block === 'FILE/REFERENCE') out.reference ??= [];
      else if (block === 'FILE/COMMENT') out.comments ??= [];
      else if (block === 'INPUT/ACKNOWLEDGMENTS') out.acknowledgments ??= [];
      else if (block === 'BIAS/DESCRIPTION') out.description ??= [];
      else if (block === 'BIAS/RECEIVER_INFORMATION') out.receivers ??= [];
      else if (block === 'BIAS/SOLUTION') out.solutionComments ??= [];
      continue;
    }
    if (line.startsWith('-')) {
      block = '';
      afterBlock = true;
      continue;
    }
    if (!block) {
      if (!line.startsWith('*')) continue;
      if (!seenBlock) (out.preamble ??= []).push(line.trimEnd());
      else if (afterBlock && out.separator === undefined)
        out.separator = line.trimEnd();
      continue;
    }
    if (line.trim() === '') continue;
    const comment = line.startsWith('*') ? line.trimEnd() : null;
    switch (block) {
      case 'FILE/REFERENCE':
        out.reference!.push(
          comment != null
            ? { comment }
            : { key: line.slice(1, 19).trim(), value: line.slice(20).trimEnd() }
        );
        break;
      case 'BIAS/DESCRIPTION':
        out.description!.push(
          comment != null
            ? { comment }
            : { key: line.slice(1, 40).trim(), value: line.slice(40).trim() }
        );
        break;
      case 'FILE/COMMENT':
        if (comment == null) out.comments!.push(line.slice(1).trimEnd());
        break;
      case 'INPUT/ACKNOWLEDGMENTS': {
        if (comment != null) break;
        // Agency codes are A3, but 4-letter ones ('ESOC') occur; a line
        // with a blank code continues the previous description.
        const m = /^ (\S+) ?(.*)$/.exec(line.trimEnd());
        out.acknowledgments!.push(
          m
            ? { agency: m[1]!, description: m[2]! }
            : { agency: '', description: line.slice(5).trimEnd() }
        );
        break;
      }
      case 'BIAS/RECEIVER_INFORMATION':
        out.receivers!.push(
          comment != null
            ? { comment }
            : {
                station: line.slice(1, 10).trim(),
                system: line.slice(11, 12).trim(),
                group: line.slice(13, 22).trim(),
                startMs: parseEpoch(line.slice(23, 37), -Infinity),
                endMs: parseEpoch(line.slice(38, 52), Infinity),
                receiverType: line.slice(53, 73).trim(),
                firmware: line.slice(74, 94).trim(),
              }
        );
        break;
    }
  }
  // A file without preamble/separator comments is written back without.
  if (out.header) out.preamble ??= [];
  if (seenBlock) out.separator ??= '';
  const bySat = new Map<string, BiasRecord[]>();
  for (const r of records) {
    if (!r.prn || r.station) continue;
    let a = bySat.get(r.prn);
    if (!a) {
      a = [];
      bySat.set(r.prn, a);
    }
    a.push(r);
  }
  return { records, bySat, ...out };
}

/** A satellite bias record's value in metres (ns → m via c; cyc left as-is). */
export function biasMetres(r: BiasRecord): number {
  return r.unit === 'ns' ? r.value * 1e-9 * C_LIGHT : r.value;
}

/**
 * Look up a satellite bias: a DSB by its (obs1,obs2) pair, or an OSB by obs1
 * alone (pass obs2 = undefined), valid at `tMs` (default: any). Returns the
 * record or null.
 */
export function findSatBias(
  bias: BiasSinex,
  prn: string,
  obs1: string,
  obs2?: string,
  tMs?: number
): BiasRecord | null {
  const recs = bias.bySat.get(prn);
  if (!recs) return null;
  for (const r of recs) {
    if (r.obs1 !== obs1) continue;
    if (obs2 === undefined ? r.obs2 !== '' : r.obs2 !== obs2) continue;
    if (tMs != null && (tMs < r.startMs || tMs > r.endMs)) continue;
    return r;
  }
  return null;
}

/**
 * Fast time-aware lookup of satellite OSBs (metres) — the form PPP needs.
 * Products with integer-recoverable clocks (CNES/GFZ "ABS", CODE) publish
 * phase OSBs that change every 30 s–15 min, so one PRN/observable can carry
 * thousands of records; they're sorted once and found by binary search.
 * Values are as published (observed = true + bias), so the corrected
 * observable is `observed − osb(...)`.
 */
export class SatOsbTable {
  private readonly byKey = new Map<
    string,
    { start: Float64Array; end: Float64Array; m: Float64Array }
  >();

  constructor(bias: BiasSinex | BiasRecord[]) {
    const recs = Array.isArray(bias) ? bias : bias.records;
    const groups = new Map<string, BiasRecord[]>();
    for (const r of recs) {
      if (r.type !== 'OSB' || !r.prn || r.station) continue;
      if (r.unit !== 'ns') continue; // cycle-unit OSBs are not used here
      const k = `${r.prn} ${r.obs1}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push(r);
    }
    for (const [k, g] of groups) {
      g.sort((a, b) => a.startMs - b.startMs);
      this.byKey.set(k, {
        start: Float64Array.from(g, (r) => r.startMs),
        end: Float64Array.from(g, (r) => r.endMs),
        m: Float64Array.from(g, biasMetres),
      });
    }
  }

  /** Whether any phase (L…) OSB is present — i.e. the product supports AR. */
  get hasPhase(): boolean {
    for (const k of this.byKey.keys())
      if (k.split(' ')[1]![0] === 'L') return true;
    return false;
  }

  /** OSB (m) of `prn`'s observable `obs` (e.g. 'C1W', 'L2W') at `tMs`;
   *  null when the product has none valid then. */
  get(prn: string, obs: string, tMs: number): number | null {
    // A satellite's bias is the same for every tracking mode of one band in
    // products that publish only the combined 'X' signal (CNES: Galileo
    // L1X/L5X, BeiDou L2I…): fall back to it.
    const e =
      this.byKey.get(`${prn} ${obs}`) ??
      this.byKey.get(`${prn} ${obs.slice(0, 2)}X`);
    if (!e) return null;
    let lo = 0;
    let hi = e.start.length - 1;
    if (tMs < e.start[0]!) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (e.start[mid]! <= tMs) lo = mid;
      else hi = mid - 1;
    }
    return tMs <= e.end[lo]! ? e.m[lo]! : null;
  }
}
