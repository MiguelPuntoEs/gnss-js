/**
 * RINEX CLOCK (.CLK) parser — high-rate (typically 30 s) precise satellite
 * clock corrections, the accuracy-limiting term for PPP that SP3's 5-minute
 * (linearly interpolated) clocks cannot match.
 *
 * Only `AS` (satellite) records are kept; `AR` (station) records — the bulk
 * of a combined file — are skipped. Clock bias is in seconds.
 */

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
void GPS_EPOCH_MS;

export interface ClkFile {
  /** prn → time-sorted samples { t: GPS-scale ms, c: clock bias (s) }. */
  sats: Record<string, { t: number[]; c: number[] }>;
  /** Nominal sampling interval (s), inferred from the first satellite. */
  intervalSec: number;
}

/** Parse a RINEX CLOCK file. */
export function parseClk(text: string): ClkFile {
  const sats: Record<string, { t: number[]; c: number[] }> = {};
  let inData = false;
  for (const line of text.split('\n')) {
    if (!inData) {
      if (line.includes('END OF HEADER')) inData = true;
      continue;
    }
    if (line.length < 3 || line[0] !== 'A' || line[1] !== 'S') continue;
    // AS <PRN> Y M D H M S.sss <n> <bias> ...
    const p = line.slice(2).trim().split(/\s+/);
    if (p.length < 9) continue;
    const prn = p[0]!;
    const y = +p[1]!;
    const mo = +p[2]!;
    const d = +p[3]!;
    const h = +p[4]!;
    const mi = +p[5]!;
    const s = +p[6]!;
    const bias = +p[8]!; // token[8] here (p[0] is PRN) = clock bias (s)
    if (!Number.isFinite(bias)) continue;
    const t = Date.UTC(y, mo - 1, d, h, mi, Math.floor(s)) + (s % 1) * 1000;
    let e = sats[prn];
    if (!e) {
      e = { t: [], c: [] };
      sats[prn] = e;
    }
    e.t.push(t);
    e.c.push(bias);
  }
  // Infer interval from the first satellite with ≥2 samples.
  let intervalSec = 30;
  for (const e of Object.values(sats)) {
    if (e.t.length >= 2) {
      intervalSec = Math.round((e.t[1]! - e.t[0]!) / 1000);
      break;
    }
  }
  return { sats, intervalSec };
}

/**
 * Satellite clock bias (seconds) at an arbitrary time by linear
 * interpolation between the bracketing samples. Returns null outside the
 * span or across a gap larger than 4 sampling intervals.
 */
export function clkBias(clk: ClkFile, prn: string, tMs: number): number | null {
  const e = clk.sats[prn];
  if (!e || e.t.length === 0) return null;
  const { t, c } = e;
  // Binary search for the last sample ≤ tMs.
  let lo = 0;
  let hi = t.length - 1;
  if (tMs < t[0]! || tMs > t[hi]!) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t[mid]! <= tMs) lo = mid;
    else hi = mid - 1;
  }
  if (t[lo] === tMs || lo === t.length - 1) return c[lo]!;
  const t0 = t[lo]!;
  const t1 = t[lo + 1]!;
  if (t1 - t0 > clk.intervalSec * 1000 * 4) return null; // gap too large
  const f = (tMs - t0) / (t1 - t0);
  return c[lo]! + f * (c[lo + 1]! - c[lo]!);
}
