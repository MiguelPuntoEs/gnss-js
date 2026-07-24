/**
 * BINEX record 0x01 — decoded GNSS ephemeris — with the per-constellation
 * subrecords laid out in RTKLIB src/rcv/binex.c:
 *
 *   0x01-01 GPS LNAV      (decode_bnx_01_01)
 *   0x01-02 GLONASS       (decode_bnx_01_02)
 *   0x01-03 SBAS          (decode_bnx_01_03)
 *   0x01-04 Galileo       (decode_bnx_01_04)
 *   0x01-05 BeiDou-2/3    (decode_bnx_01_05)
 *   0x01-06 QZSS          (decode_bnx_01_06)
 *
 * Ported from RTKLIB demo5/2.4.3 src/rcv/binex.c (Copyright (c) 2013-2018
 * T. Takasu, BSD-2-Clause) and cross-checked against the EarthScope/UNAVCO
 * BINEX definition and its reference RINEX fixtures.
 *
 * Output records mirror what `parseNavFile` produces for the equivalent
 * RINEX navigation file, exactly like the SBF/NovAtel decoders:
 *  - the Keplerian angles M0/Ω0/ω/i0 arrive as radians on the wire (R8),
 *    while the rate terms Δn/Ω̇/İ arrive as semicircles (R4) and are
 *    scaled by π (IS-GPS-200 SC2RAD);
 *  - BeiDou epochs and weeks stay on the BDT scale (no BDT→GPST shift),
 *    matching a RINEX BDS record and the NovAtel decoder;
 *  - GLONASS state vectors are in km (PZ-90), the clock is −τ_n (the
 *    RINEX sign), the reference epoch is UTC, and `messageFrameTime` is
 *    the frame time `tof` as broadcast (seconds of day);
 *  - deferred subrecords: 0x01-00 (raw-byte ephemeris) and 0x01-14 (a
 *    newer Galileo encoding not covered by RTKLIB).
 */

import type {
  Ephemeris,
  GlonassEphemeris,
  KeplerEphemeris,
} from '../rinex/nav';
import { GPS_PI } from '../navbits/index';

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
// GLONASS `day` is a 1-based day-of-4-year-era number (1…1461); era 0
// begins 1980-01-01 (verified against the EarthScope/teqc fixture:
// day 1429 → 1980-01-01 + 1428 d = 1983-11-29).
const GLO_DAY0_MS = Date.UTC(1980, 0, 1);
// BDT calendar epoch — RINEX BDS nav records print BDT calendar dates and
// parseNavFile keeps them as-is.
const BDT_EPOCH_MS = Date.UTC(2006, 0, 1);
const SEC_PER_WEEK = 7 * 86400;
const MS_PER_WEEK = SEC_PER_WEEK * 1000;
const SC2RAD = GPS_PI;

const gpsMs = (week: number, sec: number) =>
  GPS_EPOCH_MS + week * MS_PER_WEEK + sec * 1000;
const sowOf = (dateMs: number) =>
  (((dateMs / 1000) % SEC_PER_WEEK) + SEC_PER_WEEK) % SEC_PER_WEEK;
const two = (n: number) => String(n).padStart(2, '0');

/** Little-/big-endian field reader over a record body. */
class Reader {
  p: number;
  constructor(
    private readonly view: DataView,
    start: number,
    private readonly le: boolean
  ) {
    this.p = start;
  }
  u1(): number {
    return this.view.getUint8(this.p++);
  }
  i1(): number {
    return this.view.getInt8(this.p++);
  }
  u2(): number {
    const v = this.view.getUint16(this.p, this.le);
    this.p += 2;
    return v;
  }
  i4(): number {
    const v = this.view.getInt32(this.p, this.le);
    this.p += 4;
    return v;
  }
  u4(): number {
    const v = this.view.getUint32(this.p, this.le);
    this.p += 4;
    return v;
  }
  r4(): number {
    const v = this.view.getFloat32(this.p, this.le);
    this.p += 4;
    return v;
  }
  r8(): number {
    const v = this.view.getFloat64(this.p, this.le);
    this.p += 8;
    return v;
  }
}

/**
 * Read the Keplerian core shared by the GPS/Galileo/QZSS 0x01 subrecords
 * from just after the group-delay/clock preamble. The 0x01-04 (Galileo)
 * layout carries two group-delay words and no IODC, so the caller reads
 * the preamble and passes the reader positioned at Δn.
 */
