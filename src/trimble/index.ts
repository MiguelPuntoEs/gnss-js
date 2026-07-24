/**
 * Trimble RT27 raw-measurement decoding (RAWDATA 0x57, record type 27
 * "Real-time GNSS survey data", the multi-constellation successor to
 * the GPS-only RT17 record type 17).
 *
 * The stream framing and multi-page RAWDATA reassembly follow RTKLIB's
 * `src/rcv/rt17.c` (see `./frame`). The record-27 payload itself is NOT
 * decoded by RTKLIB (its `decode_rawdata` handles only record types 0
 * and 7); the block layout here is taken from Trimble's published ICD,
 * "Data record subtype 6: Real-time GNSS survey data (record type 27)"
 * (receiverhelp.trimble.com/oem-gnss), and was verified byte-for-byte
 * against a 60 s multi-GNSS capture from the TU Delft ALLOY mount
 * DLF100NLD1: carrier phase reconstructs pseudorange to |L|·λ ≈ P for
 * every signal and constellation, SNRs land in 30–48 dB-Hz, and the
 * geostationary SBAS Doppler is ≈ 0 Hz.
 *
 * Record 27 is a chain of length-prefixed blocks. The epoch header
 * carries the GPS week, receiver time (ms of week) and satellite count;
 * each satellite has a variable-length header (system, PRN, GLONASS
 * frequency channel, elevation/azimuth, flags) followed by one
 * measurement block per tracked signal. The first block of a satellite
 * carries a full pseudorange (U4, 2⁻⁷ m — 2⁻⁶ for SBAS/QZSS); later
 * blocks carry a signed 2-byte difference to it (2⁻⁸ m). Carrier phase
 * is a signed 6-byte field (2⁻¹⁵ cycles, negated for the RINEX sign
 * like RTKLIB's record-17 path); Doppler, when flagged, is a signed
 * 3-byte field (2⁻⁸ Hz). Output records mirror `parseNovatelRange`.
 *
 * An epoch that does not fit in one 15-page message overflows into a
 * following message that shares the same reply id and carries no epoch
 * header (pure satellite-block continuation); such messages are joined
 * onto the epoch by reply id. This reply-run joining is an extension of
 * RTKLIB's per-message model, driven by the DLF100 capture.
 */

import { RAWDATA, trimbleFrames } from './frame';

export { trimbleFrames } from './frame';
export type { TrimbleFrame } from './frame';
export { parseTrimbleNav } from './nav';
export type { TrimbleNavResult } from './nav';

export interface TrimbleMeasurement {
  /** RINEX PRN, e.g. "G04", "R11", "E12", "C21", "S27". */
  prn: string;
  /** RINEX band+attribute, e.g. "1C", "2W", "5Q". */
  code: string;
  /** Pseudorange (m), null when the range is not loaded. */
  pr: number | null;
  /** Carrier phase (cycles, RINEX sign), null when phase is not loaded. */
  cp: number | null;
  /** Instantaneous Doppler (Hz), null when absent. */
  doppler: number | null;
  /** C/N0 (dB-Hz). */
  cn0: number;
  /** Rolling cycle-slip counter (0–255). */
  cycleSlipCount: number;
  /** True when the measurement's cycle-slip flag is set. */
  cycleSlip: boolean;
  /** GLONASS frequency channel k (−7…+6), null for CDMA systems. */
  gloChannel: number | null;
}

export interface TrimbleEpoch {
  /** Epoch (GPS-scale ms — same convention as the RINEX parser). */
  timeMs: number;
  meas: TrimbleMeasurement[];
}

export interface TrimbleParseResult {
  epochs: TrimbleEpoch[];
  /** Observation codes seen per system letter, in first-seen order. */
  obsCodes: Record<string, string[]>;
  /** RAWDATA frame counts per record type, for diagnostics. */
  recordCounts: Record<number, number>;
  /** RETSVDATA frame counts per subtype, for diagnostics. */
  retsvCounts: Record<number, number>;
  /** Frames whose checksum failed (corruption indicator). */
  badChecksum: number;
}

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const MS_PER_WEEK = 7 * 86400_000;

const REC_TYPE_27 = 6; // RAWDATA data[0] for "Real-time GNSS survey data"

/** SV-type field (ANTENNA & SV TYPE, low 6 bits) → RINEX system letter. */
const SYS: Record<number, string> = {
  0: 'G', // GPS
  1: 'S', // SBAS
  2: 'R', // GLONASS
  3: 'E', // Galileo
  4: 'J', // QZSS
  5: 'C', // BeiDou (pre-ICD numbering)
  7: 'C', // BeiDou (ICD numbering)
  9: 'I', // NavIC / IRNSS
  10: 'C', // BeiDou
};

/**
 * (system, BLOCK TYPE band, TRACK TYPE) → RINEX observation code.
 * The frequency digit is fixed by the band and is verified against the
 * capture (|L|·λ ≈ P); the attribute letter for the modern signals
 * (GPS L1C/L2C/L5, Galileo, BeiDou B1C/B2) is a best-effort reading of
 * the ICD's partial TRACK TYPE table. Unlisted combinations fall back
 * to `<digit>X`.
 */
