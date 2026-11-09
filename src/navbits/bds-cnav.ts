/**
 * BeiDou-3 civil navigation messages: B-CNAV1 (B1C), B-CNAV2 (B2a) and
 * B-CNAV3 (B2b I-component, MEO/IGSO). All three share one ephemeris
 * model — "ephemeris I" (203 bits) + "ephemeris II" (222 bits) + a
 * 69-bit clock block, with ΔA / Ȧ / Δṅ₀ like GPS CNAV — packaged
 * differently per signal:
 *
 *  - B-CNAV1: subframe 2 (600 bits) carries a complete set (WN, IODC,
 *    IODE, ephemeris I+II, clock, TGD/ISC); subframe 3 pages carry the
 *    health, integrity flags and accuracy indices.
 *  - B-CNAV2: 288-bit messages — ephemeris I in Message Type 10,
 *    ephemeris II in 11, the clock in 30-34 (TGD/ISC only in 30).
 *  - B-CNAV3: 486-bit messages — ephemeris I+II in Message Type 10, the
 *    clock + TGD + health in 30. No IODE/IODC.
 *
 * Receiver-independent: feed decoded (post-LDPC), bit-0-aligned
 * messages. Bit layouts and scale factors from the CSNO interface
 * control documents BDS-SIS-ICD-B1C-1.0 (§6.2.3, §7), B2a-1.0 (§6.2)
 * and B2b-1.0 (§6.2.3), all CRC-24Q protected (same polynomial as GPS
 * CNAV). Output mirrors the RINEX 4 CNV1/CNV2/CNV3 records (Tables
 * A24-A26), validated field-for-field against DLR's BRD400DLR merged
 * broadcast file.
 *
 * Time: BDT. `toeDate`/`tocDate` are naive-BDT calendar Dates, like the
 * D1/D2 ephemerides of ./bds and RINEX BDS records.
 */

import { getBitS, getBitU, GPS_PI } from './index';
import { crc24q, getBitS33, getBitU33 } from './cnav';

/** BDT calendar epoch (2006-01-01 00:00:00 BDT), naive. */
const BDT_EPOCH_MS = Date.UTC(2006, 0, 1);
const SEC_PER_WEEK = 7 * 86400;
const HALF_WEEK = 302400;

/** Reference semi-major axis for ΔA (m): MEO, and IGSO/GEO (ICD §7.7). */
export const BDS_CNAV_A_REF_MEO = 27906100;
export const BDS_CNAV_A_REF_IGSO_GEO = 42162200;

/** Reference semi-major axis for a SatType (1 GEO, 2 IGSO, 3 MEO). */
export function bdsCnavAref(satType: number): number {
  return satType === 3 ? BDS_CNAV_A_REF_MEO : BDS_CNAV_A_REF_IGSO_GEO;
}

/** RINEX 4 record label of each message (signal). */
export type BdsCnavMessage = 'CNV1' | 'CNV2' | 'CNV3';

/**
 * A BeiDou-3 B-CNAV ephemeris + clock set, shaped like the RINEX 4
 * CNV1/CNV2/CNV3 record. SI units, radians. Fields a message does not
 * carry (or that have not been received yet) are null.
 */
export interface BdsCnavEphemeris {
  system: 'C';
  /** RINEX PRN, e.g. "C28". */
  prn: string;
  /** Source message: CNV1 (B1C), CNV2 (B2a), CNV3 (B2b). */
  message: BdsCnavMessage;
  /** BDT week of toe. */
  week: number;
  /** Time of ephemeris, s of the BDT week; and as a naive-BDT Date. */
  toe: number;
  toeDate: Date;
  /** Clock reference time, s of the BDT week; and as a naive-BDT Date. */
  toc: number;
  tocDate: Date;
  /** 1 = GEO, 2 = IGSO, 3 = MEO (0 reserved). */
  satType: number;
  /** Semi-major axis at toe (m) — reference + ΔA. */
  a: number;
  /** ΔA: semi-major axis difference from the SatType reference (m). */
  deltaA: number;
  /** Rate of semi-major axis (m/s). */
  aDot: number;
  /** Mean motion difference (rad/s) and its rate (rad/s²). */
  deltaN0: number;
  deltaN0Dot: number;
  m0: number;
  e: number;
  omega: number;
  omega0: number;
  i0: number;
  /** Rate of right ascension (rad/s) — absolute, no reference offset. */
  omegaDot: number;
  i0Dot: number;
  cis: number;
  cic: number;
  crs: number;
  crc: number;
  cus: number;
  cuc: number;
  /** Clock bias (s), drift (s/s), drift rate (s/s²). */
  af0: number;
  af1: number;
  af2: number;
  /** Issue of data (B-CNAV1/2); null for B-CNAV3, which has none. */
  iode: number | null;
  iodc: number | null;
  /** Group delays / inter-signal corrections (s), where broadcast. */
  tgdB1Cp: number | null;
  tgdB2ap: number | null;
  iscB1Cd: number | null;
  iscB2ad: number | null;
  tgdB2bI: number | null;
  /** Data-predict time (s of week) and accuracy indices. */
  top: number | null;
  sisaiOe: number | null;
  sisaiOcb: number | null;
  sisaiOc1: number | null;
  sisaiOc2: number | null;
  /** Signal-in-space monitoring accuracy index. */
  sismai: number | null;
  /** 2-bit satellite health (0 healthy). */
  health: number | null;
  /**
   * Integrity flags as in RINEX 4: CNV1/CNV3 3 bits (DIF·SIF·AIF, DIF
   * the MSB); CNV2 6 bits, the B2a triple above the B1C one.
   */
  integrityFlags: number | null;
  /** Transmission time of message, s of the BDT week (RINEX t_tm). */
  tow: number;
}

