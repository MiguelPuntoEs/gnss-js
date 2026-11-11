/**
 * RINEX 3.x/4.x navigation file parser.
 * Parses GPS, Galileo, BeiDou (Keplerian), and GLONASS (state vector)
 * ephemerides, plus GPS/QZSS CNAV and BeiDou-3 CNV1/2/3 records from
 * RINEX 4 files.
 */

import {
  CNAV_A_REF,
  CNAV_OMEGA_DOT_REF,
  type CnavEphemeris,
} from '../navbits/cnav';
import { GPS_PI } from '../navbits/index';
import {
  bdsCnavAref,
  type BdsCnavEphemeris,
  type BdsCnavMessage,
} from '../navbits/bds-cnav';

export type { BdsCnavEphemeris, BdsCnavMessage } from '../navbits/bds-cnav';

/* ================================================================== */
/*  Public types                                                       */
/* ================================================================== */

export interface NavHeader {
  version: number;
  type: string;
  leapSeconds: number | null;
  ionoCorrections: Record<string, number[]>;
}

/** GPS / Galileo / BeiDou / QZSS / NavIC Keplerian ephemeris. */
export interface KeplerEphemeris {
  system: 'G' | 'E' | 'C' | 'J' | 'I';
  /** Satellite PRN, e.g. "G14". */
  prn: string;
  /** Epoch of clock in seconds of GPS week. */
  toc: number;
  /** Epoch of clock as a Date. */
  tocDate: Date;
  /** SV clock bias in seconds. */
  af0: number;
  /** SV clock drift in s/s. */
  af1: number;
  /** SV clock drift rate in s/s². */
  af2: number;
  /** Issue of data (ephemeris). */
  iode: number;
  /** Amplitude of sine correction to orbit radius in meters. */
  crs: number;
  /** Mean motion difference in rad/s. */
  deltaN: number;
  /** Mean anomaly at reference time in radians. */
  m0: number;
  /** Amplitude of cosine correction to argument of latitude in radians. */
  cuc: number;
  /** Eccentricity (dimensionless). */
  e: number;
  /** Amplitude of sine correction to argument of latitude in radians. */
  cus: number;
  /** Square root of semi-major axis in m^(1/2). */
  sqrtA: number;
  /** Time of ephemeris in seconds of GPS week. */
  toe: number;
  /** Amplitude of cosine correction to inclination in radians. */
  cic: number;
  /** Right ascension of ascending node at reference time in radians. */
  omega0: number;
  /** Amplitude of sine correction to inclination in radians. */
  cis: number;
  /** Inclination at reference time in radians. */
  i0: number;
  /** Amplitude of cosine correction to orbit radius in meters. */
  crc: number;
  /** Argument of perigee in radians. */
  omega: number;
  /** Rate of right ascension in rad/s. */
  omegaDot: number;
  /** Rate of inclination in rad/s. */
  idot: number;
  /** GPS week number. */
  week: number;
  /** SV health flag. */
  svHealth: number;
  /** Total group delay in seconds (GPS/QZSS TGD, Galileo BGD E5a/E1,
   *  BeiDou TGD1 B1I/B3I). */
  tgd: number;
  /** Second group delay (s): Galileo BGD E5b/E1, BeiDou TGD2 B2I/B3I.
   *  RINEX 3 only. */
  tgd2?: number;
  /** Transmission time of the message, seconds of the record's week in
   *  the system's time scale (may be negative: previous week). RINEX 3
   *  only; absent when the file marks it unknown. */
  ttm?: number;
  /** Signal-in-space accuracy the message claims (m): GPS/QZSS URA,
   *  Galileo SISA, BeiDou URA. RINEX 3 only. */
  svAccuracy?: number;
  /** Galileo data-sources bitfield (bit 0 I/NAV E1-B, 1 F/NAV E5a-I,
   *  2 I/NAV E5b-I, 8 clock for E5a/E1, 9 clock for E5b/E1). */
  dataSources?: number;
}

