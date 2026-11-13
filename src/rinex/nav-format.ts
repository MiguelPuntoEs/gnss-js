/**
 * Shared field formatting and record layouts of the RINEX navigation
 * writers (2.11, 3.04/3.05, 4.02). Internal: not re-exported by the
 * package index.
 */

import { padL, padR, hdrLine } from './format';
import {
  GLO_UNKNOWN_DELAY,
  GLO_UNKNOWN_URAI,
  type Ephemeris,
  type KeplerEphemeris,
  type GlonassEphemeris,
  type IonoCorrectionLine,
  type NavHeader,
  type NavIonRecord,
  type NavStoRecord,
  type TimeSystemCorr,
} from './nav';
import { navSecondsOfWeek } from '../navbits/index';

/* ================================================================== */
/*  D19.12 formatter                                                   */
/* ================================================================== */

/** RINEX D19.12 with a 1-digit integer part: " 5.153718750000E+03". */
const fmtD = (val: number): string => fmtSci(val, 19, 12, 'E');

/**
 * Fortran Dw.d / Ew.d with a 1-digit integer part (`1.2345E-08`), right
 * aligned in `w` columns; `exp` is the exponent letter.
 */
export function fmtSci(
  val: number,
  w: number,
  d: number,
  exp: 'E' | 'D' = 'E'
): string {
  // −0 keeps its sign: files print -0.000000000000E+00 for tiny negatives.
  if (val === 0)
    return `${Object.is(val, -0) ? '-' : ''}0.${'0'.repeat(d)}${exp}+00`.padStart(
      w
    );
  const sign = val < 0 ? '-' : '';
  const abs = Math.abs(val);
  let e = Math.floor(Math.log10(abs));
  let m = (abs / 10 ** e).toFixed(d);
  if (m.length > d + 2) {
    // Rounding pushed the mantissa to 10.000…: renormalise
    e += 1;
    m = (abs / 10 ** e).toFixed(d);
  }
  const es = `${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  return `${sign}${m}${exp}${es}`.padStart(w);
}

/** A blank 19-char field (RINEX "BNK"). */
export const BLANK19 = ' '.repeat(19);

/** RINEX "not known" transmission time of message (Tables A6-A18 **). */
export const TTM_UNKNOWN = 0.999999999999e9;

/* ================================================================== */
/*  Shared record layout (RINEX 3 and 4 classic records)               */
/* ================================================================== */

/**
 * The broadcast-orbit values of a Keplerian record (orbit-1 … orbit-7),
 * per system as RINEX 3.05 Tables A6/A8/A12/A14/A18 and 4.02 Tables
 * A9/A11/A13/A19/A30 lay them out; `null` = blank. RINEX 3 and 4 share
 * this layout field for field.
 */
export function keplerOrbitRows(eph: KeplerEphemeris): (number | null)[][] {
  const sys = eph.system;
  const ttm = eph.ttm ?? TTM_UNKNOWN;
  const gpsLike = sys === 'G' || sys === 'J';
  const rows: (number | null)[][] = [
    [eph.iode, eph.crs, eph.deltaN, eph.m0],
    [eph.cuc, eph.e, eph.cus, eph.sqrtA],
    [eph.toe, eph.cic, eph.omega0, eph.cis],
    [eph.i0, eph.crc, eph.omega, eph.omegaDot],
  ];
  if (gpsLike) {
    rows.push(
      [
        eph.idot,
        eph.l2Codes ?? 0,
        eph.week,
        // QZSS: "L2P data flag set to 1" (RINEX 3.05 Table A12)
        eph.l2pFlag ?? (sys === 'J' ? 1 : 0),
      ],
      // IODC is not in every decoder's output; LNAV ties its 8 LSBs to
      // IODE (IS-GPS-200 20.3.4.4), the same default ephemerisToInfo uses.
      [eph.svAccuracy ?? 0, eph.svHealth, eph.tgd, eph.iodc ?? eph.iode],
      [ttm, eph.fitInterval ?? null]
    );
  } else if (sys === 'E') {
    rows.push(
      // orbit-5 slot 4 is spare: left blank, as IGS and DLR write it
      [eph.idot, eph.dataSources ?? 0, eph.week],
      [eph.svAccuracy ?? 0, eph.svHealth, eph.tgd, eph.tgd2 ?? 0],
      [ttm]
    );
  } else if (sys === 'C') {
    rows.push(
      [eph.idot, 0, eph.week, 0],
      [eph.svAccuracy ?? 0, eph.svHealth, eph.tgd, eph.tgd2 ?? 0],
      [ttm, eph.aodc ?? null]
    );
  } else {
    // NavIC: orbit-5 slot 2 and orbit-6 slot 4 are blank by definition.
    rows.push(
      [eph.idot, null, eph.week],
      [eph.svAccuracy ?? 0, eph.svHealth, eph.tgd],
      [ttm]
    );
  }
  return rows;
}

/**
 * Orbit rows of a GLONASS / SBAS state-vector record. `fdmaStatus`
 * adds the fourth GLONASS line of RINEX 3.05 / 4 (status flags, L1/L2
 * group delay, URAI, health flags; blank / unknown sentinels where the
 * ephemeris does not carry them).
 */
export function stateVectorRows(
  eph: GlonassEphemeris,
  fdmaStatus: boolean
): (number | null)[][] {
  const glo = eph.system === 'R';
  const rows: (number | null)[][] = [
    [eph.x, eph.xDot, eph.xAcc, eph.health],
    [eph.y, eph.yDot, eph.yAcc, eph.freqNum],
    [
      eph.z,
      eph.zDot,
      eph.zAcc,
      glo ? (eph.ageOfOperation ?? 0) : (eph.iodn ?? 0),
    ],
  ];
  if (glo && fdmaStatus)
    rows.push([
      eph.statusFlags ?? null,
      eph.l1l2GroupDelay ?? GLO_UNKNOWN_DELAY,
      eph.urai ?? GLO_UNKNOWN_URAI,
      eph.healthFlags ?? null,
    ]);
  return rows;
}

/** A broadcast-orbit line: 4-space indent + D19.12 fields, trailing blanks trimmed. */
export function orbitLine(values: (number | null)[]): string {
  return (
    '    ' + values.map((v) => (v == null ? BLANK19 : fmtD(v))).join('')
  ).replace(/ +$/, '');
}

/* ================================================================== */
/*  Date formatting                                                    */
/* ================================================================== */

/** "YYYY MM DD HH MM SS" with zero-padded two-digit fields (5(1X,I2.2)). */
export function fmtEpoch(d: Date): string {
  const p2 = (v: number): string => String(v).padStart(2, '0');
  return (
    `${d.getUTCFullYear()} ${p2(d.getUTCMonth() + 1)} ${p2(d.getUTCDate())}` +
    ` ${p2(d.getUTCHours())} ${p2(d.getUTCMinutes())} ${p2(d.getUTCSeconds())}`
  );
}

/* ================================================================== */
/*  Header: iono / time-system lines, also derived from RINEX 4        */
/* ================================================================== */

export function isKepler(eph: Ephemeris): eph is KeplerEphemeris {
  return 'af0' in eph;
}

/** ION record (system, message) → RINEX 3 IONOSPHERIC CORR type prefix. */
function ionoPrefix(r: NavIonRecord): string | null {
  if (r.nequickG) return 'GAL';
  if (!r.klobuchar) return null;
  return (
    ({ G: 'GPS', J: 'QZS', C: 'BDS', I: 'IRN' } as Record<string, string>)[
      r.system
    ] ?? null
  );
}

/**
 * IONOSPHERIC CORR lines: the header's own, else ones rebuilt from
 * RINEX 4 ION records — the first of each kind, BDS one per satellite
 * with the transmission hour as time mark (Table A5).
 */
export function ionoLines(
  header: NavHeader,
  ion: NavIonRecord[] | undefined
): IonoCorrectionLine[] {
  if (header.ionoCorrectionLines?.length) return header.ionoCorrectionLines;
  const keys = Object.keys(header.ionoCorrections);
  if (keys.length > 0)
    return keys.map((type) => ({
      type,
      values: header.ionoCorrections[type]!,
    }));
  const out: IonoCorrectionLine[] = [];
  const seen = new Set<string>();
  for (const r of ion ?? []) {
    const prefix = ionoPrefix(r);
    if (!prefix) continue;
    const bds = prefix === 'BDS';
    // QZSS LNAV wide-area and Japan sets both map to QZSA/QZSB: keep
    // the wide-area (or untagged) one.
    if (prefix === 'QZS' && r.subtype === 'JAPN') continue;
    const key = bds ? `${prefix}${r.sv ?? ''}` : prefix;
    if (seen.has(key)) continue;
    seen.add(key);
    const tag = bds
      ? {
          timeMark: String.fromCharCode(65 + r.epoch.getUTCHours()),
          ...(r.sv && { sv: r.sv }),
        }
      : {};
    if (r.nequickG) {
      out.push({ type: 'GAL', values: r.nequickG.ai });
    } else if (r.klobuchar) {
      out.push({ type: `${prefix}A`, values: r.klobuchar.alpha, ...tag });
      out.push({ type: `${prefix}B`, values: r.klobuchar.beta, ...tag });
    }
  }
  return out;
}

/**
 * TIME SYSTEM CORR entries: the header's own, else rebuilt from RINEX 4
 * STO records (first per type; t_ref = t_ot as week + seconds, the A2
 * term and t_tm dropped). GLUT/GLGP keep t_ref zero (Table A5).
 */
export function timeCorrs(
  header: NavHeader,
  sto: NavStoRecord[] | undefined
): TimeSystemCorr[] {
  if (header.timeSystemCorr?.length) return header.timeSystemCorr;
  const out: TimeSystemCorr[] = [];
  const seen = new Set<string>();
  for (const r of sto ?? []) {
    if (seen.has(r.type)) continue;
    seen.add(r.type);
    const bds = r.type.startsWith('BD');
    const glo = r.type.startsWith('GL');
    const epochMs = r.epoch.getTime();
    const weekEpoch = bds ? Date.UTC(2006, 0, 1) : Date.UTC(1980, 0, 6);
    out.push({
      type: r.type,
      a0: r.a0,
      a1: r.a1,
      refTime: glo ? 0 : navSecondsOfWeek(epochMs),
      refWeek: glo ? 0 : Math.floor((epochMs - weekEpoch) / (604800 * 1000)),
      ...(r.sv && { sv: r.sv }),
      ...(r.sbasId && { sv: r.sbasId }),
    });
  }
  return out;
}

/* ================================================================== */
/*  Header writer                                                      */
/* ================================================================== */

/** Options shared by the navigation writers. */
export interface NavWriterOptions {
  /** PGM field (A20). Default "GNSSCalc". */
  program?: string;
  /** RUN BY field (A20). Default blank. */
  runBy?: string;
  /** File creation date. Default: now. */
  date?: Date;
}

/** RINEX 3 PGM / RUN BY / DATE date: "yyyymmdd hhmmss UTC". */
export function runDate(date: Date): string {
  const p2 = (v: number) => String(v).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${p2(date.getUTCMonth() + 1)}${p2(date.getUTCDate())}` +
    ` ${p2(date.getUTCHours())}${p2(date.getUTCMinutes())}${p2(date.getUTCSeconds())} UTC`
  );
}

/** LEAP SECONDS: I6 ΔtLS [, 3I6 ΔtLSF WN_LSF DN, A3 system]. */
export function leapLine(h: NavHeader): string | null {
  if (h.leapSeconds == null) return null;
  let s = padR(String(h.leapSeconds), 6);
  if (h.leapSecondsFuture != null)
    s +=
      padR(String(h.leapSecondsFuture), 6) +
      padR(String(h.leapSecondsWeek ?? 0), 6) +
      padR(String(h.leapSecondsDay ?? 0), 6);
  if (h.leapSecondsSystem) s = padL(s, 24) + padL(h.leapSecondsSystem, 3);
  return hdrLine(s, 'LEAP SECONDS');
}
