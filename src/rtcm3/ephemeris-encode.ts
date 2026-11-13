/**
 * RTCM3 ephemeris encoders — the inverse of `decodeEphemeris`: GPS 1019,
 * GLONASS 1020, NavIC 1041, BeiDou 1042, SBAS 1043, QZSS 1044 and Galileo
 * 1045 (F/NAV) / 1046 (I/NAV), field for field in the decoders' order and
 * scale. Input is the decoder's `EphemerisInfo`; `ephemerisToInfo` builds
 * one from a receiver-decoded `Ephemeris`.
 *
 * Reference: RTCM 10403.3 §3.5.7–3.5.12; RTKLIB rtcm3e.c.
 */

import { MILLISECONDS_IN_WEEK, START_GPS_TIME } from '../constants/time';
import type { Ephemeris, KeplerEphemeris } from '../rinex/nav';
import type { EphemerisInfo } from './ephemeris';
import { BitWriter, frameRtcm3 } from './writer';
import { gpsFitFlag, sisaIndex, uraIndex } from './accuracy';

const PI = Math.PI;

/** Scale `v` to an integer count of `lsb` (rounded). */
const q = (v: number | undefined, lsb: number) => Math.round((v ?? 0) / lsb);
/** Same, for angles transmitted in semicircles. */
const qPi = (v: number | undefined, lsb: number) =>
  Math.round((v ?? 0) / PI / lsb);

function svNumber(prn: string): number {
  return Number(prn.slice(1));
}

/* ================================================================== */
/*  Message writers                                                    */
/* ================================================================== */

function write1019(w: BitWriter, e: EphemerisInfo): void {
  w.writeU(svNumber(e.prn), 6);
  w.writeU((e.week ?? 0) % 1024, 10);
  w.writeU(e.ura ?? 0, 4);
  w.writeU(e.l2Codes ?? 0, 2);
  w.writeS(qPi(e.idot, 2 ** -43), 14);
  w.writeU(e.iode ?? 0, 8);
  w.writeU(q(e.toc, 16), 16);
  w.writeS(q(e.af2, 2 ** -55), 8);
  w.writeS(q(e.af1, 2 ** -43), 16);
  w.writeS(q(e.af0, 2 ** -31), 22);
  w.writeU(e.iodc ?? 0, 10);
  w.writeS(q(e.crs, 2 ** -5), 16);
  w.writeS(qPi(e.deltaN, 2 ** -43), 16);
  w.writeS(qPi(e.meanAnomaly, 2 ** -31), 32);
  w.writeS(q(e.cuc, 2 ** -29), 16);
  w.writeU(q(e.eccentricity, 2 ** -33), 32);
  w.writeS(q(e.cus, 2 ** -29), 16);
  w.writeU(q(e.sqrtA, 2 ** -19), 32);
  w.writeU(q(e.toe, 16), 16);
  w.writeS(q(e.cic, 2 ** -29), 16);
  w.writeS(qPi(e.omega0, 2 ** -31), 32);
  w.writeS(q(e.cis, 2 ** -29), 16);
  w.writeS(qPi(e.inclination, 2 ** -31), 32);
  w.writeS(q(e.crc, 2 ** -5), 16);
  w.writeS(qPi(e.argPerigee, 2 ** -31), 32);
  w.writeS(qPi(e.omegaDot, 2 ** -43), 24);
  w.writeS(q(e.tgd, 2 ** -31), 8);
  w.writeU(e.health ?? 0, 6);
  w.writeU(e.l2PFlag ?? 0, 1);
  w.writeU(e.fitInterval ?? 0, 1);
}