/** GLONASS / SBAS state-vector ephemeris. Positions in km, velocities in km/s, accelerations in km/s². */
export interface GlonassEphemeris {
  system: 'R' | 'S';
  prn: string;
  tocDate: Date;
  /** Clock bias (seconds). */
  tauN: number;
  /** Relative frequency bias (dimensionless). */
  gammaN: number;
  /** Message frame time (seconds of UTC day). */
  messageFrameTime: number;
  /** X position in km (PZ-90). */
  x: number;
  /** X velocity in km/s. */
  xDot: number;
  /** X acceleration in km/s² (luni-solar). */
  xAcc: number;
  /** Y position in km (PZ-90). */
  y: number;
  /** Y velocity in km/s. */
  yDot: number;
  /** Y acceleration in km/s² (luni-solar). */
  yAcc: number;
  /** Z position in km (PZ-90). */
  z: number;
  /** Z velocity in km/s. */
  zDot: number;
  /** Z acceleration in km/s² (luni-solar). */
  zAcc: number;
  /** Health flag (0 = healthy). */
  health: number;
  /** GLONASS frequency channel number (-7 to +6). */
  freqNum: number;
}

export type Ephemeris = KeplerEphemeris | GlonassEphemeris;

/**
 * A GPS or QZSS CNAV ephemeris read from a RINEX 4 `> EPH ... CNAV`
 * record (RINEX 4.01 Tables A10/A18). Same shape as the
 * `CnavEphemeris` assembled from raw navigation bits, except that
 * QZSS records are allowed.
 *
 * Fields the RINEX record does not carry are defaulted: `clockMsgType`
 * is 0 (the record does not say which MT3x supplied the clock), and
 * `integrityFlag`/`l2cPhasing` are false. `tow` holds the record's
 * transmission time of message (t_tm) and `wnOp` the ambiguity-resolved
 * data-predict week from the file. `toe` equals `toc` (RINEX 4.01
 * Table A10 note 2: per IS-GPS-705 20.3.4.4 only Toc is provided).
 */
export type RinexCnavEphemeris = Omit<CnavEphemeris, 'system'> & {
  system: 'G' | 'J';
};

export interface NavResult {
  header: NavHeader;
  ephemerides: Ephemeris[];
  /** GPS/QZSS CNAV ephemerides (RINEX 4 only), present when any were read. */
  cnav?: RinexCnavEphemeris[];
  /** BeiDou-3 CNV1/CNV2/CNV3 ephemerides (RINEX 4 only), when any were read. */
  bdsCnav?: BdsCnavEphemeris[];
}

/* ================================================================== */
/*  Constants                                                          */
/* ================================================================== */

// Lines per record (after epoch line) for each system (RINEX 2/3 default)
const DATA_LINES: Record<string, number> = {
  G: 7,
  E: 7,
  C: 7,
  J: 7, // Keplerian
  R: 3, // GLONASS state vector
  S: 3,
  I: 7, // SBAS / NavIC
};

/**
 * RINEX 4 message type → total lines after the `>` header (epoch + data).
 * Used both to skip unsupported types and to read supported ones correctly.
 */
const R4_MSG_LINES: Record<string, number> = {
  // EPH types we parse (same Keplerian/state-vector layout as RINEX 3)
  LNAV: 8,
  INAV: 8,
  FNAV: 8,
  D1: 8,
  D2: 8,
  SBAS: 4,
  FDMA: 5, // RINEX 4 adds orbit-4 (status flags) vs 3 in RINEX 3

  // EPH type parsed into RinexCnavEphemeris for G/J (skipped otherwise)
  CNAV: 9,

  // BeiDou-3 B-CNAV, parsed into BdsCnavEphemeris
  CNV1: 10,
  CNV2: 10,
  CNV3: 9,

  // EPH types we skip (different field layout)
  L1NV: 8,
  L1OC: 9,
  L3OC: 9,
};

