/**
 * u-blox UBX raw-measurement decoding (RXM-RAWX) — the path from a
 * receiver log to RINEX-grade observables.
 *
 * Framing: 0xB5 0x62, class, id, little-endian length, payload, and an
 * 8-bit Fletcher checksum over class..payload. RXM-RAWX (0x02 0x15)
 * carries the receiver time (GPS week + tow) and, per measurement,
 * pseudorange (m), carrier phase (cycles), Doppler (Hz), C/N0 and the
 * (gnssId, svId, sigId) triple that maps onto a RINEX observation code.
 *
 * The signal table follows the u-blox interface description, with the
 * RINEX attributes chosen to match RTKLIB's u-blox conversion (the de
 * facto reference: GPS L2 CL/CM as 2X, Galileo E1 as 1X, E5b as 7X).
 */

import { ubxFrames } from './frame';

export { ubxFrames } from './frame';
export type { UbxFrame } from './frame';
export { parseUbxNav } from './nav';
export type { UbxNavOptions, UbxNavResult } from './nav';

export interface UbxMeasurement {
  /** RINEX PRN, e.g. "G04", "R11", "S23". */
  prn: string;
  /** RINEX band+attribute, e.g. "1C", "2X", "7I". */
  code: string;
  /** Pseudorange (m), null when flagged invalid. */
  pr: number | null;
  /** Carrier phase (cycles), null when flagged invalid. */
  cp: number | null;
  /** Doppler (Hz). */
  doppler: number;
  /** C/N0 (dB-Hz). */
  cn0: number;
  /** Carrier phase may be off by half a cycle (trkStat bit 2). */
  halfCycleAmbiguous: boolean;
  /** Continuous-lock time (ms, saturates at 64500). */
  lockTimeMs: number;
}

export interface UbxRawxEpoch {
  /** Receiver epoch (GPS-scale ms — same convention as the RINEX parser). */
  timeMs: number;
  /** GPS leap seconds at this epoch, if the receiver knows them. */
  leapS: number | null;
  meas: UbxMeasurement[];
}

export interface UbxParseResult {
  epochs: UbxRawxEpoch[];
  /** Count per UBX (class, id), keyed "02-15" style, for diagnostics. */
  messageCounts: Record<string, number>;
  /** Observation codes seen per system letter, in first-seen order. */
  obsCodes: Record<string, string[]>;
  /** Frames whose checksum failed (corruption indicator). */
  badChecksums: number;
}

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const MS_PER_WEEK = 7 * 86400_000;

/* ── (gnssId, sigId) → [system letter, RINEX code] ─────────────── */
const SIGNALS: Record<number, Record<number, [string, string]>> = {
  0: { 0: ['G', '1C'], 3: ['G', '2X'], 4: ['G', '2X'] }, // GPS L1C/A, L2CL, L2CM
  1: { 0: ['S', '1C'] }, // SBAS L1C/A
  2: { 0: ['E', '1X'], 1: ['E', '1X'], 5: ['E', '7X'], 6: ['E', '7X'] }, // E1C/B, E5bI/Q
  3: { 0: ['C', '2I'], 1: ['C', '2I'], 2: ['C', '7I'], 3: ['C', '7I'] }, // B1I D1/D2, B2I D1/D2
  5: { 0: ['J', '1C'], 4: ['J', '2X'], 5: ['J', '2X'] }, // QZSS L1C/A, L2CM/CL
  6: { 0: ['R', '1C'], 2: ['R', '2C'] }, // GLONASS L1OF, L2OF
};

function prnFor(gnssId: number, svId: number): string | null {
  const two = (n: number) => String(n).padStart(2, '0');
  switch (gnssId) {
    case 0:
      return svId >= 1 && svId <= 32 ? `G${two(svId)}` : null;
    case 1:
      // SBAS svId is the full PRN (120-158); RINEX uses PRN-100
      return svId >= 120 && svId <= 158 ? `S${two(svId - 100)}` : null;
    case 2:
      return svId >= 1 && svId <= 36 ? `E${two(svId)}` : null;
    case 3:
      return svId >= 1 && svId <= 63 ? `C${two(svId)}` : null;
    case 5:
      return svId >= 1 && svId <= 10 ? `J${two(svId)}` : null;
    case 6:
      // svId 255 = GLONASS satellite with unknown slot number
      return svId >= 1 && svId <= 32 ? `R${two(svId)}` : null;
    default:
      return null;
  }
}

/**
 * Decode every valid RXM-RAWX message in a UBX byte stream. Non-RAWX
 * messages are counted and skipped; frames with bad checksums are
 * skipped and counted (a resync then continues at the next byte).
 */
export function parseUbxRawx(data: Uint8Array): UbxParseResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const epochs: UbxRawxEpoch[] = [];
  const messageCounts: Record<string, number> = {};
  const obsCodes: Record<string, string[]> = {};
  const stats = { badChecksums: 0 };

  for (const frame of ubxFrames(data, stats)) {
    const { msgClass: cls, msgId: id } = frame;
    const len = frame.payload.length;
    const key = `${cls.toString(16).padStart(2, '0')}-${id
      .toString(16)
      .padStart(2, '0')}`;
    messageCounts[key] = (messageCounts[key] ?? 0) + 1;

    if (cls === 0x02 && id === 0x15 && len >= 16) {
      const p = frame.payloadStart;
      const rcvTow = view.getFloat64(p, true); // s of GPS week
      const week = view.getUint16(p + 8, true);
      const leapS = view.getInt8(p + 10);
      const numMeas = data[p + 11]!;
      const recStat = data[p + 12]!;
      const leapValid = (recStat & 0x01) !== 0;

      const meas: UbxMeasurement[] = [];
      for (let k = 0; k < numMeas; k++) {
        const off = p + 16 + 32 * k;
        if (off + 32 > p + len) break;
        const gnssId = data[off + 20]!;
        const svId = data[off + 21]!;
        const sigId = data[off + 22]!;
        const trkStat = data[off + 30]!;

        const prn = prnFor(gnssId, svId);
        const sig = SIGNALS[gnssId]?.[sigId];
        if (!prn || !sig) continue;

        const prValid = (trkStat & 0x01) !== 0;
        const cpValid = (trkStat & 0x02) !== 0;
        const cp = view.getFloat64(off + 8, true);

        meas.push({
          prn,
          code: sig[1],
          pr: prValid ? view.getFloat64(off, true) : null,
          cp: cpValid && cp !== 0 ? cp : null,
          doppler: view.getFloat32(off + 16, true),
          cn0: data[off + 26]!,
          halfCycleAmbiguous: (trkStat & 0x04) !== 0,
          lockTimeMs: view.getUint16(off + 24, true),
        });
        const sys = sig[0];
        const codes = (obsCodes[sys] ??= []);
        if (!codes.includes(sig[1])) codes.push(sig[1]);
      }

      epochs.push({
        timeMs: GPS_EPOCH_MS + week * MS_PER_WEEK + Math.round(rcvTow * 1000),
        leapS: leapValid ? leapS : null,
        meas,
      });
    }
  }

  return { epochs, messageCounts, obsCodes, badChecksums: stats.badChecksums };
}
