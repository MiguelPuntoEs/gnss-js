/**
 * Legacy RTCM3 observation encoder — the inverse of `decodeLegacyObs`:
 * GPS 1001–1004 and GLONASS 1009–1012 (L1 / L1+L2, basic / extended).
 * Older rovers, radios and machine-control systems often understand only
 * these, so a base that sends them reaches more equipment than MSM alone.
 *
 * Phase is carried relative to the (quantized) L1 pseudorange within
 * ±262 m (DF012/DF018); as in the MSM encoder, an arc whose ambiguity puts
 * it further out is shifted by whole cycles once and restarted, so the
 * phase stays continuous for every decoder. (RTKLIB instead wraps it into
 * ±750 cycles each epoch and relies on the decoder to unwrap.)
 *
 * Reference: RTCM 10403.3 §3.5.1–3.5.4; RTKLIB rtcm3e.c (gen_obs_gps/glo).
 */

import {
  C_LIGHT,
  GLO_F1_BASE,
  GLO_F1_STEP,
  GLO_F2_BASE,
  GLO_F2_STEP,
} from '../constants/gnss';
import { LockArcs } from './lock-arcs';
import { msmEpochField } from './msm-encode';
import type { MsmEncodeEpoch, MsmEncodeSignal } from './msm-encode';
import { BitWriter, frameRtcm3 } from './writer';

const PRUNIT_GPS = 299792.458;
const PRUNIT_GLO = 599584.916;
const LAM_GPS_L1 = C_LIGHT / 1575.42e6;
const LAM_GPS_L2 = C_LIGHT / 1227.6e6;
/** DF012/DF018 span: ±2^19 × 0.0005 m. */
const PPR_LIMIT = 2 ** 19;

/** Signal preference per band (RTKLIB's code priorities). */
const PREFER = {
  G1: ['1C', '1P', '1W', '1Y', '1N'],
  G2: ['2P', '2Y', '2W', '2C', '2N', '2D', '2S', '2L', '2X'],
  R1: ['1P', '1C'],
  R2: ['2P', '2C'],
} as const;

/** DF010 / DF039: 0 C/A, 1 P(Y). */
function code1(sys: string, code: string): number {
  return code === '1C' ? 0 : sys === 'R' ? (code === '1P' ? 1 : 0) : 1;
}

/** DF016 (GPS: 0 C/A or L2C, 1 P(Y) direct, 2 cross-correlated, 3 correlated P/Y) / DF046. */
function code2(sys: string, code: string): number {
  if (sys === 'R') return code === '2P' ? 1 : 0;
  switch (code[1]) {
    case 'P':
    case 'Y':
      return 1;
    case 'D':
      return 2;
    case 'W':
    case 'N':
      return 3;
    default:
      return 0;
  }
}

/**
 * DF013 / DF019 / DF043 / DF049: 7-bit lock-time indicator from seconds
 * (RTCM Table 3.4-2; RTKLIB `to_lock`). Monotonic, saturating at 127.
 */
export function legacyLockIndicator(seconds: number): number {
  const t = Math.floor(seconds);
  if (t < 0) return 0;
  if (t < 24) return t;
  if (t < 72) return Math.floor((t + 24) / 2);
  if (t < 168) return Math.floor((t + 120) / 4);
  if (t < 360) return Math.floor((t + 408) / 8);
  if (t < 744) return Math.floor((t + 1176) / 16);
  if (t < 937) return Math.floor((t + 3096) / 32);
  return 127;
}

export interface LegacyObsOptions {
  /** DF003 reference station ID (0–4095, default 0). */
  stationId?: number;
  /** L1+L2 (1003/1004, 1011/1012; default) or L1 only. */
  dual?: boolean;
  /** Extended types with the integer ms and C/N0 (default), or basic. */
  extended?: boolean;
  /** Systems to encode (default both, `['G', 'R']`). */
  systems?: readonly ('G' | 'R')[];
  /** GLONASS channels by slot, for signals without a wavelength. */
  gloChannels?: ReadonlyMap<number, number>;
}

interface Band {
  s: MsmEncodeSignal;
  lambda: number;
}

interface LegacySat {
  id: number;
  bytes: (w: BitWriter) => void;
}

/** Stateful legacy-obs encoder: feed epochs in time order. */
export class LegacyObsEncoder {
  readonly stationId: number;
  private readonly dual: boolean;
  private readonly extended: boolean;
  private readonly systems: Set<string>;
  private readonly gloChannels: Map<number, number>;
  private readonly arcs = new LockArcs(legacyLockIndicator);