/** GPS epoch (1980-01-06T00:00:00) mapped onto the JS epoch. */
const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const SEC_PER_WEEK = 7 * 86400;

/**
 * QZSS CNAV ΔA reference semi-major axis (m, IS-QZSS-PNT). The GPS
 * value lives in ../navbits/cnav (CNAV_A_REF).
 */
const QZSS_CNAV_A_REF = 42164200;

/** Message types whose field layout matches our Keplerian/state-vector builders. */
const SUPPORTED_EPH_MSGS = new Set([
  'LNAV',
  'INAV',
  'FNAV',
  'D1',
  'D2',
  'SBAS',
  'FDMA',
]);

/* ================================================================== */
/*  Parser                                                             */
/* ================================================================== */

function parseFloat19(s: string): number {
  // RINEX uses 'D' for exponent in some files
  return parseFloat(s.trim().replace(/[dD]/g, 'E'));
}

/** Parse RINEX 3/4 epoch line: A3,I5,4(1X,I2.2),I3,3D19.12 */
function parseNavEpochV3(line: string): {
  prn: string;
  date: Date;
  values: number[];
} {
  const prn = line.substring(0, 3).trim();
  const yr = parseInt(line.substring(3, 8));
  const mo = parseInt(line.substring(8, 11));
  const dy = parseInt(line.substring(11, 14));
  const hr = parseInt(line.substring(14, 17));
  const mn = parseInt(line.substring(17, 20));
  const sc = parseInt(line.substring(20, 23));
  const date = new Date(Date.UTC(yr, mo - 1, dy, hr, mn, sc));

  const values: number[] = [];
  // 3 values on epoch line, starting at col 23, each 19 chars
  for (let i = 0; i < 3; i++) {
    const start = 23 + i * 19;
    if (start < line.length) {
      values.push(parseFloat19(line.substring(start, start + 19)));
    }
  }
  return { prn, date, values };
}

/** Parse RINEX 2 epoch line: I2,5I3,F5.1,3D19.12 */
function parseNavEpochV2(
  line: string,
  defaultSys: string
): { prn: string; date: Date; values: number[] } {
  const prnNum = parseInt(line.substring(0, 2));
  const yr = parseInt(line.substring(2, 5));
  const mo = parseInt(line.substring(5, 8));
  const dy = parseInt(line.substring(8, 11));
  const hr = parseInt(line.substring(11, 14));
  const mn = parseInt(line.substring(14, 17));
  const sc = parseFloat(line.substring(17, 22));
  const fullYr = yr < 80 ? 2000 + yr : 1900 + yr;
  const date = new Date(Date.UTC(fullYr, mo - 1, dy, hr, mn, Math.floor(sc)));

  const prn = `${defaultSys}${String(prnNum).padStart(2, '0')}`;

  const values: number[] = [];
  // 3 values starting at col 22, each 19 chars
  for (let i = 0; i < 3; i++) {
    const start = 22 + i * 19;
    if (start < line.length) {
      values.push(parseFloat19(line.substring(start, start + 19)));
    }
  }
  return { prn, date, values };
}

function parseDataLine(line: string, colOffset = 4): number[] {
  const values: number[] = [];
  for (let i = 0; i < 4; i++) {
    const start = colOffset + i * 19;
    if (start >= line.length) break;
    const s = line.substring(start, start + 19).trim();
    if (s.length > 0) {
      const v = parseFloat19(s);
      values.push(Number.isFinite(v) ? v : 0);
    }
  }
  return values;
}

/**
 * Parse a data line keeping the four 19-char field positions: blank
 * slots stay `null` instead of collapsing. Needed for CNAV records,
 * where a blank marks "not available" (RINEX 4.01 Table A18 note 3:
 * the TGD/ISC do-not-use bit pattern is a blank field).
 */
