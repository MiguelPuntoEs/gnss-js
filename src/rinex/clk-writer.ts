/**
 * RINEX CLOCK writer: a {@link ClkFile} as RINEX CLOCK 3.04 (labels in cols
 * 66–85, 9-character names) or, for `version` < 3.04, the 2.x/3.00–3.02
 * layout (labels in cols 61–80, 4-character names) — Tables A15/A16 of
 * rinex_clock304.txt and rinex_clock300.txt.
 *
 * Data records come from `records` (parse with `{ records: true }` to keep
 * them all); without them the `AS` biases in `sats` are written, one value
 * per record. Clock values are in seconds, written E19.12 ("0.dddE±ee");
 * station coordinates are written as given, in millimetres (I11).
 *
 * Header records follow `headerOrder` when present (an analysis centre's
 * own order), else the order of Table A15. Counts (# OF SOLN STA, # OF
 * SOLN SATS, # OF CLK REF) are derived from the lists. Header lines are
 * padded to their full width; data lines carry no trailing blanks.
 *
 * Not converted between versions: LEAP SECONDS is written as stored (IGS
 * files before 3.04 put GPS−UTC there, 3.04 TAI−UTC), and names longer
 * than 4 characters do not fit the pre-3.04 layout.
 */
import type { ClkFile, ClkRecord } from './clk';

export interface ClkWriteOptions {
  /** RINEX CLOCK version to write. Default: the file's, else 3.04. */
  version?: number;
}

const I = (v: number, w: number) => String(v).padStart(w);

/** Fortran E19.12: "0.dddddddddddde±ee", right-aligned in `w`. */
export function fortranE(v: number, d = 12, w = 19): string {
  if (!Number.isFinite(v)) return 'NaN'.padStart(w);
  let s: string;
  if (v === 0) {
    s = (Object.is(v, -0) ? '-' : '') + '0.' + '0'.repeat(d) + 'E+00';
  } else {
    const [m, e] = Math.abs(v)
      .toExponential(d - 1)
      .split('e');
    const exp = Number(e) + 1;
    const ae = Math.abs(exp);
    s =
      (v < 0 ? '-' : '') +
      '0.' +
      m!.replace('.', '') +
      'E' +
      (exp < 0 ? '-' : '+') +
      (ae < 10 ? '0' + ae : String(ae));
  }
  return s.padStart(w);
}

function parts(ms: number) {
  const d = new Date(Math.floor(ms / 1000) * 1000);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds() + (ms - d.getTime()) / 1000,
  };
}

/** I4,4I3,F10.6 (header epochs, both layouts). */
function hdrEpoch(ms: number): string {
  const p = parts(ms);
  return (
    I(p.y, 4) +
    I(p.mo, 3) +
    I(p.d, 3) +
    I(p.h, 3) +
    I(p.mi, 3) +
    p.s.toFixed(6).padStart(10)
  );
}

function recordLines(r: ClkRecord, wide: boolean): string[] {
  const p = parts(r.t);
  const n = r.values.length;
  const head = wide
    ? // A2,1X,A9,1X,I4,1X,4(I2,1X),F9.6,1X,I2,3X — month to minute
      // zero-filled as in both Table A17 examples
      r.type +
      ' ' +
      r.name.padEnd(9) +
      ' ' +
      I(p.y, 4) +
      ' ' +
      [p.mo, p.d, p.h, p.mi]
        .map((v) => String(v).padStart(2, '0') + ' ')
        .join('') +
      p.s.toFixed(6).padStart(9) +
      ' ' +
      I(n, 2) +
      '   '
    : // A2,1X,A4,1X,I4,4I3,F10.6,I3,3X
      r.type +
      ' ' +
      r.name.padEnd(4) +
      ' ' +
      I(p.y, 4) +
      [p.mo, p.d, p.h, p.mi].map((v) => I(v, 3)).join('') +
      p.s.toFixed(6).padStart(10) +
      I(n, 3) +
      '   ';
  // E19.12 values: 2X between them in 3.04, 1X before
  const sep = wide ? '  ' : ' ';
  const out = [
    head +
      r.values
        .slice(0, 2)
        .map((v) => fortranE(v))
        .join(sep),
  ];
  for (let k = 2; k < n; k += 4) {
    const chunk = r.values.slice(k, k + 4).map((v) => fortranE(v));
    out.push((wide ? '   ' : '') + chunk.join(sep));
  }
  return out;
}