function write1044(w: BitWriter, e: EphemerisInfo): void {
  const sv = svNumber(e.prn);
  w.writeU(sv >= 193 ? sv - 192 : sv, 4);
  w.writeU(q(e.toc, 16), 16);
  w.writeS(q(e.af2, 2 ** -55), 8);
  w.writeS(q(e.af1, 2 ** -43), 16);
  w.writeS(q(e.af0, 2 ** -31), 22);
  w.writeU(e.iode ?? 0, 8);
  w.writeS(q(e.crs, 2 ** -5), 16);
  w.writeS(qPi(e.deltaN, 2 ** -43), 16);
  w.writeS(qPi(e.meanAnomaly, 2 ** -31), 32);
  w.writeS(q(e.cuc, 2 ** -29), 16);
  w.writeU(q(e.eccentricity, 2 ** -33), 32);
  w.writeS(q(e.cus, 2 ** -29), 16);
  w.writeU(q(e.sqrtA, 2 ** -19), 32);
  w.writeU(q(e.toe, 16), 16);
  w.writeS(q(e.cic, 2 ** -29), 16);
  w.writeS(qPi(e.omega0, 2 ** -31), 32);
  w.writeS(q(e.cis, 2 ** -29), 16);
  w.writeS(qPi(e.inclination, 2 ** -31), 32);
  w.writeS(q(e.crc, 2 ** -5), 16);
  w.writeS(qPi(e.argPerigee, 2 ** -31), 32);
  w.writeS(qPi(e.omegaDot, 2 ** -43), 24);
  w.writeS(qPi(e.idot, 2 ** -43), 14);
  w.writeU(e.l2Codes ?? 0, 2);
  w.writeU((e.week ?? 0) % 1024, 10);
  w.writeU(e.ura ?? 0, 4);
  w.writeU(e.health ?? 0, 6);
  w.writeS(q(e.tgd, 2 ** -31), 8);
  w.writeU(e.iodc ?? 0, 10);
  w.writeU(e.fitInterval ?? 0, 1);
}

function write1020(w: BitWriter, e: EphemerisInfo): void {
  w.writeU(svNumber(e.prn), 6);
  w.writeU((e.freqChannel ?? 0) + 7, 5);
  w.writeU(e.almanacHealth ?? 0, 1);
  w.writeU(e.almanacHealthAvailable ?? 0, 1);
  w.writeU(e.p1 ?? 0, 2);
  // tk: Moscow time of day as hours, minutes and a 30 s flag.
  const tk = (((Math.round(e.tk ?? 0) + 3 * 3600) % 86400) + 86400) % 86400;
  w.writeU(Math.floor(tk / 3600), 5);
  w.writeU(Math.floor((tk % 3600) / 60), 6);
  w.writeU(tk % 60 >= 30 ? 1 : 0, 1);
  w.writeU(e.health ?? 0, 1); // Bn MSB
  w.writeU(e.p2 ?? 0, 1);
  w.writeU(Math.round((e.tb ?? 0) / 15), 7);
  for (const [pos, vel, acc] of [
    [e.x, e.vx, e.ax],
    [e.y, e.vy, e.ay],
    [e.z, e.vz, e.az],
  ] as const) {
    w.writeSM(q(vel, 2 ** -20), 24);
    w.writeSM(q(pos, 2 ** -11), 27);
    w.writeSM(q(acc, 2 ** -30), 5);
  }
  w.writeU(e.p3 ?? 0, 1);
  w.writeSM(q(e.gammaN, 2 ** -40), 11);
  w.writeU(e.p ?? 0, 2);
  w.writeU(e.ln ?? 0, 1);
  w.writeSM(q(e.af0, 2 ** -30), 22); // τn
  w.writeSM(q(e.deltaTauN, 2 ** -30), 5);
  w.writeU(e.en ?? 0, 5);
  w.writeU(e.p4 ?? 0, 1);
  w.writeU(e.ft ?? 0, 4);
  w.writeU(e.nt ?? 0, 11);
  w.writeU(e.satType ?? 0, 2);
  const additional = e.tauC !== undefined;
  w.writeU(additional ? 1 : 0, 1);
  w.writeU(e.na ?? 0, 11);
  w.writeSM(q(e.tauC, 2 ** -31), 32);
  w.writeU(e.n4 ?? 0, 5);
  w.writeSM(q(e.tauGPS, 2 ** -30), 22);
  w.writeU(e.ln5 ?? 0, 1);
  w.zeros(7);
}