const CODES: Record<string, string> = {
  'G0-0': '1C',
  'G0-20': '1L',
  'G1-2': '2W',
  'G1-5': '2L',
  'G2-6': '5I',
  'G2-7': '5Q',
  'G2-8': '5X',
  'R0-0': '1C',
  'R0-1': '1P',
  'R1-0': '2C',
  'R1-1': '2P',
  'E0-23': '1C',
  'E2-11': '5Q',
  'E3-11': '7Q',
  'E4-14': '8Q',
  'E5-36': '6C',
  'C0-20': '1P',
  'C2-8': '5P',
  'C3-6': '7D',
  'C6-26': '2I',
  'C7-29': '6I',
  'S0-0': '1C',
  'S2-6': '5I',
  'J0-0': '1C',
};

/** BLOCK TYPE (frequency band) → RINEX band digit. */
const BAND_DIGIT: Record<number, string> = {
  0: '1', // L1 / E1 / B1C (1575.42)
  1: '2', // L2 / G2 (1227.6)
  2: '5', // L5 / E5a (1176.45)
  3: '7', // E5b / B2b (1207.14)
  4: '8', // E5 AltBOC (1191.795)
  5: '6', // E6 (1278.75)
  6: '2', // B1I (1561.098)
  7: '6', // B3I (1268.52)
  8: '1', // BeiDou E1 (1589.742)
  9: '3', // GLONASS G3 CDMA (1202.025)
  11: '9', // NavIC S-band (2492.028)
};

function rinexCode(sys: string, band: number, track: number): string {
  const key = `${sys}${band}-${track}`;
  return CODES[key] ?? `${BAND_DIGIT[band] ?? '?'}X`;
}

function rinexPrn(sys: string, svid: number): string {
  let n = svid;
  if (sys === 'S')
    n = svid - 100; // RINEX SBAS numbering
  else if (sys === 'J' && svid >= 193) n = svid - 192; // RINEX QZSS numbering
  return `${sys}${String(n).padStart(2, '0')}`;
}

/* Signed big-endian readers for the odd field widths RT27 uses. */
const readS16 = (dv: DataView, o: number) => dv.getInt16(o, false);
function readS24(d: Uint8Array, o: number): number {
  const v = (d[o]! << 16) | (d[o + 1]! << 8) | d[o + 2]!;
  return v & 0x800000 ? v - 0x1000000 : v;
}
function readS48(d: Uint8Array, dv: DataView, o: number): number {
  const hi = (d[o]! << 8) | d[o + 1]!;
  const lo = dv.getUint32(o + 2, false);
  const v = hi * 4294967296 + lo;
  return hi & 0x8000 ? v - 281474976710656 : v;
}

interface Epoch {
  reply: number;
  week: number;
  towMs: number;
  nsv: number;
  /** Concatenated satellite-block bytes (main SV region + companions). */
  chunks: Uint8Array[];
}

/**
 * Decode every RT27 (record type 27) measurement epoch in a Trimble
 * binary byte stream. RETSVDATA and unsupported RAWDATA record types
 * are counted and skipped. Navigation messages (ephemerides, ION/UTC)
 * are decoded separately by {@link parseTrimbleNav}.
 */
