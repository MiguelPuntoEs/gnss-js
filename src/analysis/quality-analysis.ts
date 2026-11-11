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
  /** Indices of pseudorange (C) observables, per code-list instance. */
  private codeIdx = new WeakMap<string[], number[]>();
  private epochTime: number | null = null;
  private epoch: { prn: string; codes: string[]; values: (number | null)[] }[] =
    [];

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
    values: (number | null)[]
  ) => {
    if (this.epochTime !== null && time !== this.epochTime) this.flush();
    this.epochTime = time;
    // Callers may reuse their value buffer between calls: keep a copy.
    this.epoch.push({ prn, codes, values: values.slice() });
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
      this.tracking?.onObservation(time, o.prn, o.codes, o.values);
      if (this.maskDeg !== null && el !== null && el < this.maskDeg) {
        this.belowMask++;
        continue;
      }
      this.profile.onGradedObservation(o.prn, o.codes, o.values);
      this.cs.onObservation(time, o.prn, o.codes, o.values);
      this.mp.onObservation(time, o.prn, o.codes, o.values);
      this.iono.onObservation(time, o.prn, o.codes, o.values);
      this.comp.onObservation(time, o.prn, o.codes, o.values);
    }
  }

  finalize(): QualityResult {
    if (this.epoch.length > 0) this.flush();
    return {
      cycleSlips: this.cs.finalize(),
      completeness: this.comp.finalize(),
      multipath: this.mp.finalize(),
      iono: this.iono.finalize(),
      maskDeg: this.maskDeg,
      belowMask: this.belowMask,
      tracking: this.tracking?.finalize() ?? null,
      clockJumps: this.clock.finalize(),
      continuity: this.continuity.finalize(),
      signals: this.profile.finalize(),
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
