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
 * All four QC accumulators behind one observation callback, with an optional
 * elevation mask in front. Run two side by side (masked + unmasked) to get
 * both views from one parse.
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

  constructor(header: RinexHeader, opts: QualityOptions = {}) {
    this.mp = new MultipathAccumulator(header);
    this.iono = new IonoAccumulator(header);
    this.cs = new CycleSlipAccumulator(header, (time, prn, bands) => {
      this.mp.notifySlip(time, prn, bands);
      this.iono.notifySlip(time, prn, bands);
    });
    this.comp = new CompletenessAccumulator(header);
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
    if (this.maskDeg !== null) {
      const el = this.elevation!.elevationDeg(prn, time);
      if (el !== null && el < this.maskDeg) {
        this.belowMask++;
        return;
      }
    }
    this.cs.onObservation(time, prn, codes, values);
    this.mp.onObservation(time, prn, codes, values);
    this.iono.onObservation(time, prn, codes, values);
    this.comp.onObservation(time, prn, codes, values);
    this.tracking?.onObservation(time, prn, codes, values);
  };

  finalize(): QualityResult {
    return {
      cycleSlips: this.cs.finalize(),
      completeness: this.comp.finalize(),
      multipath: this.mp.finalize(),
      iono: this.iono.finalize(),
      maskDeg: this.maskDeg,
      belowMask: this.belowMask,
      tracking: this.tracking?.finalize() ?? null,
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