/* ── shared data blocks ────────────────────────────────────────── */

interface EphI {
  toe: number;
  satType: number;
  deltaA: number;
  aDot: number;
  deltaN0: number;
  deltaN0Dot: number;
  m0: number;
  e: number;
  omega: number;
}

interface EphII {
  omega0: number;
  i0: number;
  omegaDot: number;
  i0Dot: number;
  cis: number;
  cic: number;
  crs: number;
  crc: number;
  cus: number;
  cuc: number;
}

interface Clock {
  toc: number;
  af0: number;
  af1: number;
  af2: number;
}

interface SisaiOc {
  top: number;
  ocb: number;
  oc1: number;
  oc2: number;
}

/** Ephemeris I (203 bits) — B1C ICD Figure 6-12 / Table 7-8. */
function ephI(b: Uint8Array, p: number): EphI {
  return {
    toe: getBitU(b, p, 11) * 300,
    satType: getBitU(b, p + 11, 2),
    deltaA: getBitS(b, p + 13, 26) * 2 ** -9,
    aDot: getBitS(b, p + 39, 25) * 2 ** -21,
    deltaN0: getBitS(b, p + 64, 17) * 2 ** -44 * GPS_PI,
    deltaN0Dot: getBitS(b, p + 81, 23) * 2 ** -57 * GPS_PI,
    m0: getBitS33(b, p + 104) * 2 ** -32 * GPS_PI,
    e: getBitU33(b, p + 137) * 2 ** -34,
    omega: getBitS33(b, p + 170) * 2 ** -32 * GPS_PI,
  };
}

/** Ephemeris II (222 bits) — B1C ICD Figure 6-13 / Table 7-8. */
function ephII(b: Uint8Array, p: number): EphII {
  return {
    omega0: getBitS33(b, p) * 2 ** -32 * GPS_PI,
    i0: getBitS33(b, p + 33) * 2 ** -32 * GPS_PI,
    omegaDot: getBitS(b, p + 66, 19) * 2 ** -44 * GPS_PI,
    i0Dot: getBitS(b, p + 85, 15) * 2 ** -44 * GPS_PI,
    cis: getBitS(b, p + 100, 16) * 2 ** -30,
    cic: getBitS(b, p + 116, 16) * 2 ** -30,
    crs: getBitS(b, p + 132, 24) * 2 ** -8,
    crc: getBitS(b, p + 156, 24) * 2 ** -8,
    cus: getBitS(b, p + 180, 21) * 2 ** -30,
    cuc: getBitS(b, p + 201, 21) * 2 ** -30,
  };
}

/** Clock correction parameters (69 bits) — B1C ICD §7.5. */
function clock(b: Uint8Array, p: number): Clock {
  return {
    toc: getBitU(b, p, 11) * 300,
    af0: getBitS(b, p + 11, 25) * 2 ** -34,
    af1: getBitS(b, p + 36, 22) * 2 ** -50,
    af2: getBitS(b, p + 58, 11) * 2 ** -66,
  };
}

/**
 * SISAI_oc (22 bits): top, SISAI_ocb, SISAI_oc1, SISAI_oc2. The ICDs
 * defer the index definitions ("will be published in a future
 * update"); the three are read as two's complement like GPS CNAV's
 * URA_NED0, which is how most RINEX producers print them (DLR's merged
 * file: SISAI_ocb −2 in every record, SISAI_oc1/2 mostly −1).
 */