function writeGalileo(w: BitWriter, e: EphemerisInfo, type: number): void {
  w.writeU(svNumber(e.prn), 6);
  w.writeU((e.week ?? 0) % 4096, 12);
  w.writeU(e.iode ?? 0, 10);
  w.writeU(e.ura ?? 0, 8); // SISA
  w.writeS(qPi(e.idot, 2 ** -43), 14);
  w.writeU(q(e.toc, 60), 14);
  w.writeS(q(e.af2, 2 ** -59), 6);
  w.writeS(q(e.af1, 2 ** -46), 21);
  w.writeS(q(e.af0, 2 ** -34), 31);
  w.writeS(q(e.crs, 2 ** -5), 16);
  w.writeS(qPi(e.deltaN, 2 ** -43), 16);
  w.writeS(qPi(e.meanAnomaly, 2 ** -31), 32);
  w.writeS(q(e.cuc, 2 ** -29), 16);
  w.writeU(q(e.eccentricity, 2 ** -33), 32);
  w.writeS(q(e.cus, 2 ** -29), 16);
  w.writeU(q(e.sqrtA, 2 ** -19), 32);
  w.writeU(q(e.toe, 60), 14);
  w.writeS(q(e.cic, 2 ** -29), 16);
  w.writeS(qPi(e.omega0, 2 ** -31), 32);
  w.writeS(q(e.cis, 2 ** -29), 16);
  w.writeS(qPi(e.inclination, 2 ** -31), 32);
  w.writeS(q(e.crc, 2 ** -5), 16);
  w.writeS(qPi(e.argPerigee, 2 ** -31), 32);
  w.writeS(qPi(e.omegaDot, 2 ** -43), 24);
  w.writeS(q(e.bgdE5aE1, 2 ** -32), 10);
  if (type === 1045) {
    w.writeU(e.health ?? 0, 2); // E5a signal health
    w.writeU(e.e5aDataInvalid ?? 0, 1);
    w.zeros(7);
  } else {
    w.writeS(q(e.bgdE5bE1, 2 ** -32), 10);
    w.writeU(e.health ?? 0, 2); // E5b signal health
    w.writeU(e.e5bDataInvalid ?? 0, 1);
    w.writeU(e.e1bHealth ?? 0, 2);
    w.writeU(e.e1bDataInvalid ?? 0, 1);
    w.zeros(2);
  }
}

function write1042(w: BitWriter, e: EphemerisInfo): void {
  w.writeU(svNumber(e.prn), 6);
  w.writeU((e.week ?? 0) % 8192, 13);
  w.writeU(e.ura ?? 0, 4);
  w.writeS(qPi(e.idot, 2 ** -43), 14);
  w.writeU(e.iode ?? 0, 5); // AODE
  w.writeU(q(e.toc, 8), 17);
  w.writeS(q(e.af2, 2 ** -66), 11);
  w.writeS(q(e.af1, 2 ** -50), 22);
  w.writeS(q(e.af0, 2 ** -33), 24);
  w.writeU(e.aodc ?? 0, 5);
  w.writeS(q(e.crs, 2 ** -6), 18);
  w.writeS(qPi(e.deltaN, 2 ** -43), 16);
  w.writeS(qPi(e.meanAnomaly, 2 ** -31), 32);
  w.writeS(q(e.cuc, 2 ** -31), 18);
  w.writeU(q(e.eccentricity, 2 ** -33), 32);
  w.writeS(q(e.cus, 2 ** -31), 18);
  w.writeU(q(e.sqrtA, 2 ** -19), 32);
  w.writeU(q(e.toe, 8), 17);
  w.writeS(q(e.cic, 2 ** -31), 18);
  w.writeS(qPi(e.omega0, 2 ** -31), 32);
  w.writeS(q(e.cis, 2 ** -31), 18);
  w.writeS(qPi(e.inclination, 2 ** -31), 32);
  w.writeS(q(e.crc, 2 ** -6), 18);
  w.writeS(qPi(e.argPerigee, 2 ** -31), 32);
  w.writeS(qPi(e.omegaDot, 2 ** -43), 24);
  w.writeS(q(e.tgd1, 1e-10), 10);
  w.writeS(q(e.tgd2, 1e-10), 10);
  w.writeU(e.health ?? 0, 1);
}

