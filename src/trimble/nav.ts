/**
 * Trimble RT17/RT27 navigation-message decoding: RETSVDATA (0x55)
 * GPS ephemeris (subtype 1), BeiDou ephemeris (subtype 21) and ION / UTC
 * data (subtype 3).
 *
 * The GPS path is ported field-for-field from RTKLIB's `src/rcv/rt17.c`
 * (`decode_gps_ephemeris` / `decode_ion_utc_data`, tomojitakasu/RTKLIB,
 * Copyright (C) 2014 D. A. Cook / T. Takasu, BSD-2-Clause). All scalar
 * fields are big-endian; the semicircle angular/harmonic fields are
 * scaled by π to radians, exactly as RTKLIB does. BeiDou (subtype 21)
 * reuses the identical 176-byte Keplerian struct — established from a
 * real DLF100NLD1 capture (√a ≈ 5282.6 m^½ ⇒ BeiDou MEO, i₀ ≈ 55°) — with
 * the GPS→BDT time-scale conversion (week − 1356, SOW − 14 s) applied so
 * the record matches `parseSbfNav`'s BDSNav output.
 *
 * Output records mirror what `parseNavFile` produces for the equivalent
 * RINEX 3 navigation record and match the NovAtel/SBF ephemeris paths
 * (GPS: GPS-scale `tocDate`; BeiDou: naive-BDT `tocDate`; angles in rad).
 *
 * Still not decoded: the GLONASS/Galileo/QZSS ephemeris and almanac
 * subtypes (RETSVDATA 9/11/13/23/27 on this stream).
 */

import type { Ephemeris, KeplerEphemeris } from '../rinex/nav';
import { RETSVDATA, trimbleFrames } from './frame';

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
// BDT calendar epoch (Jan 1 2006), naive — RINEX BDS nav records print BDT
// calendar dates and parseNavFile keeps them as-is (matches sbf/nav.ts).
const BDT_EPOCH_MS = Date.UTC(2006, 0, 1);
const SEC_PER_WEEK = 7 * 86400;
const MS_PER_WEEK = SEC_PER_WEEK * 1000;
const GPS_PI = 3.1415926535898; // RTKLIB SC2RAD
// BeiDou runs on GPS week − 1356 and BDT = GPST − 14 s. Trimble stamps its
// RETSVDATA BeiDou records on the GPS time scale (week 2429, SOW 126014 =
// a clean 126000 BDT boundary + 14 s), so convert to the BDT scale RINEX uses.
const BDS_WEEK_OFFSET = 1356;
const BDS_LEAP_SEC = 14;

const gpsMs = (week: number, sec: number) =>
  GPS_EPOCH_MS + week * MS_PER_WEEK + sec * 1000;
const sowOf = (dateMs: number) => (dateMs / 1000) % SEC_PER_WEEK;

const SUB_GPS_EPHEMERIS = 1;
const SUB_ION_UTC = 3;
const SUB_BDS_EPHEMERIS = 21;

/**
 * The raw Keplerian fields shared by the GPS (subtype 1) and BeiDou
 * (subtype 21) RETSVDATA records — identical 176-byte struct, big-endian,
 * angular/harmonic fields in semicircles (×π to radians). `base` is the
 * STX offset so the ICD byte offsets apply directly. System-specific
 * epoch/health handling is applied by the callers.
 */
interface RawKepler {
  svid: number;
  week: number;
  iode: number;
  tocSec: number;
  toeSec: number;
  tgd: number;
  af0: number;
  af1: number;
  af2: number;
  crs: number;
  deltaN: number;
  m0: number;
  cuc: number;
  e: number;
  cus: number;
  sqrtA: number;
  cic: number;
  omega0: number;
  cis: number;
  i0: number;
  crc: number;
  omega: number;
  omegaDot: number;
  idot: number;
  flags: number;
}

function readKepler(view: DataView, base: number): RawKepler {
  return {
    svid: view.getUint8(base + 5),
    week: view.getUint16(base + 6, false),
    iode: view.getUint8(base + 11),
    tocSec: view.getInt32(base + 16, false),
    toeSec: view.getUint32(base + 20, false),
    tgd: view.getFloat64(base + 24, false),
    af2: view.getFloat64(base + 32, false),
    af1: view.getFloat64(base + 40, false),
    af0: view.getFloat64(base + 48, false),
    crs: view.getFloat64(base + 56, false),
    deltaN: view.getFloat64(base + 64, false) * GPS_PI,
    m0: view.getFloat64(base + 72, false) * GPS_PI,
    cuc: view.getFloat64(base + 80, false) * GPS_PI,
    e: view.getFloat64(base + 88, false),
    cus: view.getFloat64(base + 96, false) * GPS_PI,
    sqrtA: view.getFloat64(base + 104, false),
    cic: view.getFloat64(base + 112, false) * GPS_PI,
    omega0: view.getFloat64(base + 120, false) * GPS_PI,
    cis: view.getFloat64(base + 128, false) * GPS_PI,
    i0: view.getFloat64(base + 136, false) * GPS_PI,
    crc: view.getFloat64(base + 144, false),
    omega: view.getFloat64(base + 152, false) * GPS_PI,
    omegaDot: view.getFloat64(base + 160, false) * GPS_PI,
    idot: view.getFloat64(base + 168, false) * GPS_PI,
    flags: view.getUint32(base + 176, false),
  };
}

