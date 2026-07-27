/**
 * Trimble RT17/RT27 navigation-message decoding: RETSVDATA (0x55)
 * GPS ephemeris (subtype 1) and ION / UTC data (subtype 3).
 *
 * Ported field-for-field from RTKLIB's `src/rcv/rt17.c`
 * (`decode_gps_ephemeris` / `decode_ion_utc_data`, tomojitakasu/RTKLIB,
 * Copyright (C) 2014 D. A. Cook / T. Takasu, BSD-2-Clause). All scalar
 * fields are big-endian; the semicircle angular/harmonic fields are
 * scaled by π to radians, exactly as RTKLIB does.
 *
 * Output records mirror what `parseNavFile` produces for the equivalent
 * RINEX 3 GPS navigation record and match the NovAtel/SBF ephemeris
 * paths (Keplerian `tocDate` a GPS-scale Date, angles in radians).
 *
 * RTKLIB decodes only these two RETSVDATA subtypes; the GLONASS,
 * Galileo, BeiDou and QZSS ephemeris/almanac subtypes (RETSVDATA
 * subtypes 9/11/13/21/23/27, seen on the DLF100NLD1 Trimble stream) are
 * not handled here. Validated against a real DLF100NLD1 capture: the
 * subtype-1 GPS ephemerides decode to physical Keplerian elements
 * (√a ≈ 5153.6 m^½, i₀ ≈ 55°, week 2429).
 */

import type { Ephemeris, KeplerEphemeris } from '../rinex/nav';
import { RETSVDATA, trimbleFrames } from './frame';

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const SEC_PER_WEEK = 7 * 86400;
const MS_PER_WEEK = SEC_PER_WEEK * 1000;
const GPS_PI = 3.1415926535898; // RTKLIB SC2RAD

const gpsMs = (week: number, sec: number) =>
  GPS_EPOCH_MS + week * MS_PER_WEEK + sec * 1000;
const sowOf = (dateMs: number) => (dateMs / 1000) % SEC_PER_WEEK;

const SUB_GPS_EPHEMERIS = 1;
const SUB_ION_UTC = 3;

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

/**
 * Decode a RETSVDATA GPS ephemeris (subtype 1). `base` is the STX
 * offset, so the ICD byte offsets (relative to STX) apply directly.
 */
function decodeGpsEphemeris(
  data: Uint8Array,
  view: DataView,
  base: number
): KeplerEphemeris | null {
  const prn = data[base + 5]!;
  if (prn < 1 || prn > 32) return null;

  const week = view.getUint16(base + 6, false);
  // base+8: IODC (U2), base+11: IODE (U1)
  const iode = data[base + 11]!;
  // base+12: TOW (transmission time) — not part of the RINEX record.
  const toc = view.getInt32(base + 16, false);
  const toe = view.getUint32(base + 20, false);
  const tgd = view.getFloat64(base + 24, false);
  const af2 = view.getFloat64(base + 32, false);
  const af1 = view.getFloat64(base + 40, false);
  const af0 = view.getFloat64(base + 48, false);
  const crs = view.getFloat64(base + 56, false);
  const deltaN = view.getFloat64(base + 64, false) * GPS_PI;
  const m0 = view.getFloat64(base + 72, false) * GPS_PI;
  const cuc = view.getFloat64(base + 80, false) * GPS_PI;
  const e = view.getFloat64(base + 88, false);
  const cus = view.getFloat64(base + 96, false) * GPS_PI;
  const sqrtA = view.getFloat64(base + 104, false);
  const cic = view.getFloat64(base + 112, false) * GPS_PI;
  const omega0 = view.getFloat64(base + 120, false) * GPS_PI;
  const cis = view.getFloat64(base + 128, false) * GPS_PI;
  const i0 = view.getFloat64(base + 136, false) * GPS_PI;
  const crc = view.getFloat64(base + 144, false);
  const omega = view.getFloat64(base + 152, false) * GPS_PI;
  const omegaDot = view.getFloat64(base + 160, false) * GPS_PI;
  const idot = view.getFloat64(base + 168, false) * GPS_PI;
  const flags = view.getUint32(base + 176, false);

  return {
    system: 'G',
    prn: `G${String(prn).padStart(2, '0')}`,
    toc: sowOf(gpsMs(week, toc)),
    tocDate: new Date(gpsMs(week, toc)),
    af0,
    af1,
    af2,
    iode,
    crs,
    deltaN,
    m0,
    cuc,
    e,
    cus,
    sqrtA,
    toe,
    cic,
    omega0,
    cis,
    i0,
    crc,
    omega,
    omegaDot,
    idot,
    week,
    svHealth: (flags >>> 4) & 0x7f,
    tgd,
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

    if (sub === SUB_GPS_EPHEMERIS && f.len >= 176) {
      const eph = decodeGpsEphemeris(data, view, f.start);
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
