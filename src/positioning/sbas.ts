/**
 * SBAS (WAAS/EGNOS/MSAS/…) wide-area correction processing.
 *
 * An SBAS geostationary satellite broadcasts, on L1 C/A, a stream of 250-bit
 * messages (see {@link ../navbits/sbas}) that augment GPS: a PRN mask (MT1),
 * fast pseudorange corrections (MT2–5, 24), long-term satellite ephemeris/clock
 * corrections (MT24, 25), an ionospheric grid mask (MT18) and grid delays
 * (MT26), plus degradation/latency parameters (MT7). Applied to a single-point
 * solution they remove most of the broadcast-ephemeris, satellite-clock and
 * (via the grid) ionospheric error — SBAS-augmented SPP, roughly metre-level
 * with integrity, versus a few metres for plain SPP.
 *
 * {@link SbasProcessor} ingests the decoded messages ({@link SbasProcessor.update})
 * and exposes the two corrections a solver needs: a per-satellite range/clock
 * correction ({@link SbasProcessor.satCorrection}) and a slant ionospheric
 * delay at a pierce point ({@link SbasProcessor.ionoDelay}).
 *
 * Field offsets, scale factors and the interpolation follow DO-229 and RTKLIB
 * `sbas.c` (`decode_sbstype*`, `sbssatcorr`, `sbsioncorr`), which this was
 * validated against. GEO navigation (MT9) is decoded separately by
 * {@link ../navbits/sbas.decodeSbasGeoNav}; it is recognised here but does not
 * feed the correction state.
 */
import { getBitU, getBitS } from '../navbits';
import { sbasMessageType } from '../navbits/sbas';
import { C_LIGHT } from '../constants/gnss';

const P2_11 = 2 ** -11;
const P2_31 = 2 ** -31;
const P2_39 = 2 ** -39;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const SEC_PER_WEEK = 604800;

// Correction time-outs (DO-229D Table A-25, En Route/Terminal/LNAV column —
// the widest safe validity for a general receiver). Fast corrections time out
// per Table A-8 by degradation index; 30 s is the conservative floor.
const MAXSBSAGEF = 30.0; // fast correction (s)
const MAXSBSAGEL = 360.0; // long-term correction (s) — Table A-25 (was 1800)
const MAXBAND = 10; // max SBAS ionosphere band index
const two = (n: number) => String(n).padStart(2, '0');

/** Fast-correction variance (m²) by UDRE index (udre = UDREI + 1). */
const VAR_FCORR = [
  0.052, 0.0924, 0.1444, 0.283, 0.4678, 0.8315, 1.2992, 1.8709, 2.5465, 3.326,
  5.1968, 20.787, 230.9661, 2078.695,
];
const varfcorr = (udre: number) =>
  udre > 0 && udre <= 14 ? VAR_FCORR[udre - 1]! : 0;

/** Ionospheric-correction variance (m²) by GIVE index (give = GIVEI + 1). */
const VAR_ICORR = [
  0.0084, 0.0333, 0.0749, 0.1331, 0.2079, 0.2994, 0.4075, 0.5322, 0.6735,
  0.8315, 1.1974, 1.8709, 3.326, 20.787, 187.0826,
];
const varicorr = (give: number) =>
  give > 0 && give <= 15 ? VAR_ICORR[give - 1]! : 0;

/** Fast-correction degradation factor (m/s²) by AI index. */
const DEGF = [
  0.0, 0.00005, 0.00009, 0.00012, 0.00015, 0.0002, 0.0003, 0.00045, 0.0006,
  0.0009, 0.0015, 0.0021, 0.0027, 0.0033, 0.0046, 0.0058,
];
const degfcorr = (ai: number) => (ai > 0 && ai <= 15 ? DEGF[ai]! : 0.0058);

/**
 * Long-term correction degradation ε_ltc (m) — DO-229D §A.4.5.1.3, eqs A-54
 * (velocity code 1) and A-55 (velocity code 0). `ageSec` = t − t₀ (s).
 */
export function sbasLongTermDeg(
  d: Degradation,
  vel: boolean,
  ageSec: number
): number {
  if (vel) {
    if (ageSec > 0 && ageSec < d.iltcV1) return 0;
    return d.cltcLsb + d.cltcV1 * Math.max(0, -ageSec, ageSec - d.iltcV1);
  }
  return d.cltcV0 * Math.floor(Math.abs(ageSec) / d.iltcV0);
}

/**
 * Ionospheric-correction degradation ε_iono (m) — DO-229D §A.4.5.2, eq A-59.
 * `ageSec` = t − t_iono (s) of the grid point.
 */
export function sbasIonoDeg(d: Degradation, ageSec: number): number {
  const dt = Math.abs(ageSec);
  return d.cionoStep * Math.floor(dt / d.iiono) + d.cionoRamp * dt;
}

