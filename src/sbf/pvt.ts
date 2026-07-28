/**
 * Septentrio SBF PVTGeodetic (block 4007) — the receiver's own computed
 * position/velocity/time, with its solution mode and accuracy estimate. This
 * is the receiver's ground-truth output: useful as an oracle to cross-check an
 * independent SPP/SBAS solution against (position, and the 2-σ horizontal /
 * vertical accuracy), and to know whether the receiver itself is running in
 * SBAS-aided mode.
 *
 * Field offsets follow the SBF Reference Guide PVTGeodetic v2 layout (offsets
 * from the block start, i.e. the `$@` sync). Do-Not-Use sentinels are mapped
 * to null.
 */
import { scanSbfFrames } from './frame';
import type { ReceiverPvt } from '../receiver-pvt';

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const RAD2DEG = 180 / Math.PI;
const DNU_F8 = -2e10; // SBF "do not use" for f8 fields

/** PVT solution mode (low 4 bits of the Mode field). */
const MODE_LABELS: Record<number, string> = {
  0: 'no-pvt',
  1: 'standalone',
  2: 'differential',
  3: 'fixed-location',
  4: 'rtk-fixed',
  5: 'rtk-float',
  6: 'sbas-aided',
  7: 'moving-base-rtk-fixed',
  8: 'moving-base-rtk-float',
  10: 'ppp',
};

export interface SbfPvt extends ReceiverPvt {
  /** PVT solution type (Mode & 0x0F) — the raw Septentrio code. */
  modeType: number;
}

export interface SbfPvtResult {
  records: SbfPvt[];
  /** PVTGeodetic blocks seen (with valid framing). */
  messages: number;
}

/** Decode every PVTGeodetic (4007) block in an SBF byte stream. */
export function parseSbfPvt(data: Uint8Array): SbfPvtResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const records: SbfPvt[] = [];
  let messages = 0;

  scanSbfFrames(data, view, (id, b, len) => {
    if (id !== 4007 || len < 96) return;
    messages++;
    const tow = view.getUint32(b + 8, true); // ms of week
    const wnc = view.getUint16(b + 12, true);
    if (tow === 0xffffffff || wnc === 0xffff) return; // no time
    const modeByte = view.getUint8(b + 14);
    const modeType = modeByte & 0x0f;
    const lat = view.getFloat64(b + 16, true);
    const lon = view.getFloat64(b + 24, true);
    const hgt = view.getFloat64(b + 32, true);
    const nrSV = view.getUint8(b + 74);
    const hAcc = view.getUint16(b + 90, true);
    const vAcc = view.getUint16(b + 92, true);
    const hasFix = lat > DNU_F8 && lon > DNU_F8 && hgt > DNU_F8;
    records.push({
      timeMs: GPS_EPOCH_MS + wnc * 604800000 + tow,
      week: wnc,
      tow: tow / 1000,
      modeType,
      mode: MODE_LABELS[modeType] ?? `mode-${modeType}`,
      latDeg: hasFix ? lat * RAD2DEG : null,
      lonDeg: hasFix ? lon * RAD2DEG : null,
      heightM: hasFix ? hgt : null,
      nrSV: nrSV === 255 ? null : nrSV,
      hAccuracyM: hAcc === 0xffff ? null : hAcc / 100,
      vAccuracyM: vAcc === 0xffff ? null : vAcc / 100,
    });
  });

  return { records, messages };
}
