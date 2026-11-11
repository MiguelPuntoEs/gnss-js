/**
 * Receiver clock jump detection (teqc "No. of Rx clock offsets", Anubis
 * `nJmp`).
 *
 * Many receivers keep their clock within ±0.5 ms of GNSS time by resetting
 * it in 1 ms steps. If the reset is applied to the pseudoranges but not the
 * carrier phases (or the other way round), code minus phase jumps by
 * k × 299 792.458 m on every satellite in the same epoch. Left alone, that
 * looks like a cycle slip on every satellite at once and wrecks code
 * multipath; detected, it can be removed from the code before QC runs.
 */
import type { RinexHeader } from '../rinex/parser';
import {
  C_LIGHT,
  buildGloChannelMap,
  buildObsIndices,
  getFreq,
} from '../constants/gnss';

/** One millisecond of light travel (m). */
const MS_M = C_LIGHT * 1e-3;
/** Agreement needed between satellites for a common jump (m). */
const AGREE_M = 1000;
/** Smallest common step treated as a clock event at all (m). */
const MIN_JUMP_M = 0.1 * MS_M;

export interface ClockJump {
  /** Epoch (GPS-scale ms) of the first observation after the jump. */
  time: number;
  /** Size in milliseconds (integer for millisecond resets). */
  ms: number;
  /** True when the step is a whole number of milliseconds. */
  integerMs: boolean;
  /** Satellites that agreed / were compared. */
  agree: number;
  of: number;
}

export interface ClockJumpResult {
  jumps: ClockJump[];
  /** Epochs where code minus phase could be compared (≥ 3 satellites). */
  epochsChecked: number;
}

/**
 * Epoch-wise detector. Feed one whole epoch at a time; it returns the
 * cumulative code offset (m) to subtract from every pseudorange of that
 * epoch onwards so code and phase stay coherent.
 */
export class ClockJumpDetector {
  private idx: ReturnType<typeof buildObsIndices>;
  private glo: Record<string, number>;
  private prev = new Map<string, { time: number; d: number }>();
  private prevEpoch: number | null = null;
  private offset = 0;
  private jumps: ClockJump[] = [];
  private checked = 0;

  constructor(header: RinexHeader) {
    this.idx = buildObsIndices(header);
    this.glo = buildGloChannelMap(header.glonassSlots);
  }

  /** Code − phase (m) on the first band with both, or null. */
  private codeMinusPhase(
    prn: string,
    values: (number | null)[]
  ): number | null {
    const bands = this.idx.get(prn[0]!) ?? this.idx.get('_v2');
    if (!bands) return null;
    for (const [band, { L, C }] of bands) {
      if (C === null) continue;
      const c = values[C];
      const l = values[L];
      const f = getFreq(this.glo, prn, band);
      if (c == null || c === 0 || l == null || l === 0 || !f) continue;
      return c - l * (C_LIGHT / f);
    }
    return null;
  }

  /** Process one epoch; returns the cumulative code offset (m). */
  onEpoch(
    time: number,
    obs: readonly { prn: string; values: (number | null)[] }[]
  ): number {
    const deltas: number[] = [];
    const now = new Map<string, number>();
    for (const o of obs) {
      const d = this.codeMinusPhase(o.prn, o.values);
      if (d === null) continue;
      now.set(o.prn, d);
      const p = this.prev.get(o.prn);
      if (p && p.time === this.prevEpoch) deltas.push(d - p.d);
    }
    if (deltas.length >= 3) {
      this.checked++;
      const sorted = [...deltas].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)]!;
      if (Math.abs(med) > MIN_JUMP_M) {
        const agree = deltas.filter((x) => Math.abs(x - med) < AGREE_M).length;
        if (agree >= 0.7 * deltas.length) {
          const k = Math.round(med / MS_M);
          const integerMs = k !== 0 && Math.abs(med - k * MS_M) < AGREE_M;
          this.jumps.push({
            time,
            ms: integerMs ? k : med / MS_M,
            integerMs,
            agree,
            of: deltas.length,
          });
          // Receiver resets are exact milliseconds: correct by k ms, not by
          // the measured median (which carries that epoch's code noise and
          // would leave a step in every code-minus-phase arc).
          this.offset += integerMs ? k * MS_M : med;
        }
      }
    }
    for (const [prn, d] of now) this.prev.set(prn, { time, d });
    this.prevEpoch = time;
    return this.offset;
  }

  finalize(): ClockJumpResult {
    return { jumps: this.jumps, epochsChecked: this.checked };
  }
}
