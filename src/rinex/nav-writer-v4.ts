/**
 * RINEX 4.01 mixed navigation file writer.
 *
 * Produces `> EPH` data records for the classic ephemeris types
 * (GPS/QZSS/NavIC LNAV, Galileo INAV/FNAV, BeiDou D1/D2, GLONASS FDMA,
 * SBAS), `> EPH ... CNAV` records for GPS/QZSS CNAV ephemerides, BeiDou-3
 * `CNV1`/`CNV2`/`CNV3` records for B-CNAV ephemerides, and `> STO`,
 * `> EOP`, `> ION` records — read from a RINEX 4 file, or rebuilt from a
 * RINEX 2/3 header (TIME SYSTEM CORR, IONOSPHERIC CORR) — per the RINEX
 * 4.02 record tables (A9-A15, A19-A26, A30, A33-A40).
 */

import { padL, hdrLine } from './format';
import { fmtD } from './nav-writer';
import {
  isKepler,
  keplerOrbitRows,
  leapLine,
  runDate,
  stateVectorRows,
  type NavWriterOptions,
} from './nav-format';
import type {
  NavHeader,
  Ephemeris,
  GlonassEphemeris,
  KeplerEphemeris,
  RinexCnavEphemeris,
  BdsCnavEphemeris,
  NavEopRecord,
  NavIonRecord,
  NavStoRecord,
} from './nav';

/** Input for {@link writeRinexNav4}: a NavResult, optionally with CNAV. */
export interface Nav4Input {
  header: NavHeader;
  ephemerides: Ephemeris[];
  cnav?: RinexCnavEphemeris[];
  bdsCnav?: BdsCnavEphemeris[];
  sto?: NavStoRecord[];
  eop?: NavEopRecord[];
  ion?: NavIonRecord[];
}

/* ================================================================== */
/*  Formatting helpers                                                 */
/* ================================================================== */

const BLANK19 = ' '.repeat(19);

/**
 * Format a Date for RINEX 4 record epochs: "YYYY MM DD HH MM SS" with
 * zero-padded two-digit fields (I2.2 per the RINEX 4.01 tables).
 */
function fmtEpoch4(d: Date): string {
  const p2 = (v: number): string => String(v).padStart(2, '0');
  return (
    `${d.getUTCFullYear()} ${p2(d.getUTCMonth() + 1)} ${p2(d.getUTCDate())}` +
    ` ${p2(d.getUTCHours())} ${p2(d.getUTCMinutes())} ${p2(d.getUTCSeconds())}`
  );
}

/**
 * Build a broadcast-orbit line: 4-space indent + up to four E19.12
 * fields. `null` produces a blank field (RINEX "not available"),
 * trailing blanks are trimmed.
 */
function orbitLine4(values: (number | null)[]): string {
  const line =
    '    ' + values.map((v) => (v == null ? BLANK19 : fmtD(v))).join('');
  return line.replace(/ +$/, '');
}

/** SV epoch line: PRN + epoch + up to three clock terms. */
function epochLine4(prn: string, date: Date, vals: number[]): string {
  return `${padL(prn, 3)} ${fmtEpoch4(date)}${vals.map(fmtD).join('')}`;
}

/* ================================================================== */
/*  Message-type labels                                                */
/* ================================================================== */

/** BeiDou GEO satellites broadcast D2; all others D1. */
const BDS_GEO = new Set([
  'C01',
  'C02',
  'C03',
  'C04',
  'C05',
  'C59',
  'C60',
  'C61',
  'C62',
  'C63',
]);

/**
 * RINEX 4 navigation message label for a classic ephemeris (Table 20).
 * Galileo: FNAV when the data-sources field says F/NAV E5a-I (bit 1),
 * else INAV (the layouts are identical; the clock set differs).
 */
function msgLabel(eph: Ephemeris): string {
  switch (eph.system) {
    case 'E':
      return isKepler(eph) && ((eph.dataSources ?? 0) & 2) !== 0
        ? 'FNAV'
        : 'INAV';
    case 'C':
      return BDS_GEO.has(eph.prn) ? 'D2' : 'D1';
    case 'R':
      return 'FDMA';
    case 'S':
      return 'SBAS';
    default:
      return 'LNAV'; // G, J, I
  }
}

