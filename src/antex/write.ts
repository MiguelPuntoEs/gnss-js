/**
 * ANTEX writers: an {@link AntexFile} (from either version) as ANTEX 1.4 or
 * ANTEX 2.0 text, so a file can be converted both ways.
 *
 * What does not survive a conversion, by the formats' design:
 * - 1.4 → 2.0: the NOAZI rows of azimuth-dependent patterns (2.0 has only
 *   the grid; a 2.0 reader takes the azimuth mean), RMS sections, SINEX
 *   CODE, COSPAR IDs. Satellite antenna names are kept as written (1.4's
 *   "BLOCK IIIA", not 2.0's "LANT_GPS_III") and PRN-period entries of one
 *   SVN are merged into one antenna with a calibration per distinct
 *   pattern.
 * - 2.0 → 1.4: code and gain calibrations (1.4 has phase only); missing
 *   (blank) pattern values are written as 0.00; satellites need their PRN
 *   (pass the file through `antexWithPrns` first) — without one the entry
 *   is written with its SVN only.
 * Comments inside antenna records are not kept by the parser.
 */
import { epochMs } from './index';
import type {
  SatellitePrnAssignment,
  AntennaEntry,
  AntexCalibration,
  AntexEpoch,
  AntexFile,
  FrequencyData,
} from './index';

/* ── Fixed-width fields ──────────────────────────────────────────── */

/** A labelled ANTEX line: 60 columns of content, the label in 61–80. */
const L = (content: string, label: string) =>
  content.padEnd(60).substring(0, 60) + label.padEnd(20);

/** Fortran Fw.d; keeps the sign of −0 ("-0.00") as ANTEX files write it. */
function F(v: number, w: number, d: number): string {
  const s = Object.is(v, -0) ? '-' + (0).toFixed(d) : v.toFixed(d);
  return s.padStart(w);
}

const I = (v: number, w: number) => String(v).padStart(w);

/** Pattern values: Fw.d each, a missing (NaN) one blank or 0 by format. */
const cells = (vals: readonly number[], d: number, blankMissing: boolean) =>
  vals
    .map((v) =>
      Number.isFinite(v)
        ? F(v, 8, d)
        : blankMissing
          ? ' '.repeat(8)
          : F(0, 8, d)
    )
    .join('');

function epochLine(e: AntexEpoch, label: string): string {
  const [y, mo, d, h, mi, s] = e;
  return L(
    I(y, 6) + I(mo, 6) + I(d, 6) + I(h, 6) + I(mi, 6) + F(s, 13, 7),
    label
  );
}

/** "YYYY-MM-DD HH:MM" (the parser's string form) → epoch. */
function stringEpoch(s: string): AntexEpoch | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(s);
  return m ? [+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, 0] : undefined;
}

const validity = (
  epoch: AntexEpoch | undefined,
  str: string,
  label: string
): string[] => {
  const e = epoch ?? stringEpoch(str);
  return e ? [epochLine(e, label)] : [];
};

const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];

/** Calibration date in 1.4's IGS style "DD-MON-YY" (other forms kept). */
function date14(s: string): string {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(s);
  return m ? `${m[3]}-${MONTHS[+m[2]! - 1]}-${m[1]!.substring(2)}` : s;
}

/** Calibration date in 2.0's "yyyy/mm/dd" (other forms kept). */
function date20(s: string): string {
  const m = /^(\d{2})-([A-Z]{3})-(\d{2})$/.exec(s);
  const mo = m ? MONTHS.indexOf(m[2]!) : -1;
  if (!m || mo < 0) return s;
  const yy = +m[3]!;
  const y = yy < 80 ? 2000 + yy : 1900 + yy;
  return `${y}/${String(mo + 1).padStart(2, '0')}/${m[1]}`;
}

const zenLine = (zen1: number, zen2: number, dzen: number) =>
  L('  ' + F(zen1, 6, 1) + F(zen2, 6, 1) + F(dzen, 6, 1), 'ZEN1 / ZEN2 / DZEN');

const freqCode = (code: string) => `   ${code}`;

/* ── ANTEX 1.4 ───────────────────────────────────────────────────── */