function sisaiOc(b: Uint8Array, p: number): SisaiOc {
  return {
    top: getBitU(b, p, 11) * 300,
    ocb: getBitS(b, p + 11, 5),
    oc1: getBitS(b, p + 16, 3),
    oc2: getBitS(b, p + 19, 3),
  };
}

/** 12-bit TGD / ISC, two's complement × 2⁻³⁴ s. */
const delay = (b: Uint8Array, p: number): number =>
  getBitS(b, p, 12) * 2 ** -34;

/* ── CRC gates ─────────────────────────────────────────────────── */

/** CRC-24Q over the leading `dataBits`, checked against the next 24. */
function crcOk(msg: Uint8Array, dataBits: number): boolean {
  const need = Math.ceil((dataBits + 24) / 8);
  return (
    msg.length >= need && crc24q(msg, dataBits) === getBitU(msg, dataBits, 24)
  );
}

/** B-CNAV1 subframe 2 (600 bits: 576 data + CRC). */
export const bdsCnav1Sf2CrcOk = (sf2: Uint8Array): boolean => crcOk(sf2, 576);
/** B-CNAV1 subframe 3 (264 bits: 240 data + CRC). */
export const bdsCnav1Sf3CrcOk = (sf3: Uint8Array): boolean => crcOk(sf3, 240);
/** B-CNAV2 message (288 bits from PRN, preamble excluded: 264 + CRC). */
export const bdsCnav2CrcOk = (msg: Uint8Array): boolean => crcOk(msg, 264);
/** B-CNAV3 message (486 bits from MesType: 462 + CRC). */
export const bdsCnav3CrcOk = (msg: Uint8Array): boolean => crcOk(msg, 462);

/* ── assembly ──────────────────────────────────────────────────── */

/** Resolve `sec` (s of week) to the week nearest the transmit time. */
function resolveWeek(week: number, towSec: number, sec: number): number {
  if (sec < towSec - HALF_WEEK) return week + 1;
  if (sec > towSec + HALF_WEEK) return week - 1;
  return week;
}

function bdtDate(week: number, sec: number): Date {
  return new Date(BDT_EPOCH_MS + (week * SEC_PER_WEEK + sec) * 1000);
}

/** Status fields that arrive separately from the ephemeris. */
interface Status {
  top: number | null;
  sisaiOe: number | null;
  sisaiOcb: number | null;
  sisaiOc1: number | null;
  sisaiOc2: number | null;
  sismai: number | null;
  health: number | null;
  integrityFlags: number | null;
}

const emptyStatus = (): Status => ({
  top: null,
  sisaiOe: null,
  sisaiOcb: null,
  sisaiOc1: null,
  sisaiOc2: null,
  sismai: null,
  health: null,
  integrityFlags: null,
});

function applyOc(s: Status, oc: SisaiOc): void {
  s.top = oc.top;
  s.sisaiOcb = oc.ocb;
  s.sisaiOc1 = oc.oc1;
  s.sisaiOc2 = oc.oc2;
}

interface Delays {
  iode: number | null;
  iodc: number | null;
  tgdB1Cp: number | null;
  tgdB2ap: number | null;
  iscB1Cd: number | null;
  iscB2ad: number | null;
  tgdB2bI: number | null;
}

function build(
  message: BdsCnavMessage,
  prn: string,
  wn: number,
  tTm: number,
  e1: EphI,
  e2: EphII,
  c: Clock,
  d: Delays,
  s: Status
): BdsCnavEphemeris {
  const week = resolveWeek(wn, tTm, e1.toe);
  const weekToc = resolveWeek(wn, tTm, c.toc);
  return {
    system: 'C',
    prn,
    message,
    week,
    toe: e1.toe,
    toeDate: bdtDate(week, e1.toe),
    toc: c.toc,
    tocDate: bdtDate(weekToc, c.toc),
    satType: e1.satType,
    a: bdsCnavAref(e1.satType) + e1.deltaA,
    deltaA: e1.deltaA,
    aDot: e1.aDot,
    deltaN0: e1.deltaN0,
    deltaN0Dot: e1.deltaN0Dot,
    m0: e1.m0,
    e: e1.e,
    omega: e1.omega,
    ...e2,
    af0: c.af0,
    af1: c.af1,
    af2: c.af2,
    ...d,
    ...s,
    tow: tTm,
  };
}