function write1043(w: BitWriter, e: EphemerisInfo): void {
  const n = svNumber(e.prn);
  w.writeU(n >= 120 ? n - 120 : n - 20, 6);
  w.writeU(e.iode ?? 0, 8);
  w.writeU(q(e.toc, 16), 13);
  w.writeU(e.ura ?? 0, 4);
  // Decoder keeps the state vector in km; the message carries metres.
  w.writeS(q((e.x ?? 0) * 1000, 0.08), 30);
  w.writeS(q((e.y ?? 0) * 1000, 0.08), 30);
  w.writeS(q((e.z ?? 0) * 1000, 0.4), 25);
  w.writeS(q((e.vx ?? 0) * 1000, 0.000625), 17);
  w.writeS(q((e.vy ?? 0) * 1000, 0.000625), 17);
  w.writeS(q((e.vz ?? 0) * 1000, 0.004), 18);
  w.writeS(q((e.ax ?? 0) * 1000, 0.0000125), 10);
  w.writeS(q((e.ay ?? 0) * 1000, 0.0000125), 10);
  w.writeS(q((e.az ?? 0) * 1000, 0.0000625), 10);
  w.writeS(q(e.af0, 2 ** -31), 12);
  w.writeS(q(e.af1, 2 ** -40), 8);
}

function write1041(w: BitWriter, e: EphemerisInfo): void {
  w.writeU(svNumber(e.prn), 6);
  w.writeU((e.week ?? 0) % 1024, 10);
  w.writeS(q(e.af0, 2 ** -31), 22);
  w.writeS(q(e.af1, 2 ** -43), 16);
  w.writeS(q(e.af2, 2 ** -55), 8);
  w.writeU(e.ura ?? 0, 4);
  w.writeU(q(e.toc, 16), 16);
  w.writeS(q(e.tgd, 2 ** -31), 8);
  w.writeS(qPi(e.deltaN, 2 ** -41), 22);
  w.writeU(e.iode ?? 0, 8);
  w.zeros(10);
  w.writeU(((e.health ?? 0) >> 1) & 1, 1); // L5 health
  w.writeU((e.health ?? 0) & 1, 1); // S health
  w.writeS(q(e.cuc, 2 ** -28), 15);
  w.writeS(q(e.cus, 2 ** -28), 15);
  w.writeS(q(e.cic, 2 ** -28), 15);
  w.writeS(q(e.cis, 2 ** -28), 15);
  w.writeS(q(e.crc, 2 ** -4), 15);
  w.writeS(q(e.crs, 2 ** -4), 15);
  w.writeS(qPi(e.idot, 2 ** -43), 14);
  w.writeS(qPi(e.meanAnomaly, 2 ** -31), 32);
  w.writeU(q(e.toe, 16), 16);
  w.writeU(q(e.eccentricity, 2 ** -33), 32);
  w.writeU(q(e.sqrtA, 2 ** -19), 32);
  w.writeS(qPi(e.omega0, 2 ** -31), 32);
  w.writeS(qPi(e.argPerigee, 2 ** -31), 32);
  w.writeS(qPi(e.omegaDot, 2 ** -41), 22);
  w.writeS(qPi(e.inclination, 2 ** -31), 32);
  w.zeros(2);
}

/** Default ephemeris message per system. */
const DEFAULT_TYPE: Record<string, number> = {
  G: 1019,
  R: 1020,
  I: 1041,
  C: 1042,
  S: 1043,
  J: 1044,
  E: 1046,
};

/**
 * Encode an ephemeris as a framed RTCM3 message. The type follows
 * `info.messageType` when it is an ephemeris type, else the system default
 * (Galileo → 1046 I/NAV). Null for an unsupported system.
 */