export function parseTrimble(data: Uint8Array): TrimbleParseResult {
  const stats = { badChecksum: 0 };
  const epochs: TrimbleEpoch[] = [];
  const obsCodes: Record<string, string[]> = {};
  const recordCounts: Record<number, number> = {};
  const retsvCounts: Record<number, number> = {};

  // In-progress multi-page RAWDATA message (RTKLIB input_rt17 model).
  let pages: Uint8Array[] = [];
  let msgReply = -1;
  let lastPage = 0;
  let msgPages = 0;
  // In-progress epoch (a reply-run of one main + zero or more companions).
  let epoch: Epoch | null = null;

  const finalize = () => {
    if (epoch) decodeEpoch(epoch, epochs, obsCodes);
    epoch = null;
  };

  const onMessage = (content: Uint8Array, reply: number) => {
    if (epoch && reply === epoch.reply) {
      // Companion message: pure satellite-block continuation.
      epoch.chunks.push(content);
      return;
    }
    finalize();
    // New epoch: parse the record-27 header.
    if (content.length < 12) return;
    const dv = new DataView(
      content.buffer,
      content.byteOffset,
      content.byteLength
    );
    const headerLen = content[0]!;
    const week = dv.getUint16(1, false);
    const towMs = dv.getUint32(3, false);
    const nsv = content[10]!;
    const eflags = content[11]!;
    if (week < 1024 || week > 4096 || headerLen < 12 || nsv === 0) return;
    // Satellite data starts after the epoch header. When the
    // Inter-System Clock Offset block is present (EPOCH FLAGS bit 5) it
    // sits between the header and the first satellite block.
    let svStart = headerLen;
    if (eflags & 0x20 && svStart < content.length) svStart += content[svStart]!;
    epoch = {
      reply,
      week,
      towMs,
      nsv,
      chunks: [content.subarray(svStart)],
    };
  };

  const completeMessage = () => {
    const total = pages.reduce((a, c) => a + c.length, 0);
    const content = new Uint8Array(total);
    let o = 0;
    for (const c of pages) {
      content.set(c, o);
      o += c.length;
    }
    const reply = msgReply;
    pages = [];
    onMessage(content, reply);
  };

  for (const f of trimbleFrames(data, stats)) {
    if (f.type !== RAWDATA) {
      if (f.type === 0x55) {
        const sub = data[f.payload]!;
        retsvCounts[sub] = (retsvCounts[sub] ?? 0) + 1;
      }
      continue;
    }
    const recType = data[f.payload]!;
    recordCounts[recType] = (recordCounts[recType] ?? 0) + 1;
    if (recType !== REC_TYPE_27) continue;

    const pageByte = data[f.payload + 1]!;
    const page = pageByte >> 4;
    const pagesTotal = pageByte & 0x0f;
    const reply = data[f.payload + 2]!;
    // Page content = data bytes after the 4-byte page frame
    // (record type, page, reply, interpretation flags).
    const content = data.subarray(f.payload + 4, f.payload + f.len);

    if (page === 1) {
      pages = [content];
      msgReply = reply;
      msgPages = pagesTotal;
      lastPage = 1;
    } else if (reply === msgReply && page === lastPage + 1) {
      pages.push(content);
      lastPage = page;
    } else {
      pages = []; // sequence break — drop the partial message
      continue;
    }
    if (lastPage === msgPages) completeMessage();
  }
  finalize();

  return {
    epochs,
    obsCodes,
    recordCounts,
    retsvCounts,
    badChecksum: stats.badChecksum,
  };
}

function decodeEpoch(
  epoch: Epoch,
  epochs: TrimbleEpoch[],
  obsCodes: Record<string, string[]>
): void {
  const total = epoch.chunks.reduce((a, c) => a + c.length, 0);
  const M = new Uint8Array(total);
  let o = 0;
  for (const c of epoch.chunks) {
    M.set(c, o);
    o += c.length;
  }
  const dv = new DataView(M.buffer, M.byteOffset, M.byteLength);
  const timeMs = GPS_EPOCH_MS + epoch.week * MS_PER_WEEK + epoch.towMs;
  const meas: TrimbleMeasurement[] = [];

  let q = 0;
  for (let sv = 0; sv < epoch.nsv && q + 8 <= M.length; sv++) {
    const svLen = M[q]!;
    if (svLen < 8 || q + svLen > M.length) break;
    const svid = M[q + 1]!;
    const sys = SYS[M[q + 2]! & 0x3f];
    const chan = (M[q + 3]! << 24) >> 24; // signed; GLONASS frequency channel
    const nblk = M[q + 4]!;
    const prn = sys ? rinexPrn(sys, svid) : null;
    const gloChannel = sys === 'R' ? chan : null;

    let r = q + svLen; // measurement blocks follow the SV header
    let pr0 = 0;
    for (let b = 0; b < nblk; b++) {
      if (r + 5 > M.length) break;
      const mLen = M[r]!;
      if (mLen < 5 || r + mLen > M.length) break;
      const band = M[r + 1]!;
      const track = M[r + 2]!;
      const cn0 = dv.getUint16(r + 3, false) / 10;
      let p = r + 5;

      let pr: number;
      if (b === 0) {
        const scale = sys === 'S' || sys === 'J' ? 64 : 128;
        pr = dv.getUint32(p, false) / scale;
        p += 4;
        pr0 = pr;
      } else {
        pr = pr0 + readS16(dv, p) / 256; // difference to the first block
        p += 2;
      }
      const cp = -readS48(M, dv, p) / 32768; // RINEX sign (RTKLIB negates)
      p += 6;
      const cycleSlipCount = M[p]!;
      p += 1;
      const mf = M[p]!;
      p += 1;
      let mf2 = 0;
      if (mf & 0x80) {
        mf2 = M[p]!;
        p += 1;
        let f = mf2;
        while (f & 0x80) {
          f = M[p]!;
          p += 1;
        }
      }
      if (mf2 & 0x01) p += 1; // range-difference overflow byte
      let doppler: number | null = null;
      if (mf & 0x04) doppler = readS24(M, p) / 256;

      if (prn && sys) {
        const code = rinexCode(sys, band, track);
        meas.push({
          prn,
          code,
          pr: mf & 0x02 ? pr : null,
          cp: mf & 0x01 ? cp : null,
          doppler: mf & 0x01 ? doppler : null,
          cn0,
          cycleSlipCount,
          cycleSlip: (mf & 0x08) !== 0,
          gloChannel,
        });
        const list = (obsCodes[sys] ??= []);
        if (!list.includes(code)) list.push(code);
      }
      r += mLen;
    }
    q = r;
  }

  epochs.push({ timeMs, meas });
}
