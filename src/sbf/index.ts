/**
 * Septentrio SBF raw-measurement decoding (MeasEpoch + Meas3) — the
 * path from a receiver log to RINEX-grade observables.
 *
 * Framing: 0x24 0x40, CRC16-CCITT (poly 0x1021, init 0) as U2, block
 * ID U2 (number in bits 0..12, revision in 13..15), total length U2
 * (multiple of 4, includes the 8-byte header). The CRC covers block ID
 * through payload end. Every measurement block starts with the receiver
 * time stamp: TOW (U4, ms of GPS week) + WNc (U2, continuous week).
 *
 * Two measurement families are decoded:
 *  - MeasEpoch (4027): classic per-channel absolute + delta sub-blocks.
 *  - Meas3Ranges (4109) with the Meas3CN0HiRes (4110) and Meas3Doppler
 *    (4111) extensions: a compressed format alternating reference
 *    epochs (full measurements) and delta epochs (differences against
 *    the last reference), with per-constellation master signals and
 *    slave signals encoded relative to the master. Decoding is stateful
 *    across blocks; delta epochs before the first reference epoch in
 *    the stream cannot be decoded and are dropped.
 *
 * The Meas3 decoding logic is ported from RTKLIB demo5 (rtklibexplorer),
 * src/rcv/septentrio.c, BSD-2-Clause, and cross-checked against the
 * Septentrio mosaic-X5 reference guide (the guide documents MeasEpoch
 * fully; the Meas3 bit layout is only public through that decoder).
 */

import { scanSbfFrames, svidToPrn } from './frame';

export { scanSbfFrames, crc16 as sbfCrc16 } from './frame';

export {
  parseSbfNav,
  parseSbfAlmanac,
  type SbfNavResult,
  type SbfAlmanacResult,
  type SbfAlmanac,
  type SbfKeplerAlmanac,
  type SbfGlonassAlmanac,
} from './nav';

export { parseSbfIonoUtc, type SbfIonoUtcResult } from './iono';

export { parseSbfGpsNav, type SbfGpsNavResult } from './rawnav-gps';

export {
  decodeSbfNavigation,
  type SbfNavigation,
  type SbfNavCounts,
} from './navigation';

export {
  parseSbfCnav,
  type SbfCnavResult,
  type SbfCnavEphemeris,
  type CnavEphemeris,
} from './rawnav';

export interface SbfMeasurement {
  /** RINEX PRN, e.g. "G04", "R11", "S23" (SBAS PRN-100). */
  prn: string;
  /** RINEX band+attribute, e.g. "1C", "2W", "5Q", "2I". */
  code: string;
  /** Pseudorange (m), null when flagged invalid. */
  pr: number | null;
  /** Carrier phase (cycles), null when flagged invalid. */
  cp: number | null;
  /** Doppler (Hz), null when the log carries no Doppler for the signal. */
  doppler: number | null;
  /** C/N0 (dB-Hz), null when flagged invalid. */
  cn0: number | null;
  /** Continuous PLL lock time (ms), null when unknown. */
  lockTimeMs: number | null;
}

export interface SbfMeasEpoch {
  /** Receiver epoch (GPS-scale ms — same convention as the RINEX parser). */
  timeMs: number;
  meas: SbfMeasurement[];
}

export interface SbfParseResult {
  epochs: SbfMeasEpoch[];
  /** Count per SBF block number, keyed "4109" style, for diagnostics. */
  messageCounts: Record<string, number>;
  /** Observation codes seen per system letter, in first-seen order. */
  obsCodes: Record<string, string[]>;
  /** Frames whose CRC failed (corruption indicator). */
  badCrc: number;
}

const CLIGHT = 299792458.0;
const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const MS_PER_WEEK = 7 * 86400_000;

/* ── Constellations and signals ────────────────────────────────── */