/* ================================================================== */
/*  Record writers                                                     */
/* ================================================================== */

/** Classic Keplerian record body (LNAV/INAV/FNAV/D1/D2): epoch + 7 orbit lines. */
function keplerRecord(eph: KeplerEphemeris): string {
  return [
    epochLine4(eph.prn, eph.tocDate, [eph.af0, eph.af1, eph.af2]),
    ...keplerOrbitRows(eph).map(orbitLine4),
  ].join('\n');
}

/**
 * GLONASS FDMA / SBAS record body. RINEX 4 FDMA has a fourth orbit
 * line (status flags / L1-L2 group delay / URAI / health flags, Table
 * A15): fields the ephemeris does not carry are left blank (BNK) or
 * take the table's "unknown" sentinels (.999999999999E+09 and 15).
 */
function stateVectorRecord(eph: GlonassEphemeris): string {
  // `tauN` holds the raw RINEX SV-clock field (= −τ_n, the repo-wide
  // convention — see positioning/index.ts): written verbatim.
  return [
    epochLine4(eph.prn, eph.tocDate, [
      eph.tauN,
      eph.gammaN,
      eph.messageFrameTime,
    ]),
    ...stateVectorRows(eph, true).map(orbitLine4),
  ].join('\n');
}

/**
 * Resolve the data-predict week for the orbit-8 wn_op field: RINEX
 * wants the ambiguity-resolved continuous week, while the broadcast
 * WN_OP is only 8 bits. Accepts either form (8-bit or already
 * resolved) and picks the week ≤ `week` congruent to it mod 256;
 * defaults to `week` itself when no WN_OP was seen.
 */
function resolveWnOp(week: number, wnOp: number | undefined): number {
  if (wnOp == null) return week;
  return week - ((((week - wnOp) % 256) + 256) % 256);
}

/** GPS/QZSS CNAV record body (RINEX 4.01 Tables A10/A18). */
function cnavRecord(eph: RinexCnavEphemeris): string {
  return [
    epochLine4(eph.prn, eph.tocDate, [eph.af0, eph.af1, eph.af2]),
    orbitLine4([eph.aDot, eph.crs, eph.deltaN0, eph.m0]),
    orbitLine4([eph.cuc, eph.e, eph.cus, Math.sqrt(eph.a)]),
    orbitLine4([eph.top, eph.cic, eph.omega0, eph.cis]),
    orbitLine4([eph.i0, eph.crc, eph.omega, eph.omegaDot]),
    orbitLine4([eph.i0Dot, eph.deltaN0Dot, eph.uraNed0, eph.uraNed1]),
    orbitLine4([eph.uraEd, eph.health, eph.tgd, eph.uraNed2]),
    orbitLine4([eph.iscL1ca, eph.iscL2c, eph.iscL5i5, eph.iscL5q5]),
    // 4.02 adds the integer flags: written when read from such a file
    orbitLine4([
      eph.tow,
      resolveWnOp(eph.week, eph.wnOp),
      eph.cnavFlags ?? null,
    ]),
  ].join('\n');
}

/**
 * BeiDou-3 CNV1/CNV2/CNV3 record body (RINEX 4.02 Tables A24-A26).
 * Fields not yet received are written blank.
 */
