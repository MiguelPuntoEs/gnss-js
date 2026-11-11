/**
 * Combined quality analysis — runs cycle slip detection, data completeness,
 * multipath and ionosphere analysis in a single file re-parse pass.
 */

import type { RinexHeader } from '../rinex/parser';
import { parseRinexStream } from '../rinex/parser';
import { CycleSlipAccumulator } from './cycle-slip';
import type { CycleSlipResult } from './cycle-slip';
import { CompletenessAccumulator } from './completeness';
import type { CompletenessResult } from './completeness';
import { MultipathAccumulator } from './multipath';
import type { MultipathResult } from './multipath';
import { IonoAccumulator } from './ionosphere';
import type { IonoResult } from './ionosphere';
import { TrackingAccumulator } from './elevation-mask';
import type { ElevationModel, TrackingResult } from './elevation-mask';
import { ClockJumpDetector } from './clock-jumps';
import type { ClockJumpResult } from './clock-jumps';
import { ContinuityAccumulator } from './continuity';
import type { ContinuityResult } from './continuity';
import { SignalProfileAccumulator } from './signal-profile';
import { LossOfLockAccumulator } from './loss-of-lock';
import type { LossOfLockResult } from './loss-of-lock';
import { SatelliteAccumulator } from './satellites';
import {
  ReferenceMultipathAccumulator,
  type ReferenceMultipath,
} from './multipath-reference';
import type { SatelliteRow } from './satellites';
import type { SignalProfileResult } from './signal-profile';

export interface QualityResult {
  cycleSlips: CycleSlipResult;
  completeness: CompletenessResult;
  multipath: MultipathResult;
  iono: IonoResult;
  /**
   * Elevation cut-off the statistics were computed above (degrees), or null
   * when no mask was applied (no orbits, no receiver position, or none asked).
   */
  maskDeg?: number | null;
  /** Satellite-epochs dropped for being below the mask. */
  belowMask?: number;
  /** Above-mask tracking vs the orbits; null without an elevation model. */
  tracking?: TrackingResult | null;
  /** Receiver clock jumps (removed from the code before the other checks). */
  clockJumps?: ClockJumpResult;
  /** Gaps, short pieces, repeated epochs, usable epochs (all elevations). */
  continuity?: ContinuityResult;
  /** Observations by elevation per signal; C/N0 per signal above the mask. */
  signals?: SignalProfileResult;
  /** Code multipath by direction (needs orbits). */
  multipathSky?: MultipathSky | null;
  /** Loss-of-lock (LLI) statistics above the mask. */
  lossOfLock?: LossOfLockResult;
  /** One row per satellite (SpiderQC/teqc per-satellite table). */
  satellites?: SatelliteRow[];
  /** Multipath averaged as Anubis and teqc do — for comparison, not graded. */
  referenceMultipath?: ReferenceMultipath;
}

/**
 * Code multipath by direction: RMS of every signal's MP values pooled per
 * 30° azimuth × 10° elevation cell. Multipath comes from reflectors around
 * the antenna, so it is a property of directions — a bad sector points at the
 * wall, roof or mast causing it.
 */
export interface MultipathSky {
  azBinDeg: number;
  elBinDeg: number;
  /** [azBin][elBin] RMS (m), null with fewer than `minSamples`. */
  rms: (number | null)[][];
  n: number[][];
  minSamples: number;
  /** Median RMS over the cells above 15° — what "normal" is at this site. */
  medianRms: number | null;
  /** Highest-RMS cell above 15° elevation, if any qualifies. */
  worst: {
    fromAz: number;
    toAz: number;
    fromEl: number;
    toEl: number;
    rms: number;
  } | null;
}

const MP_AZ_BIN = 30;
const MP_EL_BIN = 10;
const MP_MIN_SAMPLES = 50;

