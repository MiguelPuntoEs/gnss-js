/**
 * RTCM3 MSM4–7 encoder — the inverse of `decodeMsmFull`.
 *
 * Turns observation epochs (the neutral `ObsSatObs` shape, from any receiver
 * decoder or a decoded RTCM stream) into framed MSM messages, one or more per
 * system, splitting a system across messages when its cell mask would exceed
 * 64 cells.
 *
 * Stateful: lock-time indicators must only decrease on a real loss of lock
 * (that is how a rover detects cycle slips), so the encoder tracks every
 * satellite × signal arc across epochs. It also keeps carrier phase
 * representable: a phase whose integer ambiguity puts it more than ~1171 m
 * from the pseudorange is shifted by whole cycles once per arc.
 *
 * Reference: RTCM 10403.3 §3.5; RTKLIB rtcm3e.c (gen_msm_*).
 */

import {
  C_LIGHT,
  GLO_F1_BASE,
  GLO_F1_STEP,
  GLO_F2_BASE,
  GLO_F2_STEP,
} from '../constants/gnss';
import {
  MILLISECONDS_IN_WEEK,
  START_BDS_TIME,
  START_GPS_TIME,
} from '../constants/time';
import { getGpsLeap } from '../time/utc';
import { msmSignalFrequency, msmSignalIndex } from './msm';
import type { ObsSignal } from './msm';
import { BitWriter, frameRtcm3 } from './writer';

/* ================================================================== */
/*  Public types                                                       */
/* ================================================================== */

/** MSM level: 4/6 carry range, phase, lock and C/N0; 5/7 add Doppler. 6/7 are high resolution. */
export type MsmLevel = 4 | 5 | 6 | 7;

/** One signal to encode. `wavelength` may be omitted except for GLONASS FDMA without a known channel. */
export interface MsmEncodeSignal extends Omit<ObsSignal, 'wavelength'> {
  wavelength?: number;
  /** Loss of lock / cycle slip flagged by the source (RINEX LLI bit 0). */
  slip?: boolean;
}

/** One satellite to encode. PRN in RINEX form (`G05`, `R12`, `J01`, `S23`). */
export interface MsmEncodeSat {
  prn: string;
  signals: MsmEncodeSignal[];
}

/** One observation epoch, all systems together. */
export interface MsmEncodeEpoch {
  /** Epoch on the library's GPS-scale millisecond axis (as `obsEpochToDate`). */
  timeMs: number;
  observations: MsmEncodeSat[];
}

export interface MsmEncoderOptions {
  /** MSM level (default 7). */
  msm?: MsmLevel;
  /** Reference station ID, DF003 (0–4095, default 0). */
  stationId?: number;
  /** Systems to encode (default all: G R E S J C I). */
  systems?: readonly string[];
  /** DF411 receiver clock steering: 0 none, 1 steered, 2 unknown (default 0). */
  clockSteering?: 0 | 1 | 2;
  /** DF412 external clock: 0 internal, 1 external locked, 2 external unlocked, 3 unknown (default 0). */
  externalClock?: 0 | 1 | 2 | 3;
  /**
   * GLONASS frequency channels by slot (k = −7…+6), used when a GLONASS
   * FDMA signal carries no wavelength — e.g. from a decoded 1020 ephemeris.
   */
  gloChannels?: ReadonlyMap<number, number>;
}

/* ================================================================== */
/*  Constants                                                          */
/* ================================================================== */

const RANGE_MS = C_LIGHT / 1000; // metres per light-millisecond

/** MSM message number base per system (+ level gives 1074, 1087, …). */
const MSM_BASE: Record<string, number> = {
  G: 1070,
  R: 1080,
  E: 1090,
  S: 1100,
  J: 1110,
  C: 1120,
  I: 1130,
};

const SYSTEM_ORDER = ['G', 'R', 'E', 'S', 'J', 'C', 'I'];

/** DF402 lock-time indicator table, seconds (must match the decoder's). */
const LTI_TABLE_4BIT = [
  0, 0.032, 0.064, 0.128, 0.256, 0.512, 1.024, 2.048, 4.096, 8.192, 16.384,
  32.768, 65.536, 131.072, 262.144, 524.288,
];

/** Maximum cells (satellites × signals) in one MSM message. */
const MAX_CELLS = 64;

/* ================================================================== */
/*  Field helpers                                                      */
/* ================================================================== */

/** DF402: 4-bit lock-time indicator (largest table entry ≤ t). */
export function lockTimeIndicator4(seconds: number): number {
  let lti = 0;
  for (let i = 1; i < LTI_TABLE_4BIT.length; i++) {
    if (LTI_TABLE_4BIT[i]! <= seconds + 1e-9) lti = i;
  }
  return lti;
}