// ── SBAS ionospheric grid-point (IGP) band definitions (DO-229 A.4.4.10) ──
// prettier-ignore
const x1 = [-75,-65,-55,-50,-45,-40,-35,-30,-25,-20,-15,-10,-5,0,5,10,15,20,25,30,35,40,45,50,55,65,75,85];
// prettier-ignore
const x2 = [-55,-50,-45,-40,-35,-30,-25,-20,-15,-10,-5,0,5,10,15,20,25,30,35,40,45,50,55];
// prettier-ignore
const x3 = [-75,-65,-55,-50,-45,-40,-35,-30,-25,-20,-15,-10,-5,0,5,10,15,20,25,30,35,40,45,50,55,65,75];
// prettier-ignore
const x4 = [-85,-75,-65,-55,-50,-45,-40,-35,-30,-25,-20,-15,-10,-5,0,5,10,15,20,25,30,35,40,45,50,55,65,75];
// prettier-ignore
const x5 = [-180,-175,-170,-165,-160,-155,-150,-145,-140,-135,-130,-125,-120,-115,-110,-105,-100,-95,-90,-85,-80,-75,-70,-65,-60,-55,-50,-45,-40,-35,-30,-25,-20,-15,-10,-5,0,5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95,100,105,110,115,120,125,130,135,140,145,150,155,160,165,170,175];
// prettier-ignore
const x6 = [-180,-170,-160,-150,-140,-130,-120,-110,-100,-90,-80,-70,-60,-50,-40,-30,-20,-10,0,10,20,30,40,50,60,70,80,90,100,110,120,130,140,150,160,170];
const x7 = [-180, -150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150];
const x8 = [-170, -140, -110, -80, -50, -20, 10, 40, 70, 100, 130, 160];

interface IgpBand {
  /** Fixed coordinate for the sub-band (longitude for bands 0–8, latitude for 9–10). */
  coord: number;
  /** Varying coordinate array (latitudes for bands 0–8, longitudes for 9–10). */
  arr: readonly number[];
  bits: number;
  bite: number;
}
// prettier-ignore
const igpband1: IgpBand[][] = [
  [{coord:-180,arr:x1,bits:1,bite:28},{coord:-175,arr:x2,bits:29,bite:51},{coord:-170,arr:x3,bits:52,bite:78},{coord:-165,arr:x2,bits:79,bite:101},{coord:-160,arr:x3,bits:102,bite:128},{coord:-155,arr:x2,bits:129,bite:151},{coord:-150,arr:x3,bits:152,bite:178},{coord:-145,arr:x2,bits:179,bite:201}],
  [{coord:-140,arr:x4,bits:1,bite:28},{coord:-135,arr:x2,bits:29,bite:51},{coord:-130,arr:x3,bits:52,bite:78},{coord:-125,arr:x2,bits:79,bite:101},{coord:-120,arr:x3,bits:102,bite:128},{coord:-115,arr:x2,bits:129,bite:151},{coord:-110,arr:x3,bits:152,bite:178},{coord:-105,arr:x2,bits:179,bite:201}],
  [{coord:-100,arr:x3,bits:1,bite:27},{coord:-95,arr:x2,bits:28,bite:50},{coord:-90,arr:x1,bits:51,bite:78},{coord:-85,arr:x2,bits:79,bite:101},{coord:-80,arr:x3,bits:102,bite:128},{coord:-75,arr:x2,bits:129,bite:151},{coord:-70,arr:x3,bits:152,bite:178},{coord:-65,arr:x2,bits:179,bite:201}],
  [{coord:-60,arr:x3,bits:1,bite:27},{coord:-55,arr:x2,bits:28,bite:50},{coord:-50,arr:x4,bits:51,bite:78},{coord:-45,arr:x2,bits:79,bite:101},{coord:-40,arr:x3,bits:102,bite:128},{coord:-35,arr:x2,bits:129,bite:151},{coord:-30,arr:x3,bits:152,bite:178},{coord:-25,arr:x2,bits:179,bite:201}],
  [{coord:-20,arr:x3,bits:1,bite:27},{coord:-15,arr:x2,bits:28,bite:50},{coord:-10,arr:x3,bits:51,bite:77},{coord:-5,arr:x2,bits:78,bite:100},{coord:0,arr:x1,bits:101,bite:128},{coord:5,arr:x2,bits:129,bite:151},{coord:10,arr:x3,bits:152,bite:178},{coord:15,arr:x2,bits:179,bite:201}],
  [{coord:20,arr:x3,bits:1,bite:27},{coord:25,arr:x2,bits:28,bite:50},{coord:30,arr:x3,bits:51,bite:77},{coord:35,arr:x2,bits:78,bite:100},{coord:40,arr:x4,bits:101,bite:128},{coord:45,arr:x2,bits:129,bite:151},{coord:50,arr:x3,bits:152,bite:178},{coord:55,arr:x2,bits:179,bite:201}],
  [{coord:60,arr:x3,bits:1,bite:27},{coord:65,arr:x2,bits:28,bite:50},{coord:70,arr:x3,bits:51,bite:77},{coord:75,arr:x2,bits:78,bite:100},{coord:80,arr:x3,bits:101,bite:127},{coord:85,arr:x2,bits:128,bite:150},{coord:90,arr:x1,bits:151,bite:178},{coord:95,arr:x2,bits:179,bite:201}],
  [{coord:100,arr:x3,bits:1,bite:27},{coord:105,arr:x2,bits:28,bite:50},{coord:110,arr:x3,bits:51,bite:77},{coord:115,arr:x2,bits:78,bite:100},{coord:120,arr:x3,bits:101,bite:127},{coord:125,arr:x2,bits:128,bite:150},{coord:130,arr:x4,bits:151,bite:178},{coord:135,arr:x2,bits:179,bite:201}],
  [{coord:140,arr:x3,bits:1,bite:27},{coord:145,arr:x2,bits:28,bite:50},{coord:150,arr:x3,bits:51,bite:77},{coord:155,arr:x2,bits:78,bite:100},{coord:160,arr:x3,bits:101,bite:127},{coord:165,arr:x2,bits:128,bite:150},{coord:170,arr:x3,bits:151,bite:177},{coord:175,arr:x2,bits:178,bite:200}],
];
// prettier-ignore
const igpband2: IgpBand[][] = [
  [{coord:60,arr:x5,bits:1,bite:72},{coord:65,arr:x6,bits:73,bite:108},{coord:70,arr:x6,bits:109,bite:144},{coord:75,arr:x6,bits:145,bite:180},{coord:85,arr:x7,bits:181,bite:192}],
  [{coord:-60,arr:x5,bits:1,bite:72},{coord:-65,arr:x6,bits:73,bite:108},{coord:-70,arr:x6,bits:109,bite:144},{coord:-75,arr:x6,bits:145,bite:180},{coord:-85,arr:x8,bits:181,bite:192}],
];

