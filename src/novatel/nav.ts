/**
 * NovAtel navigation-message decoding: RAWEPHEM (message 41, raw GPS
 * LNAV subframes 1–3), GLOEPHEMERIS (message 723, decoded GLONASS
 * L1 C/A ephemeris), GALEPHEMERIS (1122), BDSEPHEMERIS (1696),
 * QZSSEPHEMERIS (1336), RAWSBASFRAME (973) / RAWWAASFRAME (287, its
 * OEMV-era twin — raw SBAS L1 GEO messages) and IONUTC (8, GPS
 * Klobuchar + UTC parameters).
 *
 * Ported from RTKLIB demo5 (rtklibexplorer fork, src/rcv/novatel.c:
 * decode_rawephemb / decode_gloephemerisb / decode_galephemerisb /
 * decode_bdsephemerisb / decode_rawsbasframeb / decode_ionutcb,
 * Copyright (c) 2007-2020 T. Takasu, BSD-2-Clause) and cross-checked
 * against the OEM7 Commands and Logs Reference Manual. QZSSEPHEMERIS
 * has no RTKLIB decoder (RTKLIB only handles the raw-subframe
 * QZSSRAWEPHEM 1331); its layout is taken from the OEM7 manual §3.150
 * and is therefore synthetic-tested only, like SBF's QZSNav.
 *
 * RAWSBASFRAME/RAWWAASFRAME carry the 250-bit SBAS L1 message as a
 * 29-byte field (OEM7 manual §3.169: after the header, frame-decoder
 * u4, PRN u4, a u4, then 29 bytes of message). Message type 9 (GEO
 * navigation) is decoded by the shared `decodeSbasGeoNav`, the same
 * decoder the u-blox and SBF paths use; other message types (fast/long
 * corrections, etc.) are skipped. Because only 29 bytes (232 bits) are
 * carried — enough for every MT9 field but 18 bits short of the 24-bit
 * SBAS CRC — the SBAS CRC is not re-checked; the OEM4 CRC-32 over the
 * whole log already guarantees the transported bytes.
 *
 * Output records mirror what `parseNavFile` produces for the
 * equivalent RINEX 3 navigation file: Keplerian `tocDate` is a
 * GPS-scale Date except BeiDou, whose epochs and week stay on the BDT
 * scale like a RINEX file; angles arrive from the receiver already in
 * radians (NovAtel decodes the semicircle SIS fields itself), so no
 * GPS_PI scaling is applied here; the Galileo clock set follows the
 * received data source (F/NAV when the rcv_fnav flag is set, I/NAV
 * otherwise — RTKLIB's convention, which convbin tags with the RINEX
 * I/NAV / F/NAV data-source flags) and `tgd` is BGD E5a/E1, the first
 * RINEX BGD slot; GLONASS `tocDate` is the UTC epoch, state vectors
 * are in km (PZ-90), the RINEX clock bias is −τ_n, and
 * `messageFrameTime` is the frame time as seconds of the UTC week.
 */

import { decodeGpsLnavFrame } from '../navbits';
import { CnavAssembler, cnavCrcOk, type CnavEphemeris } from '../navbits/cnav';
import { decodeSbasGeoNav } from '../navbits/sbas';
import type {
  Ephemeris,
  GlonassEphemeris,
  KeplerEphemeris,
} from '../rinex/nav';
import { getUtcDate } from '../time/utc';
import { oem4Frames } from './frame';

const ID_IONUTC = 8;
const ID_RAWCNAVFRAME = 1066;
const ID_RAWEPHEM = 41;
const ID_GLOEPHEMERIS = 723;
const ID_GALEPHEMERIS = 1122;
const ID_QZSSEPHEMERIS = 1336;
const ID_GPSEPHEM = 7;
const ID_BDSEPHEMERIS = 1696;
const ID_RAWWAASFRAME = 287; // OEMV/OEM4 raw SBAS (WAAS) frame
const ID_RAWSBASFRAME = 973; // OEM6/OEM7 raw SBAS frame (same format)

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
// BDT calendar epoch (Jan 1 2006 00:00:00 BDT), naive — RINEX BDS nav
// records print BDT calendar dates and parseNavFile keeps them as-is.
const BDT_EPOCH_MS = Date.UTC(2006, 0, 1);
const SEC_PER_WEEK = 7 * 86400;
const SEC_PER_DAY = 86400;
const MS_PER_WEEK = SEC_PER_WEEK * 1000;

