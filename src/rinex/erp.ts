/**
 * IGS ERP (Earth rotation parameters) "version 2" files — reader, writer
 * and an interpolator for polar motion and UT1−UTC.
 *
 * Format (IGSMAIL-1943, Kouba & Mireault 1998): a first line starting with
 * "version 2" (any case), free header/comment lines, a column-name line
 * (starting with MJD), a units line, then one whitespace-separated record
 * per epoch. Fields 1–12 are mandatory and in this order — MJD, Xpole,
 * Ypole, UT1−UTC, LOD, Xsig, Ysig, UTsig, LODsig, Nr, Nf, Nt; the optional
 * ones (rates, rate sigmas, correlations, …) appear in any order, so the
 * column-name line says which exist. Each analysis centre spells the names
 * its own way (IGS `Xpole`/`Xsig`/`Xrt`, ESA `X-pole`/`s-XP`/`X-RT`, CODE
 * `X-P`/`S-X`/`X-RT`/`C-XY`/`DPSI`…); they are mapped to one set of keys.
 *
 * Units in the file are integers: pole 1e-6″, UT1−UTC 1e-7 s, LOD 1e-7 s/day,
 * pole rates 1e-6″/day. Records here hold PHYSICAL units: arcseconds,
 * seconds, s/day, ″/day. Columns not mapped (correlations, nutation offsets
 * and their sigmas) are kept in `extra` as written (file integers) — their
 * scale differs between centres (CODE's correlations are E-2).
 */

/** One ERP epoch, physical units. */
export interface ErpRecord {
  /** Modified Julian Date of the epoch (as written, UTC). */
  mjd: number;
  /** Pole coordinates x, y (arcsec). */
  xp: number;
  yp: number;
  /** UT1 − UTC (s); some products give UT1R−UTC or UT1−TAI (see header). */
  ut1utc: number;
  /** Length-of-day excess (s/day). */
  lod: number;
  /** Formal sigmas (arcsec, s, s/day). */
  xpSigma: number;
  ypSigma: number;
  ut1Sigma: number;
  lodSigma: number;
  /** Receivers, fixed receivers, satellites (transmitters). */
  nr: number;
  nf: number;
  nt: number;
  /** Pole rates (arcsec/day) and their sigmas, when the file has them. */
  xpRate?: number;
  ypRate?: number;
  xpRateSigma?: number;
  ypRateSigma?: number;
  /** Other columns by their name in the file, as written (integers). */
  extra?: Record<string, number>;
}

type NumKey = Exclude<keyof ErpRecord, 'extra'>;

/** Canonical key and divisor (file integer / divisor = physical value; a
 *  division, so 185147 → 0.185147 exactly as printed) of each column. */
const KEYS: [NumKey, number, RegExp][] = [
  ['mjd', 1, /^MJD$/],
  ['xp', 1e6, /^(X-?POLE|X-P)$/],
  ['yp', 1e6, /^(Y-?POLE|Y-P)$/],
  ['ut1utc', 1e7, /^UT1R?-?(UTC|TAI)$/],
  ['lod', 1e7, /^LODR?$/],
  ['xpSigma', 1e6, /^(XSIG|S-XP|S-X)$/],
  ['ypSigma', 1e6, /^(YSIG|S-YP|S-Y)$/],
  ['ut1Sigma', 1e7, /^(UTSIG|S-UT)$/],
  ['lodSigma', 1e7, /^(LODSIG|S-LOD|S-LD)$/],
  ['nr', 1, /^NR$/],
  ['nf', 1, /^NF$/],
  ['nt', 1, /^NT$/],
  ['xpRate', 1e6, /^(XRT|X-RT)$/],
  ['ypRate', 1e6, /^(YRT|Y-RT)$/],
  ['xpRateSigma', 1e6, /^(XRTSIG|S-X-RT|S-XR)$/],
  ['ypRateSigma', 1e6, /^(YRTSIG|S-Y-RT|S-YR)$/],
];

function keyOf(name: string): [NumKey, number] | null {
  const n = name.toUpperCase();
  for (const [k, s, re] of KEYS) if (re.test(n)) return [k, s];
  return null;
}

export interface ErpFile {
  /** Every line before the first record: "version 2", comments, the
   *  column-name line and the units line. */
  header: string[];
  /** Column names, from the column-name line. */
  columns: string[];
  records: ErpRecord[];
}