interface FastCorr {
  prc: number; // pseudorange correction (m)
  udre: number; // UDREI + 1
  ai: number; // degradation index
  iodf: number;
  t0s: number; // reception time (seconds of GPS time)
}
interface LongCorr {
  iode: number;
  dpos: [number, number, number]; // position correction (m)
  dvel: [number, number, number]; // velocity correction (m/s)
  daf0: number; // clock correction (s)
  daf1: number; // clock drift correction (s/s)
  t0s: number; // applicability epoch (seconds of GPS time)
  vel: boolean; // velocity code (true = Type 25 v=1, per-sat velocity)
}

/** MT10 degradation parameters (DO-229D Table A-9), needed for the residual
 *  variances σ²_flt / σ²_ionogrid (§A.4.5, §J.2.2). */
export interface Degradation {
  brrc: number;
  cltcLsb: number;
  cltcV1: number;
  iltcV1: number;
  cltcV0: number;
  iltcV0: number;
  cgeoLsb: number;
  cgeoV: number;
  igeo: number;
  cer: number;
  cionoStep: number;
  iiono: number;
  cionoRamp: number;
  rssUdre: boolean;
  rssIono: boolean;
}
interface SatEntry {
  prn: string | null; // PRN string (e.g. 'G05'), or null for a masked slot we don't map
  fcorr?: FastCorr;
  lcorr?: LongCorr;
}
interface Igp {
  lat: number;
  lon: number;
  delay: number; // vertical delay (m)
  give: number; // GIVEI + 1
  t0s: number;
}
interface IonBand {
  iodi: number;
  igp: Igp[];
}

/** A per-satellite SBAS correction, ready to apply in an SPP solve. */
export interface SbasSatCorrection {
  /** Long-term ECEF position correction to add to the satellite position (m). */
  dPos: [number, number, number];
  /** Clock correction to add to the satellite clock bias (s) — long-term + fast. */
  dClkS: number;
  /** Pseudorange fast correction alone (m), for reference. */
  prcM: number;
  /** Variance of the correction (m²). */
  varM2: number;
  /** Applied long-term correction IODE (matches the broadcast ephemeris IODE). */
  iode: number;
}

/** A slant ionospheric delay at a pierce point from the SBAS grid. */
export interface SbasIonoDelay {
  /** Slant ionospheric delay on L1 (m). */
  delayM: number;
  /** Variance (m²). */
  varM2: number;
}