const gpsMs = (week: number, sec: number) =>
  GPS_EPOCH_MS + week * MS_PER_WEEK + sec * 1000;

const sowOf = (dateMs: number) => (dateMs / 1000) % SEC_PER_WEEK;

/**
 * Fold a seconds-of-week value into the week nearest the reference
 * GPS-scale time (RTKLIB adjweek): returns the epoch in ms.
 */
function nearWeekMs(refMs: number, sow: number): number {
  const refWeek = Math.floor((refMs - GPS_EPOCH_MS) / MS_PER_WEEK);
  let ms = gpsMs(refWeek, sow);
  if (ms < refMs - MS_PER_WEEK / 2) ms += MS_PER_WEEK;
  else if (ms > refMs + MS_PER_WEEK / 2) ms -= MS_PER_WEEK;
  return ms;
}

export interface NovatelNavResult {
  /** Broadcast ephemerides in stream order, duplicates suppressed. */
  ephemerides: Ephemeris[];
  /**
   * Klobuchar coefficients from IONUTC in the RINEX-header shape
   * (`GPSA` = alpha0..3, `GPSB` = beta0..3), last message wins.
   * Empty when no IONUTC message was seen.
   */
  ionoCorrections: Record<string, number[]>;
  /** GPS−UTC leap seconds (Δt_LS) from IONUTC, null when unseen. */
  leapSeconds: number | null;
  /**
   * GPS CNAV ephemerides assembled from RAWCNAVFRAME (1066) raw
   * L2C/L5 messages, repeats suppressed by the shared assembler.
   */
  cnav: CnavEphemeris[];
  /** RAWCNAVFRAME messages whose CRC-24Q check failed (dropped). */
  cnavBadCrc: number;
  /** Frames whose CRC failed (corruption indicator). */
  badCrc: number;
}

/** Decode RAWEPHEM → GPS Keplerian ephemeris (RTKLIB decode_rawephemb). */
function decodeRawEphem(
  data: Uint8Array,
  view: DataView,
  p: number
): KeplerEphemeris | null {
  const prn = view.getUint32(p, true);
  if (prn < 1 || prn > 32) return null;
  const refWeek = view.getUint32(p + 4, true);
  return decodeGpsLnavFrame(data.subarray(p + 12, p + 102), {
    prn: `G${String(prn).padStart(2, '0')}`,
    refWeek,
  });
}

/** Decode GLOEPHEMERIS → GLONASS ephemeris (RTKLIB decode_gloephemerisb). */
function decodeGloEphemeris(
  view: DataView,
  p: number
): GlonassEphemeris | null {
  const slot = view.getUint16(p, true) - 37;
  if (slot < 1 || slot > 27) return null;

  const freqNum = view.getUint16(p + 2, true) - 7; // OFF_FRQNO
  const week = view.getUint16(p + 6, true);
  // Ephemeris reference time, ms of GPS week, rounded to integer seconds.
  const tow = Math.floor(view.getUint32(p + 8, true) / 1000.0 + 0.5);
  // Integer seconds GLONASS is ahead of GPS (3 h − leap seconds).
  const toff = view.getUint32(p + 12, true);
  const health = view.getUint32(p + 24, true) < 4 ? 0 : 1;

  // Frame start (seconds of GLONASS day) → seconds of GPS week.
  let tof = view.getUint32(p + 124, true) - toff;
  tof += Math.floor(tow / SEC_PER_DAY) * SEC_PER_DAY;
  if (tof < tow - 43200.0) tof += SEC_PER_DAY;
  else if (tof > tow + 43200.0) tof -= SEC_PER_DAY;

  const toeGpsMs = GPS_EPOCH_MS + (week * SEC_PER_WEEK + tow) * 1000;
  const tofGpsMs = GPS_EPOCH_MS + (week * SEC_PER_WEEK + tof) * 1000;

  // RINEX conventions (RTKLIB outrnxgnavb): the record epoch is the
  // GLONASS toe in UTC, and the v3 message frame time is seconds of
  // the UTC week.
  const tofUtcSec =
    (getUtcDate(new Date(tofGpsMs)).getTime() - GPS_EPOCH_MS) / 1000;

  return {
    system: 'R',
    prn: `R${String(slot).padStart(2, '0')}`,
    tocDate: getUtcDate(new Date(toeGpsMs)),
    tauN: -view.getFloat64(p + 100, true), // RINEX stores −τ_n
    gammaN: view.getFloat64(p + 116, true),
    messageFrameTime:
      ((tofUtcSec % SEC_PER_WEEK) + SEC_PER_WEEK) % SEC_PER_WEEK,
    x: view.getFloat64(p + 28, true) / 1e3,
    y: view.getFloat64(p + 36, true) / 1e3,
    z: view.getFloat64(p + 44, true) / 1e3,
    xDot: view.getFloat64(p + 52, true) / 1e3,
    yDot: view.getFloat64(p + 60, true) / 1e3,
    zDot: view.getFloat64(p + 68, true) / 1e3,
    xAcc: view.getFloat64(p + 76, true) / 1e3,
    yAcc: view.getFloat64(p + 84, true) / 1e3,
    zAcc: view.getFloat64(p + 92, true) / 1e3,
    health,
    freqNum,
  };
}