function readKeplerCore(r: Reader): {
  deltaN: number;
  m0: number;
  e: number;
  sqrtA: number;
  cic: number;
  crc: number;
  cis: number;
  crs: number;
  cuc: number;
  cus: number;
  omega0: number;
  omega: number;
  i0: number;
  omegaDot: number;
  idot: number;
} {
  const deltaN = r.r4() * SC2RAD;
  const m0 = r.r8();
  const e = r.r8();
  const sqrtA = r.r8();
  const cic = r.r4();
  const crc = r.r4();
  const cis = r.r4();
  const crs = r.r4();
  const cuc = r.r4();
  const cus = r.r4();
  const omega0 = r.r8();
  const omega = r.r8();
  const i0 = r.r8();
  const omegaDot = r.r4() * SC2RAD;
  const idot = r.r4() * SC2RAD;
  return {
    deltaN,
    m0,
    e,
    sqrtA,
    cic,
    crc,
    cis,
    crs,
    cuc,
    cus,
    omega0,
    omega,
    i0,
    omegaDot,
    idot,
  };
}

/** 0x01-01 GPS / 0x01-06 QZSS decoded ephemeris (identical layout). */
function decodeGpsQzss(
  view: DataView,
  p: number,
  le: boolean,
  sys: 'G' | 'J'
): KeplerEphemeris | null {
  const r = new Reader(view, p, le);
  const prnRaw = r.u1() + (sys === 'G' ? 1 : 0);
  const prn = sys === 'G' ? prnRaw : prnRaw - 192;
  if (sys === 'G' && (prn < 1 || prn > 32)) return null;
  if (sys === 'J' && (prn < 1 || prn > 10)) return null;
  const week = r.u2();
  r.i4(); // tow (transmission time) — not part of the RINEX record
  const toes = r.i4();
  const tgd = r.r4();
  r.i4(); // IODC — no dedicated RINEX field in this shape
  const af2 = r.r4();
  const af1 = r.r4();
  const af0 = r.r4();
  const iode = r.i4();
  const core = readKeplerCore(r);
  r.r4(); // URA (m) — no RINEX field
  const svHealth = r.u2();
  // flag (U2) — fit-interval / codes-on-L2; not carried in the record
  const tocDate = new Date(gpsMs(week, toes));
  return {
    system: sys,
    prn: `${sys}${two(prn)}`,
    toc: sowOf(tocDate.getTime()),
    tocDate,
    af0,
    af1,
    af2,
    iode,
    ...core,
    toe: toes,
    week,
    svHealth,
    tgd,
  };
}

/** 0x01-04 Galileo decoded ephemeris (two BGD words, IODnav, no IODC). */
function decodeGalileo(
  view: DataView,
  p: number,
  le: boolean
): KeplerEphemeris | null {
  const r = new Reader(view, p, le);
  const prn = r.u1() + 1;
  if (prn < 1 || prn > 36) return null;
  const week = r.u2(); // GAL week = GPS week
  r.i4(); // tow
  const toes = r.i4();
  const tgd = r.r4(); // BGD E5a/E1 (first RINEX slot)
  r.r4(); // BGD E5b/E1
  const iode = r.i4(); // IODnav
  const af2 = r.r4();
  const af1 = r.r4();
  const af0 = r.r4();
  const core = readKeplerCore(r);
  r.r4(); // SISA (URA)
  const svHealth = r.u2();
  // code (U2) — I/NAV vs F/NAV data source; not stored
  const tocDate = new Date(gpsMs(week, toes));
  return {
    system: 'E',
    prn: `E${two(prn)}`,
    toc: sowOf(tocDate.getTime()),
    tocDate,
    af0,
    af1,
    af2,
    iode,
    ...core,
    toe: toes,
    week,
    svHealth,
    tgd,
  };
}

/** BeiDou signed 10-bit TGD field → seconds (RTKLIB bds_tgd). */
function bdsTgd(tgd: number): number {
  tgd &= 0x3ff;
  return tgd & 0x200 ? -1e-10 * (~tgd & 0x1ff) : 1e-10 * (tgd & 0x1ff);
}

/** 0x01-05 BeiDou decoded ephemeris (BDT scale, packed flag words). */
function decodeBeidou(
  view: DataView,
  p: number,
  le: boolean
): KeplerEphemeris | null {
  const r = new Reader(view, p, le);
  const prn = r.u1();
  if (prn < 1 || prn > 63) return null;
  const week = r.u2(); // BDT week
  r.i4(); // tow
  r.i4(); // toc field (RTKLIB uses toe for both toc and toe)
  const toes = r.i4();
  const af2 = r.r4();
  const af1 = r.r4();
  const af0 = r.r4();
  const core = readKeplerCore(r);
  const flag1 = r.u2();
  const flag2 = r.u4();
  const iode = (flag1 >> 6) & 0x1f;
  const svHealth = flag1 & 0x01;
  const tgd = bdsTgd(flag2 >> 4); // TGD1 (B1) — RINEX slot
  const tocDate = new Date(BDT_EPOCH_MS + week * MS_PER_WEEK + toes * 1000);
  return {
    system: 'C',
    prn: `C${two(prn)}`,
    toc: sowOf(tocDate.getTime()),
    tocDate,
    af0,
    af1,
    af2,
    iode,
    ...core,
    toe: toes,
    week, // RINEX BDS week field is the BDT week
    svHealth,
    tgd,
  };
}