function multipathSky(
  mp: MultipathResult,
  model: ElevationModel
): MultipathSky {
  const nAz = 360 / MP_AZ_BIN;
  const nEl = 90 / MP_EL_BIN;
  const sum2 = Array.from({ length: nAz }, () =>
    new Array<number>(nEl).fill(0)
  );
  const n = Array.from({ length: nAz }, () => new Array<number>(nEl).fill(0));
  for (const s of mp.series)
    for (const p of s.points) {
      const ae = model.azElDeg(s.prn, p.time);
      if (!ae || ae.el < 0) continue;
      const ia = Math.min(nAz - 1, Math.floor(ae.az / MP_AZ_BIN));
      const ie = Math.min(nEl - 1, Math.floor(ae.el / MP_EL_BIN));
      sum2[ia]![ie]! += p.mp * p.mp;
      n[ia]![ie]!++;
    }
  let worst: MultipathSky['worst'] = null;
  const rms = sum2.map((col, ia) =>
    col.map((x, ie) => {
      const k = n[ia]![ie]!;
      if (k < MP_MIN_SAMPLES) return null;
      const r = Math.sqrt(x / k);
      if (ie * MP_EL_BIN >= 15 && (!worst || r > worst.rms))
        worst = {
          fromAz: ia * MP_AZ_BIN,
          toAz: (ia + 1) * MP_AZ_BIN,
          fromEl: ie * MP_EL_BIN,
          toEl: (ie + 1) * MP_EL_BIN,
          rms: r,
        };
      return r;
    })
  );
  const above: number[] = [];
  rms.forEach((col) =>
    col.forEach((r, ie) => {
      if (r !== null && ie * MP_EL_BIN >= 15) above.push(r);
    })
  );
  above.sort((a, b) => a - b);
  return {
    azBinDeg: MP_AZ_BIN,
    elBinDeg: MP_EL_BIN,
    medianRms: above.length ? above[Math.floor(above.length / 2)]! : null,
    rms,
    n,
    minSamples: MP_MIN_SAMPLES,
    worst,
  };
}

export interface QualityOptions {
  /** Satellite elevations from broadcast orbits (see ElevationModel). */
  elevation?: ElevationModel | null;
  /**
   * Elevation cut-off in degrees, applied only with an elevation model.
   * Observations of satellites with no valid ephemeris are kept (unknown
   * elevation is not low elevation).
   */
  maskDeg?: number;
  /**
   * Also average multipath the way Anubis and teqc do, for comparison with
   * their reports (default true; costs a few seconds on a 1 Hz day).
   */
  referenceMultipath?: boolean;
}

/**
 * All QC accumulators behind one observation callback, with an optional
 * elevation mask in front. Run two side by side (masked + unmasked) to get
 * both views from one parse.
 *
 * Observations are buffered one epoch at a time (parsers deliver them epoch
 * by epoch): continuity and receiver clock jumps need the whole epoch, and a
 * millisecond clock jump must be taken out of the code before the slip and
 * multipath checks see it — otherwise it reads as a slip on every satellite.
 */
export class QualityAccumulator {
  private cs: CycleSlipAccumulator;
  private mp: MultipathAccumulator;
  private iono: IonoAccumulator;
  private comp: CompletenessAccumulator;
  private tracking: TrackingAccumulator | null = null;
  private elevation: ElevationModel | null;
  private maskDeg: number | null;
  private belowMask = 0;
  private clock: ClockJumpDetector;
  private continuity: ContinuityAccumulator;
  private profile = new SignalProfileAccumulator();
  private lock = new LossOfLockAccumulator();
  private sats = new SatelliteAccumulator();
  private ref: ReferenceMultipathAccumulator | null;
  /** Indices of pseudorange (C) observables, per code-list instance. */
  private codeIdx = new WeakMap<string[], number[]>();
  private epochTime: number | null = null;
  private epoch: {
    prn: string;
    codes: string[];
    values: (number | null)[];
    lli?: (number | null)[];
  }[] = [];

  constructor(header: RinexHeader, opts: QualityOptions = {}) {
    this.mp = new MultipathAccumulator(header);
    this.iono = new IonoAccumulator(header);
    this.cs = new CycleSlipAccumulator(header, (time, prn, bands) => {
      this.mp.notifySlip(time, prn, bands);
      this.iono.notifySlip(time, prn, bands);
    });
    this.comp = new CompletenessAccumulator(header);
    this.clock = new ClockJumpDetector(header);
    this.continuity = new ContinuityAccumulator(header);
    this.elevation = opts.elevation ?? null;
    this.maskDeg =
      this.elevation && opts.maskDeg != null && opts.maskDeg > 0
        ? opts.maskDeg
        : null;
    this.ref =
      opts.referenceMultipath === false
        ? null
        : new ReferenceMultipathAccumulator(header, this.maskDeg ?? 10);
    if (this.elevation)
      this.tracking = new TrackingAccumulator(
        this.elevation,
        this.maskDeg ?? 0,
        header.interval
      );
  }