/**
 * Decode GALEPHEMERIS → Galileo Keplerian ephemeris (RTKLIB
 * decode_galephemerisb). One message carries both the F/NAV and I/NAV
 * clock sets; like RTKLIB, the emitted record uses the F/NAV set when
 * the rcv_fnav flag is set and the I/NAV set otherwise. Angular fields
 * are already radians on the wire. `headerMs` is the frame header time
 * (GPS scale), used to resolve the toe/toc weeks.
 */
function decodeGalEphemeris(
  view: DataView,
  p: number,
  headerMs: number
): { eph: KeplerEphemeris; fnav: boolean } | null {
  const prn = view.getUint32(p, true);
  if (prn < 1 || prn > 36) return null;
  const fnav = (view.getUint32(p + 4, true) & 1) !== 0; // rcv_fnav
  const svhE1b = view.getUint8(p + 12) & 3;
  const svhE5a = view.getUint8(p + 13) & 3;
  const svhE5b = view.getUint8(p + 14) & 3;
  const dvsE1b = view.getUint8(p + 15) & 1;
  const dvsE5a = view.getUint8(p + 16) & 1;
  const dvsE5b = view.getUint8(p + 17) & 1;
  // p+18: SISA index, p+19: reserved — not part of the emitted record
  const iodNav = view.getUint32(p + 20, true);
  const toes = view.getUint32(p + 24, true);

  // Clock set per received data source (offsets: F/NAV at 148, I/NAV
  // at 176; each toc U4 + af0/af1/af2 R8).
  const c = fnav ? p + 148 : p + 176;
  const tocs = view.getUint32(c, true);

  // GAL week = GPS continuous week: start from the header week and
  // fold toe/toc into the half-week around the header time (RTKLIB).
  const toeMs = nearWeekMs(headerMs, toes);
  const tocDate = new Date(nearWeekMs(headerMs, tocs));

  return {
    fnav,
    eph: {
      system: 'E',
      prn: `E${String(prn).padStart(2, '0')}`,
      toc: sowOf(tocDate.getTime()),
      tocDate,
      af0: view.getFloat64(c + 4, true),
      af1: view.getFloat64(c + 12, true),
      af2: view.getFloat64(c + 20, true),
      iode: iodNav,
      crs: view.getFloat64(p + 92, true),
      deltaN: view.getFloat64(p + 36, true),
      m0: view.getFloat64(p + 44, true),
      cuc: view.getFloat64(p + 68, true),
      e: view.getFloat64(p + 52, true),
      cus: view.getFloat64(p + 76, true),
      sqrtA: view.getFloat64(p + 28, true),
      toe: toes,
      cic: view.getFloat64(p + 100, true),
      omega0: view.getFloat64(p + 132, true),
      cis: view.getFloat64(p + 108, true),
      i0: view.getFloat64(p + 116, true),
      crc: view.getFloat64(p + 84, true),
      omega: view.getFloat64(p + 60, true),
      omegaDot: view.getFloat64(p + 140, true),
      idot: view.getFloat64(p + 124, true),
      week: Math.floor((toeMs - GPS_EPOCH_MS) / MS_PER_WEEK),
      // RINEX Galileo SVH bit layout (E1B DVS/HS in bits 0-2, E5a in
      // 3-5, E5b in 6-8) — same packing as RTKLIB.
      svHealth:
        (svhE5b << 7) |
        (dvsE5b << 6) |
        (svhE5a << 4) |
        (dvsE5a << 3) |
        (svhE1b << 1) |
        dvsE1b,
      tgd: view.getFloat64(p + 204, true), // BGD E5a/E1 (RINEX slot)
    },
  };
}

