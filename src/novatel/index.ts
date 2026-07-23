/**
 * NovAtel OEM4/6/7 raw-measurement decoding (RANGE log, message 43).
 *
 * Framing: 0xAA 0x44 0x12, a 28-byte binary header (message ID,
 * GPS week + milliseconds), payload, and a reflected CRC-32
 * (poly 0xEDB88320) over the whole frame. Each RANGE observation is a
 * 44-byte record whose channel-tracking-status word carries the
 * constellation and signal type.
 *
 * Field layout and signal tables ported from RTKLIB demo5
 * (rtklibexplorer fork, src/rcv/novatel.c, BSD-2-Clause) and
 * cross-checked against the OEM7 Commands and Logs Reference Manual.
 * Notably: RINEX carrier phase is the NEGATED accumulated Doppler
 * range (L = −adr), GLONASS PRNs are offset by 37, GLONASS phases
 * without known parity are dropped, and code/phase are individually
 * gated by their lock flags.
 */

export interface NovatelMeasurement {
  /** RINEX PRN, e.g. "G04", "R11", "S23", "J01". */
  prn: string;
  /** RINEX band+attribute, e.g. "1C", "2W", "5Q". */
  code: string;
  /** Pseudorange (m), null when the code is unlocked. */
  pr: number | null;
  /** Carrier phase (cycles, RINEX sign), null when phase is unlocked. */
  cp: number | null;
  /** Instantaneous Doppler (Hz), null when phase is unlocked. */
  doppler: number | null;
  /** C/N0 (dB-Hz). */
  cn0: number;
  /** Continuous lock time (s). */
  lockTimeS: number;
  /** GLONASS frequency channel k (freqId − 8), null for CDMA systems. */
  gloChannel: number | null;
}

export interface NovatelEpoch {
  /** Epoch (GPS-scale ms — same convention as the RINEX parser). */
  timeMs: number;
  meas: NovatelMeasurement[];
}

export interface NovatelParseResult {
  epochs: NovatelEpoch[];
  /** Count per message ID, for diagnostics. */
  messageCounts: Record<number, number>;
  /** Observation codes seen per system letter, in first-seen order. */
  obsCodes: Record<string, string[]>;
  /** Frames whose CRC failed (corruption indicator). */
  badCrc: number;
}

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const MS_PER_WEEK = 7 * 86400_000;
const HDR = 28;
const ID_RANGE = 43;
const ID_RANGECMP = 140;
const ID_GLOEPHEMERIS = 723;
const C_LIGHT = 299792458.0;
const ADR_ROLL = 8388608.0; // 2^23 — RANGECMP accumulated-Doppler rollover

/** Carrier frequency (Hz) for phase reconstruction in RANGECMP. */
function carrierFreq(sys: string, code: string, gloK: number | null): number {
  const band = code[0]!;
  switch (sys) {
    case 'G':
    case 'J':
      return band === '1' ? 1575.42e6 : band === '2' ? 1227.6e6 : 1176.45e6;
    case 'S':
      return band === '1' ? 1575.42e6 : 1176.45e6;
    case 'E':
      return band === '1'
        ? 1575.42e6
        : band === '5'
          ? 1176.45e6
          : band === '7'
            ? 1207.14e6
            : band === '8'
              ? 1191.795e6
              : 1278.75e6;
    case 'C':
      return band === '1'
        ? 1575.42e6
        : band === '2'
          ? 1561.098e6
          : band === '5'
            ? 1176.45e6
            : band === '7'
              ? 1207.14e6
              : 1268.52e6;
    case 'R': {
      if (gloK === null) return 0;
      if (band === '1') return 1602e6 + gloK * 562500;
      if (band === '2') return 1246e6 + gloK * 437500;
      return 1202.025e6; // L3 CDMA
    }
    default:
      return 0;
  }
}

/** Sign-extend the low `bits` of v. */
function exsign(v: number, bits: number): number {
  return v & (1 << (bits - 1)) ? v - 2 ** bits : v;
}