/** Parse an IGS ERP version 2 file. Throws on another version. */
export function parseErp(text: string): ErpFile {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  if (!/^version\s+2/i.test(lines[0] ?? ''))
    throw new Error('parseErp: not an ERP "version 2" file');
  const header: string[] = [];
  let columns: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    if (columns.length && /^\s*\d+\.\d+\s/.test(l)) break;
    header.push(l);
    const t = l.trim().split(/\s+/);
    if (!columns.length && t[0]!.toUpperCase() === 'MJD') columns = t;
  }
  if (!columns.length) throw new Error('parseErp: no MJD column line');
  const map = columns.map(keyOf);
  const records: ErpRecord[] = [];
  for (; i < lines.length; i++) {
    const t = lines[i]!.trim().split(/\s+/);
    if (t.length < 12 || !/^\d/.test(t[0]!)) continue;
    const r = {} as ErpRecord;
    const extra: Record<string, number> = {};
    t.forEach((s, c) => {
      const v = Number(s);
      const m = map[c];
      if (m) r[m[0]] = m[1] === 1 ? v : v / m[1];
      else if (c < columns.length) extra[columns[c]!] = v;
    });
    if (Object.keys(extra).length) r.extra = extra;
    records.push(r);
  }
  return { header, columns, records };
}

/** The IGS combination's header, for files built from records. */
const IGS_HEADER = [
  'version 2',
  'EOP  SOLUTION',
  '  MJD       Xpole    Ypole   UT1-UTC    LOD   Xsig   Ysig   UTsig LODsig  Nr Nf Nt     Xrt    Yrt  Xrtsig Yrtsig',
  '               10**-6"        .1us    .1us/d    10**-6"     .1us  .1us/d                10**-6"/d    10**-6"/d',
];

/**
 * Write an ERP version 2 file. A parsed {@link ErpFile} keeps its header
 * and columns (each value right-aligned under the end of its column name,
 * MJD as F8.2 from column 1); bare records get the IGS layout.
 */
export function writeErp(erp: ErpFile | ErpRecord[]): string {
  const file: ErpFile = Array.isArray(erp)
    ? {
        header: IGS_HEADER,
        columns: IGS_HEADER[2]!.trim().split(/\s+/),
        records: erp,
      }
    : erp;
  const nameLine = file.header.find(
    (l) => l.trim().split(/\s+/)[0]!.toUpperCase() === 'MJD'
  )!;
  // End column (exclusive) of every column name.
  const ends: number[] = [];
  const re = /\S+/g;
  for (let m; (m = re.exec(nameLine));) ends.push(m.index + m[0].length);
  const map = file.columns.map(keyOf);
  const out = [...file.header];
  for (const r of file.records) {
    let line = r.mjd.toFixed(2).padStart(8);
    for (let c = 1; c < file.columns.length; c++) {
      const m = map[c];
      const v = m
        ? m[1] === 1
          ? (r[m[0]] ?? 0)
          : Math.round((r[m[0]] ?? 0) * m[1])
        : (r.extra?.[file.columns[c]!] ?? 0);
      const s = String(v);
      line += ' ' + s.padStart(Math.max(s.length, ends[c]! - line.length - 1));
    }
    out.push(line);
  }
  return out.join('\n') + '\n';
}

/**
 * Pole coordinates and UT1−UTC at `mjd` (UTC), linearly interpolated
 * between the bracketing records (sorted by MJD); null outside the
 * file's span. A leap second between the two records (UT1−UTC jumping by
 * ≈1 s) is removed before interpolating and restored from 0h UTC of the
 * day it takes effect.
 */
export function erpAt(
  erp: ErpFile | ErpRecord[],
  mjd: number
): { xp: number; yp: number; ut1utc: number; lod: number } | null {
  const recs = Array.isArray(erp) ? erp : erp.records;
  if (!recs.length || mjd < recs[0]!.mjd || mjd > recs.at(-1)!.mjd) return null;
  let lo = 0;
  let hi = recs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (recs[mid]!.mjd <= mjd) lo = mid;
    else hi = mid;
  }
  const a = recs[lo]!;
  const b = recs[hi]!;
  const f = b.mjd === a.mjd ? 0 : (mjd - a.mjd) / (b.mjd - a.mjd);
  const lin = (x: number, y: number) => x + (y - x) * f;
  const leap = Math.round(b.ut1utc - a.ut1utc);
  let ut1utc = lin(a.ut1utc, b.ut1utc - leap);
  if (leap !== 0 && mjd >= Math.floor(a.mjd) + 1) ut1utc += leap;
  return {
    xp: lin(a.xp, b.xp),
    yp: lin(a.yp, b.yp),
    ut1utc,
    lod: lin(a.lod, b.lod),
  };
}
