/**
 * SP3-c / SP3-d writer: an {@link Sp3File} (from {@link parseSp3} or built
 * by hand) as SP3 text, column for column as in the SP3-c (sp3c.txt) and
 * SP3-d (sp3d.pdf) line descriptions.
 *
 * Units are converted back to the file's: positions m → km, clocks s → µs,
 * velocities m/s → dm/s, clock rates s/s → 10⁻⁴ µs/s. A null sample is
 * written as the spec's "bad or absent" record (0.000000 position,
 * 999999.999999 clock) unless `badPositions` holds the original record.
 *
 * Header line 2 (GPS week, seconds of week, MJD, day fraction), the epoch
 * count and the satellite count are derived from the data, not copied from
 * the parsed header. Satellites are written in `satIds` order (the header
 * order, which the spec makes the record order), else sorted.
 *
 * Every line is padded to 80 columns, as IGS analysis centres write them.
 */
import type {
  Sp3Correlation,
  Sp3File,
  Sp3Sample,
  Sp3SdevExp,
  Sp3Velocity,
} from './sp3';

export interface Sp3WriteOptions {
  /** 'c' (≤ 85 satellites, exactly 4 comment lines of ≤ 57 characters)
   *  or 'd'. Default: the file's own version, else 'd'. */
  version?: 'c' | 'd';
}

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** MJD of the Unix epoch, 1970-01-01. */
const MJD_UNIX = 40587;
const BAD = 999999.999999;

const pad80 = (s: string) => s.padEnd(80);
const I = (v: number, w: number) => String(v).padStart(w);
const F = (v: number, w: number, d: number) => v.toFixed(d).padStart(w);
/** Optional integer field: blank when null/undefined. */
const OI = (v: number | null | undefined, w: number) =>
  v == null ? ' '.repeat(w) : I(v, w);

function calendar(ms: number) {
  const d = new Date(ms);
  const sec = d.getUTCSeconds() + d.getUTCMilliseconds() / 1000;
  return (
    I(d.getUTCFullYear(), 4) +
    ' ' +
    I(d.getUTCMonth() + 1, 2) +
    ' ' +
    I(d.getUTCDate(), 2) +
    ' ' +
    I(d.getUTCHours(), 2) +
    ' ' +
    I(d.getUTCMinutes(), 2) +
    ' ' +
    F(sec, 11, 8)
  );
}

/** cols 61–80 of a P or V record: sdev exponents and flags. */
function tail(sd: Sp3SdevExp | undefined, flags: string): string {
  const s =
    ' ' +
    OI(sd?.x, 2) +
    ' ' +
    OI(sd?.y, 2) +
    ' ' +
    OI(sd?.z, 2) +
    ' ' +
    OI(sd?.clk, 3) +
    ' ' +
    flags;
  return s.trimEnd() === '' ? '' : s;
}

/** EP / EV record (see {@link Sp3Correlation}). */
function correlationLine(tag: string, c: Sp3Correlation): string {
  const r = (v: number | null) =>
    ' ' + OI(v === null ? null : Math.round(v * 1e7), 8);
  return (
    tag +
    '  ' +
    OI(c.xSdev, 4) +
    ' ' +
    OI(c.ySdev, 4) +
    ' ' +
    OI(c.zSdev, 4) +
    ' ' +
    OI(c.clkSdev, 7) +
    r(c.xy) +
    r(c.xz) +
    r(c.xc) +
    r(c.yz) +
    r(c.yc) +
    r(c.zc)
  );
}

function recordLines(prn: string, s: Sp3Sample | null): string[] {
  const p = s ?? { x: 0, y: 0, z: 0, clk: null };
  const flags =
    (p.clockEvent ? 'E' : ' ') +
    (p.clockPredicted ? 'P' : ' ') +
    '  ' +
    (p.maneuver ? 'M' : ' ') +
    (p.orbitPredicted ? 'P' : ' ');
  const out = [
    'P' +
      prn +
      F(p.x / 1000, 14, 6) +
      F(p.y / 1000, 14, 6) +
      F(p.z / 1000, 14, 6) +
      F(p.clk === null ? BAD : p.clk * 1e6, 14, 6) +
      tail(p.sdevExp, flags),
  ];
  if (p.ep) out.push(correlationLine('EP', p.ep));
  const v: Sp3Velocity | undefined = p.vel;
  if (v) {
    out.push(
      'V' +
        prn +
        F(v.vx * 10, 14, 6) +
        F(v.vy * 10, 14, 6) +
        F(v.vz * 10, 14, 6) +
        F(v.clkRate === null ? BAD : v.clkRate * 1e10, 14, 6) +
        tail(v.sdevExp, '')
    );
    if (v.ev) out.push(correlationLine('EV', v.ev));
  }
  return out;
}