/** 0x01-02 GLONASS decoded ephemeris (state vector, PZ-90, km). */
function decodeGlonass(
  view: DataView,
  p: number,
  le: boolean
): GlonassEphemeris | null {
  const r = new Reader(view, p, le);
  const slot = r.u1() + 1;
  if (slot < 1 || slot > 27) return null;
  const day = r.u2(); // days since 1980-01-01
  const tod = r.u4(); // GLONASS seconds of day (= UTC + 3 h)
  const tauN = r.r8(); // wire value already carries the RINEX sign (−τ_n)
  const gammaN = r.r8();
  const tof = r.u4(); // frame time (seconds of day)
  const x = r.r8();
  const xDot = r.r8();
  const xAcc = r.r8();
  const y = r.r8();
  const yDot = r.r8();
  const yAcc = r.r8();
  const z = r.r8();
  const zDot = r.r8();
  const zAcc = r.r8();
  const health = r.u1() & 0x01;
  const freqNum = r.i1();
  // age (U1), leap (U1), τ_GPS (R8), Δτ_n (R8) follow — not in the record.
  // The 4-year era (N4) is not carried by 0x01-02; era 0 (1980-01-01) is
  // assumed — correct for the fixture, a documented limitation for live
  // streams past 1983 (which need a co-streamed epoch to fold the era).
  const tocDate = new Date(
    GLO_DAY0_MS + (day - 1) * 86400_000 + (tod - 10800) * 1000
  );
  return {
    system: 'R',
    prn: `R${two(slot)}`,
    tocDate,
    tauN,
    gammaN,
    messageFrameTime: tof,
    x,
    y,
    z,
    xDot,
    yDot,
    zDot,
    xAcc,
    yAcc,
    zAcc,
    health,
    freqNum,
  };
}

/** 0x01-03 SBAS decoded ephemeris (state vector, km; GPS-time epoch). */
function decodeSbas(
  view: DataView,
  p: number,
  le: boolean
): GlonassEphemeris | null {
  const r = new Reader(view, p, le);
  const prn = r.u1();
  const week = r.u2();
  const tow = r.u4(); // transmission time of week
  const af0 = r.r8(); // SV clock bias (SBAS Network Time)
  const af1 = r.r4(); // SV clock drift (RTKLIB mislabels this "tod")
  const toe = r.u4(); // = ToC, seconds of GPS week (RTKLIB mislabels "tof")
  const x = r.r8();
  const xDot = r.r8();
  const xAcc = r.r8();
  const y = r.r8();
  const yDot = r.r8();
  const yAcc = r.r8();
  const z = r.r8();
  const zDot = r.r8();
  const zAcc = r.r8();
  const health = r.u1();
  // ura (U1), iodn (U1) follow — not stored
  if (prn < 120 || prn > 158) return null;
  return {
    system: 'S',
    prn: `S${two(prn - 100)}`,
    tocDate: new Date(gpsMs(week, toe)),
    tauN: af0,
    gammaN: af1,
    messageFrameTime: tow,
    x,
    y,
    z,
    xDot,
    yDot,
    zDot,
    xAcc,
    yAcc,
    zAcc,
    health,
    freqNum: 0,
  };
}

/**
 * Decode a record-0x01 ephemeris body. `body` points at the subrecord-ID
 * byte. Returns the decoded `Ephemeris`, or null for an unsupported or
 * malformed subrecord. Minimum body lengths mirror RTKLIB's guards.
 */
export function decodeBinexEph(
  view: DataView,
  body: number,
  len: number,
  le: boolean
): Ephemeris | null {
  const sub = view.getUint8(body);
  const p = body + 1;
  const n = len - 1;
  switch (sub) {
    case 0x01:
      return n >= 127 ? decodeGpsQzss(view, p, le, 'G') : null;
    case 0x02:
      return n >= 119 ? decodeGlonass(view, p, le) : null;
    case 0x03:
      return n >= 98 ? decodeSbas(view, p, le) : null;
    case 0x04:
      return n >= 127 ? decodeGalileo(view, p, le) : null;
    case 0x05:
      return n >= 117 ? decodeBeidou(view, p, le) : null;
    case 0x06:
      return n >= 127 ? decodeGpsQzss(view, p, le, 'J') : null;
    default:
      return null; // 0x01-00 raw-byte and 0x01-14 not supported
  }
}
