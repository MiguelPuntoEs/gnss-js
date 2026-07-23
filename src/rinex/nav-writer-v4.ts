/**
 * RINEX 4.01 mixed navigation file writer.
 *
 * Produces `> EPH` data records for the classic ephemeris types
 * (GPS/QZSS/NavIC LNAV, Galileo INAV, BeiDou D1/D2, GLONASS FDMA,
 * SBAS), `> EPH ... CNAV` records for GPS/QZSS CNAV ephemerides, and
 * `> ION` records for the header's Klobuchar/NeQuick-G coefficients,
 * per the RINEX 4.01 record tables (A9-A18, A21, A26, A32, A33).
 */

import { padL, padR, hdrLine } from './format';
import { fmtD } from './nav-writer';
import type {
  NavHeader,
  Ephemeris,
  KeplerEphemeris,
  GlonassEphemeris,
  RinexCnavEphemeris,
} from './nav';

/** Input for {@link writeRinexNav4}: a NavResult, optionally with CNAV. */
export interface Nav4Input {
  header: NavHeader;
  ephemerides: Ephemeris[];
  cnav?: RinexCnavEphemeris[];
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
 * Galileo is labelled INAV: the parsed KeplerEphemeris does not retain
 * the data-source flags, and the INAV/FNAV record layouts are
 * identical, so INAV is used as the generic label.
 */
function msgLabel(eph: Ephemeris): string {
  switch (eph.system) {
    case 'E':
      return 'INAV';
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

function isKepler(eph: Ephemeris): eph is KeplerEphemeris {
  return 'af0' in eph;
}

/**
 * Classic Keplerian record body (LNAV/INAV/D1/D2): epoch + 7 orbit
 * lines, mirroring the RINEX 3 writer's field placement so a
 * write→parse round trip reproduces the parsed record exactly.
 */
function keplerRecord(eph: KeplerEphemeris): string {
  return [
    epochLine4(eph.prn, eph.tocDate, [eph.af0, eph.af1, eph.af2]),
    orbitLine4([eph.iode, eph.crs, eph.deltaN, eph.m0]),
    orbitLine4([eph.cuc, eph.e, eph.cus, eph.sqrtA]),
    orbitLine4([eph.toe, eph.cic, eph.omega0, eph.cis]),
    orbitLine4([eph.i0, eph.crc, eph.omega, eph.omegaDot]),
    orbitLine4([eph.idot, 0, eph.week, 0]),
    orbitLine4([0, eph.svHealth, eph.tgd, 0]),
    orbitLine4([eph.toe, 0, 0, 0]),
  ].join('\n');
}

/**
 * GLONASS FDMA / SBAS record body. RINEX 4 FDMA adds a fourth orbit
 * line (status flags / L1-L2 group delay / URAI / health flags, Table
 * A15); GlonassEphemeris does not carry those, so the flags are left
 * blank (BNK) and the group delay and URAI take the table's
 * "unknown" sentinels (.999999999999E+09 and 15).
 */
function stateVectorRecord(eph: GlonassEphemeris): string {
  // `tauN` holds the raw RINEX SV-clock field (= −τ_n, the repo-wide
  // convention — see positioning/index.ts): written verbatim.
  const lines = [
    epochLine4(eph.prn, eph.tocDate, [
      eph.tauN,
      eph.gammaN,
      eph.messageFrameTime,
    ]),
    orbitLine4([eph.x, eph.xDot, eph.xAcc, eph.health]),
    orbitLine4([eph.y, eph.yDot, eph.yAcc, eph.freqNum]),
    orbitLine4([eph.z, eph.zDot, eph.zAcc, 0]),
  ];
  if (eph.system === 'R') {
    lines.push(orbitLine4([null, 999999999.999, 15, null]));
  }
  return lines.join('\n');
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
    orbitLine4([eph.tow, resolveWnOp(eph.week, eph.wnOp)]),
  ].join('\n');
}

/* ================================================================== */
/*  ION records                                                        */
/* ================================================================== */

/** Header iono key → ION record satellite system and message label. */
const KLOBUCHAR_SOURCES: [
  alpha: string,
  beta: string,
  sys: string,
  msg: string,
][] = [
  ['GPSA', 'GPSB', 'G', 'LNAV'],
  ['QZSA', 'QZSB', 'J', 'LNAV'],
  ['BDSA', 'BDSB', 'C', 'D1D2'],
  ['IRNA', 'IRNB', 'I', 'LNAV'],
];

/**
 * `> ION` records from the header's ionospheric corrections
 * (Klobuchar per Table A32, NeQuick-G per Table A33). RINEX 3 headers
 * carry no transmit time for the coefficients, so `epoch` (the
 * earliest record epoch in the file) stands in for t_tm.
 */
function ionRecords(header: NavHeader, epoch: Date): string[] {
  const records: string[] = [];
  const iono = header.ionoCorrections;

  for (const [alphaKey, betaKey, sys, msg] of KLOBUCHAR_SOURCES) {
    const alpha = iono[alphaKey];
    if (!alpha) continue;
    const beta = iono[betaKey] ?? [0, 0, 0, 0];
    records.push(
      [
        `> ION ${sys}   ${msg}`,
        `    ${fmtEpoch4(epoch)}${[alpha[0] ?? 0, alpha[1] ?? 0, alpha[2] ?? 0].map(fmtD).join('')}`,
        orbitLine4([alpha[3] ?? 0, beta[0] ?? 0, beta[1] ?? 0, beta[2] ?? 0]),
        orbitLine4([beta[3] ?? 0, null]),
      ].join('\n')
    );
  }

  const gal = iono['GAL'];
  if (gal) {
    records.push(
      [
        '> ION E   IFNV',
        `    ${fmtEpoch4(epoch)}${[gal[0] ?? 0, gal[1] ?? 0, gal[2] ?? 0].map(fmtD).join('')}`,
        orbitLine4([gal[3] ?? 0]),
      ].join('\n')
    );
  }

  return records;
}

/* ================================================================== */
/*  Header writer                                                      */
/* ================================================================== */

function writeHeader4(header: NavHeader): string {
  const lines: string[] = [];

  lines.push(
    hdrLine(
      padL('     4.01', 9) +
        '           ' +
        padL('NAVIGATION DATA', 20) +
        padL('M', 20),
      'RINEX VERSION / TYPE'
    )
  );

  const now = new Date();
  const dateStr =
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, '0') +
    String(now.getUTCDate()).padStart(2, '0') +
    ' ' +
    String(now.getUTCHours()).padStart(2, '0') +
    String(now.getUTCMinutes()).padStart(2, '0') +
    String(now.getUTCSeconds()).padStart(2, '0') +
    ' UTC';
  lines.push(
    hdrLine(
      padL('GNSSCalc', 20) + padL('', 20) + padL(dateStr, 20),
      'PGM / RUN BY / DATE'
    )
  );

  // RINEX 4 headers carry no IONOSPHERIC CORR / TIME SYSTEM CORR lines
  // (Table A7) — that data moves to ION/STO data records.
  if (header.leapSeconds != null) {
    lines.push(hdrLine(padR(String(header.leapSeconds), 6), 'LEAP SECONDS'));
  }

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
 * per constellation: LNAV, INAV, D1/D2, FDMA, SBAS) and every CNAV
 * ephemeris (`CNAV`), sorted by PRN, epoch, then label; followed by
 * `> ION` records when the header carries Klobuchar (GPSA/GPSB,
 * QZSA/QZSB, BDSA/BDSB, IRNA/IRNB) or NeQuick-G (GAL) coefficients.
 * ION records need a transmit-time epoch, which RINEX 3-style headers
 * do not store — the earliest record epoch is used, so a file with no
 * ephemerides gets no ION records. There is no source for system
 * time offsets in NavHeader, so no `> STO` records are produced; leap
 * seconds go in the LEAP SECONDS header line.
 */
export function writeRinexNav4(nav: Nav4Input): string {
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

  records.sort(
    (a, b) =>
      a.prn.localeCompare(b.prn) ||
      a.time - b.time ||
      a.label.localeCompare(b.label)
  );

  const bodies = records.map((r) => r.body);

  if (records.length > 0) {
    const earliest = new Date(Math.min(...records.map((r) => r.time)));
    bodies.push(...ionRecords(nav.header, earliest));
  }

  return (
    writeHeader4(nav.header) +
    (bodies.length > 0 ? bodies.join('\n') + '\n' : '')
  );
}
