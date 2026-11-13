/**
 * RINEX CLOCK (.CLK) parser — high-rate (typically 30 s) precise satellite
 * clock corrections, the accuracy-limiting term for PPP that SP3's 5-minute
 * (linearly interpolated) clocks cannot match.
 *
 * `sats` holds the `AS` (satellite) clock biases only, in seconds; `AR`
 * (station) records — the bulk of a combined file — are skipped unless
 * `{ records: true }` is passed, which keeps every data record (AR, AS, CR,
 * DR, MS) with all its values for {@link writeClk}. The header is always
 * kept in full (see {@link ClkFile}).
 *
 * Reads RINEX CLOCK 2.x and 3.00–3.02 (labels in cols 61–80, 4-character
 * names) and 3.04 (labels in cols 66–85, 9-character names), per
 * rinex_clock300.txt and rinex_clock304.txt (Tables A15/A16).
 */

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
void GPS_EPOCH_MS;

/** One data record (Table A16). */
export interface ClkRecord {
  /** 'AR' receiver, 'AS' satellite, 'CR' calibration, 'DR'
   *  discontinuity, 'MS' monitor. */
  type: string;
  /** Receiver (4- or 9-character) or satellite ('G01') name. */
  name: string;
  /** Epoch in the file's time system, as epoch ms (no scale shift). */
  t: number;
  /** In file order: bias (s), bias sigma (s), rate (s/s), rate sigma,
   *  acceleration (1/s), acceleration sigma. Bias is clock − reference. */
  values: number[];
}

/** SYS / DCBS APPLIED or SYS / PCVS APPLIED. */
export interface ClkCorrectionsApplied {
  sys: string;
  program: string;
  source: string;
}

/** A "# OF CLK REF" group with its ANALYSIS CLK REF lines. */
export interface ClkRefGroup {
  /** Validity (ms, file time system); absent = whole file. */
  start?: number;
  stop?: number;
  refs: {
    name: string;
    id: string;
    /** A-priori clock constraint (s), when given. */
    constraint?: number;
  }[];
}

/** SOLN STA NAME / NUM. */
export interface ClkStation {
  name: string;
  /** DOMES number or other unique identifier. */
  id: string;
  /** Geocentric X/Y/Z in MILLIMETRES, as the header writes them (I11). */
  xMm: number;
  yMm: number;
  zMm: number;
}

export interface ClkFile {
  /** prn → time-sorted samples { t: GPS-scale ms, c: clock bias (s) }. */
  sats: Record<string, { t: number[]; c: number[] }>;
  /** Nominal sampling interval (s), inferred from the first satellite. */
  intervalSec: number;

  /* ── Header (Table A15); absent records are left undefined ── */
  /** e.g. 3.0, 3.02, 3.04. */
  version?: number;
  /** Satellite system of the file ('G', 'M', ... or '' when blank). */
  satSystem?: string;
  pgm?: string;
  runBy?: string;
  date?: string;
  comments?: string[];
  obsTypes?: { sys: string; types: string[] }[];
  timeSystem?: string;
  /** LEAP SECONDS as written: GPS−UTC in pre-3.04 IGS files, TAI−UTC
   *  ("UTC = TAI − n") in 3.04. */
  leapSeconds?: number;
  /** LEAP SECONDS GNSS (3.04): GPS−UTC. */
  leapSecondsGnss?: number;
  dcbsApplied?: ClkCorrectionsApplied[];
  pcvsApplied?: ClkCorrectionsApplied[];
  /** # / TYPES OF DATA, e.g. ['AS', 'AR']. */
  dataTypes?: string[];
  stationName?: string;
  stationId?: string;
  stationClkRef?: string;
  analysisCenter?: { id: string; name: string };
  clkRefs?: ClkRefGroup[];
  /** Number of receivers as declared in # OF SOLN STA / TRF. */
  numStations?: number;
  trf?: string;
  stations?: ClkStation[];
  /** PRN LIST. */
  prns?: string[];
  /** Header labels in file order (repeats included), so a writer can
   *  reproduce an analysis centre's own record order. */
  headerOrder?: string[];
  /** Every data record in file order — only with `{ records: true }`. */
  records?: ClkRecord[];
}

export interface ParseClkOptions {
  /** Keep every data record (AR/AS/CR/DR/MS, all values) in `records`. */
  records?: boolean;
}

