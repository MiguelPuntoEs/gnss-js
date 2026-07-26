/**
 * Compact RINEX (Hatanaka / CRX) *compression* — the inverse of crx.ts.
 *
 * This is a faithful TypeScript port of RNXCMP's `rnx2crx.c` (v4.2.0,
 * Y. Hatanaka / GSI Japan), operating on RINEX text in and CRINEX text
 * out. It reproduces the reference compressor byte-for-byte in the data
 * section (the CRINEX header's PROG/DATE line carries a timestamp, so it
 * is the only line that legitimately differs from a given run of the C
 * tool). Validated against the `rnx2crx`/`crx2rnx` oracles on real
 * multi-GNSS RINEX 3.03/3.04 observation files.
 *
 * Supports RINEX 2.x (CRINEX 1.0) and RINEX 3.x / 4.0x (CRINEX 3.0).
 * The RINEX 4.02 pico-second epoch record (CRINEX 3.1) is handled too.
 */

const ARC_ORDER = 3;

interface DataField {
  u: number[]; // upper digits per difference order (0..ARC_ORDER)
  l: number[]; // lower 5 digits per difference order
  order: number; // -1 = blank field
}

interface ClockField {
  u: number[];
  l: number[];
}

function emptyData(): DataField {
  return { u: [0, 0, 0, 0], l: [0, 0, 0, 0], order: -1 };
}

/** C `atol` on a substring: skip leading whitespace, optional sign,
 * consume digits until the first non-digit. */
function cAtol(s: string): number {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  let sign = 1;
  if (s[i] === '+' || s[i] === '-') {
    if (s[i] === '-') sign = -1;
    i++;
  }
  let n = 0;
  let any = false;
  while (i < s.length && s[i]! >= '0' && s[i]! <= '9') {
    n = n * 10 + (s.charCodeAt(i) - 48);
    i++;
    any = true;
  }
  return any ? sign * n : 0;
}

/**
 * Text-differencing (rnx2crx `strdiff`): emit only how s2 differs from s1.
 * ' ' = unchanged, '&' = became a space, else the new char. Trailing
 * spaces are chopped. Returns the diff WITHOUT a trailing newline — the
 * caller decides what follows (clock offset, then '\n').
 */
function strdiff(s1: string, s2: string): string {
  let ds = '';
  const n = Math.min(s1.length, s2.length);
  let i = 0;
  for (; i < n; i++) {
    if (s2[i] === s1[i]) ds += ' ';
    else if (s2[i] === ' ') ds += '&';
    else ds += s2[i];
  }
  if (s1.length > s2.length) {
    // Remaining s1 chars: non-space → '&', space → ' '
    for (let k = i; k < s1.length; k++) ds += s1[k] === ' ' ? ' ' : '&';
  } else if (s2.length > s1.length) {
    ds += s2.slice(i); // verbatim
  }
  // Chop trailing spaces (matches the `while(*ds==' ')` walk-back).
  let end = ds.length;
  while (end > 0 && ds[end - 1] === ' ') end--;
  return ds.slice(0, end);
}

/** rnx2crx `read_value`: split a 14-char F14.3 field into upper digits
 * and lower-5-digits, keyed off the decimal point at column 10. */
function readValue(field14: string): { u: number; l: number } {
  const c = field14.padEnd(14, ' ').split('');
  const p7 = c[7]!;
  // shift two digits over the decimal point
  c[10] = c[9]!;
  c[9] = c[8]!;
  let l = cAtol(c.slice(9, 14).join(''));
  let u: number;
  if (p7 === ' ') {
    u = 0;
  } else if (p7 === '-') {
    u = 0;
    l = -l;
  } else {
    c[8] = '.';
    u = cAtol(c.slice(0, 14).join(''));
    if (u < 0) l = -l;
  }
  return { u, l };
}

/** rnx2crx `putdiff`: normalise carry between upper/lower and format. */
function putdiff(dddu: number, dddl: number): string {
  dddu += Math.trunc(dddl / 100000);
  dddl %= 100000;
  if (dddu < 0 && dddl > 0) {
    dddu++;
    dddl -= 100000;
  } else if (dddu > 0 && dddl < 0) {
    dddu--;
    dddl += 100000;
  }
  if (dddu === 0) return String(dddl);
  return `${dddu}${String(Math.abs(dddl)).padStart(5, '0')}`;
}