/** Table A15 order, expanded for the given file. */
function canonicalOrder(c: ClkFile, lines: Map<string, string[]>): string[] {
  const n = (l: string) => lines.get(l)?.length ?? 0;
  const order: string[] = [];
  const rep = (l: string, k = n(l)) => {
    for (let i = 0; i < k; i++) order.push(l);
  };
  for (const l of [
    'RINEX VERSION / TYPE',
    'PGM / RUN BY / DATE',
    'COMMENT',
    'SYS / # / OBS TYPES',
    'TIME SYSTEM ID',
    'LEAP SECONDS',
    'LEAP SECONDS GNSS',
    'SYS / DCBS APPLIED',
    'SYS / PCVS APPLIED',
    '# / TYPES OF DATA',
    'STATION NAME / NUM',
    'STATION CLK REF',
    'ANALYSIS CENTER',
  ])
    rep(l);
  for (const g of c.clkRefs ?? []) {
    order.push('# OF CLK REF');
    rep('ANALYSIS CLK REF', g.refs.length);
  }
  for (const l of [
    '# OF SOLN STA / TRF',
    'SOLN STA NAME / NUM',
    '# OF SOLN SATS',
    'PRN LIST',
  ])
    rep(l);
  order.push('END OF HEADER');
  return order;
}