export interface TrimbleNavResult {
  /** Broadcast ephemerides in stream order, duplicates suppressed. */
  ephemerides: Ephemeris[];
  /**
   * Klobuchar coefficients from ION/UTC in the RINEX-header shape
   * (`GPSA` = alpha0..3, `GPSB` = beta0..3), last message wins.
   */
  ionoCorrections: Record<string, number[]>;
  /** GPS−UTC leap seconds (Δt_LS) from ION/UTC, null when unseen. */
  leapSeconds: number | null;
  /** RETSVDATA frame counts per subtype, for diagnostics. */
  retsvCounts: Record<number, number>;
  /** Frames whose checksum failed (corruption indicator). */
  badChecksum: number;
}

/** The orbit/clock fields common to every constellation (units matching
 *  KeplerEphemeris), given the shared raw record. */
function keplerCommon(r: RawKepler) {
  return {
    af0: r.af0,
    af1: r.af1,
    af2: r.af2,
    iode: r.iode,
    crs: r.crs,
    deltaN: r.deltaN,
    m0: r.m0,
    cuc: r.cuc,
    e: r.e,
    cus: r.cus,
    sqrtA: r.sqrtA,
    cic: r.cic,
    omega0: r.omega0,
    cis: r.cis,
    i0: r.i0,
    crc: r.crc,
    omega: r.omega,
    omegaDot: r.omegaDot,
    idot: r.idot,
    tgd: r.tgd,
  };
}

/**
 * Decode a RETSVDATA GPS ephemeris (subtype 1). `base` is the STX offset,
 * so the ICD byte offsets (relative to STX) apply directly.
 */
function decodeGpsEphemeris(
  view: DataView,
  base: number
): KeplerEphemeris | null {
  const r = readKepler(view, base);
  if (r.svid < 1 || r.svid > 32) return null;
  const tocMs = gpsMs(r.week, r.tocSec);
  return {
    system: 'G',
    prn: `G${String(r.svid).padStart(2, '0')}`,
    toc: sowOf(tocMs),
    tocDate: new Date(tocMs),
    toe: r.toeSec,
    week: r.week,
    svHealth: (r.flags >>> 4) & 0x7f,
    ...keplerCommon(r),
  };
}

/**
 * Decode a RETSVDATA BeiDou ephemeris (subtype 21). Same 176-byte
 * Keplerian struct as GPS, but stamped on the GPS time scale; convert to
 * the BDT scale RINEX uses (week − 1356, SOW − 14 s, BDT-epoch tocDate)
 * so it matches `parseSbfNav`'s BDSNav records.
 */
function decodeBdsEphemeris(
  view: DataView,
  base: number
): KeplerEphemeris | null {
  const r = readKepler(view, base);
  if (r.svid < 1 || r.svid > 63) return null;
  const bdsWeek = r.week - BDS_WEEK_OFFSET;
  const tocSec = r.tocSec - BDS_LEAP_SEC; // GPST SOW → BDT SOW
  const toeSec = r.toeSec - BDS_LEAP_SEC;
  const tocDate = new Date(
    BDT_EPOCH_MS + bdsWeek * MS_PER_WEEK + tocSec * 1000
  );
  return {
    system: 'C',
    prn: `C${String(r.svid).padStart(2, '0')}`,
    toc: sowOf(tocDate.getTime()),
    tocDate,
    toe: toeSec,
    week: bdsWeek,
    // Health from the same flags nibble as GPS (0 = healthy for the observed
    // operational BeiDou sats); flags bit 0 is a set-on-all format marker,
    // not SatH1, so it must not be used here.
    svHealth: (r.flags >>> 4) & 0x7f,
    ...keplerCommon(r),
  };
}

/**
 * Decode every RETSVDATA navigation message (GPS ephemeris, ION/UTC) in
 * a Trimble binary byte stream. Repeated broadcasts of an unchanged GPS
 * ephemeris are suppressed by issue of data (IODE), as RTKLIB does.
 */
export function parseTrimbleNav(data: Uint8Array): TrimbleNavResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stats = { badChecksum: 0 };
  const ephemerides: Ephemeris[] = [];
  const ionoCorrections: Record<string, number[]> = {};
  const retsvCounts: Record<number, number> = {};
  let leapSeconds: number | null = null;
  const lastIode = new Map<string, number>();

  for (const f of trimbleFrames(data, stats)) {
    if (f.type !== RETSVDATA) continue;
    const sub = data[f.payload]!;
    retsvCounts[sub] = (retsvCounts[sub] ?? 0) + 1;

    if (
      (sub === SUB_GPS_EPHEMERIS || sub === SUB_BDS_EPHEMERIS) &&
      f.len >= 176
    ) {
      const eph =
        sub === SUB_GPS_EPHEMERIS
          ? decodeGpsEphemeris(view, f.start)
          : decodeBdsEphemeris(view, f.start);
      if (!eph) continue;
      if (lastIode.get(eph.prn) === eph.iode) continue; // unchanged
      lastIode.set(eph.prn, eph.iode);
      ephemerides.push(eph);
    } else if (sub === SUB_ION_UTC && f.len >= 102) {
      const p = f.start;
      const alpha: number[] = [];
      const beta: number[] = [];
      for (let i = 0; i < 4; i++) {
        alpha.push(view.getFloat64(p + 6 + i * 8, false));
        beta.push(view.getFloat64(p + 38 + i * 8, false));
      }
      ionoCorrections['GPSA'] = alpha;
      ionoCorrections['GPSB'] = beta;
      leapSeconds = Math.trunc(view.getFloat64(p + 94, false)); // Δt_LS
    }
  }

  return {
    ephemerides,
    ionoCorrections,
    leapSeconds,
    retsvCounts,
    badChecksum: stats.badChecksum,
  };
}
