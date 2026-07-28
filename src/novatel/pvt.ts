/**
 * NovAtel BESTPOS (message 42) — the receiver's best position solution:
 * latitude/longitude/height, solution type (incl. WAAS/SBAS, RTK float/fixed,
 * PPP), satellites used, and per-axis standard deviations. The NovAtel
 * analogue of Septentrio PVTGeodetic / u-blox NAV-PVT — a receiver-truth
 * reference for cross-checking an independent SPP/SBAS solution.
 */
import { oem4Frames } from './frame';
import type { ReceiverPvt } from '../receiver-pvt';

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const BESTPOS = 42;

/** NovAtel BESTPOS position-type code → normalised solution mode. */
function posTypeToMode(t: number): string {
  if (t === 0) return 'no-pvt';
  if (t === 16) return 'standalone';
  if (t === 17) return 'differential';
  if (t === 18 || t === 20) return 'sbas-aided'; // WAAS / OmniSTAR VBS
  if (t === 32 || t === 33 || t === 34) return 'rtk-float';
  if (t === 48 || t === 50) return 'rtk-fixed';
  if (t >= 68 && t <= 78) return 'ppp';
  return `mode-${t}`;
}

export interface NovatelPvtResult {
  records: ReceiverPvt[];
  messages: number;
}

/** Decode every BESTPOS (binary) message in a NovAtel OEM4/7 byte stream. */
export function parseNovatelPvt(data: Uint8Array): NovatelPvtResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const records: ReceiverPvt[] = [];
  let messages = 0;
  const stats = { badCrc: 0 };

  for (const f of oem4Frames(data, view, stats)) {
    if (f.id !== BESTPOS || !f.binary || f.msgLen < 72) continue;
    messages++;
    const p = f.payload;
    const posType = view.getUint32(p + 4, true);
    const lat = view.getFloat64(p + 8, true);
    const lon = view.getFloat64(p + 16, true);
    const hgtMsl = view.getFloat64(p + 24, true);
    const undulation = view.getFloat32(p + 32, true);
    const latSig = view.getFloat32(p + 40, true);
    const lonSig = view.getFloat32(p + 44, true);
    const hgtSig = view.getFloat32(p + 48, true);
    const nrSV = view.getUint8(p + 65); // #SVs in solution
    const hasFix =
      posType !== 0 && Number.isFinite(lat) && Number.isFinite(lon);
    records.push({
      timeMs: GPS_EPOCH_MS + f.week * 604800000 + f.towMs,
      week: f.week,
      tow: f.towMs / 1000,
      mode: posTypeToMode(posType),
      latDeg: hasFix ? lat : null,
      lonDeg: hasFix ? lon : null,
      // BESTPOS height is above MSL; ellipsoidal = MSL + geoid undulation.
      heightM: hasFix ? hgtMsl + undulation : null,
      nrSV,
      hAccuracyM: hasFix ? Math.hypot(latSig, lonSig) : null,
      vAccuracyM: hasFix ? hgtSig : null,
    });
  }
  return { records, messages };
}
