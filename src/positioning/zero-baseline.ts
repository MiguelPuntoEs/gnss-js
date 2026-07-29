/**
 * Zero-baseline / single-difference receiver comparison.
 *
 * For two (or more) receivers sharing one antenna — a zero baseline — the
 * geometric range, satellite clock/orbit, atmosphere and multipath are
 * identical and cancel in a between-receiver single difference (SD), leaving
 * only the RECEIVER terms:
 *
 *   ΔP  = P_rx − P_ref  = c·Δdt(t) + Δb_code(signal)          + noise   (code)
 *   ΔΦ  = Φ_rx − Φ_ref  = c·Δdt(t) + Δb_phase(signal) + λ·ΔN  + noise   (phase)
 *
 * `Δdt` is the relative receiver clock (common to every satellite/signal at an
 * epoch); the biases are per-signal and ~constant; `λ·ΔN` is a per-arc integer.
 * This engine estimates, per epoch and per non-reference receiver:
 *  - the **code** relative clock (robust per-system, with inter-system biases
 *    absorbed as ISBs relative to a datum system),
 *  - a **phase-smoothed** relative clock — the time-differenced phase SD drops
 *    the constant ambiguity+bias, leaving `c·Δ(Δdt)` between epochs, integrated
 *    from the code-clock anchor (no ambiguity resolution needed for the clock
 *    trend / its Allan deviation),
 *  - the **inter-system/frequency biases** (ISB/IFB), the interesting cut being
 *    between receiver *types* on the same antenna.
 *
 * Double-differencing (the RTK engine) additionally differences across
 * satellites and cancels Δdt by construction — the opposite of what we want
 * here. Streaming API (`process`/`reset`), mirroring RtkFloatEngine / PppEngine.
 * See docs/zero-baseline-clock.md.
 */
import { C_LIGHT, FREQ } from '../constants/gnss';
import type { RawObservation } from './rtk';

export interface ZeroBaselineOptions {
  /** Reference receiver id (every other receiver is differenced against it). */
  reference: string;
  /** ISB datum system letter (biases are reported relative to it). Default 'G'. */
  referenceSystem?: string;
  /** Phase-SD inter-epoch jump gate (m) for cycle-slip rejection. Default 0.05. */
  slipThreshM?: number;
}

/** One receiver's relative-clock estimate at one epoch. */
export interface ReceiverClockSample {
  t: number;
  receiver: string;
  /** Code relative clock (m); divide by c for seconds. Null with no data. */
  clockOffsetM: number | null;
  /** Phase-smoothed relative clock (m) — precise; anchored to the code clock. */
  clockOffsetPhaseM: number | null;
  /** Signals used / rejected in the code solution this epoch. */
  used: number;
  rejected: number;
  /** RMS of the code-SD residuals about the clock+ISB fit (m). */
  residualRmsM: number;
}

/** A receiver's inter-system bias relative to the datum system (m). */
export interface ReceiverBias {
  receiver: string;
  system: string;
  biasM: number;
  /** Epochs the estimate averages over. */
  n: number;
}

interface PhaseArc {
  lastPhaseSdM: number;
  lastLock: number | undefined;
}

function carrierFreqHz(
  sys: string,
  band: string,
  gloChannel: number | null
): number {
  if (sys === 'R') {
    if (band === '1') return 1602e6 + (gloChannel ?? 0) * 562500;
    if (band === '2') return 1246e6 + (gloChannel ?? 0) * 437500;
    return FREQ.R?.[band] ?? 0;
  }
  return FREQ[sys]?.[band] ?? 0;
}