const prnLabel = (prn: number): string => `C${String(prn).padStart(2, '0')}`;

/**
 * B-CNAV1 (B1C) assembler. Each 18 s frame's subframe 2 is a complete
 * ephemeris + clock set; subframe 3 pages refresh the status fields.
 * A set is emitted when its (IODC, IODE, toe, toc) first appears.
 */
export class BdsCnav1Assembler {
  private status = new Map<number, Status>();
  private lastKey = new Map<number, string>();

  /**
   * Push one frame's CRC-valid subframes (bit-0 aligned; pass null for
   * a subframe that failed its CRC) for satellite `prn` (1-63). `tTm`
   * is the frame's transmit time, s of the BDT week. Returns the newly
   * seen ephemeris, or null.
   */
  push(
    prn: number,
    sf2: Uint8Array | null,
    sf3: Uint8Array | null,
    tTm: number
  ): BdsCnavEphemeris | null {
    let s = this.status.get(prn);
    if (!s) this.status.set(prn, (s = emptyStatus()));
    if (sf3) {
      const page = getBitU(sf3, 0, 6);
      if (page >= 1 && page <= 4) {
        s.health = getBitU(sf3, 6, 2);
        s.integrityFlags = getBitU(sf3, 8, 3);
        s.sismai = getBitU(sf3, 11, 4);
        if (page === 1) {
          s.sisaiOe = getBitU(sf3, 15, 5);
          applyOc(s, sisaiOc(sf3, 20));
        } else if (page === 3) s.sisaiOe = getBitU(sf3, 15, 5);
        else applyOc(s, sisaiOc(sf3, 15)); // pages 2 and 4
      }
    }
    if (!sf2) return null;

    const wn = getBitU(sf2, 0, 13);
    const iodc = getBitU(sf2, 21, 10);
    const iode = getBitU(sf2, 31, 8);
    const e1 = ephI(sf2, 39);
    const c = clock(sf2, 464);
    const key = `${wn}:${iodc}:${iode}:${e1.toe}:${c.toc}`;
    if (this.lastKey.get(prn) === key) return null;
    this.lastKey.set(prn, key);

    return build(
      'CNV1',
      prnLabel(prn),
      wn,
      tTm,
      e1,
      ephII(sf2, 242),
      c,
      {
        iode,
        iodc,
        tgdB1Cp: delay(sf2, 557),
        tgdB2ap: delay(sf2, 533),
        iscB1Cd: delay(sf2, 545),
        iscB2ad: null,
        tgdB2bI: null,
      },
      { ...s }
    );
  }
}

interface Cnav2Sat {
  /** Message Type 10 payload + its transmit SOW. */
  t10?: { wn: number; iode: number; e1: EphI; sow: number };
  /** Message Type 11 payload + its transmit SOW. */
  t11?: { e2: EphII; sow: number };
  clock?: { c: Clock; iodc: number };
  delays?: { tgdB1Cp: number; tgdB2ap: number; iscB2ad: number };
  status: Status;
  lastKey?: string;
}

/**
 * B-CNAV2 (B2a) assembler. Ephemeris II (Message Type 11) carries no
 * issue of data, so it is paired with the Message Type 10 broadcast
 * just before it (MT10 and MT11 are sent back to back); the clock
 * (MT30-34) is matched by IODE = the 8 LSBs of IODC (ICD §7.4).
 */
export class BdsCnav2Assembler {
  private sats = new Map<number, Cnav2Sat>();