/** GPS→GPS-epoch seconds. */
const gpsSeconds = (week: number, tow: number) => week * SEC_PER_WEEK + tow;

/** Map an MT1 PRN-mask index (1..210) to a PRN string, or null. */
function maskPrn(i: number): string | null {
  if (i >= 1 && i <= 37) return `G${two(i)}`;
  if (i >= 38 && i <= 61) return `R${two(i - 37)}`;
  if (i >= 120 && i <= 138) return `S${two(i - 100)}`;
  if (i >= 193 && i <= 202) return `J${two(i - 192)}`;
  return null;
}

/**
 * Ionospheric pierce point (single-layer, height `hion` km) for a receiver
 * geodetic position and a satellite az/el, returning the obliquity mapping
 * factor and filling the pierce lat/lon (rad). RTKLIB `ionppp`.
 */
function ionppp(
  latRad: number,
  lonRad: number,
  azRad: number,
  elRad: number,
  re: number,
  hion: number
): { fp: number; latP: number; lonP: number } {
  const rp = (re / (re + hion)) * Math.cos(elRad);
  const ap = Math.PI / 2 - elRad - Math.asin(rp);
  const sinap = Math.sin(ap);
  const tanap = Math.tan(ap);
  const cosaz = Math.cos(azRad);
  const latP = Math.asin(
    Math.sin(latRad) * Math.cos(ap) + Math.cos(latRad) * sinap * cosaz
  );
  let lonP: number;
  if (
    (latRad > 70 * D2R && tanap * cosaz > Math.tan(Math.PI / 2 - latRad)) ||
    (latRad < -70 * D2R && -tanap * cosaz > Math.tan(Math.PI / 2 + latRad))
  ) {
    lonP =
      lonRad + Math.PI - Math.asin((sinap * Math.sin(azRad)) / Math.cos(latP));
  } else {
    lonP = lonRad + Math.asin((sinap * Math.sin(azRad)) / Math.cos(latP));
  }
  return { fp: 1 / Math.sqrt(1 - rp * rp), latP, lonP };
}

export class SbasProcessor {
  private sats: SatEntry[] = [];
  private satIdx = new Map<string, number>();
  private iodp = -1;
  private tlat = 0;
  private degr: Degradation | null = null;
  private ion: IonBand[] = [];
  /** GEO PRN(s) whose messages have been ingested. */
  readonly geoPrns = new Set<string>();

  /**
   * Ingest one decoded SBAS L1 message (250-bit, MSB-first) received at the
   * given GPS week / time-of-week. Returns the message type, or -1 if it was
   * not a recognised/applicable correction message.
   */
  update(msg: Uint8Array, week: number, tow: number, geoPrn?: number): number {
    if (week === 0) return -1;
    const type = sbasMessageType(msg);
    if (geoPrn != null && geoPrn >= 120 && geoPrn <= 158)
      this.geoPrns.add(`S${two(geoPrn - 100)}`);
    switch (type) {
      case 1:
        return this.decodeMask(msg) ? type : -1;
      case 0:
      case 2:
      case 3:
      case 4:
      case 5:
        return this.decodeFast(msg, type, week, tow) ? type : -1;
      case 6:
        return this.decodeIntegrity(msg) ? type : -1;
      case 7:
        return this.decodeDegradation(msg) ? type : -1;
      case 10:
        return this.decodeMt10(msg) ? type : -1;
      case 18:
        return this.decodeIgpMask(msg) ? type : -1;
      case 24:
        return this.decodeMixed(msg, week, tow) ? type : -1;
      case 25:
        return this.decodeLongCorrHalf(msg, 14, week, tow) &&
          this.decodeLongCorrHalf(msg, 120, week, tow)
          ? type
          : -1;
      case 26:
        return this.decodeIgpDelay(msg, week, tow) ? type : -1;
      case 9: // GEO nav — handled by decodeSbasGeoNav elsewhere
      case 63: // null
        return type;
      default:
        return -1;
    }
  }

  private decodeMask(msg: Uint8Array): boolean {
    const sats: SatEntry[] = [];
    for (let i = 1; i <= 210; i++) {
      if (getBitU(msg, 13 + i, 1)) sats.push({ prn: maskPrn(i) });
    }
    this.iodp = getBitU(msg, 224, 2);
    this.sats = sats;
    this.satIdx.clear();
    sats.forEach((s, k) => {
      if (s.prn) this.satIdx.set(s.prn, k);
    });
    return true;
  }

