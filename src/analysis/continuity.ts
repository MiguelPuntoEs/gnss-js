/**
 * Data continuity for observation QC: missing epochs, gaps and short
 * pieces (Anubis `nGap`/`nPcs`, teqc "Report gap > 10 min"), repeated
 * epochs and duplicated satellites (teqc "Epochs repeated", "Obs w/ SV
 * duplication"), and usable epochs — at least four satellites with
 * dual-frequency code and phase, enough to position (Anubis `UseEp`).
 */
import type { RinexHeader } from '../rinex/parser';
import { buildObsIndices } from '../constants/gnss';

/** Anubis defaults: a gap is > 600 s; a short piece is < 1800 s. */
const GAP_SEC = 600;
const PIECE_SEC = 1800;

export interface DataGap {
  /** Last epoch before the gap and first epoch after it (GPS-scale ms). */
  from: number;
  to: number;
}

export interface ContinuityResult {
  intervalSec: number;
  firstEpoch: number | null;
  lastEpoch: number | null;
  /** Epochs a continuous record at `intervalSec` would hold. */
  expectedEpochs: number;
  /** Distinct epochs with observations. */
  epochs: number;
  /** Epochs that repeat (or go back in time). */
  repeatedEpochs: number;
  /** Satellites listed twice in one epoch. */
  duplicateSats: number;
  gapSec: number;
  gaps: DataGap[];
  pieceSec: number;
  /** Continuous pieces between gaps shorter than `pieceSec`. */
  shortPieces: number;
  /**
   * Shorter gaps: missing ≥ 2 epochs but under `gapSec` (SpiderQC lists
   * gaps from 5 s). On 1 Hz data a 30 s dropout is a real event. At most
   * 200 listed; `shortGapCount` and `shortGapSec` cover all.
   */
  shortGaps: DataGap[];
  shortGapCount: number;
  shortGapSec: number;
  /** Epochs with ≥ 4 satellites carrying dual-frequency code + phase. */
  usableEpochs: number;
  /** Most satellites with any observation in one epoch. */
  maxSatellites: number;
}

export class ContinuityAccumulator {
  private idx: ReturnType<typeof buildObsIndices>;
  private intervalMs: number;
  private first: number | null = null;
  private last: number | null = null;
  private epochs = 0;
  private repeated = 0;
  private dupSats = 0;
  private gaps: DataGap[] = [];
  private pieceStart: number | null = null;
  private shortPieces = 0;
  private shortGaps: DataGap[] = [];
  private shortGapCount = 0;
  private shortGapMs = 0;
  private usable = 0;
  private maxSats = 0;

  constructor(header: RinexHeader) {
    this.idx = buildObsIndices(header);
    this.intervalMs = (header.interval ?? 30) * 1000;
  }

  /** True when the satellite has code + phase on at least two bands. */
  private dualFreq(prn: string, values: (number | null)[]): boolean {
    const bands = this.idx.get(prn[0]!) ?? this.idx.get('_v2');
    if (!bands) return false;
    let n = 0;
    for (const { L, C } of bands.values()) {
      if (C === null) continue;
      const c = values[C];
      const l = values[L];
      if (c != null && c !== 0 && l != null && l !== 0 && ++n >= 2) return true;
    }
    return false;
  }

  onEpoch(
    time: number,
    obs: readonly { prn: string; values: (number | null)[] }[]
  ) {
    if (this.last !== null && time <= this.last) {
      this.repeated++;
      return;
    }
    const seen = new Set<string>();
    let dual = 0;
    for (const o of obs) {
      if (seen.has(o.prn)) {
        this.dupSats++;
        continue;
      }
      seen.add(o.prn);
      if (this.dualFreq(o.prn, o.values)) dual++;
    }
    if (dual >= 4) this.usable++;
    if (seen.size > this.maxSats) this.maxSats = seen.size;

    if (this.first === null) {
      this.first = time;
      this.pieceStart = time;
    } else if (
      this.last !== null &&
      time - this.last > 2.5 * this.intervalMs &&
      time - this.last <= GAP_SEC * 1000
    ) {
      this.shortGapCount++;
      this.shortGapMs += time - this.last - this.intervalMs;
      if (this.shortGaps.length < 200)
        this.shortGaps.push({ from: this.last, to: time });
    } else if (this.last !== null && time - this.last > GAP_SEC * 1000) {
      this.gaps.push({ from: this.last, to: time });
      if (this.last - this.pieceStart! < PIECE_SEC * 1000) this.shortPieces++;
      this.pieceStart = time;
    }
    this.last = time;
    this.epochs++;
  }

  finalize(): ContinuityResult {
    const span =
      this.first !== null && this.last !== null ? this.last - this.first : 0;
    // The final piece counts too when the file ends after a gap.
    const lastShort =
      this.gaps.length > 0 &&
      this.last !== null &&
      this.last - this.pieceStart! < PIECE_SEC * 1000;
    return {
      intervalSec: this.intervalMs / 1000,
      firstEpoch: this.first,
      lastEpoch: this.last,
      expectedEpochs:
        this.first === null ? 0 : Math.round(span / this.intervalMs) + 1,
      epochs: this.epochs,
      repeatedEpochs: this.repeated,
      duplicateSats: this.dupSats,
      gapSec: GAP_SEC,
      gaps: this.gaps,
      pieceSec: PIECE_SEC,
      shortPieces: this.shortPieces + (lastShort ? 1 : 0),
      shortGaps: this.shortGaps,
      shortGapCount: this.shortGapCount,
      shortGapSec: this.shortGapMs / 1000,
      usableEpochs: this.usable,
      maxSatellites: this.maxSats,
    };
  }
}