/** Write an {@link AntexFile} as ANTEX 1.4. */
export function writeAntex14(antex: AntexFile): string {
  const out: string[] = [];
  const system = antex.version < 2 && antex.system ? antex.system : 'M';
  out.push(L(F(1.4, 8, 1) + ' '.repeat(12) + system, 'ANTEX VERSION / SYST'));
  out.push(
    L(
      (antex.pcvType || 'A').padEnd(20) + antex.refAntenna.padEnd(20),
      'PCV TYPE / REFANT'
    )
  );
  for (const c of antex.comments) out.push(L(c, 'COMMENT'));
  out.push(L('', 'END OF HEADER'));

  for (const a of antex.antennas) {
    out.push(L('', 'START OF ANTENNA'));
    out.push(
      L(
        a.type.padEnd(20) +
          a.serialNo.padEnd(20) +
          a.svnCode.padEnd(10) +
          a.cosparId.padEnd(10),
        'TYPE / SERIAL NO'
      )
    );
    out.push(
      L(
        a.method.padEnd(20) +
          a.agency.padEnd(20) +
          I(a.numCalibrated, 6) +
          '    ' +
          date14(a.date),
        'METH / BY / # / DATE'
      )
    );
    out.push(L('  ' + F(a.dazi, 6, 1), 'DAZI'));
    out.push(zenLine(a.zen1, a.zen2, a.dzen));
    out.push(L(I(a.frequencies.length, 6), '# OF FREQUENCIES'));
    out.push(...validity(a.validFromEpoch, a.validFrom, 'VALID FROM'));
    out.push(...validity(a.validUntilEpoch, a.validUntil, 'VALID UNTIL'));
    if (a.sinexCode) out.push(L(a.sinexCode, 'SINEX CODE'));
    for (const f of a.frequencies) {
      out.push(L(freqCode(f.frequency), 'START OF FREQUENCY'));
      out.push(
        L(
          F(f.pcoN, 10, 2) + F(f.pcoE, 10, 2) + F(f.pcoU, 10, 2),
          'NORTH / EAST / UP'
        )
      );
      out.push('   NOAZI' + cells(f.pcvNoazi, 2, false));
      if (a.dazi > 0)
        f.pcv.forEach((row, i) =>
          out.push(F(i * a.dazi, 8, 1) + cells(row, 2, false))
        );
      out.push(L(freqCode(f.frequency), 'END OF FREQUENCY'));
    }
    out.push(L('', 'END OF ANTENNA'));
  }
  return out.join('\n') + '\n';
}

/* ── ANTEX 2.0 ───────────────────────────────────────────────────── */

/** Same offsets and pattern (so one 2.0 record can serve both bands). */
function samePattern(a: FrequencyData, b: FrequencyData): boolean {
  const eq = (x: number, y: number) =>
    x === y || (Number.isNaN(x) && Number.isNaN(y));
  const rowEq = (x: readonly number[], y: readonly number[]) =>
    x.length === y.length && x.every((v, i) => eq(v, y[i]!));
  return (
    a.pcoN === b.pcoN &&
    a.pcoE === b.pcoE &&
    a.pcoU === b.pcoU &&
    a.gainOffsetDb === b.gainOffsetDb &&
    rowEq(a.pcvNoazi, b.pcvNoazi) &&
    a.pcv.length === b.pcv.length &&
    a.pcv.every((r, i) => rowEq(r, b.pcv[i]!))
  );
}

/** ANTEX 2.0 Table 1: the frequency bands that share a centre frequency
 *  (the bands one 2.0 frequency record can serve). */
const CENTRE_FREQUENCY: Record<string, string> = {};
for (const [mhz, bands] of [
  ['2492.028', 'I09'],
  ['1602.000', 'R01'],
  ['1600.995', 'R04'],
  ['1575.420', 'G01 E01 C01 J01 I01 S01'],
  ['1561.098', 'C02'],
  ['1278.750', 'E06 J06'],
  ['1268.520', 'C06'],
  ['1248.065', 'R06'],
  ['1246.000', 'R02'],
  ['1227.600', 'G02 J02'],
  ['1207.140', 'E07 C07'],
  ['1202.025', 'R03'],
  ['1191.795', 'E08 C08'],
  ['1176.450', 'G05 E05 C05 J05 I05 S05'],
] as const)
  for (const b of bands.split(' ')) CENTRE_FREQUENCY[b] = mhz;

const sameCentre = (a: string, b: string) =>
  CENTRE_FREQUENCY[a] !== undefined &&
  CENTRE_FREQUENCY[a] === CENTRE_FREQUENCY[b];

/** Frequencies grouped into 2.0 frequency records: as read from a 2.0
 *  file (`bands`), else runs of adjacent bands on the same centre
 *  frequency with identical data (so the band order survives a conversion
 *  and back); at most ten per record. */
function frequencyRecords(freqs: readonly FrequencyData[]): FrequencyData[][] {
  const groups: FrequencyData[][] = [];
  const done = new Set<FrequencyData>();
  freqs.forEach((f, i) => {
    if (done.has(f)) return;
    let group: FrequencyData[];
    if (f.bands) {
      group = freqs.filter((g) => g.bands === f.bands);
    } else {
      group = [f];
      for (let j = i + 1; j < freqs.length; j++) {
        const g = freqs[j]!;
        if (
          g.bands ||
          !sameCentre(f.frequency, g.frequency) ||
          !samePattern(f, g)
        )
          break;
        group.push(g);
      }
    }
    for (const g of group) done.add(g);
    for (let k = 0; k < group.length; k += 10)
      groups.push(group.slice(k, k + 10));
  });
  return groups;
}