/**
 * Decode BDSEPHEMERIS → BeiDou Keplerian ephemeris (RTKLIB
 * decode_bdsephemerisb). Weeks and epochs stay on the BDT scale, as in
 * a RINEX file (RTKLIB converts BDT→GPST internally only to convert
 * back on RINEX output). Angular fields are already radians.
 */
function decodeBdsEphemeris(view: DataView, p: number): KeplerEphemeris | null {
  const prn = view.getUint32(p, true);
  // Deliberate deviation from RTKLIB demo5, whose MAXPRNCMP=50 drops
  // the BDS-3 GEO/IGSO satellites C51-C63; RINEX 3.04+ carries them
  // and receivers do broadcast their B1I ephemerides.
  if (prn < 1 || prn > 63) return null;
  const week = view.getUint32(p + 4, true); // BDT week
  // p+8: URA (m, R8) — not part of the emitted record
  const health = view.getUint32(p + 16, true) & 1; // SatH1
  const tgd1 = view.getFloat64(p + 20, true);
  // p+28: TGD2 (B2), p+36: AODC — not stored (single-tgd record)
  const tocs = view.getUint32(p + 40, true); // BDT seconds of week
  const toes = view.getUint32(p + 72, true); // BDT seconds of week
  const tocDate = new Date(BDT_EPOCH_MS + week * MS_PER_WEEK + tocs * 1000);

  return {
    system: 'C',
    prn: `C${String(prn).padStart(2, '0')}`,
    toc: sowOf(tocDate.getTime()),
    tocDate,
    af0: view.getFloat64(p + 44, true),
    af1: view.getFloat64(p + 52, true),
    af2: view.getFloat64(p + 60, true),
    iode: view.getUint32(p + 68, true), // AODE
    crs: view.getFloat64(p + 172, true),
    deltaN: view.getFloat64(p + 100, true),
    m0: view.getFloat64(p + 108, true),
    cuc: view.getFloat64(p + 148, true),
    e: view.getFloat64(p + 84, true),
    cus: view.getFloat64(p + 156, true),
    sqrtA: view.getFloat64(p + 76, true),
    toe: toes,
    cic: view.getFloat64(p + 180, true),
    omega0: view.getFloat64(p + 116, true),
    cis: view.getFloat64(p + 188, true),
    i0: view.getFloat64(p + 132, true),
    crc: view.getFloat64(p + 164, true),
    omega: view.getFloat64(p + 92, true),
    omegaDot: view.getFloat64(p + 124, true),
    idot: view.getFloat64(p + 140, true),
    week, // RINEX BDS week field is the BDT week
    svHealth: health,
    tgd: tgd1, // TGD1 (B1) — RINEX slot
  };
}

/**
 * Decode GPSEPHEM / QZSSEPHEMERIS → Keplerian ephemeris. The two logs
 * share one layout (OEM7 manual §3.53 GPSEPHEM, §3.150 QZSSEPHEMERIS):
 * the semi-major axis arrives as A in metres (converted to sqrtA
 * here), toc/toe as doubles, and the week field is the full
 * rollover-corrected toe week. No RTKLIB reference exists for either
 * (RTKLIB decodes only the raw-subframe RAWEPHEM/QZSSRAWEPHEM logs).
 * GPSEPHEM is data-tested against same-day IGS BRDC records (the
 * broadcast ephemeris is identical worldwide, so every orbital and
 * clock field must match exactly); QZSSEPHEMERIS remains data-untested
 * — no public capture with that log was found (synthetic tests only).
 */