/** DF407: 10-bit extended lock-time indicator. */
export function lockTimeIndicator10(seconds: number): number {
  const ms = Math.floor(seconds * 1000 + 1e-6);
  if (ms < 64) return Math.max(0, ms);
  // [2^(n+6), 2^(n+7)) ms maps to 64+32n … in steps of 2^(n+1) ms.
  const n = Math.floor(Math.log2(ms)) - 6;
  if (n >= 20) return 704;
  return 64 + 32 * n + Math.floor((ms - 2 ** (n + 6)) / 2 ** (n + 1));
}

/** MSM satellite-mask position (1–64) of a RINEX PRN, or 0. */
export function msmSatelliteId(sys: string, num: number): number {
  let id = num;
  if (sys === 'J' && num >= 193) id = num - 192;
  else if (sys === 'S') id = num >= 120 ? num - 119 : num - 19;
  return id >= 1 && id <= 64 ? id : 0;
}

/** GLONASS FDMA channel implied by a wavelength on band 1 or 2. */
function gloChannelFromWavelength(band: string, wavelength: number): number {
  const f = C_LIGHT / wavelength;
  const k =
    band === '1'
      ? (f - GLO_F1_BASE) / GLO_F1_STEP
      : (f - GLO_F2_BASE) / GLO_F2_STEP;
  return Math.round(k);
}

/**
 * MSM epoch time field for a system: DF004 GPS TOW ms (also Galileo, QZSS,
 * SBAS, NavIC), DF427 BDS TOW ms, or DF416+DF034 GLONASS day-of-week and
 * Moscow-time ms of day.
 */
export function msmEpochField(sys: string, gpsMs: number): number {
  const mod = (a: number, b: number) => ((a % b) + b) % b;
  const t = Math.round(gpsMs);
  if (sys === 'C') {
    return mod(t - START_BDS_TIME.getTime(), MILLISECONDS_IN_WEEK);
  }
  if (sys === 'R') {
    const day = 86400000;
    const utc = t - getGpsLeap(new Date(t)) * 1000;
    const moscow = utc + 3 * 3600000;
    const dow = mod(Math.floor(moscow / day) + 4, 7); // 1970-01-01 was a Thursday
    return dow * 2 ** 27 + mod(moscow, day);
  }
  return mod(t - START_GPS_TIME.getTime(), MILLISECONDS_IN_WEEK);
}

/* ================================================================== */
/*  Internal per-epoch records                                         */
/* ================================================================== */

interface Cell {
  sigIdx: number;
  /** Fine values already scaled to integers, or null = invalid. */
  psr: number | null;
  phase: number | null;
  dop: number | null;
  lti: number;
  halfCycle: boolean;
  cnr: number;
}

interface Sat {
  id: number; // 1-64
  roughInt: number; // DF397
  roughMod: number; // DF398
  rate: number | null; // DF399 m/s
  ext: number; // DF419-ish extended info
  cells: Cell[]; // sorted by sigIdx
}

interface ArcState {
  lockStartMs: number;
  /** Receiver-reported lock time at the previous epoch, seconds. */
  inputLock?: number;
  lastSeenMs: number;
  /** Whole cycles added to the input phase for this arc. */
  cycles: number;
  /** Receiver lock time still describes this arc (not slip-flagged or re-anchored). */
  trustInput: boolean;
}

/* ================================================================== */
/*  Encoder                                                            */
/* ================================================================== */

/** Stateful MSM encoder: feed epochs in time order, get framed messages out. */
export class MsmEncoder {
  readonly level: MsmLevel;
  readonly stationId: number;
  private readonly clockSteering: number;
  private readonly externalClock: number;
  private readonly systems: Set<string>;
  private readonly gloChannels: ReadonlyMap<number, number>;
  private readonly arcs = new Map<string, ArcState>();
  private readonly lastEpoch = new Map<string, number>();

  constructor(opts: MsmEncoderOptions = {}) {
    this.level = opts.msm ?? 7;
    this.stationId = opts.stationId ?? 0;
    if (
      !Number.isInteger(this.stationId) ||
      this.stationId < 0 ||
      this.stationId > 4095
    ) {
      throw new RangeError(`station ID ${this.stationId} outside 0–4095`);
    }
    this.clockSteering = opts.clockSteering ?? 0;
    this.externalClock = opts.externalClock ?? 0;
    this.systems = new Set(opts.systems ?? SYSTEM_ORDER);
    this.gloChannels = opts.gloChannels ?? new Map();
  }