// Meas3 constellation index → RINEX system letter (order fixed by format)
const M3_SYS = ['G', 'R', 'E', 'C', 'S', 'J', 'I'] as const;
// Base pseudorange per constellation (m); BDS GEO/IGSO redefined to 34e6
const M3_PR_BASE = [19e6, 19e6, 22e6, 20e6, 34e6, 34e6, 34e6] as const;
// Reference-epoch interval index → interval in ms
const M3_INTERVALS = [
  1, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 1, 1, 1, 1, 1,
  1,
] as const;
// Lock-time indicator → continuous PLL lock time (ms)
const M3_LOCK_TIME = [
  0, 60000, 30000, 15000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 40, 20,
  10, 0,
] as const;
// Default Meas3 signal-index table per constellation (before exclusions)
const M3_SIG_DEFAULT: readonly (readonly string[])[] = [
  ['1C', '2L', '5Q', '1W', '2W', '1L'], // GPS
  ['1C', '2C', '1P', '2P', '3Q'], // GLONASS
  ['1C', '5Q', '7Q', '6C', '8Q'], // Galileo
  ['2I', '7I', '6I', '1P', '5P', '7D'], // BeiDou
  ['1C', '5I'], // SBAS
  ['1C', '2L', '5Q', '6L', '1L', '1Z', '5P', '1E'], // QZSS
  ['5A', '1E', '9A'], // NavIC
];

// Classic MeasEpoch signal number → [system letter, RINEX code]
const MEAS2_SIG: readonly ([string, string] | null)[] = [
  ['G', '1C'],
  ['G', '1W'],
  ['G', '2W'],
  ['G', '2L'],
  ['G', '5Q'],
  ['G', '1L'],
  ['J', '1C'],
  ['J', '2L'],
  ['R', '1C'],
  ['R', '1P'],
  ['R', '2P'],
  ['R', '2C'],
  ['R', '3Q'],
  ['C', '1P'],
  ['C', '5P'],
  ['I', '5A'],
  null,
  ['E', '1C'],
  null,
  ['E', '6C'],
  ['E', '5Q'],
  ['E', '7Q'],
  ['E', '8Q'],
  null, // L-band
  ['S', '1C'],
  ['S', '5I'],
  ['J', '5Q'],
  ['J', '6L'],
  ['C', '2I'],
  ['C', '7I'],
  ['C', '6I'],
  null,
  ['J', '1L'],
  ['J', '1Z'],
  ['C', '7D'],
  null,
  ['I', '9A'],
  null, // NavIC L1 (no obs code assigned)
  ['J', '1E'],
  ['J', '5P'],
];

const two = (n: number) => String(n).padStart(2, '0');

/** Meas3 satellite-mask bit → PRN string (RTKLIB PRN range limits). */
function m3Prn(navsys: number, svid: number): string | null {
  switch (navsys) {
    case 0:
      return svid < 32 ? `G${two(svid + 1)}` : null;
    case 1:
      return svid < 27 ? `R${two(svid + 1)}` : null;
    case 2:
      return svid < 36 ? `E${two(svid + 1)}` : null;
    case 3:
      return svid < 50 ? `C${two(svid + 1)}` : null;
    case 4:
      // Meas3 SBAS numbering starts at PRN 120; RINEX uses PRN-100
      return svid <= 38 ? `S${two(svid + 20)}` : null;
    case 5:
      return svid < 10 ? `J${two(svid + 1)}` : null;
    case 6:
      return svid < 14 ? `I${two(svid + 1)}` : null;
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
      if (band === 1) return 1602.0e6 + fcn * 0.5625e6;
      if (band === 2) return 1246.0e6 + fcn * 0.4375e6;
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
    case 'I':
      if (band === 1) return 1575.42e6;
      if (band === 5) return 1176.45e6;
      if (band === 9) return 2492.028e6;
      return 0;
    default:
      return 0;
  }
}

/* ── Decoder state ─────────────────────────────────────────────── */

// Internal measurement: 0 marks invalid pr/cp (the receiver's own
// convention), converted to null on emission.
interface Meas {
  prn: string;
  sys: string;
  code: string;
  freq: number;
  pr: number;
  cp: number;
  cn0: number | null;
  doppler: number | null;
  lockTimeMs: number | null;
}

// Per-satellite slot list of a Meas3 epoch: slot 0 is the master signal,
// then the slaves in encoding order (null where the signal is unmapped).
interface SatEntry {
  navsys: number;
  svid: number;
  prn: string | null;
  slots: (Meas | null)[];
}

interface RefSlot {
  sigIdx: number;
  pr: number;
  cp: number;
  cn0: number;
  lockTimeMs: number | null;
}

interface RefSat {
  slaveMask: number;
  prRate: number; // pseudorange rate in 64 mm/s steps
  slots: RefSlot[];
}

