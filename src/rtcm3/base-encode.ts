/**
 * Receiver raw data → RTCM3 reference-station stream: what str2str does
 * with `-out ...#rtcm3`, as a library. Feed observation epochs from any
 * receiver decoder (UBX RAWX, SBF Meas, NovAtel RANGE, Trimble RT27, BINEX)
 * plus the ephemerides they decode; get framed MSM, station and ephemeris
 * messages back, in stream order.
 */

import type { Ephemeris } from '../rinex/nav';
import type { EphemerisInfo } from './ephemeris';
import { encodeEphemeris, ephemerisToInfo } from './ephemeris-encode';
import type { EphemerisInfoExtras } from './ephemeris-encode';
import { MsmEncoder } from './msm-encode';
import type {
  MsmEncodeEpoch,
  MsmEncodeSat,
  MsmEncoderOptions,
  MsmEncodeSignal,
} from './msm-encode';
import { LegacyObsEncoder } from './legacy-encode';
import {
  encodeAntennaDescriptor,
  encodeStationArp,
  encodeStationDescriptors,
} from './station-encode';
import type { StationArp, StationDescriptors } from './station-encode';
import {
  C_LIGHT,
  GLO_F1_BASE,
  GLO_F1_STEP,
  GLO_F2_BASE,
  GLO_F2_STEP,
} from '../constants/gnss';

/* ================================================================== */
/*  Receiver measurements → MSM input                                  */
/* ================================================================== */

/**
 * The measurement shape every receiver decoder emits (UbxMeasurement,
 * SbfMeasurement, NovatelMeasurement, TrimbleMeasurement, BinexMeasurement
 * all satisfy it structurally).
 */
export interface RawMeasurement {
  prn: string;
  code: string;
  /** Pseudorange (m). */
  pr: number | null;
  /** Carrier phase (cycles). */
  cp: number | null;
  /** Doppler (Hz). */
  doppler: number | null;
  /** C/N0 (dB-Hz). */
  cn0: number | null;
  /** Lock time, ms (UBX, SBF) … */
  lockTimeMs?: number | null;
  /** … or seconds (NovAtel). */
  lockTimeS?: number;
  /** Half-cycle ambiguity unresolved (UBX). */
  halfCycleAmbiguous?: boolean;
  /** Loss of lock at this epoch (BINEX). */
  slip?: boolean;
  /** Rolling slip counter (Trimble). */
  cycleSlipCount?: number;
  /** GLONASS FDMA channel k (NovAtel, Trimble). */
  gloChannel?: number | null;
}

export interface RawEpoch {
  /** GPS-scale epoch, ms. */
  timeMs: number;
  meas: readonly RawMeasurement[];
}

function gloWavelength(code: string, k: number): number | undefined {
  if (code[0] === '1') return C_LIGHT / (GLO_F1_BASE + k * GLO_F1_STEP);
  if (code[0] === '2') return C_LIGHT / (GLO_F2_BASE + k * GLO_F2_STEP);
  return undefined;
}

/** Convert one receiver epoch to `MsmEncoder` input. */
export function rawEpochToMsm(epoch: RawEpoch): MsmEncodeEpoch {
  const sats = new Map<string, MsmEncodeSat>();
  for (const m of epoch.meas) {
    const sig: MsmEncodeSignal = { rinexCode: m.code };
    if (m.pr !== null && m.pr > 0) sig.pseudorange = m.pr;
    if (m.cp !== null && m.cp !== 0) sig.phase = m.cp;
    if (m.doppler !== null) sig.doppler = m.doppler;
    if (m.cn0 !== null && m.cn0 > 0) sig.cn0 = m.cn0;
    if (m.lockTimeMs !== undefined && m.lockTimeMs !== null) {
      sig.lockTime = m.lockTimeMs / 1000;
    } else if (m.lockTimeS !== undefined) {
      sig.lockTime = m.lockTimeS;
    }
    if (m.halfCycleAmbiguous) sig.halfCycle = true;
    if (m.slip) sig.slip = true;
    if (m.cycleSlipCount !== undefined) sig.slipCount = m.cycleSlipCount;
    if (m.prn[0] === 'R' && m.gloChannel != null) {
      sig.wavelength = gloWavelength(m.code, m.gloChannel);
    }
    let sat = sats.get(m.prn);
    if (!sat) sats.set(m.prn, (sat = { prn: m.prn, signals: [] }));
    sat.signals.push(sig);
  }
  return { timeMs: epoch.timeMs, observations: [...sats.values()] };
}

/* ================================================================== */
/*  Reference-station stream                                           */
/* ================================================================== */

export interface RtcmBaseOptions extends MsmEncoderOptions {
  /**
   * Antenna reference point. Sent as 1006 when it has an antenna height,
   * else 1005. Without it no position goes out — rovers need one for RTK.
   */
  arp?: Omit<StationArp, 'stationId'>;
  /**
   * Receiver/antenna descriptors for 1033 (antenna name matters for PCV);
   * in legacy mode also sent as 1007/1008, which older rovers read instead.
   */
  descriptors?: Omit<StationDescriptors, 'stationId'>;
  /**
   * Observation messages: MSM (default, every system, level from `msm`) or
   * legacy 1001–1012 (GPS and GLONASS L1/L2 only) for equipment that
   * predates MSM.
   */
  obs?: 'msm' | 'legacy';
  /** Legacy variant (default L1+L2 extended: 1004 + 1012). */
  legacy?: { dual?: boolean; extended?: boolean };
  /** Seconds between station messages (default 10; first epoch always). */
  stationIntervalS?: number;
  /**
   * Seconds between re-sends of every current ephemeris (default 0 = only
   * when new). Streams joined mid-way need a re-send; files do not.
   */
  ephemerisIntervalS?: number;
  /** Message content an `Ephemeris` lacks (URA, IODC, BGDs). */
  ephemerisExtras?: EphemerisInfoExtras;
}

