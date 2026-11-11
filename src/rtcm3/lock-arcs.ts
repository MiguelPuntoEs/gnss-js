/**
 * Lock-arc bookkeeping shared by the RTCM3 observation encoders (MSM and
 * legacy 1001–1012): when a satellite × signal's carrier lock continues,
 * when it restarts, and which lock-time indicator to send so rovers see
 * every restart.
 */

/** What the source says about a signal's lock at one epoch. */
export interface LockInput {
  /** Receiver-reported continuous lock time, seconds. */
  lockTime?: number;
  /** Loss of lock / cycle slip flagged by the source (RINEX LLI bit 0). */
  slip?: boolean;
  /** Rolling cycle-slip counter (e.g. Trimble): any change is a slip. */
  slipCount?: number;
}

export interface ArcState {
  lockStartMs: number;
  /** Receiver-reported lock time at the previous epoch, seconds. */
  inputLock?: number;
  /** Receiver slip counter at the previous epoch. */
  slipCount?: number;
  lastSeenMs: number;
  /** Whole cycles added to the input phase for this arc. */
  cycles: number;
  /** Receiver lock time still describes this arc (not slip-flagged or re-anchored). */
  trustInput: boolean;
  /** Lock-time indicator last sent for this signal. */
  lastLti?: number;
}

/**
 * Lock arcs keyed by signal (the key must start with the system letter).
 * Feed each system's epochs in time order: `beginEpoch`, `update` per
 * signal, `indicator` when encoding it, `endEpoch`.
 */
export class LockArcs {
  private readonly arcs = new Map<string, ArcState>();
  private readonly lastEpoch = new Map<string, number>();

  /** @param lti seconds → the message's lock-time indicator (monotonic). */
  constructor(private readonly lti: (seconds: number) => number) {}

  reset(): void {
    this.arcs.clear();
    this.lastEpoch.clear();
  }

  /** Start a system's epoch; time going backwards (source restart) clears it. */
  beginEpoch(sys: string, timeMs: number): void {
    const last = this.lastEpoch.get(sys);
    if (last !== undefined && timeMs < last) {
      for (const key of [...this.arcs.keys()]) {
        if (key.startsWith(sys)) this.arcs.delete(key);
      }
    }
  }

  /**
   * Finish a system's epoch. Continuity without receiver lock times means
   * present in every epoch of its system; epochs without the system at all
   * don't count, so systems may be fed in separate calls.
   */
  endEpoch(sys: string, timeMs: number): void {
    this.lastEpoch.set(sys, timeMs);
  }

  /** The arc as it stands, without advancing it. */
  peek(key: string): ArcState | undefined {
    return this.arcs.get(key);
  }

  /** Advance (or restart) the lock arc of one signal. */
  update(key: string, timeMs: number, s: LockInput): ArcState {
    const prev = this.arcs.get(key);
    const sysLast = this.lastEpoch.get(key[0]!);
    let restart = !prev || s.slip === true || timeMs < prev.lastSeenMs;
    if (
      !restart &&
      prev?.slipCount !== undefined &&
      s.slipCount !== undefined &&
      s.slipCount !== prev.slipCount
    ) {
      restart = true;
    } else if (!restart && prev) {
      if (s.lockTime !== undefined && prev.inputLock !== undefined) {
        // The receiver knows best: lock time drops, or grows by less than
        // the time elapsed, only after a loss of lock (RTKLIB's test).
        // 1 s of slack for whole-second lock times (SBF); an unchanged
        // value is a saturated counter (UBX caps at 64.5 s), not a slip.
        const elapsed = (timeMs - prev.lastSeenMs) / 1000;
        restart =
          s.lockTime < prev.inputLock ||
          (s.lockTime !== prev.inputLock &&
            s.lockTime + 1 < prev.inputLock + elapsed);
      } else {
        restart = prev.lastSeenMs !== sysLast;
      }
    }
    if (restart || !prev) {
      // Rovers see a slip only when the indicator drops (RTKLIB
      // lossoflock), so a restarted arc must go out below the last one
      // sent: at the receiver's new lock time if that is lower, else at 0.
      let lock = s.slip === true ? 0 : (s.lockTime ?? 0);
      let trustInput = s.slip !== true;
      if (prev?.lastLti !== undefined && this.lti(lock) >= prev.lastLti) {
        lock = 0;
        trustInput = false;
      }
      const arc: ArcState = {
        lockStartMs: timeMs - lock * 1000,
        inputLock: s.lockTime,
        slipCount: s.slipCount,
        lastSeenMs: timeMs,
        cycles: 0,
        trustInput,
      };
      this.arcs.set(key, arc);
      return arc;
    }
    prev.inputLock = s.lockTime;
    prev.slipCount = s.slipCount;
    prev.lastSeenMs = timeMs;
    return prev;
  }

  /**
   * Shift the arc's phase by whole cycles (its ambiguity changes, so the
   * arc restarts at lock 0).
   */
  reanchor(arc: ArcState, cycles: number, timeMs: number): void {
    arc.cycles = cycles;
    arc.lockStartMs = timeMs;
    arc.trustInput = false;
  }

  /** The indicator to send for this arc now (recorded as the last sent). */
  indicator(arc: ArcState, timeMs: number, s: LockInput): number {
    // Own arc age, raised to the receiver's figure when that is finer
    // (a quantized input lock time would otherwise make us lag a step).
    let lockS = (timeMs - arc.lockStartMs) / 1000;
    if (arc.trustInput && s.lockTime !== undefined && s.lockTime > lockS) {
      lockS = s.lockTime;
    }
    return (arc.lastLti = this.lti(lockS));
  }
}