function parseDataLineSlots(line: string): (number | null)[] {
  const values: (number | null)[] = [];
  for (let i = 0; i < 4; i++) {
    const start = 4 + i * 19;
    const s =
      start < line.length ? line.substring(start, start + 19).trim() : '';
    if (s.length === 0) {
      values.push(null);
      continue;
    }
    const v = parseFloat19(s);
    values.push(Number.isFinite(v) ? v : null);
  }
  return values;
}

function buildKeplerEphemeris(
  sys: 'G' | 'E' | 'C' | 'J' | 'I',
  prn: string,
  date: Date,
  epochVals: number[],
  data: number[][]
): KeplerEphemeris {
  // Flatten data lines, padding each to 4 values.
  // Some constellations' last orbit line has fewer than 4 fields
  // (e.g. Galileo orbit-7 often has only 1), so we must pad to keep
  // the flat array indices stable.
  const d: number[] = [];
  for (const line of data) {
    for (let i = 0; i < 4; i++) d.push(line[i] ?? 0);
  }
  return {
    system: sys,
    prn,
    tocDate: date,
    toc: (date.getTime() / 1000) % (7 * 86400), // seconds of week approx
    af0: epochVals[0] ?? 0,
    af1: epochVals[1] ?? 0,
    af2: epochVals[2] ?? 0,
    iode: d[0] ?? 0,
    crs: d[1] ?? 0,
    deltaN: d[2] ?? 0,
    m0: d[3] ?? 0,
    cuc: d[4] ?? 0,
    e: d[5] ?? 0,
    cus: d[6] ?? 0,
    sqrtA: d[7] ?? 0,
    toe: d[8] ?? 0,
    cic: d[9] ?? 0,
    omega0: d[10] ?? 0,
    cis: d[11] ?? 0,
    i0: d[12] ?? 0,
    crc: d[13] ?? 0,
    omega: d[14] ?? 0,
    omegaDot: d[15] ?? 0,
    idot: d[16] ?? 0,
    // d[17] = codes on L2 (GPS) or data sources (GAL)
    week: d[18] ?? 0,
    // d[19] = L2P flag (GPS) or spare
    // d[20] = SV accuracy (URA index for GPS, SISA for GAL)
    svHealth: d[21] ?? 0,
    tgd: d[22] ?? 0,
    // d[23] = IODC (GPS/QZSS), BGD E5b/E1 (GAL), TGD2 (BDS)
    ...((sys === 'E' || sys === 'C') && { tgd2: d[23] ?? 0 }),
    // d[24] = transmission time; 0.9999e9 marks it unknown
    ...(data.length >= 7 && Math.abs(d[24] ?? 1e9) < 1e6 && { ttm: d[24] }),
    ...(d[20] != null && d[20] > 0 && { svAccuracy: d[20] }),
    ...(sys === 'E' && { dataSources: d[17] ?? 0 }),
  };
}

function buildStateVectorEphemeris(
  sys: 'R' | 'S',
  prn: string,
  date: Date,
  epochVals: number[],
  data: number[][]
): GlonassEphemeris {
  const d = data.flat();
  return {
    system: sys,
    prn,
    tocDate: date,
    tauN: epochVals[0] ?? 0,
    gammaN: epochVals[1] ?? 0,
    messageFrameTime: epochVals[2] ?? 0,
    x: d[0] ?? 0,
    xDot: d[1] ?? 0,
    xAcc: d[2] ?? 0,
    health: d[3] ?? 0,
    y: d[4] ?? 0,
    yDot: d[5] ?? 0,
    yAcc: d[6] ?? 0,
    freqNum: d[7] ?? 0,
    z: d[8] ?? 0,
    zDot: d[9] ?? 0,
    zAcc: d[10] ?? 0,
  };
}