export function encodeEphemeris(info: EphemerisInfo): Uint8Array | null {
  const sys = info.prn.charAt(0);
  const type =
    info.messageType === DEFAULT_TYPE[sys] ||
    (sys === 'E' && info.messageType === 1045)
      ? info.messageType
      : DEFAULT_TYPE[sys];
  if (type === undefined) return null;
  const w = new BitWriter();
  w.writeU(type, 12);
  switch (type) {
    case 1019:
      write1019(w, info);
      break;
    case 1020:
      write1020(w, info);
      break;
    case 1041:
      write1041(w, info);
      break;
    case 1042:
      write1042(w, info);
      break;
    case 1043:
      write1043(w, info);
      break;
    case 1044:
      write1044(w, info);
      break;
    default:
      writeGalileo(w, info, type);
  }
  return frameRtcm3(w.toBytes());
}

/* ================================================================== */
/*  Ephemeris → EphemerisInfo                                          */
/* ================================================================== */

/** Fields a receiver-decoded `Ephemeris` does not carry. */
export interface EphemerisInfoExtras {
  /** URA / SISA index. Default: from `svAccuracy` (metres), else 0
   *  (GPS/QZSS/BDS/NavIC) or 107 (Galileo, the value its satellites
   *  broadcast). */
  ura?: number;
  /** GPS/QZSS IODC. Default: the ephemeris' `iodc`, else the IODE (LNAV
   *  ties its low 8 bits to IODE). */
  iodc?: number;
  /** Galileo message: 1045 F/NAV or 1046 I/NAV. Default: F/NAV when
   *  `dataSources` bit 1 is set, else I/NAV. */
  galileoType?: 1045 | 1046;
  /** Galileo BGD E5b/E1 (s). Default: `tgd2`, else `tgd` (E5a/E1). */
  bgdE5bE1?: number;
  /** BeiDou TGD2 (s). Default: `tgd2`; TGD1 is `tgd`. */
  tgd2?: number;
}

const GPS_EPOCH_MS = START_GPS_TIME.getTime();
// BeiDou tocDate is on the BDT clock face (RINEX convention).
const BDS_EPOCH_MS = Date.UTC(2006, 0, 1);
const GAL_EPOCH_MS = GPS_EPOCH_MS + 1024 * MILLISECONDS_IN_WEEK; // GST week 0

/**
 * RTCM week of a GPS-scale clock epoch: GPS/QZSS/NavIC weeks count from the
 * GPS epoch (sent mod 1024), Galileo from GST week 0, BeiDou from BDT 0.
 * Derived from `tocDate` because `Ephemeris.week` conventions differ by source.
 */
function rtcmWeek(sys: string, tocMs: number): number {
  const epoch =
    sys === 'C' ? BDS_EPOCH_MS : sys === 'E' ? GAL_EPOCH_MS : GPS_EPOCH_MS;
  return Math.floor((tocMs - epoch) / MILLISECONDS_IN_WEEK);
}

/**
 * Inverse of `ephInfoToEphemeris`: an `EphemerisInfo` ready for
 * `encodeEphemeris` from a receiver-decoded broadcast ephemeris.
 */