/** 17 three-character slots from col 10, `fill` in the unused ones. */
function slots(vals: string[], n: number, fill: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < n * 17; i += 17) {
    let s = '';
    for (let j = i; j < i + 17; j++) s += vals[j] ?? fill;
    out.push(s);
  }
  return out;
}

/** Write an SP3-c or SP3-d file. */
export function writeSp3(sp3: Sp3File, opts: Sp3WriteOptions = {}): string {
  const version =
    opts.version ??
    (sp3.version === 'c' || sp3.version === 'd' ? sp3.version : 'd');
  const ids = sp3.satIds?.length
    ? sp3.satIds
    : Object.keys(sp3.satellites).sort();
  if (version === 'c' && ids.length > 85) {
    throw new Error(`SP3-c holds at most 85 satellites (${ids.length})`);
  }
  const t0 = sp3.epochs[0] ?? GPS_EPOCH_MS;
  const hasVel =
    sp3.pvFlag === 'V' ||
    Object.values(sp3.satellites).some((a) => a.some((s) => s?.vel));
  const lines: string[] = [];

  // Line 1: version, P/V, start, epochs, data used, frame, orbit type, agency
  lines.push(
    '#' +
      version +
      (hasVel ? 'V' : 'P') +
      calendar(t0) +
      ' ' +
      I(sp3.epochs.length, 7) +
      ' ' +
      (sp3.dataUsed ?? '').padStart(5).slice(0, 5) +
      ' ' +
      (sp3.coordSys ?? '').padEnd(5).slice(0, 5) +
      ' ' +
      (sp3.orbitType ?? '').padEnd(3).slice(0, 3) +
      ' ' +
      (sp3.agency ?? '').padStart(4).slice(0, 4)
  );
  // Line 2: GPS week, seconds of week, interval, MJD, fraction of day
  const sinceGps = t0 - GPS_EPOCH_MS;
  const week = Math.floor(sinceGps / WEEK_MS);
  const dayMs = ((t0 % DAY_MS) + DAY_MS) % DAY_MS;
  lines.push(
    '## ' +
      I(week, 4) +
      ' ' +
      F((sinceGps - week * WEEK_MS) / 1000, 15, 8) +
      ' ' +
      F(sp3.intervalSec, 14, 8) +
      ' ' +
      I(Math.floor(t0 / DAY_MS) + MJD_UNIX, 5) +
      ' ' +
      F(dayMs / DAY_MS, 15, 13)
  );
  // Satellite IDs and accuracy exponents: 17 per line, ≥ 5 lines each
  const nLines = Math.max(5, Math.ceil(ids.length / 17));
  slots(ids, nLines, '  0').forEach((s, i) =>
    lines.push((i === 0 ? '+  ' + I(ids.length, 3) + '   ' : '+        ') + s)
  );
  const acc = ids.map((_, i) => I(sp3.accuracy?.[i] ?? 0, 3));
  for (const s of slots(acc, nLines, '  0')) lines.push('++       ' + s);
  // %c / %f / %i: file type, time system, sdev bases; the rest unused
  lines.push(
    '%c ' +
      (sp3.fileType || 'M').padEnd(2).slice(0, 2) +
      ' cc ' +
      (sp3.timeSystem || 'GPS').padEnd(3).slice(0, 3) +
      ' ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc',
    '%c cc cc ccc ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc',
    '%f ' +
      F(sp3.posBase ?? 0, 10, 7) +
      ' ' +
      F(sp3.clkBase ?? 0, 12, 9) +
      '  0.00000000000  0.000000000000000',
    '%f  0.0000000  0.000000000  0.00000000000  0.000000000000000',
    '%i    0    0    0    0      0      0      0      0         0',
    '%i    0    0    0    0      0      0      0      0         0'
  );
  // Comments: SP3-c exactly 4 of cols 4–60; SP3-d at least 4 of cols 4–80
  const width = version === 'c' ? 57 : 77;
  const comments = (sp3.comments ?? []).map((c) => c.slice(0, width));
  if (version === 'c') comments.length = Math.min(comments.length, 4);
  while (comments.length < 4) comments.push('C'.repeat(width));
  for (const c of comments) lines.push('/* ' + c);

  sp3.epochs.forEach((t, k) => {
    lines.push('*  ' + calendar(t));
    for (const prn of ids) {
      const s = sp3.satellites[prn]?.[k] ?? sp3.badPositions?.[prn]?.[k];
      lines.push(...recordLines(prn, s ?? null));
    }
  });
  lines.push('EOF');
  return lines.map(pad80).join('\n') + '\n';
}
