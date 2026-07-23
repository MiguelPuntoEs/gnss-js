/**
 * NovAtel navigation-message decoding: RAWEPHEM (message 41, raw GPS
 * LNAV subframes 1–3) and GLOEPHEMERIS (message 723, decoded GLONASS
 * L1 C/A ephemeris).
 *
 * Ported from RTKLIB demo5 (rtklibexplorer fork, src/rcv/novatel.c:
 * decode_rawephemb / decode_gloephemerisb, Copyright (c) 2007-2020
 * T. Takasu, BSD-2-Clause) and cross-checked against the OEM7
 * Commands and Logs Reference Manual. Output records mirror what
 * `parseNavFile` produces for the equivalent RINEX 3 navigation file:
 * GPS `tocDate` is a GPS-scale Date, GLONASS `tocDate` is the UTC
 * epoch, GLONASS state vectors are in km (PZ-90), the RINEX clock bias
 * is −τ_n, and `messageFrameTime` is the frame time as seconds of the
 * UTC week.
 */

import { decodeGpsLnavFrame } from '../navbits';
import type {
  Ephemeris,
  GlonassEphemeris,
  KeplerEphemeris,
} from '../rinex/nav';
import { getUtcDate } from '../time/utc';
import { oem4Frames } from './frame';

const ID_RAWEPHEM = 41;
const ID_GLOEPHEMERIS = 723;

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const SEC_PER_WEEK = 7 * 86400;
const SEC_PER_DAY = 86400;

export interface NovatelNavResult {
  /** Broadcast ephemerides in stream order, duplicates suppressed. */
  ephemerides: Ephemeris[];
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
 * Decode every navigation message (RAWEPHEM, GLOEPHEMERIS) in a
 * NovAtel binary byte stream. Repeated broadcasts of an unchanged
 * ephemeris are suppressed the same way RTKLIB does: GPS by issue of
 * data, GLONASS by reference time and health.
 */
export function parseNovatelNav(data: Uint8Array): NovatelNavResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stats = { badCrc: 0 };
  const ephemerides: Ephemeris[] = [];
  const lastGps = new Map<string, KeplerEphemeris>();
  const lastGlo = new Map<string, GlonassEphemeris>();

  for (const frame of oem4Frames(data, view, stats)) {
    if (!frame.binary) continue;

    if (frame.id === ID_RAWEPHEM && frame.msgLen >= 102) {
      const eph = decodeRawEphem(data, view, frame.payload);
      if (!eph) continue;
      const prev = lastGps.get(eph.prn);
      if (
        prev &&
        prev.iode === eph.iode &&
        prev.tocDate.getTime() === eph.tocDate.getTime()
      ) {
        continue; // unchanged issue of data
      }
      lastGps.set(eph.prn, eph);
      ephemerides.push(eph);
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
    }
  }

  return { ephemerides, badCrc: stats.badCrc };
}
