/**
 * Bias-SINEX 1.00 writer: a {@link BiasSinex} (parsed, or built from
 * estimates) as `.BIA` text, following the IGS format description
 * (S. Schaer, "SINEX BIAS — Solution (Software/technique) INdependent
 * EXchange Format for GNSS Biases, Version 1.00", 2016).
 *
 * Blocks are written in the specification's order — FILE/REFERENCE,
 * FILE/COMMENT, INPUT/ACKNOWLEDGMENTS, BIAS/DESCRIPTION,
 * BIAS/RECEIVER_INFORMATION, BIAS/SOLUTION — each only when present.
 * BIAS/SOLUTION lines use the fixed §4.8 layout: value `E21.15`, standard
 * deviation `E11.6`, optional slope + slope standard deviation; numbers are
 * written the way Fortran does (`0.123E+01`, `-.123E+01` when the leading
 * zero does not fit), so a file written by Fortran software (ESA, CODE)
 * comes back line for line.
 *
 * Sign convention (§6.1) is the file's: observed = true + bias, so values
 * are written exactly as held — nothing is negated or rescaled here.
 *
 * What a round trip does not keep: trailing blanks; the header's estimate
 * count (recomputed — §4.1 makes it the number of BIAS/SOLUTION lines);
 * comment lines inside FILE/COMMENT; free-format numbers (CNES writes
 * `F` values without standard deviations — they come back as `E21.15`).
 */
import type { BiasRecord, BiasSinex, BiasSinexEntry } from './bias-sinex';

/** Fortran `Ew.d`: `0.ddddE±ee`, the leading 0 dropped when it doesn't fit. */
function fortranE(v: number, w: number, d: number): string {
  let mant: string;
  let exp: number;
  if (v === 0) {
    mant = '0'.repeat(d);
    exp = 0;
  } else {
    const s = Math.abs(v).toExponential(d - 1);
    const e = s.indexOf('e');
    mant = s[0]! + s.slice(2, e);
    exp = +s.slice(e + 1) + 1;
  }
  const ex = Math.abs(exp);
  const exStr =
    ex < 100
      ? 'E' + (exp < 0 ? '-' : '+') + String(ex).padStart(2, '0')
      : (exp < 0 ? '-' : '+') + ex;
  const sign = v < 0 ? '-' : '';
  let out = sign + '0.' + mant + exStr;
  if (out.length > w) out = sign + '.' + mant + exStr;
  return out.padStart(w);
}

/** GPS-scale ms → `YYYY:DDD:SSSSS`; ±Infinity/NaN → `0000:000:00000`. */
function epoch(ms: number): string {
  if (!Number.isFinite(ms)) return '0000:000:00000';
  const y = new Date(ms).getUTCFullYear();
  const t = ms - Date.UTC(y, 0, 1);
  const doy = Math.floor(t / 86400_000) + 1;
  const sod = Math.round((t - (doy - 1) * 86400_000) / 1000);
  return (
    String(y).padStart(4, '0') +
    ':' +
    String(doy).padStart(3, '0') +
    ':' +
    String(sod).padStart(5, '0')
  );
}

/** The §4.8 column-header comment line (slope columns when used). */
const COLS =
  '*BIAS SVN_ PRN STATION__ OBS1 OBS2 BIAS_START____ BIAS_END______ UNIT __ESTIMATED_VALUE____ _STD_DEV___';
const SLOPE_COLS = ' __ESTIMATED_SLOPE____ _STD_DEV___';

/** One BIAS/SOLUTION data line (§4.8, 137 columns with slope). */
export function biasSolutionLine(r: BiasRecord): string {
  let s =
    ' ' +
    r.type.padEnd(4) +
    ' ' +
    (r.svn ?? '').padEnd(4) +
    ' ' +
    r.prn.padEnd(3) +
    ' ' +
    r.station.padEnd(9) +
    ' ' +
    r.obs1.padEnd(4) +
    ' ' +
    r.obs2.padEnd(4) +
    ' ' +
    epoch(r.startMs) +
    ' ' +
    epoch(r.endMs) +
    ' ' +
    r.unit.padEnd(4) +
    ' ' +
    fortranE(r.value, 21, 15) +
    ' ' +
    (r.std != null ? fortranE(r.std, 11, 6) : ' '.repeat(11));
  if (r.slope != null || r.slopeStd != null)
    s +=
      ' ' +
      (r.slope != null ? fortranE(r.slope, 21, 15) : ' '.repeat(21)) +
      ' ' +
      (r.slopeStd != null ? fortranE(r.slopeStd, 11, 6) : ' '.repeat(11));
  return s.trimEnd();
}

