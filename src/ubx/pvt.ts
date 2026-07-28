/**
 * u-blox UBX-NAV-PVT (class 0x01, id 0x07) — the receiver's navigation
 * solution: position, fix type (incl. RTK float/fixed via carrier solution),
 * satellites used, and the horizontal/vertical accuracy estimate. The u-blox
 * analogue of Septentrio PVTGeodetic / NovAtel BESTPOS — a receiver-truth
 * reference for cross-checking an independent SPP/SBAS solution.
 */
import { ubxFrames } from './frame';
import type { ReceiverPvt } from '../receiver-pvt';

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);

export interface UbxPvtResult {
  records: ReceiverPvt[];
  messages: number;
}

/** Decode every UBX-NAV-PVT message in a u-blox byte stream. */
export function parseUbxPvt(data: Uint8Array): UbxPvtResult {
  const records: ReceiverPvt[] = [];
  let messages = 0;

  for (const f of ubxFrames(data)) {
    if (f.msgClass !== 0x01 || f.msgId !== 0x07 || f.payload.length < 92)
      continue;
    messages++;
    const v = new DataView(
      f.payload.buffer,
      f.payload.byteOffset,
      f.payload.byteLength
    );
    const iTow = v.getUint32(0, true); // GPS ms of week
    const year = v.getUint16(4, true);
    const month = v.getUint8(6);
    const day = v.getUint8(7);
    const hour = v.getUint8(8);
    const min = v.getUint8(9);
    const sec = v.getUint8(10);
    const fixType = v.getUint8(20);
    const flags = v.getUint8(21);
    const numSV = v.getUint8(23);
    const lon = v.getInt32(24, true) * 1e-7;
    const lat = v.getInt32(28, true) * 1e-7;
    const height = v.getInt32(32, true) / 1000; // mm → m (ellipsoidal)
    const hAcc = v.getUint32(40, true) / 1000; // mm → m
    const vAcc = v.getUint32(44, true) / 1000;

    const carrSoln = (flags >> 6) & 0x03;
    const diffSoln = (flags >> 1) & 0x01;
    const mode =
      carrSoln === 2
        ? 'rtk-fixed'
        : carrSoln === 1
          ? 'rtk-float'
          : diffSoln
            ? 'differential'
            : fixType >= 2
              ? 'standalone'
              : 'no-pvt';
    const hasFix = fixType >= 2;
    // Absolute time from the UTC date fields; tow is the GPS iTOW.
    const timeMs =
      year > 1980
        ? Date.UTC(year, month - 1, day, hour, min, sec)
        : GPS_EPOCH_MS + iTow;
    const week = Math.floor((timeMs - GPS_EPOCH_MS) / 1000 / 604800);
    records.push({
      timeMs,
      week,
      tow: iTow / 1000,
      mode,
      latDeg: hasFix ? lat : null,
      lonDeg: hasFix ? lon : null,
      heightM: hasFix ? height : null,
      nrSV: numSV,
      hAccuracyM: hasFix ? hAcc : null,
      vAccuracyM: hasFix ? vAcc : null,
    });
  }
  return { records, messages };
}