/** Reflected CRC-32 (poly 0xEDB88320, init 0) — NovAtel "32-bit CRC". */
function crc32(data: Uint8Array, start: number, len: number): number {
  let crc = 0;
  for (let i = start; i < start + len; i++) {
    crc ^= data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return crc >>> 0;
}

/* (system, signal type) → [system letter, RINEX code] — RTKLIB table */
const SIGNALS: Record<number, Record<number, [string, string]>> = {
  0: {
    0: ['G', '1C'],
    5: ['G', '2P'],
    9: ['G', '2W'],
    14: ['G', '5Q'],
    16: ['G', '1L'],
    17: ['G', '2S'],
  },
  1: { 0: ['R', '1C'], 1: ['R', '2C'], 5: ['R', '2P'], 6: ['R', '3Q'] },
  2: { 0: ['S', '1C'], 6: ['S', '5I'] },
  3: {
    1: ['E', '1C'],
    2: ['E', '1C'],
    6: ['E', '6B'],
    7: ['E', '6C'],
    12: ['E', '5Q'],
    17: ['E', '7Q'],
    20: ['E', '8Q'],
  },
  4: {
    0: ['C', '2I'],
    1: ['C', '7I'],
    2: ['C', '6I'],
    4: ['C', '2I'],
    5: ['C', '7I'],
    6: ['C', '6I'],
    7: ['C', '1P'],
    9: ['C', '5P'],
    11: ['C', '7D'],
  },
  5: {
    0: ['J', '1C'],
    14: ['J', '5Q'],
    16: ['J', '1L'],
    17: ['J', '2S'],
    27: ['J', '6L'],
  },
  6: { 0: ['I', '5A'] },
};

/**
 * Decode every valid RANGE message in a NovAtel binary byte stream.
 * Other messages are counted and skipped; CRC failures resync at the
 * next byte.
 */
export function parseNovatelRange(data: Uint8Array): NovatelParseResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const epochs: NovatelEpoch[] = [];
  const messageCounts: Record<number, number> = {};
  const obsCodes: Record<string, string[]> = {};
  let badCrc = 0;

  // Pass 1 — GLONASS frequency channels from GLOEPHEMERIS (723).
  // RANGECMP carries no channel field; phase reconstruction needs the
  // carrier frequency, so channels are collected up front (RTKLIB gets
  // them the same way via its scan pass).
  const gloFcn = new Map<number, number>();
  for (let j = 0; j + HDR + 4 <= data.length; j++) {
    if (data[j] !== 0xaa || data[j + 1] !== 0x44 || data[j + 2] !== 0x12)
      continue;
    const hl = data[j + 3]!;
    const id = view.getUint16(j + 4, true);
    const ln = view.getUint16(j + 8, true);
    if (id !== ID_GLOEPHEMERIS || hl < HDR || j + hl + ln + 4 > data.length)
      continue;
    if (crc32(data, j, hl + ln) !== view.getUint32(j + hl + ln, true)) continue;
    const slot = view.getUint16(j + hl, true) - 37;
    const k = view.getUint16(j + hl + 2, true) - 7; // OFF_FRQNO
    if (slot >= 1 && slot <= 32) gloFcn.set(slot, k);
    j += hl + ln + 3;
  }

  let i = 0;
  while (i + HDR + 4 <= data.length) {
    if (data[i] !== 0xaa || data[i + 1] !== 0x44 || data[i + 2] !== 0x12) {
      i++;
      continue;
    }
    const hlen = data[i + 3]!;
    const msgId = view.getUint16(i + 4, true);
    const msgLen = view.getUint16(i + 8, true);
    const total = hlen + msgLen + 4;
    if (hlen < HDR || i + total > data.length) {
      i++;
      continue;
    }
    if (
      crc32(data, i, hlen + msgLen) !== view.getUint32(i + hlen + msgLen, true)
    ) {
      badCrc++;
      i++;
      continue;
    }

    messageCounts[msgId] = (messageCounts[msgId] ?? 0) + 1;

    const binary = ((data[i + 6]! >> 4) & 0x3) === 0;
    const week = view.getUint16(i + 14, true);
    const towMs = view.getUint32(i + 16, true);

    if (msgId === ID_RANGECMP && binary && week > 0) {
      const p = i + hlen;
      const nobs = view.getUint32(p, true);
      if (p + 4 + nobs * 24 <= i + hlen + msgLen) {
        const meas: NovatelMeasurement[] = [];
        for (let k = 0; k < nobs; k++) {
          const o = p + 4 + 24 * k;
          const stat = view.getUint32(o, true);
          const satsys = (stat >>> 16) & 7;
          const sigtype = (stat >>> 21) & 0x1f;
          const plock = (stat >>> 10) & 1;
          const parity = (stat >>> 11) & 1;
          const clock = (stat >>> 12) & 1;

          const sig = SIGNALS[satsys]?.[sigtype];
          if (!sig) continue;
          let [sysL, code] = sig;

          let prnNum = data[o + 17]!;
          if (sysL === 'R') prnNum -= 37;
          if (sysL === 'S' && prnNum >= 183 && prnNum <= 191 && code === '1C') {
            sysL = 'J';
            code = '1Z';
            prnNum -= 182;
          } else if (sysL === 'S') {
            prnNum -= 100;
          }
          if (prnNum < 1 || prnNum > 99) continue;
          if (sysL === 'R' && !parity) continue;

          const gloK = sysL === 'R' ? (gloFcn.get(prnNum) ?? null) : null;
          const dop = exsign(view.getUint32(o + 4, true) & 0xfffffff, 28) / 256;
          const psr =
            (view.getUint32(o + 7, true) >>> 4) / 128 + data[o + 11]! * 2097152;

          // Phase: 24-bit accumulated-Doppler remainder + rollover count
          // recovered from the pseudorange (RTKLIB decode_rangecmpb).
          let cp: number | null = null;
          const freq = carrierFreq(sysL, code, gloK);
          if (freq > 0) {
            const adr = view.getInt32(o + 12, true) / 256;
            const rolls = (psr * freq) / C_LIGHT / ADR_ROLL + adr / ADR_ROLL;
            cp =
              -adr + ADR_ROLL * Math.floor(rolls + (rolls <= 0 ? -0.5 : 0.5));
          }
          const lockt = (view.getUint32(o + 18, true) & 0x1fffff) / 32;
          const cn0 = ((view.getUint16(o + 20, true) & 0x3ff) >>> 5) + 20;

          meas.push({
            prn: `${sysL}${String(prnNum).padStart(2, '0')}`,
            code,
            pr: clock ? psr : null,
            cp: plock ? cp : null,
            doppler: plock ? dop : null,
            cn0,
            lockTimeS: lockt,
            gloChannel: gloK,
          });
          const codes = (obsCodes[sysL] ??= []);
          if (!codes.includes(code)) codes.push(code);
        }
        epochs.push({
          timeMs: GPS_EPOCH_MS + week * MS_PER_WEEK + towMs,
          meas,
        });
      }
    } else if (msgId === ID_RANGE && binary && week > 0) {
      const p = i + hlen;
      const nobs = view.getUint32(p, true);
      if (p + 4 + nobs * 44 <= i + hlen + msgLen) {
        const meas: NovatelMeasurement[] = [];
        for (let k = 0; k < nobs; k++) {
          const o = p + 4 + 44 * k;
          const stat = view.getUint32(o + 40, true);
          const satsys = (stat >>> 16) & 7;
          const sigtype = (stat >>> 21) & 0x1f;
          const plock = (stat >>> 10) & 1;
          const parity = (stat >>> 11) & 1;
          const clock = (stat >>> 12) & 1;

          const sig = SIGNALS[satsys]?.[sigtype];
          if (!sig) continue;
          let [sysL, code] = sig;

          let prnNum = view.getUint16(o, true);
          if (sysL === 'R') prnNum -= 37;
          // QZSS L1 SAIF broadcast under SBAS PRNs 183–191
          if (sysL === 'S' && prnNum >= 183 && prnNum <= 191 && code === '1C') {
            sysL = 'J';
            code = '1Z';
            prnNum -= 182;
          } else if (sysL === 'S') {
            prnNum -= 100; // RINEX SBAS numbering
          }
          if (prnNum < 1 || prnNum > 99) continue;
          if (sysL === 'R' && !parity) continue; // half-cycle unresolved

          const prn = `${sysL}${String(prnNum).padStart(2, '0')}`;
          const gfrq = view.getUint16(o + 2, true);
          const psr = view.getFloat64(o + 4, true);
          const adr = view.getFloat64(o + 16, true);
          const dop = view.getFloat32(o + 28, true);
          const snr = view.getFloat32(o + 32, true);
          const lockt = view.getFloat32(o + 36, true);

          meas.push({
            prn,
            code,
            pr: clock ? psr : null,
            cp: plock ? -adr : null,
            doppler: plock ? dop : null,
            cn0: snr,
            lockTimeS: lockt,
            gloChannel: sysL === 'R' ? gfrq - 8 : null,
          });
          const codes = (obsCodes[sysL] ??= []);
          if (!codes.includes(code)) codes.push(code);
        }
        epochs.push({
          timeMs: GPS_EPOCH_MS + week * MS_PER_WEEK + towMs,
          meas,
        });
      }
    }
    i += total;
  }

  return { epochs, messageCounts, obsCodes, badCrc };
}