const entries = (
  list: BiasSinexEntry[],
  line: (key: string, value: string) => string
) => list.map((e) => ('comment' in e ? e.comment : line(e.key, e.value)));

/** DESCRIPTION keys whose value is an integer `1X,I12` (§4.6). */
const INT_KEYS = new Set(['OBSERVATION_SAMPLING', 'PARAMETER_SPACING']);

export interface WriteBiasSinexOptions {
  /** Header fields to use when the input has no header (or to override). */
  fileAgency?: string;
  dataAgency?: string;
  createdMs?: number;
}

/** Write a {@link BiasSinex} as Bias-SINEX 1.00 text. */
export function writeBiasSinex(
  bias: BiasSinex,
  opts: WriteBiasSinexOptions = {}
): string {
  const recs = bias.records;
  const h = bias.header;
  let start = h?.startMs;
  let end = h?.endMs;
  if (start == null || end == null) {
    start = Infinity;
    end = -Infinity;
    for (const r of recs) {
      if (Number.isFinite(r.startMs)) start = Math.min(start, r.startMs);
      if (Number.isFinite(r.endMs)) end = Math.max(end, r.endMs);
    }
  }
  const mode =
    h?.mode ||
    (recs.length > 0 && recs.every((r) => r.type === 'OSB') ? 'A' : 'R');
  const out: string[] = [
    '%=BIA ' +
      (h?.version || '1.00') +
      ' ' +
      (opts.fileAgency ?? h?.fileAgency ?? '').padEnd(3) +
      ' ' +
      epoch(opts.createdMs ?? h?.createdMs ?? NaN) +
      ' ' +
      (opts.dataAgency ?? h?.dataAgency ?? '').padEnd(3) +
      ' ' +
      epoch(start) +
      ' ' +
      epoch(end) +
      ' ' +
      mode +
      ' ' +
      String(recs.length).padStart(8, '0'),
  ];
  const sep = bias.separator ?? '*' + '-'.repeat(79);
  out.push(...(bias.preamble ?? (sep ? [sep] : [])));

  const blocks: [string, string[]][] = [];
  if (bias.reference)
    blocks.push([
      'FILE/REFERENCE',
      entries(bias.reference, (k, v) => ' ' + k.padEnd(18) + ' ' + v),
    ]);
  if (bias.comments)
    blocks.push(['FILE/COMMENT', bias.comments.map((c) => ' ' + c)]);
  if (bias.acknowledgments)
    blocks.push([
      'INPUT/ACKNOWLEDGMENTS',
      bias.acknowledgments.map(
        (a) => ' ' + a.agency.padEnd(3) + ' ' + a.description
      ),
    ]);
  blocks.push([
    'BIAS/DESCRIPTION',
    bias.description
      ? entries(
          bias.description,
          (k, v) =>
            ' ' + k.padEnd(39) + ' ' + (INT_KEYS.has(k) ? v.padStart(12) : v)
        )
      : [
          ' ' +
            'BIAS_MODE'.padEnd(39) +
            ' ' +
            (mode === 'A' ? 'ABSOLUTE' : 'RELATIVE'),
          ' ' + 'TIME_SYSTEM'.padEnd(39) + ' G',
        ],
  ]);
  if (bias.receivers)
    blocks.push([
      'BIAS/RECEIVER_INFORMATION',
      bias.receivers.map((r) =>
        'comment' in r
          ? r.comment
          : (
              ' ' +
              r.station.padEnd(9) +
              ' ' +
              r.system.padEnd(1) +
              ' ' +
              r.group.padEnd(9) +
              ' ' +
              epoch(r.startMs) +
              ' ' +
              epoch(r.endMs) +
              ' ' +
              r.receiverType.padEnd(20) +
              ' ' +
              r.firmware
            ).trimEnd()
      ),
    ]);

  const sol: string[] = [];
  const comments = bias.solutionComments ?? [
    {
      before: 0,
      text: recs.some((r) => r.slope != null) ? COLS + SLOPE_COLS : COLS,
    },
  ];
  let c = 0;
  for (let i = 0; i <= recs.length; i++) {
    while (c < comments.length && comments[c]!.before <= i)
      sol.push(comments[c++]!.text);
    if (i < recs.length) sol.push(biasSolutionLine(recs[i]!));
  }
  blocks.push(['BIAS/SOLUTION', sol]);

  blocks.forEach(([name, lines], i) => {
    if (i > 0 && sep) out.push(sep);
    out.push('+' + name);
    for (const l of lines) out.push(l);
    out.push('-' + name);
  });
  if (sep) out.push(sep);
  out.push('%=ENDBIA');
  return out.map((l) => l.trimEnd()).join('\n') + '\n';
}