  private decodeFast(
    msg: Uint8Array,
    type: number,
    week: number,
    tow: number
  ): boolean {
    if (this.iodp !== getBitU(msg, 16, 2)) return false;
    const iodf = getBitU(msg, 14, 2);
    const t0s = gpsSeconds(week, tow);
    for (let i = 0; i < 13; i++) {
      const j = 13 * ((type === 0 ? 2 : type) - 2) + i;
      if (j >= this.sats.length) break;
      const udre = getBitU(msg, 174 + 4 * i, 4);
      const prc = getBitS(msg, 18 + i * 12, 12) * 0.125;
      const prev = this.sats[j]!.fcorr;
      this.sats[j]!.fcorr = {
        prc,
        udre: udre + 1,
        ai: prev?.ai ?? 0,
        iodf,
        t0s,
      };
    }
    return true;
  }

  private decodeIntegrity(msg: Uint8Array): boolean {
    const iodf = [0, 1, 2, 3].map((i) => getBitU(msg, 14 + i * 2, 2));
    for (let i = 0; i < this.sats.length; i++) {
      const f = this.sats[i]!.fcorr;
      if (!f || f.iodf !== iodf[Math.floor(i / 13)]) continue;
      f.udre = getBitU(msg, 22 + i * 4, 4) + 1;
    }
    return true;
  }

  private decodeDegradation(msg: Uint8Array): boolean {
    if (this.iodp !== getBitU(msg, 18, 2)) return false;
    this.tlat = getBitU(msg, 14, 4);
    for (let i = 0; i < this.sats.length; i++) {
      const ai = getBitU(msg, 22 + i * 4, 4);
      if (this.sats[i]!.fcorr) this.sats[i]!.fcorr!.ai = ai;
      else this.sats[i]!.fcorr = { prc: 0, udre: 0, ai, iodf: -1, t0s: 0 };
    }
    return true;
  }

  /** MT10 degradation factors (DO-229D Table A-9). Fields follow the 8-bit
   *  preamble + 6-bit type (start bit 14), MSB-first, with the listed LSBs.
   *  Iiono / Iltc_v0 of 0 must be read as 1 (Table A-9, Note 3). */
  private decodeMt10(msg: Uint8Array): boolean {
    const u = (p: number, n: number) => getBitU(msg, p, n);
    this.degr = {
      brrc: u(14, 10) * 0.002,
      cltcLsb: u(24, 10) * 0.002,
      cltcV1: u(34, 10) * 0.00005,
      iltcV1: u(44, 9),
      cltcV0: u(53, 10) * 0.002,
      iltcV0: u(63, 9) || 1,
      cgeoLsb: u(72, 10) * 0.0005,
      cgeoV: u(82, 10) * 0.00005,
      igeo: u(92, 9),
      cer: u(101, 6) * 0.5,
      cionoStep: u(107, 10) * 0.001,
      iiono: u(117, 9) || 1,
      cionoRamp: u(126, 10) * 0.000005,
      rssUdre: u(136, 1) === 1,
      rssIono: u(137, 1) === 1,
    };
    return true;
  }

  private decodeMixed(msg: Uint8Array, week: number, tow: number): boolean {
    if (this.iodp !== getBitU(msg, 110, 2)) return false;
    const blk = getBitU(msg, 112, 2);
    const iodf = getBitU(msg, 114, 2);
    const t0s = gpsSeconds(week, tow);
    for (let i = 0; i < 6; i++) {
      const j = 13 * blk + i;
      if (j >= this.sats.length) break;
      const udre = getBitU(msg, 86 + 4 * i, 4);
      const prc = getBitS(msg, 14 + i * 12, 12) * 0.125;
      const prev = this.sats[j]!.fcorr;
      this.sats[j]!.fcorr = {
        prc,
        udre: udre + 1,
        ai: prev?.ai ?? 0,
        iodf,
        t0s,
      };
    }
    return this.decodeLongCorrHalf(msg, 120, week, tow);
  }

  private decodeLongCorrHalf(
    msg: Uint8Array,
    p: number,
    week: number,
    tow: number
  ): boolean {
    if (getBitU(msg, p, 1) === 0) {
      if (this.iodp === getBitU(msg, p + 103, 2)) {
        const a = this.decodeLong0(msg, p + 1, week, tow);
        const b = this.decodeLong0(msg, p + 52, week, tow);
        return a || b;
      }
    } else if (this.iodp === getBitU(msg, p + 104, 2)) {
      return this.decodeLong1(msg, p + 1, week, tow);
    }
    return false;
  }

  private decodeLong0(
    msg: Uint8Array,
    p: number,
    week: number,
    tow: number
  ): boolean {
    const n = getBitU(msg, p, 6);
    if (n === 0 || n > this.sats.length) return false;
    this.sats[n - 1]!.lcorr = {
      iode: getBitU(msg, p + 6, 8),
      dpos: [
        getBitS(msg, p + 14, 9) * 0.125,
        getBitS(msg, p + 23, 9) * 0.125,
        getBitS(msg, p + 32, 9) * 0.125,
      ],
      dvel: [0, 0, 0],
      daf0: getBitS(msg, p + 41, 10) * P2_31,
      daf1: 0,
      t0s: gpsSeconds(week, tow),
      vel: false,
    };
    return true;
  }