/**
 * Build a `RinexCnavEphemeris` from a RINEX 4 GPS/QZSS CNAV record
 * (epoch line + 8 broadcast-orbit lines, RINEX 4.01 Tables A10/A18):
 *
 *   orbit-1: ADOT, Crs, Δn0, M0
 *   orbit-2: Cuc, e, Cus, √A
 *   orbit-3: t_op, Cic, Ω0, Cis
 *   orbit-4: i0, Crc, ω, Ω̇
 *   orbit-5: IDOT, Δn0Dot, URAI_NED0, URAI_NED1
 *   orbit-6: URAI_ED, SV health, TGD, URAI_NED2
 *   orbit-7: ISC_L1CA, ISC_L2C, ISC_L5I5, ISC_L5Q5
 *   orbit-8: t_tm, wn_op
 *
 * ΔA and ΔΩ̇ are recovered from √A / Ω̇ using the constellation's
 * reference values; the GPS week and toc seconds-of-week come from the
 * epoch date (the record stores only Toc — Toe equals it by the CNAV
 * consistency rule).
 */
function buildCnavEphemeris(
  sys: 'G' | 'J',
  prn: string,
  date: Date,
  epochVals: number[],
  d: (number | null)[][]
): RinexCnavEphemeris {
  const num = (r: number, c: number): number => d[r]?.[c] ?? 0;
  const opt = (r: number, c: number): number | null => d[r]?.[c] ?? null;

  const t = (date.getTime() - GPS_EPOCH_MS) / 1000;
  const week = Math.floor(t / SEC_PER_WEEK);
  const toc = t - week * SEC_PER_WEEK;

  const sqrtA = num(1, 3);
  const a = sqrtA * sqrtA;
  const aRef = sys === 'J' ? QZSS_CNAV_A_REF : CNAV_A_REF;
  const omegaDot = num(3, 3);
  const wnOp = d[7]?.[1];

  return {
    system: sys,
    prn,
    week,
    health: num(5, 1),
    uraEd: num(5, 0),
    uraNed0: num(4, 2),
    uraNed1: num(4, 3),
    uraNed2: num(5, 3),
    top: num(2, 0),
    toe: toc,
    toeDate: date,
    a,
    deltaA: a - aRef,
    aDot: num(0, 0),
    deltaN0: num(0, 2),
    deltaN0Dot: num(4, 1),
    m0: num(0, 3),
    e: num(1, 1),
    omega: num(3, 2),
    omega0: num(2, 2),
    i0: num(3, 0),
    omegaDot,
    deltaOmegaDot: omegaDot - CNAV_OMEGA_DOT_REF * GPS_PI,
    i0Dot: num(4, 0),
    cis: num(2, 3),
    cic: num(2, 1),
    crs: num(0, 1),
    crc: num(3, 1),
    cus: num(1, 2),
    cuc: num(1, 0),
    toc,
    tocDate: date,
    af0: epochVals[0] ?? 0,
    af1: epochVals[1] ?? 0,
    af2: epochVals[2] ?? 0,
    clockMsgType: 0, // not recorded in RINEX
    tgd: opt(5, 2),
    iscL1ca: opt(6, 0),
    iscL2c: opt(6, 1),
    iscL5i5: opt(6, 2),
    iscL5q5: opt(6, 3),
    ...(wnOp != null && { wnOp }),
    integrityFlag: false, // not recorded in RINEX
    l2cPhasing: false, // not recorded in RINEX
    tow: num(7, 0),
  };
}

const BDT_EPOCH_MS = Date.UTC(2006, 0, 1);

/**
 * Build a `BdsCnavEphemeris` from a RINEX 4 BeiDou CNV1/CNV2/CNV3 record
 * (RINEX 4.02 Tables A24-A26; epochs naive BDT):
 *
 *   orbit-1: ADOT, Crs, Δn0, M0
 *   orbit-2: Cuc, e, Cus, √A
 *   orbit-3: toe, Cic, Ω0, Cis
 *   orbit-4: i0, Crc, ω, Ω̇
 *   orbit-5: IDOT, Δn0Dot, SatType, t_op
 *   orbit-6: SISAI_oe, SISAI_ocb, SISAI_oc1, SISAI_oc2
 *   CNV1/2 orbit-7: ISC_B1Cd, ISC_B2ad, TGD_B1Cp, TGD_B2ap
 *          orbit-8: SISMAI, health, integrity flags, IODC
 *          orbit-9: t_tm, spare, spare, IODE
 *   CNV3   orbit-7: SISMAI, health, integrity flags, TGD_B2bI
 *          orbit-8: t_tm
 *
 * ΔA is recovered from √A with the SatType reference radius.
 */