function writeCalibration(
  out: string[],
  c: AntexCalibration,
  isSatellite: boolean
): void {
  const kind = c.kind;
  const d = kind === 'CODE' ? 1 : 2;
  const records = frequencyRecords(c.frequencies);
  out.push(L('', 'START OF CALIB'));
  out.push(L(kind.padEnd(10) + I(records.length, 6), 'TYPE / # OF FREQS'));
  out.push(
    L(
      c.method.padEnd(20) +
        c.agency.padEnd(20) +
        (c.numCalibrated ? I(c.numCalibrated, 6) : ' '.repeat(6)) +
        '    ' +
        date20(c.date),
      'METH / BY / # / DATE'
    )
  );
  out.push(...validity(c.validFromEpoch, c.validFrom, 'VALID FROM'));
  out.push(...validity(c.validUntilEpoch, c.validUntil, 'VALID UNTIL'));
  out.push(L('  ' + F(c.dazi > 0 ? c.dazi : 360, 6, 1), 'DAZI'));
  out.push(zenLine(c.zen1, c.zen2, c.dzen));
  for (const rec of records) {
    const f = rec[0]!;
    out.push(
      L(rec.map((g) => freqCode(g.frequency)).join(''), `START OF ${kind}`)
    );
    if (kind === 'GAIN') out.push(L(F(f.gainOffsetDb ?? 0, 10, 2), 'OFFSET'));
    else {
      // Receiver: x = East, y = North. Satellite: body X, Y, Z.
      const [x, y] = isSatellite ? [f.pcoN, f.pcoE] : [f.pcoE, f.pcoN];
      out.push(L(F(x, 10, d) + F(y, 10, d) + F(f.pcoU, 10, d), 'X / Y / Z'));
    }
    if (c.dazi > 0)
      f.pcv.forEach((row, i) =>
        out.push(F(i * c.dazi, 8, 1) + cells(row, d, true))
      );
    else
      for (const az of [0, 360])
        out.push(F(az, 8, 1) + cells(f.pcvNoazi, d, true));
    out.push(L('', `END OF ${kind}`));
  }
  out.push(L('', 'END OF CALIB'));
}

const phaseCalibration = (a: AntennaEntry): AntexCalibration => ({
  kind: 'PHASE',
  method: a.method,
  agency: a.agency,
  numCalibrated: a.numCalibrated,
  date: a.date,
  validFrom: a.validFrom,
  validUntil: a.validUntil,
  ...(a.validFromEpoch ? { validFromEpoch: a.validFromEpoch } : {}),
  ...(a.validUntilEpoch ? { validUntilEpoch: a.validUntilEpoch } : {}),
  dazi: a.dazi,
  zen1: a.zen1,
  zen2: a.zen2,
  dzen: a.dzen,
  frequencies: a.frequencies,
});

const sameData = (a: AntennaEntry, b: AntennaEntry) =>
  a.method === b.method &&
  a.agency === b.agency &&
  a.numCalibrated === b.numCalibrated &&
  a.date === b.date &&
  a.dazi === b.dazi &&
  a.zen1 === b.zen1 &&
  a.zen2 === b.zen2 &&
  a.dzen === b.dzen &&
  a.frequencies.length === b.frequencies.length &&
  a.frequencies.every(
    (f, i) =>
      f.frequency === b.frequencies[i]!.frequency &&
      samePattern(f, b.frequencies[i]!)
  );

/** Same instant to within a millisecond (1.4 ends a period at its last
 *  instant, 23:59:59.9999999; the metadata at the next start). */
const near = (a: number | null, b: number) =>
  a !== null && (a === b || Math.abs(a - b) < 1);

/** The time of a validity bound, if any. */
const boundMs = (epoch: AntexEpoch | undefined, str: string) => {
  const e = epoch ?? stringEpoch(str);
  return e ? epochMs(e) : null;
};

/**
 * Write an {@link AntexFile} as ANTEX 2.0. `release` ("YYYY:DDD" or
 * "YYYYDDD") defaults to the file's, else today.
 *
 * `prns` (from `parseSatellitePrns`): a 1.4 file can only give a satellite
 * antenna per PRN period, so its validity starts and ends with the PRN
 * assignment; with the assignments, a bound that is just the SVN's first
 * or last PRN date is dropped, as a 2.0 file writes it (the SVN is the
 * antenna).
 */
