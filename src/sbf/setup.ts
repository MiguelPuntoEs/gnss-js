/**
 * Septentrio SBF ReceiverSetup (5902) — station identity: marker,
 * receiver, antenna and the reference position. Broadcast every 60 s and
 * on any setup change; it's what a RINEX header's marker/receiver/antenna
 * and APPROX POSITION lines come from.
 *
 * Layout (AsteRx / mosaic reference guide §4.2, "ReceiverSetup"): after
 * the 8-byte SBF header, TOW u4 + WNc u2, Reserved u1[2], then fixed-width
 * zero-padded strings — MarkerName c1[60], MarkerNumber c1[20],
 * Observer c1[20], Agency c1[40], RxSerialNumber c1[20], RxName c1[20],
 * RxVersion c1[20], AntSerialNbr c1[20], AntType c1[20] — then deltaH/E/N
 * f4 (antenna offsets, m). Later block revisions append MarkerType c1[20]
 * (rev1), GNSSFWVersion c1[40] (rev2), ProductName c1[40] + the reference
 * position Latitude f8 / Longitude f8 (radians) / Height f4 (m, WGS84)
 * (rev3), and StationCode c1[10] … (rev4). Every trailing field is read
 * only when the block length covers it, so older revisions decode fine.
 */

import { geodeticToEcef } from '../coordinates/ecef';
import { scanSbfFrames } from './frame';

const F8_DNU = -2e10;
const F4_DNU = -2e10;

export interface SbfReceiverSetup {
  /** Marker (station) name. */
  markerName: string;
  markerNumber: string;
  observer: string;
  agency: string;
  /** Receiver serial number. */
  rxSerialNumber: string;
  /** Receiver GNSS engine name (e.g. "MOSAIC-X5"). */
  rxName: string;
  /** Receiver firmware version. */
  rxVersion: string;
  /** Main antenna serial number. */
  antSerialNumber: string;
  /** Main antenna type (IGS antenna name). */
  antType: string;
  /** Antenna offset from the marker, metres (H/E/N). */
  deltaH: number;
  deltaE: number;
  deltaN: number;
  /** Marker type (rev 1+), e.g. "GEODETIC". */
  markerType: string | null;
  /** GNSS firmware version string (rev 2+). */
  gnssFwVersion: string | null;
  /** Product name (rev 3+). */
  productName: string | null;
  /** Reference latitude, radians (rev 3+), or null if absent/do-not-use. */
  latitude: number | null;
  /** Reference longitude, radians (rev 3+), or null if absent/do-not-use. */
  longitude: number | null;
  /** Reference ellipsoidal height, metres WGS84 (rev 3+), or null. */
  height: number | null;
  /**
   * Reference position as ECEF metres `[x, y, z]` (from lat/lon/height),
   * or null when the block carries no valid reference position. Matches
   * the `StationMeta.position` convention.
   */
  position: [number, number, number] | null;
  /** Station code, e.g. the 4-char IGS code (rev 4+). */
  stationCode: string | null;
}

/** Read a fixed-width, zero-padded ASCII string field. */
function str(data: Uint8Array, off: number, n: number): string {
  let end = off;
  const stop = off + n;
  while (end < stop && data[end] !== 0) end++;
  let s = '';
  for (let i = off; i < end; i++) s += String.fromCharCode(data[i]!);
  return s.trim();
}

/**
 * Decode the ReceiverSetup (5902) block from an SBF byte stream. Returns
 * the LAST valid block (the most recent setup), or null when none is
 * present. Trailing revision fields are decoded only when the block is
 * long enough, so all block revisions are handled.
 */
export function parseSbfReceiverSetup(
  data: Uint8Array
): SbfReceiverSetup | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let out: SbfReceiverSetup | null = null;

  scanSbfFrames(data, view, (id, b, len) => {
    if (id !== 5902 || len < 256) return; // through AntType

    const setup: SbfReceiverSetup = {
      markerName: str(data, b + 16, 60),
      markerNumber: str(data, b + 76, 20),
      observer: str(data, b + 96, 20),
      agency: str(data, b + 116, 40),
      rxSerialNumber: str(data, b + 156, 20),
      rxName: str(data, b + 176, 20),
      rxVersion: str(data, b + 196, 20),
      antSerialNumber: str(data, b + 216, 20),
      antType: str(data, b + 236, 20),
      deltaH: len >= 268 ? view.getFloat32(b + 256, true) : 0,
      deltaE: len >= 268 ? view.getFloat32(b + 260, true) : 0,
      deltaN: len >= 268 ? view.getFloat32(b + 264, true) : 0,
      markerType: len >= 288 ? str(data, b + 268, 20) : null,
      gnssFwVersion: len >= 328 ? str(data, b + 288, 40) : null,
      productName: len >= 368 ? str(data, b + 328, 40) : null,
      latitude: null,
      longitude: null,
      height: null,
      position: null,
      stationCode: len >= 398 ? str(data, b + 388, 10) : null,
    };

    if (len >= 388) {
      const lat = view.getFloat64(b + 368, true);
      const lon = view.getFloat64(b + 376, true);
      const h = view.getFloat32(b + 384, true);
      if (lat !== F8_DNU && lon !== F8_DNU && h !== F4_DNU) {
        setup.latitude = lat;
        setup.longitude = lon;
        setup.height = h;
        setup.position = geodeticToEcef(lat, lon, h);
      }
    }

    out = setup;
  });

  return out;
}