  /** Forget all lock arcs (e.g. when the source restarts). */
  reset(): void {
    this.arcs.clear();
    this.lastEpoch.clear();
  }

  /**
   * Encode one epoch into framed RTCM3 MSM messages, systems in RTCM order.
   * The multiple-message bit is set on every message but the last.
   */
  encode(epoch: MsmEncodeEpoch): Uint8Array[] {
    const bySystem = new Map<string, Array<[number, MsmEncodeSat]>>();
    for (const sat of epoch.observations) {
      const m = /^([GRECJIS])(\d+)$/.exec(sat.prn);
      if (!m) continue;
      const sys = m[1]!;
      if (!this.systems.has(sys)) continue;
      const id = msmSatelliteId(sys, Number(m[2]));
      if (!id) continue;
      let list = bySystem.get(sys);
      if (!list) bySystem.set(sys, (list = []));
      list.push([id, sat]);
    }

    const payloads: Array<(multi: boolean) => Uint8Array> = [];
    for (const sys of SYSTEM_ORDER) {
      const list = bySystem.get(sys);
      if (!list) continue;
      const sats = this.buildSats(sys, epoch.timeMs, list);
      this.lastEpoch.set(sys, epoch.timeMs);
      const epochField = msmEpochField(sys, epoch.timeMs);
      for (const group of splitGroups(sats)) {
        payloads.push((multi) =>
          this.writeMessage(sys, epochField, multi, group)
        );
      }
    }
    return payloads.map((write, i) =>
      frameRtcm3(write(i < payloads.length - 1))
    );
  }

  /* ---------------------------------------------------------------- */

