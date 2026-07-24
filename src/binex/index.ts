/**
 * BINEX (BINary EXchange) decoding — the path from a receiver BINEX log
 * to RINEX-grade observables and broadcast ephemerides, mirroring the
 * SBF and NovAtel decoders in this package.
 *
 * `parseBinex` runs a single framing pass over the byte stream and emits
 * both observation epochs (record 0x7f-05, the obs record `convbin`
 * reads) and decoded `Ephemeris` records (record 0x01, per-constellation
 * subrecords). Frame walking, the ubnxi variable-length integer, the
 * XOR-8/CRC16/CRC32 checksum models and the field layouts are ported
 * from RTKLIB demo5/2.4.3 src/rcv/binex.c (Copyright (c) 2013-2018
 * T. Takasu, BSD-2-Clause) and cross-checked against the
 * EarthScope/UNAVCO BINEX definition and its reference RINEX fixtures.
 *
 * Framing (forward records only): a sync byte (0xE2 big-endian /
 * 0xC2 little-endian, regular CRC; 0xE8/0xC8 enhanced CRC), the record
 * ID, the message length (ubnxi), the body, then the checksum. The
 * subrecord ID is the first body byte. Reverse-readable records
 * (0xD2/0xF2/0xD8/0xF8 and terminating variants) are NOT decoded.
 *
 * Implemented: 0x7f-05 observations (multi-GNSS pseudorange, carrier
 * phase, Doppler, C/N0, slip) and 0x01-01…06 ephemeris (GPS, GLONASS,
 * SBAS, Galileo, BeiDou, QZSS). Deferred (counted, skipped): 0x00 site
 * metadata, 0x02/0x03 generalized data, 0x7d/0x7e prototyping, the
 * 0x7f-00…04 obs prototypes, 0x01-00 raw-byte ephemeris and 0x01-14.
 */

import { getBitS, getBitU } from '../navbits/index';
import type {
  Ephemeris,
  GlonassEphemeris,
  KeplerEphemeris,
} from '../rinex/nav';
import { binexRecords } from './frame';
import { decodeBinexEph } from './nav';

export {
  binexRecords,
  getBnxi,
  binexCrc16,
  binexCrc32,
  binexCsum8,
  type BinexRecord,
} from './frame';
export { decodeBinexEph } from './nav';

export interface BinexMeasurement {
  /** RINEX PRN, e.g. "G04", "R11", "S23", "J01". */
  prn: string;
  /** RINEX band+attribute, e.g. "1C", "2W", "5Q", "2I". */
  code: string;
  /** Pseudorange (m). */
  pr: number | null;
  /** Carrier phase (cycles, RINEX sign), null when the frequency is unknown. */
  cp: number | null;
  /** Doppler (Hz), null when the record carries none for the signal. */
  doppler: number | null;
  /** C/N0 (dB-Hz). */
  cn0: number | null;
  /** Loss-of-lock / cycle-slip flag. */
  slip: boolean;
}

export interface BinexEpoch {
  /** Receiver epoch (GPS-scale ms — same convention as the RINEX parser). */
  timeMs: number;
  meas: BinexMeasurement[];
}

export interface BinexParseResult {
  /** Observation epochs (record 0x7f-05), one per record. */
  epochs: BinexEpoch[];
  /** Broadcast ephemerides (record 0x01), duplicates suppressed. */
  ephemerides: Ephemeris[];
  /** Count per record/subrecord, keyed "0x7f-05" / "0x01-01" style. */
  messageCounts: Record<string, number>;
  /** Observation codes seen per system letter, in first-seen order. */
  obsCodes: Record<string, string[]>;
  /** Records whose checksum failed (corruption indicator). */
  badCrc: number;
}

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const CLIGHT = 299792458.0;

/* ── obs signal-code tables (RTKLIB decode_bnx_7f_05_obs) ──────────
 * Index → RINEX band+attribute (empty = unmapped, skipped). BeiDou B1I
 * is emitted on band "2" (RINEX 3.02, matching the SBF/NovAtel decoders
 * in this package) rather than RTKLIB's "1I". */