  private decodeLong1(
    msg: Uint8Array,
    p: number,
    week: number,
    tow: number
  ): boolean {
    const n = getBitU(msg, p, 6);
    if (n === 0 || n > this.sats.length) return false;
    let t = getBitU(msg, p + 90, 13) * 16 - (tow % 86400);
    if (t <= -43200) t += 86400;
    else if (t > 43200) t -= 86400;
    this.sats[n - 1]!.lcorr = {
      iode: getBitU(msg, p + 6, 8),
      dpos: [
        getBitS(msg, p + 14, 11) * 0.125,
        getBitS(msg, p + 25, 11) * 0.125,
        getBitS(msg, p + 36, 11) * 0.125,
      ],
      dvel: [
        getBitS(msg, p + 58, 8) * P2_11,
        getBitS(msg, p + 66, 8) * P2_11,
        getBitS(msg, p + 74, 8) * P2_11,
      ],
      daf0: getBitS(msg, p + 47, 11) * P2_31,
      daf1: getBitS(msg, p + 82, 8) * P2_39,
      t0s: gpsSeconds(week, tow + t),
      vel: true,
    };
    return true;
  }

  private decodeIgpMask(msg: Uint8Array): boolean {
    const band = getBitU(msg, 18, 4);
    let p: IgpBand[];
    let m: number;
    if (band <= 8) {
      p = igpband1[band]!;
      m = 8;
    } else if (band <= 10) {
      p = igpband2[band - 9]!;
      m = 5;
    } else return false;
    const igp: Igp[] = [];
    for (let i = 1; i <= 201; i++) {
      if (!getBitU(msg, 23 + i, 1)) continue;
      for (let j = 0; j < m; j++) {
        const b = p[j]!;
        if (i < b.bits || b.bite < i) continue;
        const varying = b.arr[i - b.bits]!;
        igp.push({
          lat: band <= 8 ? varying : b.coord,
          lon: band <= 8 ? b.coord : varying,
          delay: 0,
          give: 0,
          t0s: 0,
        });
        break;
      }
    }
    this.ion[band] = { iodi: getBitU(msg, 22, 2), igp };
    return true;
  }

  private decodeIgpDelay(msg: Uint8Array, week: number, tow: number): boolean {
    const band = getBitU(msg, 14, 4);
    const b = this.ion[band];
    if (band > MAXBAND || !b || b.iodi !== getBitU(msg, 217, 2)) return false;
    const block = getBitU(msg, 18, 4);
    const t0s = gpsSeconds(week, tow);
    for (let i = 0; i < 15; i++) {
      const j = block * 15 + i;
      if (j >= b.igp.length) continue;
      const give = getBitU(msg, 22 + i * 13 + 9, 4);
      const delay = getBitU(msg, 22 + i * 13, 9);
      b.igp[j]!.delay = delay === 0x1ff ? 0 : delay * 0.125;
      b.igp[j]!.give = give + 1 >= 16 ? 0 : give + 1;
      b.igp[j]!.t0s = t0s;
    }
    return true;
  }

  /** PRNs currently in the correction mask (in mask order). */
  activeSats(): string[] {
    return this.sats.map((s) => s.prn).filter((p): p is string => !!p);
  }

  /** Number of ionospheric grid points with a valid delay across all bands. */
  ionoGridPoints(): number {
    let n = 0;
    for (const b of this.ion) if (b) for (const g of b.igp) if (g.give > 0) n++;
    return n;
  }

  /**
   * Correction-coverage census at a GPS week/time — a diagnostic funnel over
   * the current state, explaining how many masked satellites are actually
   * correctable. Each stage subsumes the requirement of the previous one for a
   * full range/clock correction: a satellite is `corrected` only when it has
   * both a fresh fast correction and (for non-SBAS satellites) a fresh
   * long-term correction (exactly {@link satCorrection}'s gate). `ionoGrid` is
   * the total number of valid grid points — the additional requirement for the
   * *iono*-corrected subset a solver forms per pierce point.
   *
   * Use it to tell "no corrections applied" (mask empty / products stale) apart
   * from "corrections applied but the pierce points aren't grid-covered yet".
   */
  coverage(
    week: number,
    tow: number
  ): {
    masked: number;
    fast: number;
    long: number;
    corrected: number;
    ionoGrid: number;
  } {
    const now = gpsSeconds(week, tow);
    let masked = 0;
    let fast = 0;
    let long = 0;
    let corrected = 0;
    for (const s of this.sats) {
      if (!s.prn) continue;
      masked++;
      if (
        s.fcorr &&
        s.fcorr.t0s !== 0 &&
        s.fcorr.udre < 15 &&
        Math.abs(now - s.fcorr.t0s + this.tlat) <= MAXSBSAGEF
      )
        fast++;
      if (
        s.prn[0] === 'S' ||
        (s.lcorr &&
          s.lcorr.t0s !== 0 &&
          Math.abs(now - s.lcorr.t0s) <= MAXSBSAGEL)
      )
        long++;
      if (this.satCorrection(s.prn, week, tow)) corrected++;
    }
    return { masked, fast, long, corrected, ionoGrid: this.ionoGridPoints() };
  }