export function writeAntex20(
  antex: AntexFile,
  opts: {
    release?: string;
    referenceFrame?: string;
    prns?: readonly SatellitePrnAssignment[];
  } = {}
): string {
  const svnSpan = new Map<string, [number, number]>();
  for (const p of opts.prns ?? []) {
    const [f, u] = svnSpan.get(p.svn) ?? [Infinity, -Infinity];
    svnSpan.set(p.svn, [Math.min(f, p.fromMs), Math.max(u, p.untilMs)]);
  }
  const out: string[] = [];
  out.push(L(F(2.0, 8, 1), 'ANTEX VERSION'));
  out.push(L('', 'START OF HEADER'));
  for (const c of antex.comments) out.push(L(c, 'COMMENT'));
  const sats = antex.antennas.some((a) => a.isSatellite);
  const rcvs = antex.antennas.some((a) => !a.isSatellite);
  out.push(
    L(sats && rcvs ? 'MIXED' : sats ? 'SATELLITE' : 'RECEIVER', 'ANTENNA TYPES')
  );
  const frame = opts.referenceFrame ?? antex.referenceFrame;
  if (frame) out.push(L(frame, 'REFERENCE FRAME'));
  const now = new Date();
  const doy =
    Math.floor(
      (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
        Date.UTC(now.getUTCFullYear(), 0, 1)) /
        86_400_000
    ) + 1;
  const release = (
    opts.release ??
    antex.release ??
    `${now.getUTCFullYear()}${String(doy).padStart(3, '0')}`
  ).replace(':', '');
  out.push(L(release, 'RELEASE'));
  out.push(L('', 'END OF HEADER'));

  // One 2.0 antenna per receiver type + serial number, per satellite SVN
  // (or block type): 1.4 repeats a satellite per PRN period, 2.0 once.
  const key = (a: AntennaEntry) =>
    a.isSatellite
      ? `S|${a.type}|${a.svnCode || a.serialNo}`
      : `R|${a.type}|${a.serialNo}`;
  const groups = new Map<string, AntennaEntry[]>();
  for (const a of antex.antennas) {
    const list = groups.get(key(a)) ?? [];
    list.push(a);
    groups.set(key(a), list);
  }

  for (const list of groups.values()) {
    const a = list[0]!;
    out.push('');
    out.push(L('', 'START OF ANTENNA'));
    if (a.isSatellite) {
      out.push(
        L(
          a.type.padEnd(20) + ' '.repeat(20) + a.svnCode.padEnd(4),
          'TYPE / SVN'
        )
      );
      out.push(L(a.origin ?? 'COM', 'ORIGIN'));
    } else {
      out.push(L(a.type.padEnd(20) + a.serialNo.padEnd(20), 'TYPE / SN'));
    }
    // Phase calibrations in time order; consecutive periods with the same
    // calibration (e.g. one SVN under several PRNs) become one.
    const byTime = [...list].sort((x, y) =>
      (x.validFromEpoch
        ? epochKey(x.validFromEpoch)
        : x.validFrom
      ).localeCompare(
        y.validFromEpoch ? epochKey(y.validFromEpoch) : y.validFrom
      )
    );
    const phases: AntexCalibration[] = [];
    let prev: AntennaEntry | null = null;
    for (const e of byTime) {
      const last = phases[phases.length - 1];
      if (prev && last && sameData(prev, e)) {
        last.validUntil = e.validUntil;
        if (e.validUntilEpoch) last.validUntilEpoch = e.validUntilEpoch;
        else delete last.validUntilEpoch;
      } else if (e.frequencies.length) {
        phases.push(phaseCalibration(e));
      }
      prev = e;
    }
    const span = a.isSatellite ? svnSpan.get(a.svnCode) : undefined;
    const first = phases[0];
    const last = phases[phases.length - 1];
    if (
      span &&
      first &&
      near(boundMs(first.validFromEpoch, first.validFrom), span[0])
    ) {
      first.validFrom = '';
      delete first.validFromEpoch;
    }
    if (
      span &&
      last &&
      near(boundMs(last.validUntilEpoch, last.validUntil), span[1])
    ) {
      last.validUntil = '';
      delete last.validUntilEpoch;
    }
    for (const c of phases) writeCalibration(out, c, a.isSatellite);
    for (const c of a.codeCalibrations ?? [])
      writeCalibration(out, c, a.isSatellite);
    for (const c of a.gainCalibrations ?? [])
      writeCalibration(out, c, a.isSatellite);
    out.push(L('', 'END OF ANTENNA'));
  }
  return out.join('\n') + '\n';
}

const epochKey = (e: AntexEpoch) =>
  e
    .slice(0, 5)
    .map((v, i) => String(v).padStart(i ? 2 : 4, '0'))
    .join('-') + String(e[5]).padStart(10, '0');