const OBS_CODES: Record<number, readonly string[]> = {
  0: [
    '1C',
    '1C',
    '1P',
    '1W',
    '1Y',
    '1M',
    '1X',
    '1N',
    '',
    '',
    '2W',
    '2C',
    '2D',
    '2S',
    '2L',
    '2X',
    '2P',
    '2W',
    '2Y',
    '2M',
    '2N',
    '',
    '',
    '5X',
    '5I',
    '5Q',
    '5X',
  ], // GPS
  1: [
    '1C',
    '1C',
    '1P',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '2C',
    '2C',
    '2P',
    '3X',
    '3I',
    '3Q',
    '3X',
  ], // GLONASS
  3: [
    '1C',
    '1A',
    '1B',
    '1C',
    '1X',
    '1Z',
    '5X',
    '5I',
    '5Q',
    '5X',
    '7X',
    '7I',
    '7Q',
    '7X',
    '8X',
    '8I',
    '8Q',
    '8X',
    '6X',
    '6A',
    '6B',
    '6C',
    '6X',
    '6Z',
  ], // Galileo
  2: ['1C', '1C', '', '', '', '', '5X', '5I', '5Q', '5X'], // SBAS
  4: [
    '2X',
    '2I',
    '2Q',
    '2X',
    '7X',
    '7I',
    '7Q',
    '7X',
    '6X',
    '6I',
    '6Q',
    '6X',
    '1X',
    '1S',
    '1L',
    '1X',
  ], // BeiDou
  5: [
    '1C',
    '1C',
    '1S',
    '1L',
    '1X',
    '',
    '',
    '2X',
    '2S',
    '2L',
    '2X',
    '',
    '',
    '5X',
    '5I',
    '5Q',
    '5X',
    '',
    '',
    '6X',
    '6S',
    '6L',
    '6X',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '1Z',
  ], // QZSS
};

const two = (n: number) => String(n).padStart(2, '0');

/** obs system index → RINEX PRN string (RTKLIB satno ranges). */
function obsPrn(sys: number, prn: number): string | null {
  switch (sys) {
    case 0:
      return prn >= 1 && prn <= 32 ? `G${two(prn)}` : null;
    case 1:
      return prn >= 1 && prn <= 27 ? `R${two(prn)}` : null;
    case 2:
      return prn >= 120 && prn <= 158 ? `S${two(prn - 100)}` : null;
    case 3:
      return prn >= 1 && prn <= 36 ? `E${two(prn)}` : null;
    case 4:
      return prn >= 1 && prn <= 63 ? `C${two(prn)}` : null;
    case 5:
      if (prn >= 193 && prn <= 202) return `J${two(prn - 192)}`;
      return prn >= 1 && prn <= 10 ? `J${two(prn)}` : null;
    default:
      return null;
  }
}

/** Carrier frequency (Hz) for a system letter + RINEX code (+GLONASS FCN). */
function carrierFreq(sys: string, code: string, fcn: number): number {
  const band = code.charCodeAt(0) - 48;
  switch (sys) {
    case 'G':
    case 'J':
      if (band === 1) return 1575.42e6;
      if (band === 2) return 1227.6e6;
      if (band === 5) return 1176.45e6;
      if (band === 6) return 1278.75e6;
      return 0;
    case 'R':
      if (band === 1) return fcn >= -7 ? 1602.0e6 + fcn * 0.5625e6 : 0;
      if (band === 2) return fcn >= -7 ? 1246.0e6 + fcn * 0.4375e6 : 0;
      if (band === 3) return 1202.025e6;
      return 0;
    case 'E':
      if (band === 1) return 1575.42e6;
      if (band === 5) return 1176.45e6;
      if (band === 6) return 1278.75e6;
      if (band === 7) return 1207.14e6;
      if (band === 8) return 1191.795e6;
      return 0;
    case 'C':
      if (band === 1) return 1575.42e6;
      if (band === 2) return 1561.098e6;
      if (band === 5) return 1176.45e6;
      if (band === 6) return 1268.52e6;
      if (band === 7) return 1207.14e6;
      if (band === 8) return 1191.795e6;
      return 0;
    case 'S':
      if (band === 1) return 1575.42e6;
      if (band === 5) return 1176.45e6;
      return 0;
    default:
      return 0;
  }
}

interface ObsRaw {
  code: number;
  slip: boolean;
  pr: number;
  phase: number;
  cn0: number;
  doppler: number | null;
}