  private buildSats(
    sys: string,
    timeMs: number,
    list: Array<[number, MsmEncodeSat]>
  ): Sat[] {
    const last = this.lastEpoch.get(sys);
    if (last !== undefined && timeMs < last) {
      // Time went backwards (source restarted): every arc is new.
      for (const key of [...this.arcs.keys()]) {
        if (key.startsWith(sys)) this.arcs.delete(key);
      }
    }

    const hiRes = this.level >= 6;
    const withDoppler = this.level === 5 || this.level === 7;
    const sats: Sat[] = [];

    list.sort((a, b) => a[0] - b[0]);
    for (const [id, sat] of list) {
      // Resolve each signal's mask position and wavelength (first wins).
      const sigs = new Map<number, { s: MsmEncodeSignal; lambda: number }>();
      let gloK: number | undefined =
        sys === 'R' ? this.gloChannels.get(id) : undefined;
      for (const s of sat.signals) {
        const idx = msmSignalIndex(sys, s.rinexCode);
        if (idx < 0 || sigs.has(idx)) continue;
        let lambda = s.wavelength ?? 0;
        if (
          sys === 'R' &&
          lambda > 0 &&
          (s.rinexCode[0] === '1' || s.rinexCode[0] === '2')
        ) {
          gloK ??= gloChannelFromWavelength(s.rinexCode[0]!, lambda);
        }
        if (!(lambda > 0)) {
          const f = msmSignalFrequency(sys, idx);
          lambda = f > 0 ? C_LIGHT / f : 0;
        }
        sigs.set(idx, { s, lambda });
      }
      if (sys === 'R' && gloK !== undefined) {
        for (const [idx, v] of sigs) {
          if (v.lambda > 0) continue;
          const band = v.s.rinexCode[0];
          const f =
            band === '1'
              ? GLO_F1_BASE + gloK * GLO_F1_STEP
              : band === '2'
                ? GLO_F2_BASE + gloK * GLO_F2_STEP
                : 0;
          if (f > 0) sigs.set(idx, { s: v.s, lambda: C_LIGHT / f });
        }
      }
      const order = [...sigs.keys()].sort((a, b) => a - b);
      if (order.length === 0) continue;

      // Rough range: mean of the pseudoranges (else of the phase ranges),
      // rounded to 2^-10 ms. Centres every fine value; matches Trimble
      // receivers bit for bit (RTKLIB takes the first signal instead).
      let sum = 0;
      let n = 0;
      for (const idx of order) {
        const pr = sigs.get(idx)!.s.pseudorange;
        if (pr !== undefined && pr > 0) {
          sum += pr;
          n++;
        }
      }
      if (n === 0) {
        for (const idx of order) {
          const { s, lambda } = sigs.get(idx)!;
          if (s.phase !== undefined && lambda > 0 && s.phase > 0) {
            const arc = this.arcs.get(`${sys}${id}/${idx}`);
            sum += (s.phase + (arc?.cycles ?? 0)) * lambda;
            n++;
          }
        }
      }
      const rough = n > 0 ? sum / n : 0;
      const roughMs = Math.round((rough / RANGE_MS) * 1024) / 1024;
      if (!(roughMs > 0) || roughMs >= 255) continue;
      const roughM = roughMs * RANGE_MS;
      const roughInt = Math.floor(roughMs);
      const roughMod = Math.round((roughMs - roughInt) * 1024);

      // Rough phase-range rate: first Doppler, rounded to 1 m/s.
      let rate: number | null = null;
      if (withDoppler) {
        for (const idx of order) {
          const { s, lambda } = sigs.get(idx)!;
          if (s.doppler !== undefined && lambda > 0) {
            const r = Math.round(-s.doppler * lambda);
            if (Math.abs(r) < 8192) rate = r;
            break;
          }
        }
      }

      const cells: Cell[] = [];
      for (const idx of order) {
        const { s, lambda } = sigs.get(idx)!;
        const arc = this.updateArc(`${sys}${id}/${idx}`, timeMs, s);

        // Pseudorange: DF400 (2^-24 ms, 15 bit) / DF405 (2^-29 ms, 20 bit).
        let psr: number | null = null;
        if (s.pseudorange !== undefined && s.pseudorange > 0) {
          const scale = hiRes ? 2 ** 29 : 2 ** 24;
          const lim = hiRes ? 2 ** 19 : 2 ** 14;
          const v = Math.round(((s.pseudorange - roughM) / RANGE_MS) * scale);
          if (Math.abs(v) < lim) psr = v;
        }

        // Phase range: DF401 (2^-29 ms, 22 bit) / DF406 (2^-31 ms, 24 bit).
        let phase: number | null = null;
        if (s.phase !== undefined && lambda > 0) {
          const scale = hiRes ? 2 ** 31 : 2 ** 29;
          const lim = hiRes ? 2 ** 23 : 2 ** 21;
          const toField = (cycles: number) =>
            Math.round(
              (((s.phase! + cycles) * lambda - roughM) / RANGE_MS) * scale
            );
          let v = toField(arc.cycles);
          if (Math.abs(v) >= lim && s.pseudorange !== undefined) {
            // Ambiguity puts the phase out of range: re-anchor it near the
            // pseudorange. That changes the ambiguity, so restart the arc.
            arc.cycles = Math.round(s.pseudorange / lambda - s.phase);
            arc.lockStartMs = timeMs;
            arc.trustInput = false;
            v = toField(arc.cycles);
          }
          if (Math.abs(v) < lim) phase = v;
        }
        if (psr === null && phase === null) continue;

        // Fine phase-range rate: DF404, 0.0001 m/s, 15 bit.
        let dop: number | null = null;
        if (
          withDoppler &&
          rate !== null &&
          s.doppler !== undefined &&
          lambda > 0
        ) {
          const v = Math.round((-s.doppler * lambda - rate) / 0.0001);
          if (Math.abs(v) < 2 ** 14) dop = v;
        }

        // Own arc age, raised to the receiver's figure when that is finer
        // (a quantized input lock time would otherwise make us lag a step).
        let lockS = (timeMs - arc.lockStartMs) / 1000;
        if (arc.trustInput && s.lockTime !== undefined && s.lockTime > lockS) {
          lockS = s.lockTime;
        }
        const cn0 = s.cn0 ?? 0;
        cells.push({
          sigIdx: idx,
          psr,
          phase,
          dop,
          lti: hiRes ? lockTimeIndicator10(lockS) : lockTimeIndicator4(lockS),
          halfCycle: s.halfCycle === true,
          cnr: hiRes
            ? Math.min(1023, Math.max(0, Math.round(cn0 * 16)))
            : Math.min(63, Math.max(0, Math.round(cn0))),
        });
      }
      if (cells.length === 0) continue;

      // DF419: GLONASS channel k+7 (15 = unknown); reserved 0 elsewhere.
      let ext = 0;
      if (sys === 'R') {
        ext = gloK !== undefined && gloK >= -7 && gloK <= 6 ? gloK + 7 : 15;
      }
      sats.push({ id, roughInt, roughMod, rate, ext, cells });
    }
    return sats;
  }

