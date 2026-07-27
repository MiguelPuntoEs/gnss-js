/**
 * SBAS L1 C/A GEO navigation message (DO-229 message type 9) decoder.
 *
 * An SBAS message is 250 bits: 8-bit preamble, 6-bit message type, 212-bit
 * data, 24-bit CRC-24Q. Message type 9 carries the GEO satellite's ECEF
 * state vector (position/velocity/acceleration) plus a clock offset/drift —
 * the SBAS analogue of a broadcast ephemeris. It maps onto the same
 * `GlonassEphemeris` shape used for GLONASS (a state vector propagated by
 * `glonassPosition`), tagged `system: 'S'`.
 *
 * Field offsets and scale factors follow DO-229 / RTKLIB `decode_sbstype9`
 * (rcv/sbas.c). This decoder is shared by every raw-frame source that can
 * carry an SBAS L1 message: u-blox RXM-SFRBX (gnssId 1) and Septentrio SBF
 * GEORawL1 (4020).
 */
import { getBitU, getBitS } from './index';
import { crc24q } from './cnav';
import type { GlonassEphemeris } from '../rinex/nav';

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const MS_PER_WEEK = 7 * 86400 * 1000;
const two = (n: number) => String(n).padStart(2, '0');

/** SBAS message type carrying the GEO navigation (ephemeris) message. */
export const SBAS_MT_GEO_NAV = 9;

/** Message type in bits 8..13 of an SBAS L1 message. */
export function sbasMessageType(msg: Uint8Array): number {
  return getBitU(msg, 8, 6);
}

/**
 * Verify the SBAS CRC-24Q. The 24-bit parity (bits 226..249) is computed
 * over the preceding 226 data bits (preamble + type + data). Requires the
 * full 250-bit message (≥ 32 bytes).
 */
export function sbasCrcOk(msg: Uint8Array): boolean {
  if (msg.length < 32) return false;
  return crc24q(msg, 226) === getBitU(msg, 226, 24);
}

/**
 * Decode an SBAS message type 9 (GEO navigation) into a GEO ephemeris.
 *
 * @param msg  the 250-bit SBAS L1 message, MSB-first (≥ 29 bytes for the
 *             fields; ≥ 32 bytes if `sbasCrcOk` is also wanted).
 * @param prn  SBAS PRN (120–158).
 * @param week reception GPS week.
 * @param tow  reception GPS time of week (seconds); used to resolve the
 *             13-bit time-of-day `t0` into a full seconds-of-week epoch.
 * @returns the GEO ephemeris, or `null` if the message is not type 9 or the
 *          PRN is out of range.
 */
export function decodeSbasGeoNav(
  msg: Uint8Array,
  prn: number,
  week: number,
  tow: number
): GlonassEphemeris | null {
  if (prn < 120 || prn > 158) return null;
  if (sbasMessageType(msg) !== SBAS_MT_GEO_NAV) return null;

  // t0 is a 13-bit time-of-day (×16 s); anchor it to the reception ToW,
  // resolving the day boundary the same way RTKLIB does.
  let t = getBitU(msg, 22, 13) * 16 - (tow % 86400);
  if (t <= -43200) t += 86400;
  else if (t > 43200) t -= 86400;
  const t0Sec = tow + t;

  const ura = getBitU(msg, 35, 4);
  // Position m→km, velocity m/s→km/s, acceleration m/s²→km/s² for the
  // GlonassEphemeris (km) convention.
  return {
    system: 'S',
    prn: `S${two(prn - 100)}`,
    tocDate: new Date(GPS_EPOCH_MS + week * MS_PER_WEEK + t0Sec * 1000),
    tauN: getBitS(msg, 206, 12) * 2 ** -31, // a_Gf0, clock offset (s)
    gammaN: (getBitS(msg, 218, 8) * 2 ** -39) / 2, // a_Gf1, clock drift (s/s)
    messageFrameTime: ((tow % 86400) + 86400) % 86400,
    x: (getBitS(msg, 39, 30) * 0.08) / 1000,
    y: (getBitS(msg, 69, 30) * 0.08) / 1000,
    z: (getBitS(msg, 99, 25) * 0.4) / 1000,
    xDot: (getBitS(msg, 124, 17) * 0.000625) / 1000,
    yDot: (getBitS(msg, 141, 17) * 0.000625) / 1000,
    zDot: (getBitS(msg, 158, 18) * 0.004) / 1000,
    xAcc: (getBitS(msg, 176, 10) * 0.0000125) / 1000,
    yAcc: (getBitS(msg, 186, 10) * 0.0000125) / 1000,
    zAcc: (getBitS(msg, 196, 10) * 0.0000625) / 1000,
    health: ura === 15 ? 1 : 0,
    freqNum: 0,
  };
}