function bdsCnavRecord(eph: BdsCnavEphemeris): string {
  const lines = [
    epochLine4(eph.prn, eph.tocDate, [eph.af0, eph.af1, eph.af2]),
    orbitLine4([eph.aDot, eph.crs, eph.deltaN0, eph.m0]),
    orbitLine4([eph.cuc, eph.e, eph.cus, Math.sqrt(eph.a)]),
    orbitLine4([eph.toe, eph.cic, eph.omega0, eph.cis]),
    orbitLine4([eph.i0, eph.crc, eph.omega, eph.omegaDot]),
    orbitLine4([eph.i0Dot, eph.deltaN0Dot, eph.satType, eph.top]),
    orbitLine4([eph.sisaiOe, eph.sisaiOcb, eph.sisaiOc1, eph.sisaiOc2]),
  ];
  if (eph.message === 'CNV3') {
    lines.push(
      orbitLine4([eph.sismai, eph.health, eph.integrityFlags, eph.tgdB2bI]),
      orbitLine4([eph.tow])
    );
  } else {
    lines.push(
      orbitLine4([eph.iscB1Cd, eph.iscB2ad, eph.tgdB1Cp, eph.tgdB2ap]),
      orbitLine4([eph.sismai, eph.health, eph.integrityFlags, eph.iodc]),
      orbitLine4([eph.tow, null, null, eph.iode])
    );
  }
  return lines.join('\n');
}

/* ================================================================== */
/*  STO / EOP / ION records                                            */
/* ================================================================== */

/** `> TYP` record header: A1,1X,A3,1X,A1,A2,1X,A4[,1X,A4] (Tables A33-A40). */
function recordHeader(
  type: string,
  system: string,
  sv: string | undefined,
  message: string,
  subtype?: string
): string {
  const num = sv && sv.length > 1 ? sv.slice(1, 3) : '  ';
  return `> ${type} ${system}${padL(num, 2)} ${padL(message, 4)}${subtype ? ' ' + subtype : ''}`.trimEnd();
}

/** Epoch line of STO/EOP/ION records: 4X,I4,5(1X,I2.2) + values. */
function recordEpoch(epoch: Date, values: (number | null)[]): string {
  return (
    '    ' +
    fmtEpoch4(epoch) +
    values
      .map((v) => (v == null ? BLANK19 : fmtD(v)))
      .join('')
      .trimEnd()
  );
}

function stoRecord(r: NavStoRecord): string {
  const ids = [r.type, r.sbasId ?? '', r.utcId ?? ''];
  return [
    recordHeader('STO', r.system, r.sv, r.message, r.subtype),
    (
      `    ${fmtEpoch4(r.epoch)} ` + ids.map((x) => padL(x, 18)).join(' ')
    ).trimEnd(),
    orbitLine4([r.ttm, r.a0, r.a1, r.a2]),
  ].join('\n');
}

function eopRecord(r: NavEopRecord): string {
  return [
    recordHeader('EOP', r.system, r.sv, r.message, r.subtype),
    recordEpoch(r.epoch, [r.xp, r.xpDot, r.xpDotDot]),
    orbitLine4([null, r.yp, r.ypDot, r.ypDotDot]),
    orbitLine4([r.ttm, r.dUt1, r.dUt1Dot, r.dUt1DotDot]),
  ].join('\n');
}

function ionRecord(r: NavIonRecord): string {
  const [first = [], ...rest] = r.rows;
  return [
    recordHeader('ION', r.system, r.sv, r.message, r.subtype),
    recordEpoch(r.epoch, first),
    ...rest.map(orbitLine4),
  ].join('\n');
}

/** IONOSPHERIC CORR type → ION record system and message label. */
const KLOBUCHAR_SOURCES: Record<string, [sys: string, msg: string]> = {
  GPS: ['G', 'LNAV'],
  QZS: ['J', 'LNAV'],
  BDS: ['C', 'D1D2'],
  IRN: ['I', 'LNAV'],
};

/**
 * `> ION` records from a RINEX 2/3 header's ionospheric corrections
 * (Klobuchar, Table A35; NeQuick-G, Table A36): one per IONOSPHERIC
 * CORR α/β pair — BDS one per broadcasting satellite. RINEX 3 headers
 * carry no transmit time; the BDS time mark gives the hour on the day of
 * `epoch` (the earliest record epoch), otherwise `epoch` itself stands
 * in for t_tm.
 */