  constructor(opts: LegacyObsOptions = {}) {
    this.stationId = opts.stationId ?? 0;
    if (
      !Number.isInteger(this.stationId) ||
      this.stationId < 0 ||
      this.stationId > 4095
    ) {
      throw new RangeError(`station ID ${this.stationId} outside 0–4095`);
    }
    this.dual = opts.dual ?? true;
    this.extended = opts.extended ?? true;
    this.systems = new Set(opts.systems ?? ['G', 'R']);
    this.gloChannels = new Map(opts.gloChannels);
  }

  /** Message number for a system with this encoder's variant. */
  messageType(sys: 'G' | 'R'): number {
    const base = sys === 'G' ? 1001 : 1009;
    return base + (this.dual ? 2 : 0) + (this.extended ? 1 : 0);
  }

  /** Learn a GLONASS slot's frequency channel (e.g. from its ephemeris). */
  setGloChannel(slot: number, k: number): void {
    if (slot >= 1 && slot <= 24 && k >= -7 && k <= 13) {
      this.gloChannels.set(slot, k);
    }
  }

  reset(): void {
    this.arcs.reset();
  }

  /**
   * Encode one epoch: GPS then GLONASS, at most 31 satellites per message,
   * DF005 (synchronous GNSS) set on every message but the last. Other
   * systems, and satellites without an L1 pseudorange, are skipped.
   */
  encode(epoch: MsmEncodeEpoch): Uint8Array[] {
    const payloads: Array<(sync: boolean) => Uint8Array> = [];
    for (const sys of ['G', 'R'] as const) {
      if (!this.systems.has(sys)) continue;
      const sats = epoch.observations
        .map((o) => {
          const m = /^([GR])(\d+)$/.exec(o.prn);
          return m && m[1] === sys ? { id: Number(m[2]), o } : null;
        })
        .filter((x) => x !== null)
        .filter(({ id }) => id >= 1 && id <= (sys === 'G' ? 32 : 24))
        .sort((a, b) => a.id - b.id);
      if (sats.length === 0) continue;

      this.arcs.beginEpoch(sys, epoch.timeMs);
      const built: LegacySat[] = [];
      for (const { id, o } of sats) {
        const sat = this.buildSat(sys, id, o.signals, epoch.timeMs);
        if (sat) built.push(sat);
      }
      this.arcs.endEpoch(sys, epoch.timeMs);

      const epochField =
        sys === 'G'
          ? msmEpochField('G', epoch.timeMs)
          : msmEpochField('R', epoch.timeMs) % 2 ** 27; // DF034 ms of day
      for (let i = 0; i < built.length; i += 31) {
        const group = built.slice(i, i + 31);
        payloads.push((sync) => this.write(sys, epochField, sync, group));
      }
    }
    return payloads.map((write, i) =>
      frameRtcm3(write(i < payloads.length - 1))
    );
  }

  /* ---------------------------------------------------------------- */

  private wavelength(
    sys: string,
    id: number,
    band: '1' | '2',
    s: MsmEncodeSignal
  ): number {
    if (s.wavelength && s.wavelength > 0) return s.wavelength;
    if (sys === 'G') return band === '1' ? LAM_GPS_L1 : LAM_GPS_L2;
    const k = this.gloChannels.get(id);
    if (k === undefined) return 0;
    return band === '1'
      ? C_LIGHT / (GLO_F1_BASE + k * GLO_F1_STEP)
      : C_LIGHT / (GLO_F2_BASE + k * GLO_F2_STEP);
  }

  private pick(
    sys: string,
    id: number,
    band: '1' | '2',
    signals: readonly MsmEncodeSignal[]
  ): Band | null {
    for (const code of PREFER[`${sys as 'G' | 'R'}${band}`]) {
      const s = signals.find((x) => x.rinexCode === code);
      if (s && (s.pseudorange !== undefined || s.phase !== undefined)) {
        return { s, lambda: this.wavelength(sys, id, band, s) };
      }
    }
    return null;
  }

  /** Phase-range minus `pr1q` in 0.5 mm units, re-anchoring the arc if needed. */
  private ppr(
    key: string,
    b: Band,
    pr1q: number,
    timeMs: number
  ): { value: number | null; lti: number } {
    const arc = this.arcs.update(key, timeMs, b.s);
    let value: number | null = null;
    if (b.s.phase !== undefined && b.lambda > 0) {
      const field = (cycles: number) =>
        Math.round(((b.s.phase! + cycles) * b.lambda - pr1q) / 0.0005);
      let v = field(arc.cycles);
      if (Math.abs(v) >= PPR_LIMIT) {
        this.arcs.reanchor(
          arc,
          Math.round(pr1q / b.lambda - b.s.phase),
          timeMs
        );
        v = field(arc.cycles);
      }
      if (Math.abs(v) < PPR_LIMIT) value = v;
    }
    return { value, lti: this.arcs.indicator(arc, timeMs, b.s) };
  }

