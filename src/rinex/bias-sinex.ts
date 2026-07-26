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
}

export interface BiasSinex {
  records: BiasRecord[];
  /** All satellite records grouped by PRN (station === ''). */
  bySat: Map<string, BiasRecord[]>;
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

/** Parse a Bias-SINEX file. */
export function parseBiasSinex(text: string): BiasSinex {
  const records: BiasRecord[] = [];
  let inBlock = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('+BIAS/SOLUTION')) {
      inBlock = true;
      continue;
    }
    if (line.startsWith('-BIAS/SOLUTION')) {
      inBlock = false;
      continue;
    }
    if (!inBlock || line.length < 65 || line.startsWith('*')) continue;
    const type = line.slice(1, 4).trim();
    if (type !== 'DSB' && type !== 'OSB' && type !== 'ISB') continue;
    // Fixed columns (Bias-SINEX v1.00); the numeric tail is whitespace-split.
    const prn = line.slice(11, 14).trim();
    const station = line.slice(15, 24).trim();
    const obs1 = line.slice(25, 29).trim();
    const obs2 = line.slice(30, 34).trim();
    const startMs = parseEpoch(line.slice(35, 49), -Infinity);
    const endMs = parseEpoch(line.slice(50, 64), Infinity);
    const tail = line.slice(65).trim().split(/\s+/);
    if (tail.length < 2) continue;
    const unit = tail[0]!;
    const value = Number(tail[1]);
    if (!Number.isFinite(value)) continue;
    records.push({
      type,
      prn,
      station,
      obs1,
      obs2,
      startMs,
      endMs,
      value,
      unit,
    });
  }
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
  return { records, bySat };
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