function headerIonRecords(header: NavHeader, epoch: Date): NavIonRecord[] {
  const lines = header.ionoCorrectionLines?.length
    ? header.ionoCorrectionLines
    : Object.entries(header.ionoCorrections).map(([type, values]) => ({
        type,
        values,
        timeMark: undefined as string | undefined,
        sv: undefined as string | undefined,
      }));
  const day = Date.UTC(
    epoch.getUTCFullYear(),
    epoch.getUTCMonth(),
    epoch.getUTCDate()
  );
  const at = (mark?: string) =>
    mark && /^[A-X]$/.test(mark)
      ? new Date(day + (mark.charCodeAt(0) - 65) * 3600_000)
      : epoch;
  const out: NavIonRecord[] = [];
  for (const l of lines) {
    const v = (k: number) => l.values[k] ?? 0;
    if (l.type === 'GAL') {
      const ai = [v(0), v(1), v(2)];
      out.push({
        system: 'E',
        message: 'IFNV',
        epoch: at(l.timeMark),
        rows: [ai, [v(3)]],
        nequickG: { ai, disturbanceFlags: v(3) },
      });
      continue;
    }
    const src = KLOBUCHAR_SOURCES[l.type.slice(0, 3)];
    if (!src || !l.type.endsWith('A')) continue;
    const beta = lines.find(
      (b) =>
        b.type === l.type.slice(0, 3) + 'B' &&
        b.sv === l.sv &&
        b.timeMark === l.timeMark
    )?.values ?? [0, 0, 0, 0];
    const alpha = [v(0), v(1), v(2), v(3)];
    const b = (k: number) => beta[k] ?? 0;
    out.push({
      system: src[0],
      message: src[1],
      ...(l.sv && { sv: l.sv }),
      epoch: at(l.timeMark),
      rows: [
        [alpha[0]!, alpha[1]!, alpha[2]!],
        [alpha[3]!, b(0), b(1), b(2)],
        [b(3)],
      ],
      klobuchar: { alpha, beta: [b(0), b(1), b(2), b(3)] },
    });
  }
  return out;
}

/** TIME SYSTEM CORR system code → providing system and STO message type. */
const STO_SOURCES: Record<string, [sys: string, msg: string]> = {
  GP: ['G', 'LNAV'],
  GL: ['R', 'FDMA'],
  GA: ['E', 'IFNV'],
  BD: ['C', 'D1D2'],
  QZ: ['J', 'LNAV'],
  IR: ['I', 'LNAV'],
  SB: ['S', 'SBAS'],
};

/** RINEX 3 UTC identifier → RINEX 4 UTC ID (RINEX 4.02 Table 27). */
const UTC_IDS: Record<number, string> = {
  1: 'UTC(NIST)',
  2: 'UTC(USNO)',
  3: 'UTC(SU)',
  4: 'UTC(BIPM)',
  5: 'UTCGAL',
  6: 'UTC(NICT)',
  7: 'UTC(NTSC)',
};

/**
 * `> STO` records from RINEX 2/3 TIME SYSTEM CORR lines. t_ot is the
 * line's reference week + seconds (BDT week for BDUT); GLONASS lines
 * have none and take the RINEX 2 reference date or `epoch`. RINEX 3
 * keeps no transmission time: t_tm is written as t_ref.
 */
function headerStoRecords(header: NavHeader, epoch: Date): NavStoRecord[] {
  return (header.timeSystemCorr ?? []).map((c) => {
    const [system, message] = STO_SOURCES[c.type.slice(0, 2)] ?? ['G', 'LNAV'];
    const weekEpoch = c.type.startsWith('BD')
      ? Date.UTC(2006, 0, 1)
      : Date.UTC(1980, 0, 6);
    const t =
      c.refWeek > 0 || c.refTime > 0
        ? new Date(weekEpoch + (c.refWeek * 604800 + c.refTime) * 1000)
        : (c.refDate ?? epoch);
    const sbas = c.type.slice(0, 2) === 'SB' && c.sv && !/^S\d/.test(c.sv);
    const utcId =
      c.type.endsWith('UT') && c.utcId != null ? UTC_IDS[c.utcId] : undefined;
    return {
      system,
      message,
      ...(c.sv && !sbas && { sv: c.sv }),
      epoch: t,
      type: c.type,
      ...(sbas && { sbasId: c.sv }),
      ...(utcId && { utcId }),
      ttm: c.refTime,
      a0: c.a0,
      a1: c.a1,
      a2: 0,
    };
  });
}