/** rnx2crx `put_clock`: like putdiff but 8 lower digits + arc marker. */
function putClock(du: number, dl: number, cOrder: number): string {
  du += Math.trunc(dl / 100000000);
  dl %= 100000000;
  if (du < 0 && dl > 0) {
    du++;
    dl -= 100000000;
  } else if (du > 0 && dl < 0) {
    du--;
    dl += 100000000;
  }
  let out = '';
  if (cOrder === 0) out += `${ARC_ORDER}&`;
  if (du === 0) out += String(dl);
  else out += `${du}${String(Math.abs(dl)).padStart(8, '0')}`;
  return out;
}

/** Right-trim a line of trailing spaces and a possible CR, as both
 * `get_next_epoch` and `read_chk_line` do. */
function chop(line: string): string {
  let end = line.length;
  if (end > 0 && line[end - 1] === '\r') end--;
  while (end > 0 && line[end - 1] === ' ') end--;
  return line.slice(0, end);
}

interface Sat {
  data: DataField[];
  flag: string;
  ntypeRec: number;
}

/** Parse one satellite's observation record(s) into diffs + flags,
 * mirroring rnx2crx `ggetline`. `lines`/`li` is the line cursor. */
function readSat(
  lines: string[],
  cursor: { li: number },
  rinexVersion: number,
  ntype: number,
  ntypeGnss: Record<string, number>
): { sat: Sat; satId: string } | null {
  let line = chop(lines[cursor.li++] ?? '');
  let maxField: number;
  let ntypeRec: number;
  let firstRec: number; // offset of first record in the line
  let satId = '';
  if (rinexVersion === 2) {
    maxField = 5;
    ntypeRec = ntype;
    firstRec = 0;
  } else {
    satId = line.slice(0, 3);
    const sys = line[0]!;
    maxField = ntypeRec = ntypeGnss[sys] ?? -1;
    if (maxField < 0) return null; // GNSS type not in header
    firstRec = 3;
  }
  const data: DataField[] = [];
  let flag = '';
  for (let i = 0; i < ntypeRec; i += maxField) {
    const nfield = Math.min(ntypeRec - i, maxField);
    // Pad the record area to 16*nfield chars from firstRec.
    const need = firstRec + 16 * nfield;
    let body = line;
    if (body.length < need) body = body.padEnd(need, ' ');
    for (let j = 0; j < nfield; j++) {
      const p = firstRec + j * 16;
      const rec = body.slice(p, p + 16); // 14 value + 2 flag
      const d = emptyData();
      if (rec[10] === '.') {
        flag += rec[14] ?? ' ';
        flag += rec[15] ?? ' ';
        const v = readValue(rec.slice(0, 14));
        d.u[0] = v.u;
        d.l[0] = v.l;
        d.order = 0;
      } else if (rec.slice(0, 14).trim() === '') {
        flag += rec[14] ?? ' ';
        flag += rec[15] ?? ' ';
        d.order = -1;
      } else {
        // Abnormal field — bail (caller skips the epoch).
        return null;
      }
      data.push(d);
    }
    if (i + maxField < ntypeRec) {
      line = chop(lines[cursor.li++] ?? ''); // continuation line
    }
  }
  return { sat: { data, flag, ntypeRec }, satId };
}