// Sentinel GLONASS frequency channel meaning "not yet known"; a real
// channel is −7…+6, so this can never collide.
const FCN_UNKNOWN = -100;

/**
 * Decode the observation blocks for one satellite (record 0x7f-05).
 * Returns the raw obs (phase in metres) and the byte offset just past
 * them. Ported from EarthScope gnsstools DeserializeRecord7F05: each obs
 * block inherits block 0's ObsFlags before overlaying its own, which sets
 * the expanded-delta/Doppler/slip-count field widths — the reference C
 * port (RTKLIB) resets the flags per block and mis-sizes later blocks.
 * A GLONASS frequency channel carried in the flags applies to the whole
 * satellite.
 */
function decodeObsSat(
  data: Uint8Array,
  start: number,
  nobs: number,
  sys: number
): { obs: ObsRaw[]; fcn: number; next: number } {
  let p = start;
  let fcn = FCN_UNKNOWN;
  const obs: ObsRaw[] = [];
  const block0Flags = [0, 0, 0, 0];
  let refRange = 0;
  for (let b = 0; b < nobs; b++) {
    // Block 0 seeds block0Flags in place; later blocks start from a copy.
    const flags = b === 0 ? block0Flags : block0Flags.slice();
    const b0 = data[p++]!;
    const code = b0 & 0x1f;
    const slip = ((b0 >> 5) & 1) === 1;
    let more = (b0 >> 7) & 1; // one or more ObsFlags fields follow
    while (more) {
      const fb = data[p++]!;
      flags[fb & 0x03] = fb & 0x7f;
      more = fb & 0x80;
    }
    // GLONASS FCN comes in flags[2] of an FDMA signal block (1C/1P/2C/2P).
    if (
      sys === 1 &&
      flags[2]! > 0 &&
      (code === 1 || code === 2 || code === 11 || code === 12)
    ) {
      fcn = getBitS(Uint8Array.of(flags[2]!), 2, 4);
    }
    const acc = flags[0]! & 0x20 ? 0.0001 : 0.00002; // phase resolution

    let cn0 = data[p++]! * 0.4;
    let range: number;
    if (b === 0) {
      cn0 += getBitS(data, p * 8, 2) * 0.1;
      range = getBitU(data, p * 8 + 2, 38) * 0.001; // reference range
      p += 5;
      refRange = range;
    } else if (flags[0]! & 0x40) {
      cn0 += getBitS(data, p * 8, 2) * 0.1;
      range = refRange + getBitS(data, p * 8 + 4, 20) * 0.001; // expanded delta
      p += 3;
    } else {
      range = refRange + getBitS(data, p * 8, 16) * 0.001; // delta
      p += 2;
    }

    let phase: number;
    if (flags[0]! & 0x40) {
      phase = range + getBitS(data, p * 8, 24) * acc; // expanded delta
      p += 3;
    } else {
      cn0 += getBitS(data, p * 8, 2) * 0.1;
      phase = range + getBitS(data, p * 8 + 2, 22) * acc; // delta
      p += 3;
    }

    let doppler: number | null = null;
    if (flags[0]! & 0x04) {
      doppler = getBitS(data, p * 8, 24) / 256.0;
      p += 3;
    }
    if (flags[0]! & 0x08) {
      p += flags[0]! & 0x10 ? 2 : 1; // slip count (u2/u1), not emitted
    }

    obs.push({ code, slip, pr: range, phase, cn0, doppler });
  }
  return { obs, fcn, next: p };
}