  /**
   * Satellite range/clock correction for a PRN at a GPS week/tow, or null if
   * no valid (unexpired) long-term + fast correction is available. Add `dPos`
   * to the satellite ECEF position and `dClkS` to its clock bias.
   */
  satCorrection(
    prn: string,
    week: number,
    tow: number
  ): SbasSatCorrection | null {
    const idx = this.satIdx.get(prn);
    if (idx === undefined) return null;
    const s = this.sats[idx]!;
    const now = gpsSeconds(week, tow);

    // Long-term correction (SBAS sats without one apply zero; others require it).
    const drs: [number, number, number] = [0, 0, 0];
    let dclk = 0;
    let iode = -1;
    if (s.lcorr && s.lcorr.t0s !== 0) {
      const t = now - s.lcorr.t0s;
      if (Math.abs(t) > MAXSBSAGEL) return null;
      for (let i = 0; i < 3; i++)
        drs[i] = s.lcorr.dpos[i] + s.lcorr.dvel[i] * t;
      dclk = s.lcorr.daf0 + s.lcorr.daf1 * t;
      iode = s.lcorr.iode;
    } else if (prn[0] !== 'S') {
      return null; // GPS/GLONASS/QZSS need a long-term correction
    }

    // Fast correction.
    if (!s.fcorr || s.fcorr.t0s === 0) return null;
    const tf = now - s.fcorr.t0s + this.tlat;
    if (Math.abs(tf) > MAXSBSAGEF || s.fcorr.udre >= 15) return null;
    const prc = s.fcorr.prc;

    // Fast/long-term residual variance σ²_flt (DO-229D §J.2.2). σ_UDRE is the
    // broadcast UDRE variance; the degradation terms grow it with correction
    // age. εrrc and εer are 0 here (we apply no range-rate extrapolation, and
    // this is en-route-equivalent SPP, not an LPV/LNAV-VNAV approach).
    const sigUdre = Math.sqrt(varfcorr(s.fcorr.udre)); // δUDRE = 1 (no MT27/28)
    const efc = (degfcorr(s.fcorr.ai) * tf * tf) / 2; // §A.4.5.1.1 (A-51)
    const eltc =
      this.degr && s.lcorr && s.lcorr.t0s !== 0
        ? sbasLongTermDeg(this.degr, s.lcorr.vel, now - s.lcorr.t0s)
        : 0; // §A.4.5.1.3
    const varM2 = this.degr?.rssUdre
      ? sigUdre * sigUdre + efc * efc + eltc * eltc
      : (sigUdre + efc + eltc) ** 2;

    return { dPos: drs, dClkS: dclk + prc / C_LIGHT, prcM: prc, varM2, iode };
  }

  /** The last-decoded MT10 degradation factors, or null if none seen. */
  get degradation(): Readonly<Degradation> | null {
    return this.degr;
  }