const num = (s: string): number | undefined => {
  const t = s.trim();
  if (t === '') return undefined;
  const v = Number(t.replace(/[dD]/, 'E'));
  return Number.isFinite(v) ? v : undefined;
};

/** "yyyy mm dd hh mi ss.ssssss" (any spacing) → ms, or undefined. */
function epoch(s: string): number | undefined {
  const f = s.trim().split(/\s+/).map(Number);
  if (f.length < 6 || !f.every(Number.isFinite)) return undefined;
  const sec = f[5]!;
  return (
    Date.UTC(f[0]!, f[1]! - 1, f[2]!, f[3]!, f[4]!, Math.floor(sec)) +
    (sec % 1) * 1000
  );
}

/** Parse a RINEX CLOCK file. */
export function parseClk(text: string, opts: ParseClkOptions = {}): ClkFile {
  const sats: Record<string, { t: number[]; c: number[] }> = {};
  const lines = text.split('\n');
  const h: Partial<ClkFile> = {};
  const comments: string[] = [];
  const order: string[] = [];
  const records: ClkRecord[] | undefined = opts.records ? [] : undefined;
  // label column: 61 (≤ 3.02) or 66 (3.04)
  let lc = 60;
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '');
    if (i === 0 && line.slice(65).trim() === 'RINEX VERSION / TYPE') lc = 65;
    const label = line.slice(lc).trim();
    const c = line.slice(0, lc);
    if (line.includes('END OF HEADER')) {
      order.push('END OF HEADER');
      i++;
      break;
    }
    if (!label) continue;
    order.push(label);
    const wide = lc === 65;
    switch (label) {
      case 'RINEX VERSION / TYPE':
        // ≤ 3.02: F9.2,11X,A1,19X,A1 ; 3.04: F4.2,17X,A1,20X,A1
        h.version = num(wide ? c.slice(0, 4) : c.slice(0, 9));
        h.satSystem = (wide ? c.charAt(42) : c.charAt(40)).trim();
        break;
      case 'PGM / RUN BY / DATE':
        // ≤ 3.02: 3A20 ; 3.04: A19,2X,A19,2X,A21
        h.pgm = (wide ? c.slice(0, 19) : c.slice(0, 20)).trim();
        h.runBy = (wide ? c.slice(21, 40) : c.slice(20, 40)).trim();
        h.date = (wide ? c.slice(42, 63) : c.slice(40, 60)).trim();
        break;
      case 'COMMENT':
        comments.push(c.trimEnd());
        break;
      case 'SYS / # / OBS TYPES': {
        const t = c.slice(6).trim().split(/\s+/).filter(Boolean);
        const sys = c.charAt(0).trim();
        const obs = (h.obsTypes ??= []);
        if (sys) obs.push({ sys, types: t });
        else obs.at(-1)?.types.push(...t); // continuation line
        break;
      }
      case 'TIME SYSTEM ID':
        h.timeSystem = c.slice(3, 6).trim();
        break;
      case 'LEAP SECONDS':
        h.leapSeconds = num(c.slice(0, 6));
        break;
      case 'LEAP SECONDS GNSS':
        h.leapSecondsGnss = num(c.slice(0, 6));
        break;
      case 'SYS / DCBS APPLIED':
      case 'SYS / PCVS APPLIED': {
        // A1,1X,A17,1X,A40 — some ACs overflow the A17 program name, so
        // split on the blank run before the source instead of col 21.
        const rest = c.slice(2).trimEnd();
        const m =
          c.charAt(19) === ' ' || c.charAt(19) === ''
            ? [rest.slice(0, 17), rest.slice(18)]
            : rest.split(/\s{2,}/);
        const e = {
          sys: c.charAt(0).trim(),
          program: (m[0] ?? '').trim(),
          source: m.slice(1).join(' ').trim(),
        };
        if (label === 'SYS / DCBS APPLIED') (h.dcbsApplied ??= []).push(e);
        else (h.pcvsApplied ??= []).push(e);
        break;
      }
      case '# / TYPES OF DATA':
        h.dataTypes = c.slice(6).trim().split(/\s+/).filter(Boolean);
        break;
      case 'STATION NAME / NUM': {
        // A4,1X / A9,1X then A20 — Table A18 writes "USNO 40451S003" even
        // in 3.04, so split on the blank instead of the column
        const [name = '', ...id] = c.trim().split(/\s+/);
        h.stationName = name;
        h.stationId = id.join(' ');
        break;
      }
      case 'STATION CLK REF':
        h.stationClkRef = c.trim();
        break;
      case 'ANALYSIS CENTER': {
        // A3,2X,A55 — a 4-character id ("ESOC USING NAPEOS") is kept whole
        const id = c.charAt(3) === ' ' ? c.slice(0, 3) : c.slice(0, 4);
        h.analysisCenter = { id: id.trim(), name: c.slice(5).trim() };
        break;
      }
      case '# OF CLK REF':
        // I6,1X,I4,4I3,F10.6,1X,I4,4I3,F10.6 (blank epochs: whole file)
        (h.clkRefs ??= []).push({
          start: epoch(c.slice(7, 33)),
          stop: epoch(c.slice(34, 60)),
          refs: [],
        });
        break;
      case 'ANALYSIS CLK REF': {
        // A4,1X,A20,15X,E19.12 (3.04: A9,1X,...)
        const o = wide ? 5 : 0;
        const g = (h.clkRefs ??= []);
        if (!g.length) g.push({ refs: [] });
        const constraint = num(c.slice(40 + o, 59 + o));
        g.at(-1)!.refs.push({
          name: c.slice(0, 4 + o).trim(),
          id: c.slice(5 + o, 25 + o).trim(),
          ...(constraint !== undefined ? { constraint } : {}),
        });
        break;
      }
      case '# OF SOLN STA / TRF':
        h.numStations = num(c.slice(0, 6));
        h.trf = c.slice(10).trim();
        break;
      case 'SOLN STA NAME / NUM': {
        // A4,1X,A20,I11,1X,I11,1X,I11 (3.04: A9,1X,...) — millimetres
        const o = wide ? 5 : 0;
        (h.stations ??= []).push({
          name: c.slice(0, 4 + o).trim(),
          id: c.slice(5 + o, 25 + o).trim(),
          xMm: num(c.slice(25 + o, 36 + o)) ?? 0,
          yMm: num(c.slice(37 + o, 48 + o)) ?? 0,
          zMm: num(c.slice(49 + o, 60 + o)) ?? 0,
        });
        break;
      }
      case 'PRN LIST':
        (h.prns ??= []).push(...c.trim().split(/\s+/).filter(Boolean));
        break;
    }
  }

  // ── Data records ──
  // (hot loop: a full-day 30 s file has ~10⁶ lines)
  const val = (v: string) => {
    const x = +v;
    return Number.isNaN(x) ? (num(v) ?? NaN) : x;
  };
  const isRecord = (l: string) =>
    l.charCodeAt(2) === 32 &&
    l.charCodeAt(0) >= 65 &&
    l.charCodeAt(0) <= 90 &&
    l.charCodeAt(1) >= 65 &&
    l.charCodeAt(1) <= 90;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length < 3 || !isRecord(line)) continue;
    const isAs = line[0] === 'A' && line[1] === 'S';
    if (!isAs && !records) continue;
    // TYPE NAME Y M D H M S.sss <n> <values...>
    const p = line.slice(2).trim().split(/\s+/);
    if (p.length < 9) continue;
    const name = p[0]!;
    const s = +p[6]!;
    const t =
      Date.UTC(+p[1]!, +p[2]! - 1, +p[3]!, +p[4]!, +p[5]!, Math.floor(s)) +
      (s % 1) * 1000;
    if (!Number.isFinite(t)) continue;
    if (!records) {
      const bias = val(p[8]!); // clock bias (s)
      if (!Number.isFinite(bias)) continue;
      let e = sats[name];
      if (!e) sats[name] = e = { t: [], c: [] };
      e.t.push(t);
      e.c.push(bias);
      continue;
    }
    const n = +p[7]!;
    const values = p.slice(8).map(val);
    // values 3+ sit on continuation lines (4 per line)
    while (values.length < n && i + 1 < lines.length) {
      const next = lines[i + 1]!;
      if (isRecord(next) || next.trim() === '') break;
      i++;
      values.push(...next.trim().split(/\s+/).map(val));
    }
    records.push({ type: line.slice(0, 2), name, t, values });
    const bias = values[0]!;
    if (!isAs || !Number.isFinite(bias)) continue;
    let e = sats[name];
    if (!e) sats[name] = e = { t: [], c: [] };
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
  return {
    sats,
    intervalSec,
    ...h,
    comments,
    headerOrder: order,
    ...(records ? { records } : {}),
  };
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