export function ephemerisToInfo(
  eph: Ephemeris,
  extras: EphemerisInfoExtras = {}
): EphemerisInfo {
  const base = {
    prn: eph.prn,
    lastReceived: eph.tocDate.getTime(),
  };
  if (eph.system === 'R' || eph.system === 'S') {
    const tocMs = eph.tocDate.getTime();
    if (eph.system === 'S') {
      return {
        ...base,
        constellation: 'SBAS',
        messageType: 1043,
        health: eph.health,
        iode: 0,
        toc: ((((tocMs - GPS_EPOCH_MS) / 1000) % 86400) + 86400) % 86400,
        ura: extras.ura ?? 0,
        x: eph.x,
        y: eph.y,
        z: eph.z,
        vx: eph.xDot,
        vy: eph.yDot,
        vz: eph.zDot,
        ax: eph.xAcc,
        ay: eph.yAcc,
        az: eph.zAcc,
        af0: eph.tauN,
        af1: eph.gammaN,
      };
    }
    // tb: 15-minute index into the Moscow day; tocDate is UTC.
    const moscowSod = (((tocMs / 1000 + 3 * 3600) % 86400) + 86400) % 86400;
    return {
      ...base,
      constellation: 'GLONASS',
      messageType: 1020,
      health: eph.health,
      freqChannel: eph.freqNum,
      tk: eph.messageFrameTime % 86400,
      tb: Math.round(moscowSod / 60 / 15) * 15,
      x: eph.x,
      y: eph.y,
      z: eph.z,
      vx: eph.xDot,
      vy: eph.yDot,
      vz: eph.zDot,
      ax: eph.xAcc,
      ay: eph.yAcc,
      az: eph.zAcc,
      gammaN: eph.gammaN,
      af0: -eph.tauN, // RINEX/Ephemeris carry −τn; 1020 carries τn
    };
  }

  const k = eph as KeplerEphemeris; // R and S returned above
  const sys = k.system;
  // Galileo: F/NAV when data sources say so (RINEX bit 1), else I/NAV
  const galileoType =
    extras.galileoType ?? (((k.dataSources ?? 0) & 2) !== 0 ? 1045 : 1046);
  const sv = k.svHealth;
  const acc = k.svAccuracy;
  const ura =
    extras.ura ??
    (sys === 'E'
      ? acc !== undefined
        ? sisaIndex(acc)
        : 107
      : acc !== undefined
        ? uraIndex(acc)
        : 0);
  // Galileo SV health: the RINEX bit field (Table A8) when the
  // ephemeris has data sources (RINEX / RTCM / receiver I/NAV-F/NAV),
  // unpacked into the message's signal health + data-validity bits.
  const galHealth =
    sys !== 'E'
      ? { health: sv }
      : galileoType === 1045
        ? { health: (sv >> 4) & 3, e5aDataInvalid: (sv >> 3) & 1 }
        : {
            health: (sv >> 7) & 3,
            e5bDataInvalid: (sv >> 6) & 1,
            e1bHealth: (sv >> 1) & 3,
            e1bDataInvalid: sv & 1,
          };
  return {
    ...base,
    constellation: {
      G: 'GPS',
      E: 'Galileo',
      C: 'BeiDou',
      J: 'QZSS',
      I: 'NavIC',
    }[sys],
    messageType: sys === 'E' ? galileoType : DEFAULT_TYPE[sys]!,
    ...galHealth,
    week: rtcmWeek(sys, k.tocDate.getTime()),
    ura,
    toc: k.toc,
    toe: k.toe,
    sqrtA: k.sqrtA,
    eccentricity: k.e,
    inclination: k.i0,
    omega0: k.omega0,
    omegaDot: k.omegaDot,
    argPerigee: k.omega,
    meanAnomaly: k.m0,
    deltaN: k.deltaN,
    idot: k.idot,
    crs: k.crs,
    crc: k.crc,
    cuc: k.cuc,
    cus: k.cus,
    cic: k.cic,
    cis: k.cis,
    af0: k.af0,
    af1: k.af1,
    af2: k.af2,
    iode: k.iode,
    ...(sys === 'G' || sys === 'J'
      ? {
          iodc: extras.iodc ?? k.iodc ?? k.iode,
          tgd: k.tgd,
          l2Codes: k.l2Codes ?? 0,
          l2PFlag: k.l2pFlag ?? 0,
          fitInterval:
            sys === 'J' ? (k.fitInterval ?? 0) : gpsFitFlag(k.fitInterval),
        }
      : {}),
    ...(sys === 'I' ? { tgd: k.tgd } : {}),
    ...(sys === 'E'
      ? { bgdE5aE1: k.tgd, bgdE5bE1: extras.bgdE5bE1 ?? k.tgd2 ?? k.tgd }
      : {}),
    ...(sys === 'C'
      ? {
          tgd1: k.tgd,
          tgd2: extras.tgd2 ?? k.tgd2 ?? 0,
          ...(k.aodc !== undefined && { aodc: k.aodc }),
        }
      : {}),
  };
}