  private buildSat(
    sys: 'G' | 'R',
    id: number,
    signals: readonly MsmEncodeSignal[],
    timeMs: number
  ): LegacySat | null {
    const l1 = this.pick(sys, id, '1', signals);
    if (!l1 || !(l1.s.pseudorange! > 0)) return null;
    const l2 = this.dual ? this.pick(sys, id, '2', signals) : null;

    // GLONASS channel (DF040, k + 7) from the L1 wavelength.
    let fcn = 0;
    if (sys === 'R') {
      const k =
        l1.lambda > 0
          ? Math.round((C_LIGHT / l1.lambda - GLO_F1_BASE) / GLO_F1_STEP)
          : this.gloChannels.get(id);
      if (k === undefined) return null; // DF040 is mandatory
      fcn = k + 7;
    }

    // L1 pseudorange: modulus (DF011/DF041, 0.02 m) + whole units (DF014/DF044).
    const unit = sys === 'G' ? PRUNIT_GPS : PRUNIT_GLO;
    const pr = l1.s.pseudorange!;
    let amb = Math.floor(pr / unit);
    let pr1 = Math.round((pr - amb * unit) / 0.02);
    if (pr1 * 0.02 >= unit) {
      amb += 1;
      pr1 = Math.round((pr - amb * unit) / 0.02);
    }
    if (amb > (sys === 'G' ? 255 : 127)) return null;
    // Every other field is relative to the L1 pseudorange as decoded.
    const pr1q = pr1 * 0.02 + amb * unit;

    const p1 = this.ppr(`${sys}${id}/1`, l1, pr1q, timeMs);
    const cnr = (b: Band) =>
      Math.min(255, Math.max(0, Math.round((b.s.cn0 ?? 0) * 4)));

    let p2: { value: number | null; lti: number } | null = null;
    let pr21: number | null = null;
    if (l2) {
      p2 = this.ppr(`${sys}${id}/2`, l2, pr1q, timeMs);
      if (l2.s.pseudorange !== undefined && l2.s.pseudorange > 0) {
        const v = Math.round((l2.s.pseudorange - pr1q) / 0.02);
        if (Math.abs(v) < 2 ** 13) pr21 = v;
      }
    }

    const ext = this.extended;
    return {
      id,
      bytes: (w) => {
        w.writeU(id, 6); // DF009 / DF038
        w.writeU(code1(sys, l1.s.rinexCode), 1); // DF010 / DF039
        if (sys === 'R') w.writeU(fcn, 5); // DF040
        w.writeU(pr1, sys === 'G' ? 24 : 25); // DF011 / DF041
        w.writeS(p1.value ?? -PPR_LIMIT, 20); // DF012 / DF042
        w.writeU(p1.lti, 7); // DF013 / DF043
        if (ext) {
          w.writeU(amb, sys === 'G' ? 8 : 7); // DF014 / DF044
          w.writeU(cnr(l1), 8); // DF015 / DF045
        }
        if (this.dual) {
          w.writeU(l2 ? code2(sys, l2.s.rinexCode) : 0, 2); // DF016 / DF046
          w.writeS(pr21 ?? -(2 ** 13), 14); // DF017 / DF047
          w.writeS(p2?.value ?? -PPR_LIMIT, 20); // DF018 / DF048
          w.writeU(p2?.lti ?? 0, 7); // DF019 / DF049
          if (ext) w.writeU(l2 ? cnr(l2) : 0, 8); // DF020 / DF050
        }
      },
    };
  }

  private write(
    sys: 'G' | 'R',
    epochField: number,
    sync: boolean,
    sats: LegacySat[]
  ): Uint8Array {
    const w = new BitWriter();
    w.writeU(this.messageType(sys), 12);
    w.writeU(this.stationId, 12);
    w.writeU(epochField, sys === 'G' ? 30 : 27); // DF004 / DF034
    w.writeU(sync ? 1 : 0, 1); // DF005
    w.writeU(sats.length, 5); // DF006 / DF035
    w.writeU(0, 1); // DF007 / DF036 divergence-free smoothing
    w.writeU(0, 3); // DF008 / DF037 smoothing interval
    for (const s of sats) s.bytes(w);
    return w.toBytes();
  }
}