function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export class ZeroBaselineEngine {
  private readonly ref: string;
  private readonly refSys: string;
  private readonly slip: number;
  /** Per (receiver|prn|code) continuous phase-SD arc. */
  private readonly arcs = new Map<string, PhaseArc>();
  /** Per receiver: integrated phase-smoothed clock (m). */
  private readonly phaseClock = new Map<string, number>();
  /** Per (receiver|system): accumulated ISB (m) + count. */
  private readonly isb = new Map<string, { sum: number; n: number }>();

  constructor(opts: ZeroBaselineOptions) {
    this.ref = opts.reference;
    this.refSys = opts.referenceSystem ?? 'G';
    this.slip = opts.slipThreshM ?? 0.05;
  }

  reset(): void {
    this.arcs.clear();
    this.phaseClock.clear();
    this.isb.clear();
  }

  /** ISB/IFB estimates accumulated so far, per receiver × system. */
  biases(): ReceiverBias[] {
    const out: ReceiverBias[] = [];
    for (const [key, { sum, n }] of this.isb) {
      const [receiver, system] = key.split('|');
      out.push({ receiver: receiver!, system: system!, biasM: sum / n, n });
    }
    return out;
  }

  /**
   * Ingest one time-aligned instant: observations per receiver id. Returns one
   * {@link ReceiverClockSample} per non-reference receiver present this epoch.
   */
  process(epoch: {
    timeMs: number;
    obs: Record<string, readonly RawObservation[]>;
  }): ReceiverClockSample[] {
    const refObs = epoch.obs[this.ref];
    if (!refObs) return [];
    const refByKey = new Map<string, RawObservation>();
    for (const o of refObs)
      if (o.pr != null && Number.isFinite(o.pr))
        refByKey.set(`${o.prn}|${o.code}`, o);

    const out: ReceiverClockSample[] = [];
    for (const rx of Object.keys(epoch.obs)) {
      if (rx === this.ref) continue;
      out.push(
        this.processReceiver(rx, epoch.obs[rx]!, refByKey, epoch.timeMs)
      );
    }
    return out;
  }

  private processReceiver(
    rx: string,
    obs: readonly RawObservation[],
    refByKey: Map<string, RawObservation>,
    t: number
  ): ReceiverClockSample {
    // Single differences vs the reference for the common satellites/signals.
    const codeBySys = new Map<string, number[]>();
    const phase: { key: string; sdM: number; lock: number | undefined }[] = [];
    for (const o of obs) {
      if (o.pr == null || !Number.isFinite(o.pr)) continue;
      const r = refByKey.get(`${o.prn}|${o.code}`);
      if (!r || r.pr == null) continue;
      const sys = o.prn[0]!;
      (codeBySys.get(sys) ?? codeBySys.set(sys, []).get(sys)!).push(
        o.pr - r.pr
      );
      if (o.cp != null && r.cp != null) {
        const f = carrierFreqHz(
          sys,
          o.code[0]!,
          o.gloChannel ?? r.gloChannel ?? null
        );
        if (f > 0)
          phase.push({
            key: `${rx}|${o.prn}|${o.code}`,
            sdM: (o.cp - r.cp) * (C_LIGHT / f),
            lock: o.lockTimeS,
          });
      }
    }

    if (codeBySys.size === 0)
      return {
        t,
        receiver: rx,
        clockOffsetM: null,
        clockOffsetPhaseM: this.phaseClock.get(rx) ?? null,
        used: 0,
        rejected: 0,
        residualRmsM: 0,
      };

    // Code relative clock = robust datum-system SD (or the overall SD if the
    // datum system is absent); per-system offsets from it are the ISBs.
    const sysMedian = new Map<string, number>();
    for (const [sys, v] of codeBySys) sysMedian.set(sys, median(v));
    const allSd: number[] = [];
    for (const v of codeBySys.values()) allSd.push(...v);
    const clk = sysMedian.get(this.refSys) ?? median(allSd);

    for (const [sys, med] of sysMedian) {
      if (sys === this.refSys) continue;
      const cur = this.isb.get(`${rx}|${sys}`) ?? { sum: 0, n: 0 };
      cur.sum += med - clk;
      cur.n += 1;
      this.isb.set(`${rx}|${sys}`, cur);
    }

    let ss = 0,
      used = 0,
      rejected = 0;
    for (const [sys, v] of codeBySys) {
      const isb = sys === this.refSys ? 0 : sysMedian.get(sys)! - clk;
      for (const sd of v) {
        const res = sd - clk - isb;
        if (Math.abs(res) > 5) {
          rejected++;
          continue;
        } // gross blunder (m)
        ss += res * res;
        used++;
      }
    }
    const residualRmsM = used ? Math.sqrt(ss / used) : 0;

    // Phase-smoothed clock: the constant ambiguity+bias cancels in the between-
    // epoch difference of each arc's phase SD, leaving c·Δ(relclk). Take the
    // robust mean of those deltas (rejecting cycle slips) and integrate from the
    // code-clock anchor.
    const deltas: number[] = [];
    for (const p of phase) {
      const arc = this.arcs.get(p.key);
      this.arcs.set(p.key, { lastPhaseSdM: p.sdM, lastLock: p.lock });
      if (!arc) continue;
      const lockReset =
        p.lock != null && arc.lastLock != null && p.lock < arc.lastLock;
      if (lockReset) continue;
      deltas.push(p.sdM - arc.lastPhaseSdM);
    }
    let phaseClockM = this.phaseClock.get(rx) ?? null;
    if (phaseClockM == null) {
      phaseClockM = clk; // anchor the first epoch to the code clock
    } else if (deltas.length) {
      const md = median(deltas);
      const good = deltas.filter((d) => Math.abs(d - md) < this.slip);
      const step = good.length
        ? good.reduce((a, b) => a + b, 0) / good.length
        : md;
      phaseClockM += step;
    }
    this.phaseClock.set(rx, phaseClockM);

    return {
      t,
      receiver: rx,
      clockOffsetM: clk,
      clockOffsetPhaseM: phaseClockM,
      used,
      rejected,
      residualRmsM,
    };
  }
}