/** Decode record 0x7f-05 into one observation epoch (RTKLIB decode_bnx_7f_05). */
function decodeObsRecord(
  data: Uint8Array,
  view: DataView,
  body: number,
  len: number,
  obsCodes: Record<string, string[]>
): BinexEpoch | null {
  // subrecord id (0x05) already dispatched; body[0] = subrec.
  let p = body + 1;
  const min = view.getUint32(p); // minutes since GPS epoch (big-endian)
  p += 4;
  const msec = view.getUint16(p);
  p += 2;
  const timeMs = GPS_EPOCH_MS + min * 60_000 + msec;

  const flag = data[p++]!;
  const nsat = (flag & 0x3f) + 1;
  if (flag & 0x80) p += 3; // rxclkoff
  if (flag & 0x40) {
    // systime: nsys 4-bit + rsys 4-bit, then nsys × 4 bytes
    const nsys = getBitU(data, p * 8, 4);
    p += 1;
    p += nsys * 4;
  }

  const end = body + len;
  const meas: BinexMeasurement[] = [];
  for (let i = 0; i < nsat && p < end; i++) {
    const prn = data[p++]!;
    const b = data[p++]!;
    const nobs = (b >> 4) & 0x07;
    const sys = b & 0x0f;
    const sat = obsPrn(sys, prn);
    const { obs, fcn, next } = decodeObsSat(data, p, nobs, sys);
    p = next;
    if (p > end) return null;
    if (!sat) continue;
    const table = OBS_CODES[sys];
    const sysL = sat[0]!;
    for (const o of obs) {
      const code = table?.[o.code & 0x3f] ?? '';
      if (!code) continue;
      const freq = carrierFreq(sysL, code, fcn);
      meas.push({
        prn: sat,
        code,
        pr: o.pr,
        cp: freq > 0 ? (o.phase * freq) / CLIGHT : null,
        doppler: o.doppler,
        cn0: o.cn0,
        slip: o.slip,
      });
      const codes = (obsCodes[sysL] ??= []);
      if (!codes.includes(code)) codes.push(code);
    }
  }
  return { timeMs, meas };
}

/**
 * Decode every supported BINEX record in a byte stream: 0x7f-05
 * observation epochs and 0x01-01…06 broadcast ephemerides. Repeated
 * broadcasts of an unchanged ephemeris are suppressed the way RTKLIB
 * does: GPS/Galileo/QZSS/BeiDou by issue of data (iode) plus toe and toc,
 * GLONASS/SBAS by reference epoch and health. Other records are counted
 * and skipped; checksum failures resync at the next byte.
 */
export function parseBinex(data: Uint8Array): BinexParseResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const epochs: BinexEpoch[] = [];
  const ephemerides: Ephemeris[] = [];
  const messageCounts: Record<string, number> = {};
  const obsCodes: Record<string, string[]> = {};
  const stats = { badCrc: 0 };

  const lastKep = new Map<string, KeplerEphemeris>();
  const lastState = new Map<string, GlonassEphemeris>();

  const hex = (n: number) => `0x${n.toString(16).padStart(2, '0')}`;

  for (const rec of binexRecords(data, view, stats)) {
    // Key by record + subrecord (the first body byte) for diagnostics.
    const sub = rec.len > 0 ? data[rec.body]! : 0;
    const key =
      rec.id === 0x01 || rec.id === 0x7f
        ? `${hex(rec.id)}-${sub.toString(16).padStart(2, '0')}`
        : hex(rec.id);
    messageCounts[key] = (messageCounts[key] ?? 0) + 1;

    if (rec.id === 0x7f && sub === 0x05 && rec.len >= 8 && !rec.littleEndian) {
      const epoch = decodeObsRecord(data, view, rec.body, rec.len, obsCodes);
      if (epoch) epochs.push(epoch);
    } else if (rec.id === 0x01 && rec.len >= 2) {
      const eph = decodeBinexEph(view, rec.body, rec.len, rec.littleEndian);
      if (!eph) continue;
      if ('iode' in eph) {
        // Keplerian (GPS/Galileo/BeiDou/QZSS): dedup by issue of data.
        const prev = lastKep.get(eph.prn);
        if (
          prev &&
          prev.iode === eph.iode &&
          prev.toe === eph.toe &&
          prev.tocDate.getTime() === eph.tocDate.getTime()
        ) {
          continue;
        }
        lastKep.set(eph.prn, eph);
        ephemerides.push(eph);
      } else {
        // State-vector (GLONASS/SBAS): dedup by reference epoch and health.
        const prev = lastState.get(eph.prn);
        if (
          prev &&
          Math.abs(prev.tocDate.getTime() - eph.tocDate.getTime()) < 1000 &&
          prev.health === eph.health
        ) {
          continue;
        }
        lastState.set(eph.prn, eph);
        ephemerides.push(eph);
      }
    }
  }

  return { epochs, ephemerides, messageCounts, obsCodes, badCrc: stats.badCrc };
}