const ZERO_REF_SLOT: RefSlot = {
  sigIdx: 0,
  pr: 0,
  cp: 0,
  cn0: 0,
  lockTimeMs: null,
};

interface RefEpoch {
  tow: number;
  headers: (Uint8Array | null)[];
  sats: (RefSat | undefined)[][];
}

function freshRefEpoch(tow: number): RefEpoch {
  return {
    tow,
    headers: new Array(7).fill(null),
    sats: Array.from({ length: 7 }, () => new Array(64)),
  };
}

/**
 * Decode every valid MeasEpoch/Meas3 block in an SBF byte stream.
 * Other block types are counted and skipped; frames with bad CRC are
 * counted and a resync continues at the next byte.
 */
export function parseSbfMeas(data: Uint8Array): SbfParseResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const epochs: SbfMeasEpoch[] = [];
  const messageCounts: Record<string, number> = {};
  const obsCodes: Record<string, string[]> = {};

  let ref = freshRefEpoch(-1);
  let curTime = NaN;
  let curMeas: Meas[] = [];
  let curSats: SatEntry[] = [];

  const flush = () => {
    if (curMeas.length > 0) {
      const meas: SbfMeasurement[] = curMeas.map((m) => {
        const codes = (obsCodes[m.sys] ??= []);
        if (!codes.includes(m.code)) codes.push(m.code);
        return {
          prn: m.prn,
          code: m.code,
          pr: m.pr !== 0 ? m.pr : null,
          cp: m.cp !== 0 ? m.cp : null,
          doppler: m.doppler,
          cn0: m.cn0,
          lockTimeMs: m.lockTimeMs,
        };
      });
      epochs.push({ timeMs: curTime, meas });
    }
    curMeas = [];
    curSats = [];
  };

  const ensureEpoch = (timeMs: number) => {
    if (timeMs !== curTime) {
      flush();
      curTime = timeMs;
    }
  };

  /* ── Meas3Ranges (4109) ──────────────────────────────────────── */
  const decodeMeas3Ranges = (i: number, tow: number) => {
    const o = i + 8; // payload start (TOW at o)
    const constellations = view.getUint16(o + 8, true) & 0x7f;
    const misc = data[o + 10]!;
    const version = data[o + 11]!;
    if (version > 31) return;
    if ((misc & 7) !== 0) return; // aux-antenna block: main antenna only
    const prrAvailable = (misc & 8) !== 0;
    const interval = M3_INTERVALS[misc >> 4]!;
    const isRef = tow % interval === 0;
    const dtow = tow % interval; // ms since the reference epoch

    if (isRef) {
      ref = freshRefEpoch(tow);
    } else if (ref.tow !== Math.floor(tow / interval) * interval) {
      // Delta epoch without its reference epoch: cannot decode.
      curMeas = [];
      curSats = [];
      return;
    }

    let idx = o + 12;
    for (let navsys = 0; navsys < 7; navsys++) {
      if ((constellations & (1 << navsys)) === 0) continue;
      const sys = M3_SYS[navsys]!;

      // Constellation header: a leading zero byte means "reuse the
      // header stored at the reference epoch".
      const useRefHeader = data[idx] === 0;
      const hdr = useRefHeader
        ? (ref.headers[navsys] ?? new Uint8Array(0))
        : data.subarray(idx, idx + 32);
      const BF1 = hdr[0] ?? 0;
      let nB = BF1 & 7;
      if (nB === 7) nB = 8;
      const sigIdxMasterShort = (BF1 >> 3) & 0xf;
      const sigExclPresent = BF1 >> 7 !== 0;
      let h = 1;
      const maskBytes = hdr.subarray(h, h + nB);
      let nSats = 0;
      for (const b of maskBytes)
        for (let k = 0; k < 8; k++) nSats += (b >> k) & 1;
      h += nB;
      let gloFncs: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
      let bdsLongRange = 0;
      if (navsys === 1) {
        gloFncs = hdr.subarray(h, h + ((nSats + 1) >> 1));
        h += (nSats + 1) >> 1;
      } else if (navsys === 3) {
        bdsLongRange = (hdr[h] ?? 0) | ((hdr[h + 1] ?? 0) << 8);
        h += 2;
      }
      const sigExcluded = sigExclPresent ? (hdr[h++] ?? 0) : 0;
      if (isRef) ref.headers[navsys] = data.slice(idx, idx + h);
      idx += useRefHeader ? 1 : h;

      // Compact the default signal table over the excluded signals
      const sigTable: (string | null)[] = [];
      for (let s = 0; s < 16; s++)
        if ((sigExcluded & (1 << s)) === 0)
          sigTable.push(M3_SIG_DEFAULT[navsys]![s] ?? null);
      while (sigTable.length < 16) sigTable.push(null);

      let satCnt = 0;
      for (let svid = 0; svid < 64 && satCnt < nSats; svid++) {
        if ((((maskBytes[svid >> 3] ?? 0) >> (svid & 7)) & 1) === 0) continue;
        const glofnc =
          navsys === 1
            ? (((gloFncs[satCnt >> 1] ?? 0) >> (4 * (satCnt % 2))) & 0xf) - 8
            : 0;
        const prn = m3Prn(navsys, svid);
        const prbase =
          navsys === 3 && (bdsLongRange & (1 << satCnt)) !== 0
            ? 34e6
            : M3_PR_BASE[navsys]!;
        const refSat = ref.sats[navsys]![svid];
        const refSlot = (k: number): RefSlot =>
          refSat?.slots[k] ?? ZERO_REF_SLOT;

        const entry: SatEntry = { navsys, svid, prn, slots: [] };

        // ── master signal ──
        const bt = data[idx]!;
        let masterSigIdx: number;
        let slaveMask: number;
        let prRate = 0;
        let mPr = 0;
        let mCp = 0;
        let mCn0 = 0;
        let mLock: number | null = null;
        let masterCode: string | null;
        let mFreq = 0;

        if ((bt & 1) === 1) {
          // Master short
          const BF1m = view.getUint32(idx, true);
          const prLsb = view.getUint32(idx + 4, true);
          const cmc = (BF1m >>> 1) & 0x3ffff;
          const prMsb = (BF1m >>> 19) & 1;
          const lti3 = (BF1m >>> 20) & 7;
          const cn0 = (BF1m >>> 23) & 0x1f;
          const signalList = (BF1m >>> 28) & 0xf;
          masterSigIdx = sigIdxMasterShort;
          slaveMask = signalList << (masterSigIdx + 1);
          masterCode = sigTable[masterSigIdx] ?? null;
          if (masterCode) {
            mFreq = carrierFreq(sys, masterCode, glofnc);
            mPr = prbase + (prLsb + 4294967296 * prMsb) * 0.001;
            mCn0 = cn0 + 24;
            if (cmc !== 0) mCp = mPr / (CLIGHT / mFreq) - 131.072 + cmc * 0.001;
            mLock = M3_LOCK_TIME[lti3]!;
          }
          prRate = prrAvailable ? view.getInt16(idx + 8, true) : 0;
          idx += prrAvailable ? 10 : 8;
        } else if ((bt & 3) === 0) {
          // Master long
          const BF1m = view.getUint32(idx, true);
          const prLsb = view.getUint32(idx + 4, true);
          const BF2 = view.getUint16(idx + 8, true);
          const BF3 = data[idx + 10]!;
          const prMsb = (BF1m >>> 2) & 0xf;
          const cmc = (BF1m >>> 6) & 0x3fffff;
          const lti4 = (BF1m >>> 28) & 0xf;
          const cn0 = BF2 & 0x3f;
          let signalMask = (BF2 >>> 6) & 0x1ff;
          const cont = (BF2 >>> 15) & 1;
          if (cont !== 0) signalMask |= (BF3 & 0x7f) << 9;
          masterSigIdx = 0;
          while (masterSigIdx < 32 && ((signalMask >> masterSigIdx) & 1) === 0)
            masterSigIdx++;
          slaveMask = signalMask !== 0 ? signalMask ^ (1 << masterSigIdx) : 0;
          masterCode = sigTable[masterSigIdx] ?? null;
          if (masterCode) {
            mFreq = carrierFreq(sys, masterCode, glofnc);
            const isGpsPCode =
              navsys === 0 && (masterCode === '1W' || masterCode === '2W');
            mPr = (prLsb + 4294967296 * prMsb) * 0.001;
            mCn0 = isGpsPCode ? cn0 : cn0 + 10;
            if (cmc !== 0)
              mCp = mPr / (CLIGHT / mFreq) - 2097.152 + cmc * 0.001;
            mLock = M3_LOCK_TIME[lti4]!;
          }
          prRate = prrAvailable ? view.getInt16(idx + 10, true) : 0;
          idx += (prrAvailable ? 12 : 10) + cont;
        } else if ((bt & 0xc) === 0xc) {
          // Master long delta (vs the reference epoch)
          const BF1m = data[idx]!;
          const BF2 = view.getUint32(idx + 1, true);
          const prDelta = ((BF1m >> 4) << 13) | (BF2 & 0x1fff);
          const cn0Delta = (BF2 >>> 13) & 7;
          const cmc = BF2 >>> 16;
          masterSigIdx = refSlot(0).sigIdx;
          slaveMask = refSat?.slaveMask ?? 0;
          masterCode = sigTable[masterSigIdx] ?? null;
          if (masterCode) {
            const r = refSlot(0);
            mFreq = carrierFreq(sys, masterCode, glofnc);
            mPr =
              r.pr +
              Math.trunc(((refSat?.prRate ?? 0) * 64 * dtow) / 1000) * 0.001 +
              prDelta * 0.001 -
              65.536;
            mCn0 = r.cn0 - 4 + cn0Delta;
            if (cmc !== 0)
              mCp =
                (mPr - r.pr) / (CLIGHT / mFreq) + r.cp - 32.768 + cmc * 0.001;
            mLock = r.lockTimeMs;
          }
          idx += 5;
        } else {
          // Master short delta (vs the reference epoch)
          const BF1m = view.getUint32(idx, true);
          const prDelta = (BF1m >>> 4) & 0x3fff;
          const cmc = (BF1m >>> 18) & 0x3fff;
          const cn0Delta = (BF1m >>> 2) & 3;
          masterSigIdx = refSlot(0).sigIdx;
          slaveMask = refSat?.slaveMask ?? 0;
          masterCode = sigTable[masterSigIdx] ?? null;
          if (masterCode) {
            const r = refSlot(0);
            mFreq = carrierFreq(sys, masterCode, glofnc);
            mPr =
              r.pr +
              Math.trunc(((refSat?.prRate ?? 0) * 64 * dtow) / 1000) * 0.001 +
              prDelta * 0.001 -
              8.192;
            mCn0 = r.cn0 - 1 + cn0Delta;
            if (cmc !== 0)
              mCp =
                (mPr - r.pr) / (CLIGHT / mFreq) + r.cp - 8.192 + cmc * 0.001;
            mLock = r.lockTimeMs;
          }
          idx += 4;
        }

        let masterMeas: Meas | null = null;
        if (masterCode && prn) {
          masterMeas = {
            prn,
            sys,
            code: masterCode,
            freq: mFreq,
            pr: mPr,
            cp: mCp,
            cn0: mCn0,
            doppler: null,
            lockTimeMs: mLock,
          };
          curMeas.push(masterMeas);
        }
        entry.slots.push(masterMeas);

        let newRefSat: RefSat | null = null;
        if (isRef && prn) {
          newRefSat = {
            slaveMask,
            prRate,
            slots: [
              {
                sigIdx: masterSigIdx,
                pr: mPr,
                cp: mCp,
                cn0: mCn0,
                lockTimeMs: mLock,
              },
            ],
          };
          ref.sats[navsys]![svid] = newRefSat;
        }

        // ── slave signals ──
        let slaveCnt = 0;
        let mask = slaveMask;
        for (let s = 1; s < 16 && mask !== 0; s++) {
          if ((mask & (1 << s)) === 0) continue;
          const bt2 = data[idx]!;
          const code = sigTable[s] ?? null;
          const freq = code ? carrierFreq(sys, code, glofnc) : 0;
          let sPr = 0;
          let sCp = 0;
          let sCn0 = 0;
          let sLock: number | null = null;

          if ((bt2 & 1) === 1) {
            // Slave short
            const BF1s = view.getUint32(idx, true);
            const BF2s = data[idx + 4]!;
            const cmcRes = (BF1s >>> 1) & 0xffff;
            const prRel = BF1s >>> 17;
            const lti3 = BF2s & 7;
            const cn0 = BF2s >> 3;
            if (code) {
              sPr =
                mFreq > freq
                  ? mPr + prRel * 0.001 - 10
                  : mPr - prRel * 0.001 + 10;
              if (cmcRes !== 0)
                sCp =
                  sPr / (CLIGHT / freq) +
                  (mCp - mPr / (CLIGHT / mFreq)) * (mFreq / freq) -
                  32.768 +
                  cmcRes * 0.001;
              sCn0 =
                navsys === 0 && (code === '1W' || code === '2W')
                  ? mCn0 - 3 - cn0
                  : cn0 + 24;
              sLock = M3_LOCK_TIME[lti3]!;
            }
            idx += 5;
          } else if ((bt2 & 3) === 0) {
            // Slave long
            const BF1s = view.getUint32(idx, true);
            const prLsbRel = view.getUint16(idx + 4, true);
            const BF3s = data[idx + 6]!;
            const cmc = (BF1s >>> 2) & 0x3fffff;
            const lti4 = (BF1s >>> 24) & 0xf;
            const prMsbRel = (BF1s >>> 28) & 7;
            const cn0 = BF3s & 0x3f;
            if (code) {
              sPr = mPr + (prMsbRel * 65536 + prLsbRel) * 0.001 - 262.144;
              if (cmc !== 0)
                sCp = sPr / (CLIGHT / freq) - 2097.152 + cmc * 0.001;
              sCn0 =
                navsys === 0 && (code === '1W' || code === '2W')
                  ? cn0
                  : cn0 + 10;
              sLock = M3_LOCK_TIME[lti4]!;
            }
            idx += 7;
          } else {
            // Slave delta (vs the reference epoch)
            const BF1s = view.getUint16(idx, true);
            const dC = data[idx + 2]!;
            const dPr = (BF1s >>> 2) & 0xfff;
            const cn0Delta = BF1s >>> 14;
            if (code) {
              const rS = refSlot(slaveCnt + 1);
              const rM = refSlot(0);
              sCp = rS.cp + (mCp - rM.cp) * (freq / mFreq) - 0.128 + dC * 0.001;
              sPr =
                rS.pr + (sCp - rS.cp) * (CLIGHT / freq) - 2.048 + dPr * 0.001;
              sCn0 = rS.cn0 - 2 + cn0Delta;
              sLock = rS.lockTimeMs;
            }
            idx += 3;
          }

          let slaveMeas: Meas | null = null;
          if (code && prn) {
            slaveMeas = {
              prn,
              sys,
              code,
              freq,
              pr: sPr,
              cp: sCp,
              cn0: sCn0,
              doppler: null,
              lockTimeMs: sLock,
            };
            curMeas.push(slaveMeas);
          }
          entry.slots.push(slaveMeas);

          if (newRefSat)
            newRefSat.slots[slaveCnt + 1] = {
              sigIdx: s,
              pr: sPr,
              cp: sCp,
              cn0: sCn0,
              lockTimeMs: sLock,
            };

          slaveCnt++;
          mask &= ~(1 << s);
        }

        curSats.push(entry);
        satCnt++;
      }
    }
  };

  /* ── Meas3CN0HiRes (4110): 4-bit fractional C/N0 per signal ──── */
  const decodeMeas3CN0 = (i: number, len: number) => {
    const flags = view.getUint16(i + 14, true);
    if ((flags & 7) !== 0) return;
    const maxNibbles = (len - 16) * 2;
    let off = 0;
    for (const e of curSats) {
      if (off >= maxNibbles) break;
      if (!e.prn) continue; // no nibbles encoded for unmapped satellites
      for (let k = 0; k < e.slots.length; k++) {
        const slot = e.slots[k];
        // The master always consumes a nibble; the slave list stops at
        // the first unmapped signal (mirrors the reference decoder).
        if (k > 0 && !slot) break;
        const nib = ((data[i + 16 + (off >> 1)] ?? 0) >> ((off & 1) * 4)) & 0xf;
        if (slot && slot.cn0 !== null) slot.cn0 += nib * 0.0625 - 0.5;
        off++;
      }
    }
  };

  /* ── Meas3Doppler (4111): variable-length PR rates per signal ── */
  const readPrRate = (
    base: number,
    off: number
  ): { value: number; size: number } => {
    const byteAt = (k: number) => data[base + off + k] ?? 0;
    const v =
      (byteAt(0) | (byteAt(1) << 8) | (byteAt(2) << 16) | (byteAt(3) << 24)) >>>
      0;
    let value: number;
    let size: number;
    if ((v & 2) === 0) {
      value = (v & 0xff) >>> 2;
      size = 1;
    } else if ((v & 6) === 2) {
      value = (v & 0xffff) >>> 3;
      size = 2;
    } else if ((v & 0xe) === 6) {
      value = (v & 0xffffff) >>> 4;
      size = 3;
    } else {
      value = v >>> 4;
      size = 4;
    }
    if ((v & 1) === 1) value = -value;
    return { value, size };
  };

  const decodeMeas3Doppler = (i: number, len: number) => {
    const flags = view.getUint16(i + 14, true);
    if ((flags & 7) !== 0) return;
    let off = 0;
    for (const e of curSats) {
      if (off + 16 >= len) break;
      if (!e.prn) continue;
      const master = readPrRate(i + 16, off);
      off += master.size;
      if (master.value === -268435455) continue; // no Doppler for this sat
      const refPrRate = ref.sats[e.navsys]![e.svid]?.prRate ?? 0;
      const m = e.slots[0];
      const mD = m
        ? (-(master.value + refPrRate * 64) * 0.001) / (CLIGHT / m.freq)
        : 0;
      if (m) m.doppler = mD;
      for (let k = 1; k < e.slots.length; k++) {
        const slot = e.slots[k];
        if (!slot) break;
        const slave = readPrRate(i + 16, off);
        off += slave.size;
        if (m)
          slot.doppler =
            ((mD * (CLIGHT / m.freq) * 1000 - slave.value) * 0.001) /
            (CLIGHT / slot.freq);
      }
    }
  };

  /* ── MeasEpoch (4027): classic Type1/Type2 sub-blocks ────────── */
  const decodeMeasEpoch = (i: number, len: number) => {
    const n1 = data[i + 14]!;
    const len1 = data[i + 15]!;
    const len2 = data[i + 16]!;
    if ((data[i + 17]! & 0x80) !== 0) return; // scrambled measurements
    const end = i + len;
    let p = i + 20;
    for (let b1 = 0; b1 < n1 && p + 20 <= end; b1++) {
      const ant = data[p + 1]! >> 5;
      let sig = data[p + 1]! & 0x1f;
      const svid = data[p + 2]!;
      const misc = data[p + 3]!;
      const info = data[p + 18]!;
      const n2 = data[p + 19]!;
      let fcn = 0;
      if (sig === 31) sig = (info >> 3) + 32;
      else if (sig >= 8 && sig <= 11) fcn = (info >> 3) - 8;

      const prn = svidToPrn(svid);
      const sigDef = MEAS2_SIG[sig] ?? null;
      if (ant !== 0 || !prn || !sigDef || sigDef[0] !== prn[0]) {
        p += len1 + len2 * n2; // skip block and its sub-blocks
        continue;
      }
      const [sys, code] = sigDef;
      const freq1 = carrierFreq(sys, code, fcn);

      const codeLsb = view.getUint32(p + 4, true);
      const dopplerRaw = view.getInt32(p + 8, true);
      const carrierLsb = view.getUint16(p + 12, true);
      const carrierMsb = view.getInt8(p + 14);
      const cn0Raw = data[p + 15]!;
      const lock = view.getUint16(p + 16, true);

      let p1 = 0;
      if ((misc & 0x0f) !== 0 || codeLsb !== 0)
        p1 = (misc & 0x0f) * 4294967.296 + codeLsb * 0.001;
      const d1 = dopplerRaw !== -2147483648 ? dopplerRaw * 0.0001 : null;
      let l1 = 0;
      if (
        p1 !== 0 &&
        freq1 > 0 &&
        lock !== 65535 &&
        (carrierMsb !== -128 || carrierLsb !== 0)
      )
        l1 = (p1 * freq1) / CLIGHT + carrierMsb * 65.536 + carrierLsb * 0.001;
      const cn0 =
        cn0Raw !== 255
          ? cn0Raw * 0.25 + (sig === 1 || sig === 2 ? 0 : 10)
          : null;

      curMeas.push({
        prn,
        sys,
        code,
        freq: freq1,
        pr: p1,
        cp: l1,
        cn0,
        doppler: d1,
        lockTimeMs: lock !== 65535 ? lock * 1000 : null,
      });

      p += len1;
      for (let b2 = 0; b2 < n2 && p + 12 <= end; b2++, p += len2) {
        let sig2 = data[p]! & 0x1f;
        const ant2 = data[p]! >> 5;
        const lock2 = data[p + 1]!;
        const cn0Raw2 = data[p + 2]!;
        const offsetsMsb = data[p + 3]!;
        const carrierMsb2 = view.getInt8(p + 4);
        const info2 = data[p + 5]!;
        if (sig2 === 31) sig2 = (info2 >> 3) + 32;
        const sigDef2 = MEAS2_SIG[sig2] ?? null;
        if (ant2 !== 0 || !sigDef2 || sigDef2[0] !== prn[0]) continue;
        const code2 = sigDef2[1];
        const freq2 = carrierFreq(sys, code2, fcn);

        // OffsetsMSB: two's-complement 3-bit code + 5-bit Doppler MSBs
        const codeOffMsb = ((offsetsMsb & 7) << 29) >> 29;
        const dopplerOffMsb = ((offsetsMsb >> 3) << 27) >> 27;
        const codeOffLsb = view.getUint16(p + 6, true);
        const carrierLsb2 = view.getUint16(p + 8, true);
        const dopplerOffLsb = view.getUint16(p + 10, true);

        let p2 = 0;
        if (p1 !== 0 && (codeOffMsb !== -4 || codeOffLsb !== 0))
          p2 = p1 + codeOffMsb * 65.536 + codeOffLsb * 0.001;
        let l2 = 0;
        if (
          p2 !== 0 &&
          freq2 > 0 &&
          (carrierMsb2 !== -128 || carrierLsb2 !== 0)
        )
          l2 =
            (p2 * freq2) / CLIGHT + carrierMsb2 * 65.536 + carrierLsb2 * 0.001;
        let d2: number | null = null;
        if (
          d1 !== null &&
          freq1 > 0 &&
          freq2 > 0 &&
          (dopplerOffMsb !== -16 || dopplerOffLsb !== 0)
        )
          d2 =
            (d1 * freq2) / freq1 +
            dopplerOffMsb * 6.5536 +
            dopplerOffLsb * 0.0001;
        const cn02 =
          cn0Raw2 !== 255
            ? cn0Raw2 * 0.25 + (sig2 === 1 || sig2 === 2 ? 0 : 10)
            : null;

        curMeas.push({
          prn,
          sys,
          code: code2,
          freq: freq2,
          pr: p2,
          cp: l2,
          cn0: cn02,
          doppler: d2,
          lockTimeMs: lock2 !== 255 ? lock2 * 1000 : null,
        });
      }
    }
  };

  /* ── frame scan ──────────────────────────────────────────────── */
  const badCrc = scanSbfFrames(data, view, (id, i, len) => {
    const key = String(id);
    messageCounts[key] = (messageCounts[key] ?? 0) + 1;

    if (
      (id === 4027 || id === 4109 || id === 4110 || id === 4111) &&
      len >= 16
    ) {
      const tow = view.getUint32(i + 8, true);
      const wnc = view.getUint16(i + 12, true);
      if (tow !== 4294967295 && wnc !== 65535) {
        ensureEpoch(GPS_EPOCH_MS + wnc * MS_PER_WEEK + tow);
        if (id === 4109) decodeMeas3Ranges(i, tow);
        else if (id === 4110) decodeMeas3CN0(i, len);
        else if (id === 4111) decodeMeas3Doppler(i, len);
        else decodeMeasEpoch(i, len);
      }
    }
  });
  flush();

  return { epochs, messageCounts, obsCodes, badCrc };
}

export {
  parseSbfGalNav,
  type SbfGalNavResult,
  type SbfGalEphemeris,
} from './rawnav-gal';

export {
  parseSbfBdsNav,
  parseSbfGloNav,
  type SbfBdsNavResult,
  type SbfGloNavResult,
} from './rawnav-bds';

export {
  parseSbfHas,
  type SbfHasResult,
  type SbfHasMessage,
  type HasMessage,
} from './rawnav-has';