/* ================================================================== */
/*  Header writer                                                      */
/* ================================================================== */

function writeHeader4(header: NavHeader, opts: NavWriterOptions): string {
  const lines: string[] = [];
  lines.push(
    hdrLine(
      padL('     4.01', 9) +
        '           ' +
        padL('N: GNSS NAV DATA', 20) +
        padL('M: MIXED', 20),
      'RINEX VERSION / TYPE'
    )
  );
  lines.push(
    hdrLine(
      padL(opts.program ?? 'GNSSCalc', 20) +
        padL(opts.runBy ?? '', 20) +
        padL(runDate(opts.date ?? new Date()), 20),
      'PGM / RUN BY / DATE'
    )
  );
  // RINEX 4 headers carry no IONOSPHERIC CORR / TIME SYSTEM CORR lines
  // (Table A7) — that data moves to ION/STO data records.
  const leap = leapLine(header);
  if (leap) lines.push(leap);
  lines.push(hdrLine('', 'END OF HEADER'));
  return lines.join('\n') + '\n';
}

/* ================================================================== */
/*  Public API                                                         */
/* ================================================================== */

/**
 * Write a RINEX 4.01 mixed navigation file.
 *
 * Emits `> EPH` records for every classic ephemeris (message labels
 * per constellation: LNAV, INAV/FNAV, D1/D2, FDMA, SBAS), every GPS/QZSS
 * CNAV ephemeris (`CNAV`) and every BeiDou-3 B-CNAV ephemeris (`CNV1`/
 * `CNV2`/`CNV3`), sorted by PRN, epoch, then label; then the `> STO`,
 * `> EOP` and `> ION` records — the input's own (from a RINEX 4 file),
 * else STO/ION records rebuilt from a RINEX 2/3 header's TIME SYSTEM
 * CORR / IONOSPHERIC CORR lines (see {@link headerIonRecords} and
 * {@link headerStoRecords} for the transmit times RINEX 3 lacks; with no
 * ephemeris to date them, none are written).
 */
export function writeRinexNav4(
  nav: Nav4Input,
  opts: NavWriterOptions = {}
): string {
  interface Rec {
    prn: string;
    time: number;
    label: string;
    body: string;
  }
  const records: Rec[] = [];

  for (const eph of nav.ephemerides) {
    const label = msgLabel(eph);
    records.push({
      prn: eph.prn,
      time: eph.tocDate.getTime(),
      label,
      body:
        `> EPH ${padL(eph.prn, 3)} ${label}\n` +
        (isKepler(eph) ? keplerRecord(eph) : stateVectorRecord(eph)),
    });
  }
  for (const eph of nav.cnav ?? []) {
    records.push({
      prn: eph.prn,
      time: eph.tocDate.getTime(),
      label: 'CNAV',
      body: `> EPH ${padL(eph.prn, 3)} CNAV\n` + cnavRecord(eph),
    });
  }
  for (const eph of nav.bdsCnav ?? []) {
    records.push({
      prn: eph.prn,
      time: eph.tocDate.getTime(),
      label: eph.message,
      body: `> EPH ${padL(eph.prn, 3)} ${eph.message}\n` + bdsCnavRecord(eph),
    });
  }

  records.sort(
    (a, b) =>
      a.prn.localeCompare(b.prn) ||
      a.time - b.time ||
      a.label.localeCompare(b.label)
  );

  const bodies = records.map((r) => r.body);

  const earliest =
    records.length > 0
      ? new Date(Math.min(...records.map((r) => r.time)))
      : null;
  const sto =
    nav.sto ?? (earliest ? headerStoRecords(nav.header, earliest) : []);
  const ion =
    nav.ion ?? (earliest ? headerIonRecords(nav.header, earliest) : []);
  bodies.push(...sto.map(stoRecord));
  bodies.push(...(nav.eop ?? []).map(eopRecord));
  bodies.push(...ion.map(ionRecord));

  return (
    writeHeader4(nav.header, opts) +
    (bodies.length > 0 ? bodies.join('\n') + '\n' : '')
  );
}