function decodeGpsQzssEphemeris(
  view: DataView,
  p: number,
  sys: 'G' | 'J'
): KeplerEphemeris | null {
  const prn = view.getUint32(p, true); // G: 1…32, J: 193…202
  if (sys === 'G' && (prn < 1 || prn > 32)) return null;
  if (sys === 'J' && (prn < 193 || prn > 202)) return null;
  // p+4: tow R8 (subframe-0 time stamp) — unused
  const health = view.getUint32(p + 12, true) & 0x3f; // 6-bit SIS health
  const iode1 = view.getUint32(p + 16, true);
  // p+20: IODE2, p+28: z-count week — unused (week below is the full
  // rollover-corrected toe week per the manual)
  const week = view.getUint32(p + 24, true);
  const toes = view.getFloat64(p + 32, true);
  const toeMs = gpsMs(week, toes);
  const tocs = view.getFloat64(p + 164, true);
  // toc shares the toe week; fold across a week boundary if needed.
  const tocDate = new Date(nearWeekMs(toeMs, tocs));

  return {
    system: sys,
    prn: `${sys}${String(sys === 'J' ? prn - 192 : prn).padStart(2, '0')}`,
    toc: sowOf(tocDate.getTime()),
    tocDate,
    af0: view.getFloat64(p + 180, true),
    af1: view.getFloat64(p + 188, true),
    af2: view.getFloat64(p + 196, true),
    iode: iode1,
    crs: view.getFloat64(p + 104, true),
    deltaN: view.getFloat64(p + 48, true),
    m0: view.getFloat64(p + 56, true),
    cuc: view.getFloat64(p + 80, true),
    e: view.getFloat64(p + 64, true),
    cus: view.getFloat64(p + 88, true),
    sqrtA: Math.sqrt(view.getFloat64(p + 40, true)),
    toe: toes,
    cic: view.getFloat64(p + 112, true),
    omega0: view.getFloat64(p + 144, true),
    cis: view.getFloat64(p + 120, true),
    i0: view.getFloat64(p + 128, true),
    crc: view.getFloat64(p + 96, true),
    omega: view.getFloat64(p + 72, true),
    omegaDot: view.getFloat64(p + 152, true),
    idot: view.getFloat64(p + 136, true),
    week,
    svHealth: health,
    tgd: view.getFloat64(p + 172, true),
  };
}

/**
 * Decode every navigation message (RAWEPHEM, GLOEPHEMERIS,
 * GALEPHEMERIS, BDSEPHEMERIS, QZSSEPHEMERIS, IONUTC) in a NovAtel
 * binary byte stream. Repeated broadcasts of an unchanged ephemeris
 * are suppressed the same way RTKLIB does: GPS/QZSS by issue of data,
 * Galileo by IODNav + toe + toc per data source, BeiDou by toe + toc,
 * GLONASS by reference time and health.
 */
