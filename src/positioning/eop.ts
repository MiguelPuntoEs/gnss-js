/**
 * Earth orientation parameters (polar motion, UT1 − UTC) from the IERS
 * series, for the models that need the pole position at an instant — the
 * solid-earth and ocean pole tides (IERS Conventions 2010, 7.1.4–7.1.5).
 *
 *  - {@link parseFinals2000A}: IERS Rapid Service/Prediction Center
 *    `finals2000A.all` / `finals2000A.daily` (fixed columns; Bulletin A
 *    values, or Bulletin B where given with `bulletinB: true`).
 *  - {@link parseEopC04}: IERS EOP 20 C04 (`EOP_20_C04_one_file_1962-now.txt`,
 *    whitespace columns, `#` header).
 *  - IGS ERP files (published with the orbit products): the records of
 *    `parseErp` (gnss-js/rinex) are EopRecords as they are (mjd, xp, yp).
 *
 * {@link interpolateEop} interpolates linearly between daily values. The
 * diurnal/semidiurnal ocean-tide and libration terms of polar motion
 * (≤ 0.5 mas) are not added: in the pole tide they are ≤ 0.02 mm.
 */
import { getGpsLeap } from '../time/utc';

/** One EOP sample. */
export interface EopRecord {
  /** Modified Julian Date (UTC) of the sample. */
  mjd: number;
  /** Pole coordinates (arcsec). */
  xp: number;
  yp: number;
  /** UT1 − UTC (s), when the source gives it. */
  ut1Utc?: number;
}

const MJD_UNIX_EPOCH = 40587; // 1970-01-01

/** GPS-scale ms → UTC MJD. */
export function gpsMsToUtcMjd(timeMs: number): number {
  const utc = timeMs - getGpsLeap(new Date(timeMs)) * 1000;
  return utc / 86_400_000 + MJD_UNIX_EPOCH;
}

/**
 * IERS `finals2000A` (Bulletin A rapid + predictions; Bulletin B columns at
 * the end of final rows). Rows without polar motion are skipped. Columns
 * (1-based): MJD 8–15, x 19–27, y 38–46, UT1−UTC 59–68; Bulletin B x
 * 135–144, y 145–154, UT1−UTC 155–165.
 */
export function parseFinals2000A(
  text: string,
  opts: { bulletinB?: boolean } = {}
): EopRecord[] {
  const out: EopRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 46) continue;
    const mjd = Number(line.slice(7, 15));
    if (!Number.isFinite(mjd) || mjd < 30000) continue;
    let xs = line.slice(18, 27);
    let ys = line.slice(37, 46);
    let us = line.slice(58, 68);
    if (opts.bulletinB && line.length >= 154 && line.slice(134, 144).trim()) {
      xs = line.slice(134, 144);
      ys = line.slice(144, 154);
      us = line.slice(154, 165);
    }
    if (!xs.trim() || !ys.trim()) continue;
    const xp = Number(xs);
    const yp = Number(ys);
    if (!Number.isFinite(xp) || !Number.isFinite(yp)) continue;
    const u = us.trim() ? Number(us) : NaN;
    out.push({ mjd, xp, yp, ...(Number.isFinite(u) ? { ut1Utc: u } : {}) });
  }
  return out;
}

/** IERS EOP (20) C04: `YR MM DD HH MJD x y UT1-UTC …`, `#` comments. */
export function parseEopC04(text: string): EopRecord[] {
  const out: EopRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const f = line.trim().split(/\s+/).map(Number);
    // EOP 20 C04 has an hour column (MJD at index 4); the older 14 C04
    // layout does not (MJD at index 3).
    const k = f[4] !== undefined && f[4] > 30000 ? 4 : 3;
    const mjd = f[k]!;
    const xp = f[k + 1]!;
    const yp = f[k + 2]!;
    const u = f[k + 3]!;
    if (![mjd, xp, yp].every(Number.isFinite) || mjd < 30000) continue;
    out.push({ mjd, xp, yp, ...(Number.isFinite(u) ? { ut1Utc: u } : {}) });
  }
  return out;
}

/**
 * Polar motion (arcsec) and UT1 − UTC (s) at a GPS-scale instant, linear
 * between the bracketing samples (records sorted by MJD; unsorted input is
 * sorted). Null outside the series by more than `maxExtrapolateDays`
 * (default 1, i.e. the nearest sample is used up to a day past an end).
 */
export function interpolateEop(
  records: readonly EopRecord[],
  timeMs: number,
  maxExtrapolateDays = 1
): { xp: number; yp: number; ut1Utc?: number } | null {
  if (!records.length) return null;
  let r = records;
  for (let i = 1; i < r.length; i++)
    if (r[i]!.mjd < r[i - 1]!.mjd) {
      r = [...records].sort((a, b) => a.mjd - b.mjd);
      break;
    }
  const mjd = gpsMsToUtcMjd(timeMs);
  const first = r[0]!;
  const last = r[r.length - 1]!;
  if (mjd <= first.mjd)
    return first.mjd - mjd <= maxExtrapolateDays ? pick(first) : null;
  if (mjd >= last.mjd)
    return mjd - last.mjd <= maxExtrapolateDays ? pick(last) : null;
  let lo = 0;
  let hi = r.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (r[m]!.mjd <= mjd) lo = m;
    else hi = m;
  }
  const a = r[lo]!;
  const b = r[hi]!;
  const f = (mjd - a.mjd) / (b.mjd - a.mjd);
  const lerp = (x: number, y: number) => x + f * (y - x);
  const out: { xp: number; yp: number; ut1Utc?: number } = {
    xp: lerp(a.xp, b.xp),
    yp: lerp(a.yp, b.yp),
  };
  // UT1 − UTC jumps by 1 s at a leap second: don't interpolate across one.
  if (
    a.ut1Utc !== undefined &&
    b.ut1Utc !== undefined &&
    Math.abs(b.ut1Utc - a.ut1Utc) < 0.5
  )
    out.ut1Utc = lerp(a.ut1Utc, b.ut1Utc);
  return out;
}

function pick(r: EopRecord) {
  return {
    xp: r.xp,
    yp: r.yp,
    ...(r.ut1Utc !== undefined ? { ut1Utc: r.ut1Utc } : {}),
  };
}