  /**
   * Slant L1 ionospheric delay (m) at the pierce point for a receiver geodetic
   * position (lat/lon rad, height m) and a satellite az/el (rad), interpolated
   * from the SBAS grid — or null if the pierce point isn't covered. RTKLIB
   * `sbsioncorr`.
   */
  ionoDelay(
    week: number,
    tow: number,
    latRad: number,
    lonRad: number,
    heightM: number,
    azRad: number,
    elRad: number
  ): SbasIonoDelay | null {
    if (heightM < -100 || elRad <= 0) return { delayM: 0, varM2: 0 };
    const { fp, latP, lonP } = ionppp(
      latRad,
      lonRad,
      azRad,
      elRad,
      6378.1363,
      350.0
    );
    const igp = this.searchIgp(latP, lonP);
    if (!igp) return null;
    const { pts, x, y } = igp;
    const w = [0, 0, 0, 0];
    // {ws, wn, es, en} bilinear weights, with the RTKLIB 3-point fallbacks.
    if (pts[0] && pts[1] && pts[2] && pts[3]) {
      w[0] = (1 - x) * (1 - y);
      w[1] = (1 - x) * y;
      w[2] = x * (1 - y);
      w[3] = x * y;
    } else if (pts[0] && pts[1] && pts[2]) {
      w[1] = y;
      w[2] = x;
      w[0] = 1 - w[1] - w[2];
      if (w[0] < 0) return null;
    } else if (pts[0] && pts[2] && pts[3]) {
      w[0] = 1 - x;
      w[3] = y;
      w[2] = 1 - w[0] - w[3];
      if (w[2] < 0) return null;
    } else if (pts[0] && pts[1] && pts[3]) {
      w[0] = 1 - y;
      w[3] = x;
      w[1] = 1 - w[0] - w[3];
      if (w[1] < 0) return null;
    } else if (pts[1] && pts[2] && pts[3]) {
      w[1] = 1 - x;
      w[2] = 1 - y;
      w[3] = 1 - w[1] - w[2];
      if (w[3] < 0) return null;
    } else return null;

    const now = gpsSeconds(week, tow);
    let delay = 0;
    let varVert = 0; // σ²_UIVE = Σ Wn·σ²_ionogrid,n (DO-229D §A.4.4.10.4)
    for (let i = 0; i < 4; i++) {
      const g = pts[i];
      if (!g) continue;
      delay += w[i]! * g.delay;
      // Per-IGP σ²_ionogrid (DO-229D §A.4.5.2, A-58/A-59): the GIVE variance
      // grown by the iono degradation εiono with grid-point age (MT10).
      const sigGive = Math.sqrt(varicorr(g.give));
      const d = this.degr;
      const eiono = d ? sbasIonoDeg(d, now - g.t0s) : 0;
      const sig2 = d?.rssIono
        ? sigGive * sigGive + eiono * eiono
        : (sigGive + eiono) ** 2;
      varVert += w[i]! * sig2;
    }
    // Slant: σ_UIRE = Fpp·σ_UIVE, so the variance scales by fp².
    return { delayM: delay * fp, varM2: varVert * fp * fp };
  }

  /** Find the four IGPs bracketing a pierce point (RTKLIB `searchigp`). */
  private searchIgp(
    latP: number,
    lonP: number
  ): { pts: (Igp | null)[]; x: number; y: number } | null {
    const lat = latP * R2D;
    let lon = lonP * R2D;
    if (lon >= 180) lon -= 360;
    const latp = [0, 0];
    const lonp = [0, 0, 0, 0];
    let x: number;
    let y: number;
    if (lat >= -55 && lat < 55) {
      latp[0] = Math.floor(lat / 5) * 5;
      latp[1] = latp[0] + 5;
      lonp[0] = lonp[1] = Math.floor(lon / 5) * 5;
      lonp[2] = lonp[3] = lonp[0] + 5;
      x = (lon - lonp[0]) / 5;
      y = (lat - latp[0]) / 5;
    } else {
      latp[0] = Math.floor((lat - 5) / 10) * 10 + 5;
      latp[1] = latp[0] + 10;
      lonp[0] = lonp[1] = Math.floor(lon / 10) * 10;
      lonp[2] = lonp[3] = lonp[0] + 10;
      x = (lon - lonp[0]) / 10;
      y = (lat - latp[0]) / 10;
      if (lat >= 75 && lat < 85) {
        lonp[1] = Math.floor(lon / 90) * 90;
        lonp[3] = lonp[1] + 90;
      } else if (lat >= -85 && lat < -75) {
        lonp[0] = Math.floor((lon - 50) / 90) * 90 + 40;
        lonp[2] = lonp[0] + 90;
      } else if (lat >= 85) {
        for (let i = 0; i < 4; i++) lonp[i] = Math.floor(lon / 90) * 90;
      } else if (lat < -85) {
        for (let i = 0; i < 4; i++)
          lonp[i] = Math.floor((lon - 50) / 90) * 90 + 40;
      }
    }
    for (let i = 0; i < 4; i++) if (lonp[i] === 180) lonp[i] = -180;
    const pts: (Igp | null)[] = [null, null, null, null];
    for (const band of this.ion) {
      if (!band) continue;
      for (const g of band.igp) {
        if (g.t0s === 0 || g.give <= 0) continue;
        if (g.lat === latp[0] && g.lon === lonp[0]) pts[0] = g;
        else if (g.lat === latp[1] && g.lon === lonp[1]) pts[1] = g;
        else if (g.lat === latp[0] && g.lon === lonp[2]) pts[2] = g;
        else if (g.lat === latp[1] && g.lon === lonp[3]) pts[3] = g;
      }
    }
    if (!pts[0] && !pts[1] && !pts[2] && !pts[3]) return null;
    return { pts, x, y };
  }
}