  onObservation = (
    time: number,
    prn: string,
    codes: string[],
    values: (number | null)[],
    lli?: (number | null)[]
  ) => {
    if (this.epochTime !== null && time !== this.epochTime) this.flush();
    this.epochTime = time;
    // Callers may reuse their buffers between calls: keep copies.
    this.epoch.push({ prn, codes, values: values.slice(), lli: lli?.slice() });
  };

  private codeIndices(codes: string[]): number[] {
    let idx = this.codeIdx.get(codes);
    if (!idx) {
      idx = [];
      for (let i = 0; i < codes.length; i++)
        if (codes[i]![0] === 'C' || codes[i]![0] === 'P') idx.push(i);
      this.codeIdx.set(codes, idx);
    }
    return idx;
  }

  private flush() {
    const time = this.epochTime!;
    const obs = this.epoch;
    this.epoch = [];
    this.continuity.onEpoch(time, obs);
    const offset = this.clock.onEpoch(time, obs);
    for (const o of obs) {
      if (offset !== 0)
        for (const i of this.codeIndices(o.codes)) {
          const v = o.values[i];
          if (v != null && v !== 0) o.values[i] = v - offset;
        }
      const el = this.elevation
        ? this.elevation.elevationDeg(o.prn, time)
        : null;
      this.profile.onObservation(o.prn, o.codes, o.values, el);
      this.sats.onObservation(o.prn, el);
      this.tracking?.onObservation(time, o.prn, o.codes, o.values);
      this.ref?.onObservation(time, o.prn, o.codes, o.values, el);
      if (this.maskDeg !== null && el !== null && el < this.maskDeg) {
        this.belowMask++;
        continue;
      }
      this.profile.onGradedObservation(o.prn, o.codes, o.values);
      this.sats.onGradedObservation(o.prn, o.codes, o.values);
      this.lock.onObservation(o.prn, o.codes, o.values, o.lli);
      this.cs.onObservation(time, o.prn, o.codes, o.values);
      this.mp.onObservation(time, o.prn, o.codes, o.values);
      this.iono.onObservation(time, o.prn, o.codes, o.values);
      this.comp.onObservation(time, o.prn, o.codes, o.values);
    }
  }

  finalize(): QualityResult {
    if (this.epoch.length > 0) this.flush();
    const mp = this.mp.finalize();
    const cycleSlips = this.cs.finalize();
    const tracking = this.tracking?.finalize() ?? null;
    const lossOfLock = this.lock.finalize();
    // Slipped epochs per satellite, each slip once (events repeat per
    // combination that saw it).
    const slipEpochs = new Map<string, Set<number>>();
    for (const e of cycleSlips.events) {
      let set = slipEpochs.get(e.prn);
      if (!set) slipEpochs.set(e.prn, (set = new Set()));
      set.add(e.time);
    }
    const satellites = this.sats.finalize({
      prns: [
        ...mp.series.map((x) => x.prn),
        ...Object.keys(cycleSlips.satSlipCounts),
        ...(tracking?.timeline.rows ?? [])
          .filter((r) => r.tracked.some((x) => x > 0))
          .map((r) => r.prn),
      ],
      timeline: tracking?.timeline.rows,
      slips: Object.fromEntries(
        [...slipEpochs].map(([p, set]) => [p, set.size])
      ),
      lossOfLock: lossOfLock.perSatellite,
      multipath: mp.series,
    });
    return {
      cycleSlips,
      completeness: this.comp.finalize(),
      multipath: mp,
      iono: this.iono.finalize(),
      maskDeg: this.maskDeg,
      belowMask: this.belowMask,
      tracking,
      clockJumps: this.clock.finalize(),
      continuity: this.continuity.finalize(),
      signals: this.profile.finalize(),
      multipathSky: this.elevation ? multipathSky(mp, this.elevation) : null,
      lossOfLock,
      satellites,
      referenceMultipath: this.ref?.finalize(),
    };
  }
}

export async function analyzeQuality(
  file: File,
  header: RinexHeader,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
  opts: QualityOptions = {}
): Promise<QualityResult> {
  const qa = new QualityAccumulator(header, opts);
  await parseRinexStream(
    file,
    onProgress,
    signal,
    qa.onObservation,
    true /* workerMode: skip EpochSummary construction */
  );
  return qa.finalize();
}