  /**
   * Push one CRC-valid 288-bit message (bit 0 = first PRN bit, the
   * preamble stripped). Returns the newly completed ephemeris, or null.
   */
  push(msg: Uint8Array): BdsCnavEphemeris | null {
    const prn = getBitU(msg, 0, 6);
    const type = getBitU(msg, 6, 6);
    const sow = getBitU(msg, 12, 18) * 3;
    if (prn < 1) return null;
    let sat = this.sats.get(prn);
    if (!sat) this.sats.set(prn, (sat = { status: emptyStatus() }));
    const s = sat.status;

    if (type === 10) {
      sat.t10 = {
        wn: getBitU(msg, 30, 13),
        iode: getBitU(msg, 53, 8),
        e1: ephI(msg, 61),
        sow,
      };
      s.integrityFlags = (getBitU(msg, 43, 3) << 3) | getBitU(msg, 50, 3);
      s.sismai = getBitU(msg, 46, 4);
      // An MT11 from before this MT10 may belong to the previous set.
      if (sat.t11 && sat.t11.sow < sow) sat.t11 = undefined;
    } else if (type === 11 || (type >= 30 && type <= 34) || type === 40) {
      s.health = getBitU(msg, 30, 2);
      s.integrityFlags = (getBitU(msg, 32, 3) << 3) | getBitU(msg, 39, 3);
      s.sismai = getBitU(msg, 35, 4);
      if (type === 11) {
        if (!sat.t10 || sow <= sat.t10.sow) return null;
        sat.t11 = { e2: ephII(msg, 42), sow };
      } else if (type === 34) {
        applyOc(s, sisaiOc(msg, 42));
        sat.clock = { c: clock(msg, 64), iodc: getBitU(msg, 133, 10) };
      } else if (type === 40) {
        s.sisaiOe = getBitU(msg, 42, 5);
        applyOc(s, sisaiOc(msg, 47));
        return null;
      } else {
        sat.clock = { c: clock(msg, 42), iodc: getBitU(msg, 111, 10) };
        if (type === 30)
          sat.delays = {
            tgdB2ap: delay(msg, 121),
            iscB2ad: delay(msg, 133),
            tgdB1Cp: delay(msg, 219),
          };
      }
    } else return null;

    const { t10, t11, clock: ck } = sat;
    if (!t10 || !t11 || !ck || (ck.iodc & 0xff) !== t10.iode) return null;
    const key = `${t10.wn}:${ck.iodc}:${t10.iode}:${t10.e1.toe}:${ck.c.toc}`;
    if (sat.lastKey === key) return null;
    sat.lastKey = key;
    return build(
      'CNV2',
      prnLabel(prn),
      t10.wn,
      t10.sow,
      t10.e1,
      t11.e2,
      ck.c,
      {
        iode: t10.iode,
        iodc: ck.iodc,
        tgdB1Cp: sat.delays?.tgdB1Cp ?? null,
        tgdB2ap: sat.delays?.tgdB2ap ?? null,
        iscB1Cd: null,
        iscB2ad: sat.delays?.iscB2ad ?? null,
        tgdB2bI: null,
      },
      { ...s }
    );
  }
}

interface Cnav3Sat {
  t10?: { e1: EphI; e2: EphII; sow: number };
  t30?: { wn: number; c: Clock; tgd: number };
  status: Status;
  lastKey?: string;
}

/**
 * B-CNAV3 (B2b I) assembler: Message Type 10 (ephemeris I+II) paired
 * with Message Type 30 (clock, TGD, health) of the same epoch — there
 * is no issue of data, so toe == toc marks one set.
 */
export class BdsCnav3Assembler {
  private sats = new Map<number, Cnav3Sat>();

  /**
   * Push one CRC-valid 486-bit message (bit 0 = first MesType bit) from
   * satellite `prn`. Returns the newly completed ephemeris, or null.
   */
  push(prn: number, msg: Uint8Array): BdsCnavEphemeris | null {
    const type = getBitU(msg, 0, 6);
    const sow = getBitU(msg, 6, 20);
    let sat = this.sats.get(prn);
    if (!sat) this.sats.set(prn, (sat = { status: emptyStatus() }));
    const s = sat.status;

    if (type === 10) {
      sat.t10 = { e1: ephI(msg, 30), e2: ephII(msg, 233), sow };
      s.integrityFlags = getBitU(msg, 455, 3);
      s.sismai = getBitU(msg, 458, 4);
    } else if (type === 30) {
      sat.t30 = {
        wn: getBitU(msg, 26, 13),
        c: clock(msg, 43),
        tgd: delay(msg, 112),
      };
      applyOc(s, sisaiOc(msg, 433));
      s.sisaiOe = getBitU(msg, 455, 5);
      s.health = getBitU(msg, 460, 2);
    } else return null;

    const { t10, t30 } = sat;
    if (!t10 || !t30 || t10.e1.toe !== t30.c.toc) return null;
    const key = `${t30.wn}:${t10.e1.toe}:${t30.c.af0}:${t10.e1.m0}`;
    if (sat.lastKey === key) return null;
    sat.lastKey = key;
    return build(
      'CNV3',
      prnLabel(prn),
      t30.wn,
      t10.sow,
      t10.e1,
      t10.e2,
      t30.c,
      {
        iode: null,
        iodc: null,
        tgdB1Cp: null,
        tgdB2ap: null,
        iscB1Cd: null,
        iscB2ad: null,
        tgdB2bI: t30.tgd,
      },
      { ...s }
    );
  }
}