function buildBdsCnavEphemeris(
  message: BdsCnavMessage,
  prn: string,
  date: Date,
  epochVals: number[],
  d: (number | null)[][]
): BdsCnavEphemeris {
  const num = (r: number, c: number): number => d[r]?.[c] ?? 0;
  const opt = (r: number, c: number): number | null => d[r]?.[c] ?? null;
  const cnv3 = message === 'CNV3';

  const t = (date.getTime() - BDT_EPOCH_MS) / 1000;
  const weekToc = Math.floor(t / SEC_PER_WEEK);
  const toc = t - weekToc * SEC_PER_WEEK;
  const toe = num(2, 0);
  const week =
    toe - toc > SEC_PER_WEEK / 2
      ? weekToc - 1
      : toc - toe > SEC_PER_WEEK / 2
        ? weekToc + 1
        : weekToc;
  const sqrtA = num(1, 3);
  const a = sqrtA * sqrtA;
  const satType = num(4, 2);

  return {
    system: 'C',
    prn,
    message,
    week,
    toe,
    toeDate: new Date(BDT_EPOCH_MS + (week * SEC_PER_WEEK + toe) * 1000),
    toc,
    tocDate: date,
    satType,
    a,
    deltaA: a - bdsCnavAref(satType),
    aDot: num(0, 0),
    deltaN0: num(0, 2),
    deltaN0Dot: num(4, 1),
    m0: num(0, 3),
    e: num(1, 1),
    omega: num(3, 2),
    omega0: num(2, 2),
    i0: num(3, 0),
    omegaDot: num(3, 3),
    i0Dot: num(4, 0),
    cis: num(2, 3),
    cic: num(2, 1),
    crs: num(0, 1),
    crc: num(3, 1),
    cus: num(1, 2),
    cuc: num(1, 0),
    af0: epochVals[0] ?? 0,
    af1: epochVals[1] ?? 0,
    af2: epochVals[2] ?? 0,
    iode: cnv3 ? null : opt(8, 3),
    iodc: cnv3 ? null : opt(7, 3),
    tgdB1Cp: cnv3 ? null : opt(6, 2),
    tgdB2ap: cnv3 ? null : opt(6, 3),
    iscB1Cd: cnv3 ? null : opt(6, 0),
    iscB2ad: cnv3 ? null : opt(6, 1),
    tgdB2bI: cnv3 ? opt(6, 3) : null,
    top: opt(4, 3),
    sisaiOe: opt(5, 0),
    sisaiOcb: opt(5, 1),
    sisaiOc1: opt(5, 2),
    sisaiOc2: opt(5, 3),
    sismai: cnv3 ? opt(6, 0) : opt(7, 0),
    health: cnv3 ? opt(6, 1) : opt(7, 1),
    integrityFlags: cnv3 ? opt(6, 2) : opt(7, 2),
    tow: cnv3 ? num(7, 0) : num(8, 0),
  };
}