/** Write a RINEX CLOCK file. */
export function writeClk(clk: ClkFile, opts: ClkWriteOptions = {}): string {
  const version = opts.version ?? clk.version ?? 3.04;
  const wide = version >= 3.04 - 1e-9;
  const lc = wide ? 65 : 60;
  const nw = wide ? 9 : 4; // receiver name width
  const records: ClkRecord[] = clk.records ?? asRecords(clk);
  const prns = clk.prns ?? Object.keys(clk.sats).sort();
  if (!wide) {
    const long = [
      ...records.map((r) => r.name),
      ...(clk.stations ?? []).map((s) => s.name),
    ].find((n) => n.length > 4);
    if (long)
      throw new Error(
        `RINEX CLOCK ${version.toFixed(2)} holds 4-character names ("${long}"); write 3.04`
      );
  }

  // Header lines, per label in their own order
  const L = new Map<string, string[]>();
  const add = (label: string, content: string) => {
    const a = L.get(label);
    const line = content.padEnd(lc).slice(0, Math.max(lc, content.length));
    if (a) a.push(line);
    else L.set(label, [line]);
  };
  const v = version.toFixed(2);
  add(
    'RINEX VERSION / TYPE',
    wide
      ? (v.padEnd(4) + ' '.repeat(17) + 'C').padEnd(42) + (clk.satSystem ?? '')
      : (v.padStart(9) + ' '.repeat(11) + 'C').padEnd(40) +
          (clk.satSystem ?? '')
  );
  add(
    'PGM / RUN BY / DATE',
    wide
      ? (clk.pgm ?? '').padEnd(19) +
          '  ' +
          (clk.runBy ?? '').padEnd(19) +
          '  ' +
          (clk.date ?? '')
      : (clk.pgm ?? '').padEnd(20) +
          (clk.runBy ?? '').padEnd(20) +
          (clk.date ?? '')
  );
  for (const c of clk.comments ?? []) add('COMMENT', c);
  for (const o of clk.obsTypes ?? []) {
    const per = wide ? 14 : 13;
    for (let k = 0; k < Math.max(1, o.types.length); k += per) {
      const t = o.types.slice(k, k + per).join(' ');
      add(
        'SYS / # / OBS TYPES',
        k === 0
          ? o.sys + '  ' + I(o.types.length, 3) + (wide ? '  ' : ' ') + t
          : ' '.repeat(wide ? 8 : 7) + t
      );
    }
  }
  if (clk.timeSystem) add('TIME SYSTEM ID', '   ' + clk.timeSystem);
  if (clk.leapSeconds !== undefined) add('LEAP SECONDS', I(clk.leapSeconds, 6));
  if (clk.leapSecondsGnss !== undefined)
    add('LEAP SECONDS GNSS', I(clk.leapSecondsGnss, 6));
  for (const [label, list] of [
    ['SYS / DCBS APPLIED', clk.dcbsApplied],
    ['SYS / PCVS APPLIED', clk.pcvsApplied],
  ] as const)
    for (const e of list ?? [])
      add(
        label,
        // A1,1X,A17,1X,A40; a longer program name keeps two blanks before
        // the source so a reader can still split them
        e.sys.padEnd(1) +
          ' ' +
          (e.program.length > 17
            ? e.program + '  '
            : e.program.padEnd(17) + ' ') +
          e.source
      );
  const types =
    clk.dataTypes ?? [...new Set(records.map((r) => r.type))].sort();
  add(
    '# / TYPES OF DATA',
    I(types.length, 6) + types.map((t) => '    ' + t).join('')
  );
  if (clk.stationName !== undefined)
    add(
      'STATION NAME / NUM',
      clk.stationName.padEnd(nw) + ' ' + (clk.stationId ?? '')
    );
  if (clk.stationClkRef !== undefined)
    add('STATION CLK REF', clk.stationClkRef);
  if (clk.analysisCenter)
    add(
      'ANALYSIS CENTER',
      (clk.analysisCenter.id + ' ').padEnd(5) + clk.analysisCenter.name
    );
  for (const g of clk.clkRefs ?? []) {
    add(
      '# OF CLK REF',
      I(g.refs.length, 6) +
        (g.start !== undefined && g.stop !== undefined
          ? ' ' + hdrEpoch(g.start) + ' ' + hdrEpoch(g.stop)
          : '')
    );
    for (const r of g.refs)
      add(
        'ANALYSIS CLK REF',
        r.name.padEnd(nw) +
          ' ' +
          r.id.padEnd(20) +
          (r.constraint !== undefined
            ? ' '.repeat(15) + fortranE(r.constraint)
            : '')
      );
  }
  if (clk.stations || clk.trf !== undefined)
    add(
      '# OF SOLN STA / TRF',
      I(clk.stations?.length ?? clk.numStations ?? 0, 6) +
        '    ' +
        (clk.trf ?? '')
    );
  for (const s of clk.stations ?? [])
    add(
      'SOLN STA NAME / NUM',
      s.name.padEnd(nw) +
        ' ' +
        s.id.padEnd(20) +
        I(s.xMm, 11) +
        ' ' +
        I(s.yMm, 11) +
        ' ' +
        I(s.zMm, 11)
    );
  if (prns.length) {
    add('# OF SOLN SATS', I(prns.length, 6));
    const per = wide ? 16 : 15;
    for (let k = 0; k < prns.length; k += per)
      add(
        'PRN LIST',
        prns
          .slice(k, k + per)
          .map((p) => p + ' ')
          .join('')
      );
  }
  add('END OF HEADER', '');

  // Walk the record order; lines it doesn't account for go after the
  // last line of their label (else before END OF HEADER).
  const order = clk.headerOrder?.length
    ? clk.headerOrder
    : canonicalOrder(clk, L);
  const out: { label: string; line: string }[] = [];
  for (const label of order) {
    const line = L.get(label)?.shift();
    if (line !== undefined) out.push({ label, line });
  }
  for (const [label, rest] of L) {
    for (const line of rest) {
      let at = out.map((o) => o.label).lastIndexOf(label);
      if (at < 0) at = out.findIndex((o) => o.label === 'END OF HEADER') - 1;
      if (at < 0) at = out.length - 1;
      out.splice(at + 1, 0, { label, line });
    }
  }
  if (!out.some((o) => o.label === 'END OF HEADER'))
    out.push({ label: 'END OF HEADER', line: ''.padEnd(lc) });

  const text = out.map((o) => o.line + o.label.padEnd(20));
  for (const r of records) text.push(...recordLines(r, wide));
  return text.join('\n') + '\n';
}

/** `AS` records from the lean `sats` table, by epoch then PRN-list order. */
function asRecords(clk: ClkFile): ClkRecord[] {
  const rank = new Map((clk.prns ?? []).map((p, i) => [p, i]));
  const out: ClkRecord[] = [];
  for (const [name, e] of Object.entries(clk.sats))
    e.t.forEach((t, k) => out.push({ type: 'AS', name, t, values: [e.c[k]!] }));
  const r = (n: string) => rank.get(n) ?? Infinity;
  return out.sort(
    (a, b) => a.t - b.t || r(a.name) - r(b.name) || (a.name < b.name ? -1 : 1)
  );
}