export interface WriteCrxOptions {
  /** CRINEX PROG / DATE program label (≤20 chars). */
  prog?: string;
  /** CRINEX PROG / DATE timestamp (as `dd-MMM-yy HH:mm`). Defaults to now (UTC). */
  date?: string;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function crinexDate(): string {
  const d = new Date();
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mon = MONTHS[d.getUTCMonth()];
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}-${mon}-${yy} ${hh}:${mm}`;
}

/**
 * Compress a full RINEX observation file (text) to Compact RINEX (text).
 * The inverse of the crx.ts decoder. Throws on structurally invalid input.
 */
export function writeCrx(
  rinexText: string,
  opts: WriteCrxOptions = {}
): string {
  const rawLines = rinexText.split('\n');
  const cursor = { li: 0 };
  const out: string[] = [];

  // ---- Header ----
  const firstLine = chop(rawLines[cursor.li++] ?? '');
  if (
    firstLine.slice(60, 80) !== 'RINEX VERSION / TYPE' ||
    firstLine[20] !== 'O'
  ) {
    throw new Error('writeCrx: not a RINEX observation file');
  }
  const rinexVersion = parseInt(firstLine, 10); // integer part
  const rinexVersionFull = readVersionFull(firstLine);
  if (rinexVersionFull < 0) throw new Error('writeCrx: invalid RINEX version');

  const crxVersion =
    rinexVersionFull >= 402 ? '3.1' : rinexVersion === 2 ? '1.0' : '3.0';
  out.push(
    `${crxVersion.padEnd(20)}${'COMPACT RINEX FORMAT'.padEnd(40)}${'CRINEX VERS   / TYPE'.padEnd(20)}`
  );
  const prog = (opts.prog ?? 'gnss-js writeCrx').slice(0, 40);
  const date = opts.date ?? crinexDate();
  out.push(`${prog.padEnd(40)}${date.padEnd(20)}CRINEX PROG / DATE`);
  out.push(firstLine);

  let ntype = 0; // RINEX2 obs type count
  const ntypeGnss: Record<string, number> = {}; // RINEX3 per-system count
  let line: string;
  do {
    line = chop(rawLines[cursor.li++] ?? '');
    out.push(line);
    // RINEX labels live in columns 60–79; tolerate the odd file whose
    // label is shifted a column or two (real files sit exactly at 60,
    // and so stay byte-exact with the reference compressor).
    const label = line.slice(60).trimStart();
    if (label.startsWith('# / TYPES OF OBSERV') && line[5] !== ' ') {
      ntype = parseInt(line, 10);
    } else if (label.startsWith('SYS / # / OBS TYPES') && line[0] !== ' ') {
      ntypeGnss[line[0]!] = parseInt(line.slice(3), 10);
    }
    if (cursor.li >= rawLines.length) break; // guard against a headerless file
  } while (!line.slice(60).trimStart().startsWith('END OF HEADER'));

  // ---- Field offsets (fixed per version) ----
  const v2 = rinexVersion === 2;
  const off = v2
    ? { event: 28, nsat: 29, satlst: 32, clock: 68, satOld: 32, shiftClk: 1 }
    : {
        event: 31,
        nsat: 32,
        satlst: 41,
        clock: 41,
        satOld: 41,
        shiftClk: 4,
        psec: 57,
      };

  // ---- Epoch loop state ----
  let oldline = '&';
  let nsatOld = 0;
  let clk0: ClockField = { u: [0, 0, 0, 0], l: [0, 0, 0, 0] };
  let dy0: DataField[][] = []; // previous epoch, per-sat
  let flag0: string[] = [];
  let oldpsec = '';
  let clkOrderPrev = -1; // persists across epochs like C `clk_order`

  const resetArcs = () => {
    oldline = '&';
    nsatOld = 0;
    clkOrderPrev = -1;
  };

  for (;;) {
    if (cursor.li >= rawLines.length) break;
    let epoch = rawLines[cursor.li];
    // Genuine EOF: trailing empty string from split on final '\n'.
    if (epoch === undefined) break;
    if (epoch === '' && cursor.li === rawLines.length - 1) break;
    cursor.li++;
    epoch = chop(epoch);
    if (epoch === '') continue;

    let newline: string;
    if (v2) {
      newline = epoch;
    } else {
      // pad epoch record to 41 (satellite IDs get written from col 41)
      newline = epoch.length < 41 ? epoch.padEnd(41, ' ') : epoch;
    }

    // Event flag > 1: copy verbatim event block, reset arcs.
    const eventFlag = parseInt(newline[off.event] ?? '0', 10) || 0;
    if (eventFlag > 1) {
      putEventData(rawLines, cursor, v2, newline, out, ntypeGnss, (n) => {
        ntype = n;
      });
      resetArcs();
      clk0 = { u: [0, 0, 0, 0], l: [0, 0, 0, 0] };
      dy0 = [];
      flag0 = [];
      continue;
    }

    // pico-second record (RINEX ≥ 4.02) — rare; preserved if present.
    let newpsec = '';
    if (rinexVersionFull >= 402 && newline.length === 62) {
      const psec = newline.slice(off.psec!, off.psec! + 5);
      if (/^\d{5}$/.test(psec)) newpsec = psec;
      newline = newline.slice(0, off.psec!).replace(/\s+$/, '');
    }

    // Clock offset (optional).
    let clkOrder = -1;
    const clk1: ClockField = { u: [0, 0, 0, 0], l: [0, 0, 0, 0] };
    if (newline.length > off.clock) {
      clkOrder = readClock(
        newline.slice(off.clock),
        off.shiftClk,
        clk1,
        clkOrderPrev
      );
      if (clkOrder > -1) {
        newline = newline.slice(0, off.clock).replace(/\s+$/, '');
        // Re-pad v3 epoch to 41 after stripping clock so satlist offset holds.
        if (!v2 && newline.length < 41) newline = newline.padEnd(41, ' ');
      }
    }
    clkOrderPrev = clkOrder;

    // Number of satellites.
    const nsat = parseInt((newline.slice(off.nsat) || '0').trim(), 10) || 0;
    if (v2 && nsat > 12) {
      newline = readMoreSat(rawLines, cursor, nsat, newline);
    }

    // Read each satellite's observations.
    const sats: Sat[] = [];
    const satIds: string[] = [];
    let bad = false;
    // For v3 the sat IDs are written into newline starting at col 41.
    let satlist = v2 ? newline.slice(off.satlst, off.satlst + nsat * 3) : '';
    for (let i = 0; i < nsat; i++) {
      const r = readSat(rawLines, cursor, rinexVersion, ntype, ntypeGnss);
      if (!r) {
        bad = true;
        break;
      }
      sats.push(r.sat);
      satIds.push(v2 ? satlist.slice(i * 3, i * 3 + 3) : r.satId);
    }
    if (bad) continue;
    if (!v2) satlist = satIds.join('');

    // Compose the full "epoch + satellite list" line for diffing.
    const fullNew = v2 ? newline : newline.slice(0, 41) + satlist;

    // Sat table: index of each current sat in the previous epoch.
    const oldSatList = v2
      ? oldline.slice(off.satOld, off.satOld + nsatOld * 3)
      : oldline.slice(off.satOld);
    const sattbl: number[] = [];
    const dup = new Set<string>();
    for (let i = 0; i < nsat; i++) {
      const id = satIds[i]!;
      if (dup.has(id)) {
        bad = true;
        break;
      }
      dup.add(id);
      let found = -1;
      for (let j = 0; j < nsatOld; j++) {
        if (oldSatList.slice(j * 3, j * 3 + 3) === id) {
          found = j;
          break;
        }
      }
      sattbl.push(found);
    }
    if (bad) continue;

    // ---- Emit epoch line, then the clock-offset line ----
    // The clock offset always occupies its own line, left empty when the
    // epoch carries no receiver clock offset (this is what the reference
    // emits and what the decoder expects).
    out.push(strdiff(oldline, fullNew));
    let clockLine = '';
    if (clkOrder > -1) {
      if (clkOrder > 0) processClock(clk1, clk0, clkOrder);
      clockLine += putClock(clk1.u[clkOrder]!, clk1.l[clkOrder]!, clkOrder);
    }
    if (newpsec.length === 5) {
      clockLine += ' ' + strdiff(oldpsec, newpsec);
    }
    out.push(clockLine);

    // ---- Emit data section ----
    const dataLines = buildData(sats, sattbl, dy0, flag0, rinexVersion);
    for (const dl of dataLines) out.push(dl);

    // ---- Save state for next epoch ----
    oldline = fullNew;
    nsatOld = nsat;
    clk0 = clk1;
    oldpsec = newpsec;
    dy0 = sats.map((s) => s.data);
    flag0 = sats.map((s) => s.flag);
  }

  return out.join('\n') + '\n';
}

/** rnx2crx `read_clock` — parse the receiver clock offset field. Returns
 * the (post-increment) clock arc order, and fills clk1.u[0]/l[0]. */
function readClock(
  field: string,
  shiftClk: number,
  clk1: ClockField,
  prevOrder: number
): number {
  const c = field.split('');
  if (c[2] !== '.') return -1; // invalid → treat as no clock
  // shift `shiftClk` digits left over the decimal point
  for (let k = 0; k < shiftClk; k++) c[2 + k] = c[3 + k]!;
  c[2 + shiftClk] = '.';
  const s = c.join('');
  const m = /(-?\d+)\.(\d+)/.exec(s);
  if (!m) return -1;
  clk1.u[0] = parseInt(m[1]!, 10);
  clk1.l[0] = parseInt(m[2]!, 10);
  if (c[0] === '-' || c[1] === '-') clk1.l[0] = -clk1.l[0];
  return Math.min(prevOrder + 1, ARC_ORDER);
}

/** rnx2crx `process_clock` — take successive differences of the clock. */
function processClock(clk1: ClockField, clk0: ClockField, clkOrder: number) {
  for (let i = 0; i < clkOrder; i++) {
    clk1.u[i + 1] = clk1.u[i]! - clk0.u[i]!;
    clk1.l[i + 1] = clk1.l[i]! - clk0.l[i]!;
  }
}

/** rnx2crx `take_diff` — ramp the difference order and difference vs prev. */
function takeDiff(py1: DataField, py0: DataField) {
  py1.order = py0.order;
  if (py1.order < ARC_ORDER) py1.order++;
  for (let k = 0; k < py1.order; k++) {
    py1.u[k + 1] = py1.u[k]! - py0.u[k]!;
    py1.l[k + 1] = py1.l[k]! - py0.l[k]!;
  }
}

/** rnx2crx `data` — build one compressed line per satellite. */
function buildData(
  sats: Sat[],
  sattbl: number[],
  dy0: DataField[][],
  flag0: string[],
  rinexVersion: number
): string[] {
  const lines: string[] = [];
  for (let i = 0; i < sats.length; i++) {
    const sat = sats[i]!;
    const i0 = sattbl[i]!;
    // Mutable copy of the previous epoch's flags for this satellite — the
    // CRINEX-1 (RINEX 2) path blanks a flag position when its observation
    // field goes empty, so the flag diff shows no change there.
    const prevFlag = (i0 >= 0 ? (flag0[i0] ?? '') : '').split('');
    let line = '';
    for (let j = 0; j < sat.ntypeRec; j++) {
      const py1 = sat.data[j]!;
      if (py1.order >= 0) {
        if (i0 < 0 || dy0[i0]?.[j]?.order === -1) {
          py1.order = 0;
          line += `${ARC_ORDER}&`;
        } else {
          takeDiff(py1, dy0[i0]![j]!);
          if (Math.abs(py1.u[py1.order]!) > 100000) {
            py1.order = 0;
            line += `${ARC_ORDER}&`;
          }
        }
        line += putdiff(py1.u[py1.order]!, py1.l[py1.order]!);
      } else if (i0 >= 0 && rinexVersion === 2) {
        prevFlag[j * 2] = ' ';
        prevFlag[j * 2 + 1] = ' ';
      }
      line += ' '; // field separator
    }
    // Flags. The reference `strdiff` walks back over the *entire* line's
    // trailing spaces (so unused field separators at the end are chopped);
    // the RINEX-3 new-satellite branch instead maps spaces to '&' and keeps
    // them, so it is not trimmed.
    if (i0 < 0 && rinexVersion !== 2) {
      for (const ch of sat.flag) line += ch === ' ' ? '&' : ch;
    } else {
      line +=
        i0 < 0 ? strdiff('', sat.flag) : strdiff(prevFlag.join(''), sat.flag);
      line = line.replace(/ +$/, '');
    }
    lines.push(line);
  }
  return lines;
}

/** rnx2crx `put_event_data` — copy an event block (flag > 1) verbatim. */
function putEventData(
  lines: string[],
  cursor: { li: number },
  v2: boolean,
  epochLine: string,
  out: string[],
  ntypeGnss: Record<string, number>,
  setNtype: (n: number) => void
) {
  if (v2) {
    out.push('&' + epochLine.slice(1));
    if (epochLine.length > 29) {
      const n = parseInt(epochLine.slice(29), 10) || 0;
      for (let i = 0; i < n; i++) {
        const l = chop(lines[cursor.li++] ?? '');
        out.push(l);
        if (
          l.slice(60).trimStart().startsWith('# / TYPES OF OBSERV') &&
          l[5] !== ' '
        ) {
          setNtype(parseInt(l, 10));
        }
      }
    }
  } else {
    out.push(epochLine.replace(/\s+$/, ''));
    const n = parseInt(epochLine.slice(32), 10) || 0;
    for (let i = 0; i < n; i++) {
      const l = chop(lines[cursor.li++] ?? '');
      out.push(l);
      if (
        l.slice(60).trimStart().startsWith('SYS / # / OBS TYPES') &&
        l[0] !== ' '
      ) {
        ntypeGnss[l[0]!] = parseInt(l.slice(3), 10);
      }
    }
  }
}

/** rnx2crx `read_more_sat` — gather RINEX2 continuation lines of the
 * satellite list into the epoch line. */
function readMoreSat(
  lines: string[],
  cursor: { li: number },
  n: number,
  epochLine: string
): string {
  let result = epochLine;
  let remaining = n;
  while (remaining > 12) {
    const l = lines[cursor.li++] ?? '';
    const chopped = chop(l);
    result += chopped[2] === ' ' ? chopped.slice(32) : chopped;
    remaining -= 12;
  }
  return result;
}

/** rnx2crx `read_version_full` — "4.02" → 402, "2" → 200, else -1. */
function readVersionFull(line: string): number {
  if (line[5] === '2' && line[6] === ' ') return 200;
  const d = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
  if (!d(line[5]) || line[6] !== '.' || !d(line[7]) || !d(line[8])) return -1;
  return (
    (line.charCodeAt(5) - 48) * 100 +
    (line.charCodeAt(7) - 48) * 10 +
    (line.charCodeAt(8) - 48)
  );
}