  /** Advance (or restart) the lock arc of one satellite × signal. */
  private updateArc(key: string, timeMs: number, s: MsmEncodeSignal): ArcState {
    const prev = this.arcs.get(key);
    const sysLast = this.lastEpoch.get(key[0]!);
    let restart = !prev || s.slip === true || timeMs < prev.lastSeenMs;
    if (!restart && prev) {
      if (s.lockTime !== undefined && prev.inputLock !== undefined) {
        // The receiver knows best: lock time only drops on a real loss.
        restart = s.lockTime < prev.inputLock;
      } else {
        // No lock time: continuity means present in every epoch of its
        // system (epochs without the system at all don't count, so systems
        // may be fed in separate calls).
        restart = prev.lastSeenMs !== sysLast;
      }
    }
    if (restart || !prev) {
      const arc: ArcState = {
        lockStartMs: timeMs - (s.slip === true ? 0 : (s.lockTime ?? 0) * 1000),
        inputLock: s.lockTime,
        lastSeenMs: timeMs,
        cycles: 0,
        trustInput: s.slip !== true,
      };
      this.arcs.set(key, arc);
      return arc;
    }
    prev.inputLock = s.lockTime;
    prev.lastSeenMs = timeMs;
    return prev;
  }

  private writeMessage(
    sys: string,
    epochField: number,
    multi: boolean,
    sats: Sat[]
  ): Uint8Array {
    const level = this.level;
    const sigSet = new Set<number>();
    for (const sat of sats) for (const c of sat.cells) sigSet.add(c.sigIdx);
    const sigList = [...sigSet].sort((a, b) => a - b);

    const w = new BitWriter();
    w.writeU(MSM_BASE[sys]! + level, 12);
    w.writeU(this.stationId, 12);
    w.writeU(epochField, 30);
    w.writeU(multi ? 1 : 0, 1); // DF393 multiple message bit
    w.writeU(0, 3); // DF409 IODS
    w.zeros(7); // DF001 reserved
    w.writeU(this.clockSteering, 2); // DF411 clock steering
    w.writeU(this.externalClock, 2); // DF412 external clock
    w.writeU(0, 1); // DF417 divergence-free smoothing
    w.writeU(0, 3); // DF418 smoothing interval

    // DF394 satellite mask, DF395 signal mask, DF396 cell mask.
    const satIds = new Set(sats.map((s) => s.id));
    for (let i = 1; i <= 64; i++) w.writeU(satIds.has(i) ? 1 : 0, 1);
    for (let i = 0; i < 32; i++) w.writeU(sigSet.has(i) ? 1 : 0, 1);
    const cells: Cell[] = [];
    for (const sat of sats) {
      const bySig = new Map(sat.cells.map((c) => [c.sigIdx, c]));
      for (const idx of sigList) {
        const c = bySig.get(idx);
        w.writeU(c ? 1 : 0, 1);
        if (c) cells.push(c);
      }
    }

    // Satellite data.
    const ext = level === 5 || level === 7;
    for (const s of sats) w.writeU(s.roughInt, 8); // DF397
    if (ext) for (const s of sats) w.writeU(s.ext, 4); // DF419
    for (const s of sats) w.writeU(s.roughMod, 10); // DF398
    if (ext) for (const s of sats) w.writeS(s.rate ?? -8192, 14); // DF399

    // Signal data.
    const hiRes = level >= 6;
    const psrBits = hiRes ? 20 : 15;
    const phBits = hiRes ? 24 : 22;
    for (const c of cells) w.writeS(c.psr ?? -(2 ** (psrBits - 1)), psrBits);
    for (const c of cells) w.writeS(c.phase ?? -(2 ** (phBits - 1)), phBits);
    for (const c of cells) w.writeU(c.lti, hiRes ? 10 : 4);
    for (const c of cells) w.writeU(c.halfCycle ? 1 : 0, 1);
    for (const c of cells) w.writeU(c.cnr, hiRes ? 10 : 6);
    if (ext) for (const c of cells) w.writeS(c.dop ?? -16384, 15); // DF404
    return w.toBytes();
  }
}

/**
 * Split a system's satellites into groups whose cell mask (satellites ×
 * union of signals) fits the 64-cell limit, keeping satellite order.
 */
function splitGroups(sats: Sat[]): Sat[][] {
  const groups: Sat[][] = [];
  let group: Sat[] = [];
  let sigs = new Set<number>();
  for (const sat of sats) {
    const union = new Set(sigs);
    for (const c of sat.cells) union.add(c.sigIdx);
    if (group.length > 0 && (group.length + 1) * union.size > MAX_CELLS) {
      groups.push(group);
      group = [];
      sigs = new Set(sat.cells.map((c) => c.sigIdx));
    } else {
      sigs = union;
    }
    group.push(sat);
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

/** One-shot convenience: encode a single epoch with a fresh encoder. */
export function encodeMsm(
  epoch: MsmEncodeEpoch,
  opts: MsmEncoderOptions = {}
): Uint8Array[] {
  return new MsmEncoder(opts).encode(epoch);
}