export function parseNavFile(text: string): NavResult {
  const lines = text.split('\n');
  const header: NavHeader = {
    version: 0,
    type: '',
    leapSeconds: null,
    ionoCorrections: {},
  };
  const ephemerides: Ephemeris[] = [];
  const cnav: RinexCnavEphemeris[] = [];
  const bdsCnav: BdsCnavEphemeris[] = [];

  let inHeader = true;
  let i = 0;

  // Parse header
  while (i < lines.length) {
    const line = lines[i]!;
    const label = line.substring(60).trim();

    if (label === 'END OF HEADER') {
      inHeader = false;
      i++;
      break;
    }

    if (label === 'RINEX VERSION / TYPE') {
      header.version = parseFloat(line.substring(0, 9));
      header.type = line.substring(20, 40).trim();
    } else if (label === 'LEAP SECONDS') {
      header.leapSeconds = parseInt(line.substring(0, 6));
    } else if (label === 'IONOSPHERIC CORR') {
      const corrType = line.substring(0, 4).trim();
      const vals: number[] = [];
      for (let j = 0; j < 4; j++) {
        const s = line.substring(5 + j * 12, 5 + (j + 1) * 12).trim();
        if (s) vals.push(parseFloat19(s));
      }
      header.ionoCorrections[corrType] = vals;
    } else if (label === 'ION ALPHA') {
      // RINEX 2 GPS iono alpha
      const vals: number[] = [];
      for (let j = 0; j < 4; j++) {
        const s = line.substring(2 + j * 12, 2 + (j + 1) * 12).trim();
        if (s) vals.push(parseFloat19(s));
      }
      header.ionoCorrections['GPSA'] = vals;
    } else if (label === 'ION BETA') {
      // RINEX 2 GPS iono beta
      const vals: number[] = [];
      for (let j = 0; j < 4; j++) {
        const s = line.substring(2 + j * 12, 2 + (j + 1) * 12).trim();
        if (s) vals.push(parseFloat19(s));
      }
      header.ionoCorrections['GPSB'] = vals;
    }

    i++;
  }

  if (inHeader) return { header, ephemerides };

  // Determine RINEX version and default system for v2
  const isV2 = header.version > 0 && header.version < 3;
  let defaultSys = 'G';
  if (isV2) {
    const ht = header.type.toUpperCase();
    if (ht.includes('GLONASS')) defaultSys = 'R';
    else if (ht.includes('GEO')) defaultSys = 'S';
    else if (ht.includes('GALILEO')) defaultSys = 'E';
    else if (ht.includes('BEIDOU') || ht.includes('BDS')) defaultSys = 'C';
    // Default: GPS
  }

  // Parse records
  const isV4 = header.version >= 4;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim().length === 0) {
      i++;
      continue;
    }

    // ── RINEX 4: handle `>` record header lines ──
    if (isV4 && line.charAt(0) === '>') {
      const parts = line.substring(2).trim().split(/\s+/);
      const recType = parts[0] ?? ''; // EPH, STO, EOP, ION
      const svSys = (parts[1] ?? '').charAt(0); // G, R, E, C, J, I, S
      const msgType = parts[2] ?? recType; // LNAV, CNAV, FDMA, etc.

      if (recType !== 'EPH') {
        // STO/EOP/ION records have fixed shapes (RINEX 4.01 Tables
        // A30-A34); their msgType field (LNAV/CNVX/IFNV/...) names the
        // source navigation message, not the record length, so it must
        // not drive the skip. ION is 3 lines for Klobuchar/BDGIM but
        // 2 for the Galileo NeQuick-G record.
        const totalLines =
          recType === 'STO'
            ? 2
            : recType === 'EOP'
              ? 3
              : recType === 'ION'
                ? svSys === 'E'
                  ? 2
                  : 3
                : 2;
        i += totalLines + 1; // +1 for the `>` line itself
        continue;
      }

      const isCnav = msgType === 'CNAV' && (svSys === 'G' || svSys === 'J');
      const isBdsCnav =
        svSys === 'C' &&
        (msgType === 'CNV1' || msgType === 'CNV2' || msgType === 'CNV3');
      if (!SUPPORTED_EPH_MSGS.has(msgType) && !isCnav && !isBdsCnav) {
        // Skip unsupported EPH record: advance past all its lines
        const totalLines = R4_MSG_LINES[msgType] ?? 2;
        i += totalLines + 1; // +1 for the `>` line itself
        continue;
      }

      // Supported EPH: read the correct number of data lines
      const numDataLines = (R4_MSG_LINES[msgType] ?? 8) - 1; // minus epoch line

      // Advance past `>` to epoch line
      i++;
      if (i >= lines.length) break;
      const epochLine = lines[i]!;
      const sys = epochLine.charAt(0);
      const parsed = parseNavEpochV3(epochLine);
      const prn = `${sys}${parsed.prn.substring(1)}`;

      if (isCnav || isBdsCnav) {
        // CNAV records: position-aware fields (blanks = unavailable)
        const slotLines: (number | null)[][] = [];
        for (let j = 0; j < numDataLines; j++) {
          i++;
          if (i >= lines.length) break;
          slotLines.push(parseDataLineSlots(lines[i]!));
        }
        if (slotLines.length === numDataLines) {
          if (isBdsCnav && sys === 'C')
            bdsCnav.push(
              buildBdsCnavEphemeris(
                msgType as BdsCnavMessage,
                prn,
                parsed.date,
                parsed.values,
                slotLines
              )
            );
          else if (sys === 'G' || sys === 'J')
            cnav.push(
              buildCnavEphemeris(
                sys,
                prn,
                parsed.date,
                parsed.values,
                slotLines
              )
            );
        }
        i++;
        continue;
      }

      // Read data lines
      const dataLines: number[][] = [];
      for (let j = 0; j < numDataLines; j++) {
        i++;
        if (i >= lines.length) break;
        dataLines.push(parseDataLine(lines[i]!, 4));
      }

      if (dataLines.length === numDataLines) {
        if (sys === 'R' || sys === 'S') {
          ephemerides.push(
            buildStateVectorEphemeris(
              sys,
              prn,
              parsed.date,
              parsed.values,
              dataLines
            )
          );
        } else if (
          sys === 'G' ||
          sys === 'E' ||
          sys === 'C' ||
          sys === 'J' ||
          sys === 'I'
        ) {
          ephemerides.push(
            buildKeplerEphemeris(
              sys,
              prn,
              parsed.date,
              parsed.values,
              dataLines
            )
          );
        }
      }

      i++;
      continue;
    }

    // ── RINEX 2/3: no `>` prefix ──
    let sys: string;
    let prn: string;
    let date: Date;
    let epochVals: number[];

    if (isV2) {
      const parsed = parseNavEpochV2(line, defaultSys);
      sys = defaultSys;
      prn = parsed.prn;
      date = parsed.date;
      epochVals = parsed.values;
    } else {
      sys = line.charAt(0);
      const parsed = parseNavEpochV3(line);
      prn = `${sys}${parsed.prn.substring(1)}`;
      date = parsed.date;
      epochVals = parsed.values;
    }

    const numDataLines = DATA_LINES[sys];
    if (numDataLines == null) {
      // Unknown system, try to skip
      i++;
      continue;
    }

    // Read data lines
    const dataLines: number[][] = [];
    for (let j = 0; j < numDataLines; j++) {
      i++;
      if (i >= lines.length) break;
      dataLines.push(parseDataLine(lines[i]!, isV2 ? 3 : 4));
    }

    if (dataLines.length === numDataLines) {
      if (sys === 'R' || sys === 'S') {
        ephemerides.push(
          buildStateVectorEphemeris(sys, prn, date, epochVals, dataLines)
        );
      } else if (
        sys === 'G' ||
        sys === 'E' ||
        sys === 'C' ||
        sys === 'J' ||
        sys === 'I'
      ) {
        ephemerides.push(
          buildKeplerEphemeris(sys, prn, date, epochVals, dataLines)
        );
      }
    }

    i++;
  }

  return {
    header,
    ephemerides,
    ...(cnav.length > 0 && { cnav }),
    ...(bdsCnav.length > 0 && { bdsCnav }),
  };
}