export function parseNovatelNav(data: Uint8Array): NovatelNavResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stats = { badCrc: 0 };
  const ephemerides: Ephemeris[] = [];
  const ionoCorrections: Record<string, number[]> = {};
  let leapSeconds: number | null = null;
  const cnav: CnavEphemeris[] = [];
  const cnavAssembler = new CnavAssembler();
  let cnavBadCrc = 0;
  // Last Keplerian record per dedup key ("G07", "J01", "C11",
  // "E12:inav"/"E12:fnav" — Galileo dedups per data source, RTKLIB's
  // MAXSAT*set slots).
  const lastKep = new Map<string, KeplerEphemeris>();
  const lastGlo = new Map<string, GlonassEphemeris>();

  const pushKepler = (key: string, eph: KeplerEphemeris) => {
    const prev = lastKep.get(key);
    if (
      prev &&
      prev.iode === eph.iode &&
      prev.toe === eph.toe &&
      prev.tocDate.getTime() === eph.tocDate.getTime()
    ) {
      return; // unchanged issue of data
    }
    lastKep.set(key, eph);
    ephemerides.push(eph);
  };

  for (const frame of oem4Frames(data, view, stats)) {
    if (!frame.binary) continue;

    if (frame.id === ID_RAWEPHEM && frame.msgLen >= 102) {
      const eph = decodeRawEphem(data, view, frame.payload);
      if (eph) pushKepler(eph.prn, eph);
    } else if (frame.id === ID_GALEPHEMERIS && frame.msgLen >= 220) {
      if (frame.week === 0) continue; // header time unresolved
      const headerMs = gpsMs(frame.week, frame.towMs / 1000);
      const dec = decodeGalEphemeris(view, frame.payload, headerMs);
      if (dec)
        pushKepler(`${dec.eph.prn}:${dec.fnav ? 'fnav' : 'inav'}`, dec.eph);
    } else if (frame.id === ID_BDSEPHEMERIS && frame.msgLen >= 196) {
      const eph = decodeBdsEphemeris(view, frame.payload);
      // RTKLIB dedups BDS by toe + toc only (AODE can lag); iode is
      // still compared here — the pair changes together in practice
      // and convbin emits a record whenever toe/toc move.
      if (eph) pushKepler(eph.prn, eph);
    } else if (frame.id === ID_GPSEPHEM && frame.msgLen >= 204) {
      const eph = decodeGpsQzssEphemeris(view, frame.payload, 'G');
      // Some logs carry both RAWEPHEM and GPSEPHEM: the dedup key is
      // the PRN, so whichever repeats an unchanged IODE is suppressed.
      if (eph) pushKepler(eph.prn, eph);
    } else if (frame.id === ID_QZSSEPHEMERIS && frame.msgLen >= 204) {
      const eph = decodeGpsQzssEphemeris(view, frame.payload, 'J');
      if (eph) pushKepler(eph.prn, eph);
    } else if (frame.id === ID_RAWCNAVFRAME && frame.msgLen >= 50) {
      // OEM7 manual §3.165: signal channel u4, PRN u4, frame ID u4,
      // then the 300-bit CNAV message in 38 bytes. Same payload the
      // SBF/UBX paths carry — one shared assembler; the message's own
      // PRN field governs (QZSS frames fall outside its 1-32 range
      // and are ignored, like the SBF path).
      const msg = data.subarray(frame.payload + 12, frame.payload + 50);
      if (!cnavCrcOk(msg)) {
        cnavBadCrc++;
      } else {
        const eph = cnavAssembler.push(msg);
        if (eph) cnav.push(eph);
      }
    } else if (frame.id === ID_IONUTC && frame.msgLen >= 108) {
      const p = frame.payload;
      const alpha: number[] = [];
      const beta: number[] = [];
      for (let i = 0; i < 4; i++) {
        alpha.push(view.getFloat64(p + i * 8, true));
        beta.push(view.getFloat64(p + 32 + i * 8, true));
      }
      ionoCorrections['GPSA'] = alpha;
      ionoCorrections['GPSB'] = beta;
      leapSeconds = view.getInt32(p + 96, true); // Δt_LS
    } else if (frame.id === ID_GLOEPHEMERIS && frame.msgLen >= 144) {
      const eph = decodeGloEphemeris(view, frame.payload);
      if (!eph) continue;
      const prev = lastGlo.get(eph.prn);
      if (
        prev &&
        Math.abs(prev.tocDate.getTime() - eph.tocDate.getTime()) < 1000 &&
        prev.health === eph.health
      ) {
        continue; // unchanged ephemeris
      }
      lastGlo.set(eph.prn, eph);
      ephemerides.push(eph);
    } else if (
      (frame.id === ID_RAWSBASFRAME || frame.id === ID_RAWWAASFRAME) &&
      frame.msgLen >= 41
    ) {
      if (frame.week === 0) continue; // header time unresolved
      // §3.169: frame-decoder u4, PRN u4, a u4, then the 250-bit SBAS
      // message as 29 bytes (only enough for the MT9 fields, not its CRC).
      const p = frame.payload;
      const prn = view.getUint32(p + 4, true);
      const msg = new Uint8Array(32);
      msg.set(data.subarray(p + 12, p + 41));
      const eph = decodeSbasGeoNav(msg, prn, frame.week, frame.towMs / 1000);
      if (!eph) continue; // not a type-9 (GEO navigation) message
      const prev = lastGlo.get(eph.prn);
      if (
        prev &&
        Math.abs(prev.tocDate.getTime() - eph.tocDate.getTime()) < 1000 &&
        prev.health === eph.health
      ) {
        continue; // unchanged ephemeris
      }
      lastGlo.set(eph.prn, eph);
      ephemerides.push(eph);
    }
  }

  return {
    ephemerides,
    ionoCorrections,
    leapSeconds,
    cnav,
    cnavBadCrc,
    badCrc: stats.badCrc,
  };
}