interface KnownEph {
  key: string;
  info: EphemerisInfo;
  tocMs: number;
}

/** Ephemerides this far behind the newest epoch are forgotten. */
const EPH_KEEP_MS = 6 * 3600_000;

/**
 * Stateful reference-station encoder. Call `addEphemerides` whenever the
 * receiver decodes navigation data and `encodeEpoch` for every observation
 * epoch, in time order; concatenate the returned frames into the stream.
 */
export class RtcmBaseEncoder {
  readonly msm: MsmEncoder;
  /** Set in legacy mode (`obs: 'legacy'`). */
  readonly legacy: LegacyObsEncoder | null;
  private readonly opts: RtcmBaseOptions;
  private lastStationMs = -Infinity;
  private lastEphResendMs = -Infinity;
  /** Known ephemerides per satellite, sorted by toc. */
  private readonly known = new Map<string, KnownEph[]>();
  /** Ephemeris last sent per satellite. */
  private readonly sent = new Map<string, KnownEph>();

  constructor(opts: RtcmBaseOptions = {}) {
    this.opts = opts;
    this.msm = new MsmEncoder(opts);
    this.legacy =
      opts.obs === 'legacy'
        ? new LegacyObsEncoder({
            ...opts.legacy,
            stationId: opts.stationId,
            gloChannels: opts.gloChannels,
          })
        : null;
  }

  /**
   * Add broadcast ephemerides (duplicates ignored). At each epoch every
   * satellite's ephemeris with the toc nearest the epoch goes out when it
   * changes — the broadcast cadence without per-system rules (GPS switches
   * an hour before toe, GLONASS 15 min before tb, Galileo 5 min).
   */
  addEphemerides(ephs: Iterable<Ephemeris>): void {
    for (const eph of ephs) {
      if (eph.system === 'R') {
        this.msm.setGloChannel(Number(eph.prn.slice(1)), eph.freqNum);
        this.legacy?.setGloChannel(Number(eph.prn.slice(1)), eph.freqNum);
      }
      const info = ephemerisToInfo(eph, this.opts.ephemerisExtras);
      const tocMs = eph.tocDate.getTime();
      const key = `${tocMs}/${info.iode ?? ''}`;
      let list = this.known.get(eph.prn);
      if (!list) this.known.set(eph.prn, (list = []));
      if (list.some((k) => k.key === key)) continue;
      list.push({ key, info, tocMs });
      list.sort((x, y) => x.tocMs - y.tocMs);
    }
  }

  /** Encode one epoch: due station and ephemeris messages, then its MSMs. */
  encodeEpoch(epoch: RawEpoch | MsmEncodeEpoch): Uint8Array[] {
    const t = epoch.timeMs;
    const out: Uint8Array[] = [];
    const stationId = this.msm.stationId;

    const every = (this.opts.stationIntervalS ?? 10) * 1000;
    if (t - this.lastStationMs >= every || t < this.lastStationMs) {
      if (this.opts.arp) {
        out.push(encodeStationArp({ ...this.opts.arp, stationId }));
      }
      if (this.opts.descriptors) {
        out.push(
          encodeStationDescriptors({ ...this.opts.descriptors, stationId })
        );
      }
      if (this.legacy && this.opts.descriptors) {
        out.push(
          encodeAntennaDescriptor({ ...this.opts.descriptors, stationId })
        );
      }
      this.lastStationMs = t;
    }

    for (const [prn, list] of this.known) {
      while (list.length > 1 && list[0]!.tocMs < t - EPH_KEEP_MS) list.shift();
      let best = list[0]!;
      for (const k of list) {
        if (Math.abs(k.tocMs - t) < Math.abs(best.tocMs - t)) best = k;
      }
      if (this.sent.get(prn)?.key !== best.key) {
        const bytes = encodeEphemeris(best.info);
        if (bytes) out.push(bytes);
        this.sent.set(prn, best);
      }
    }

    const resend = (this.opts.ephemerisIntervalS ?? 0) * 1000;
    if (resend > 0 && t - this.lastEphResendMs >= resend) {
      if (this.lastEphResendMs > -Infinity) {
        for (const p of this.sent.values()) {
          const bytes = encodeEphemeris(p.info);
          if (bytes) out.push(bytes);
        }
      }
      this.lastEphResendMs = t;
    }

    const msmEpoch = 'meas' in epoch ? rawEpochToMsm(epoch) : epoch;
    out.push(...(this.legacy ?? this.msm).encode(msmEpoch));
    return out;
  }
}

/**
 * One-shot conversion of a decoded receiver log into an RTCM3 byte stream:
 * station messages, ephemerides as they come due, and MSMs per epoch.
 */
export function receiverToRtcm3(
  epochs: readonly RawEpoch[],
  ephemerides: Iterable<Ephemeris>,
  opts: RtcmBaseOptions = {}
): Uint8Array {
  const enc = new RtcmBaseEncoder(opts);
  enc.addEphemerides(ephemerides);
  const parts: Uint8Array[] = [];
  let size = 0;
  for (const e of epochs) {
    for (const f of enc.encodeEpoch(e)) {
      parts.push(f);
      size += f.length;
    }
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
