/**
 * Cycle slip detection from RINEX carrier phase observations.
 *
 * Detection hierarchy (per frequency pair):
 *  1. Melbourne-Wübbena (MW): uses both code (C) and phase (L) on two bands.
 *     MW = φ_WL − P_NL / λ_WL  (wide-lane ambiguity, cycles)
 *     Smoothed with running mean — a deviation > threshold makes a candidate,
 *     confirmed only if the next epoch stays at the new level (a slip
 *     persists; a one-epoch code outlier returns). Without this, noise spikes
 *     of 0.5–1 WL cycle were most of the "slips" on clean IGS stations —
 *     ~5× Anubis's counts (2026-11-11 comparison, 7 IGS/EUREF stations).
 *     GLONASS FDMA frequencies come from the header's GLONASS SLOT / FRQ #
 *     channel map; without it, GLONASS isn't tested.
 *  2. Geometry-Free (GF): L1·λ1 − L2·λ2 (requires only phase on two bands).
 *     Removes geometry but retains ionospheric signature.
 *  3. Single-frequency phase-code (SF): |Δφ_m − ΔP| between consecutive epochs.
 *     Removes satellite motion via code; only works when code is available.
 */

import type { RinexHeader } from '../rinex/parser';
import {
  C_LIGHT,
  FREQ,
  BAND_LABELS,
  SYSTEM_NAMES,
  DUAL_FREQ_PAIRS,
  ARC_GAP_FACTOR,
  buildGloChannelMap,
  getFreq,
  buildObsIndices,
} from '../constants/gnss';
import type { OnSlipDetected } from '../constants/gnss';

/* ================================================================== */
/*  Types                                                              */
/* ================================================================== */

export interface CycleSlipEvent {
  /** Epoch time in milliseconds. */
  time: number;
  /** Satellite PRN, e.g. "G01". */
  prn: string;
  /** Detection method and bands, e.g. "MW L1-L2", "GF L1-L2", or "L1" (single-freq). */
  signal: string;
  /**
   * Slip magnitude. Units depend on detection method:
   * - MW (Melbourne-Wübbena): wide-lane cycles
   * - GF (geometry-free): meters
   * - SF (single-frequency): meters
   */
  magnitude: number;
}

export interface CycleSlipSignalStats {
  /** Human label, e.g. "MW L1-L2 (GPS)". */
  label: string;
  /** System letter, e.g. "G". */
  system: string;
  /** Total cycle slips detected for this signal combination. */
  totalSlips: number;
  /** Number of distinct satellites with data. */
  satellites: number;
  /** Total observation epochs for this combination. */
  totalEpochs: number;
  /** Slip rate: slips per 1000 epochs. */
  slipRate: number;
}

export interface CycleSlipResult {
  events: CycleSlipEvent[];
  signalStats: CycleSlipSignalStats[];
  /**
   * Distinct satellite-epochs with at least one slip. One L1 slip trips both
   * "MW L1-L2" and "MW L1-L5" — two events, one slip here. The headline
   * count (teqc's "slps" sense); per-signal stats double-count by design.
   */
  slipEpochs: number;
  /** Distinct satellite-epochs any detector tested. */
  testedEpochs: number;
  /** slipEpochs / testedEpochs split by system letter. */
  perSystem: Record<string, { slipEpochs: number; testedEpochs: number }>;
  /** Per-satellite slip counts. Key = PRN, value = total slips. */
  satSlipCounts: Record<string, number>;
}

/* ================================================================== */
/*  Thresholds                                                         */
/* ================================================================== */

/** MW: deviation from smoothed mean must exceed both of these. */
const MW_MIN_THRESHOLD = 0.5; // absolute minimum (WL cycles)
const MW_SIGMA_FACTOR = 4; // n-sigma factor for adaptive threshold
const MW_MIN_EPOCHS = 3; // minimum epochs before detection starts
const MW_WINDOW = 30; // epochs in the sliding MW reference window
/**
 * A wide-lane slip moves the phase-only geometry-free combination too (a
 * 1-cycle L1 slip: 19 cm; L2: 24 cm); a code excursion that shifts MW does
 * not. A candidate needs this GF jump unless its MW step is unambiguous.
 * Only near-equal slips on both bands (e.g. 4/3 cycles, ~3 cm) slip past.
 */
const MW_GF_CONFIRM_M = 0.05;
const MW_UNAMBIGUOUS = 3; // WL cycles

const GF_THRESHOLD_M = 0.15; // geometry-free epoch-to-epoch jump (metres)
const SF_THRESHOLD_M = 3.0; // single-freq phase-code jump (metres)

/* ================================================================== */
/*  MW Smoother (Welford online statistics)                            */
/* ================================================================== */

/**
 * MW statistics over the last {@link MW_WINDOW} epochs of the arc. A
 * whole-arc running mean lags the slow MW drift that long-period code
 * multipath causes; 0.6–2 cycle "slips" deep into hours-long arcs were the
 * residual false alarms on clean stations against teqc (2026-11-12). A
 * sliding window follows the drift and still sees a sudden step.
 */
interface MwSmooth {
  buf: number[];
  mean: number;
  n: number; // epochs in the arc so far (not capped by the window)
}

interface MwPending {
  mw: number;
  time: number;
  deviation: number;
  /** |ΔGF| (m) between the candidate epoch and the one before it. */
  gfJump: number;
}

interface SfPending {
  time: number;
  magnitude: number;
  /** Phase − code (m) at the last epoch before the jump. */
  ref: number;
}

function mwSmoothInit(value: number): MwSmooth {
  return { buf: [value], mean: value, n: 1 };
}

/** Add a value, in place (the previous state is never read again). The
 *  sum runs oldest to newest, as it always has, so results are unchanged
 *  to the bit. */
function mwSmoothUpdate(s: MwSmooth, value: number): MwSmooth {
  const buf = s.buf;
  if (buf.length >= MW_WINDOW) buf.shift();
  buf.push(value);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i]!;
  s.mean = sum / buf.length;
  s.n++;
  return s;
}

function mwSmoothStddev(s: MwSmooth): number {
  const k = s.buf.length;
  if (k < 2) return Infinity;
  let ss = 0;
  for (const v of s.buf) ss += (v - s.mean) * (v - s.mean);
  return Math.sqrt(ss / (k - 1));
}

/* ================================================================== */
/*  Accumulator                                                        */
/* ================================================================== */

interface PrevState {
  time: number;
  /** False until the satellite's first epoch with phase. */
  valid: boolean;
  /** Smoothed MW per pair key "b1-b2" */
  mwSmooth: Map<string, MwSmooth>;
  /** Unconfirmed MW jump per pair key, awaiting the next epoch. */
  mwPending: Map<string, MwPending>;
  /** Unconfirmed single-frequency jump per band, awaiting the next epoch. */
  sfPending: Map<string, SfPending>;
  /** GF values per pair key "b1-b2" (in metres) */
  gf: Map<string, number>;
  /** Phase values (metres) per band */
  phase: Map<string, number>;
  /** Code values (metres) per band */
  code: Map<string, number>;
}

/** Per-system strings for a dual-frequency pair, built once. */
interface PairInfo {
  b1: string;
  b2: string;
  key: string;
  mwSignal: string;
  mwSigKey: string;
  gfSignal: string;
  gfSigKey: string;
}

const newState = (): PrevState => ({
  time: 0,
  valid: false,
  mwSmooth: new Map(),
  mwPending: new Map(),
  sfPending: new Map(),
  gf: new Map(),
  phase: new Map(),
  code: new Map(),
});

export class CycleSlipAccumulator {
  private obsIndices: Map<string, Map<string, { L: number; C: number | null }>>;
  /** Two states per satellite, swapped each epoch: the previous one is
   *  read while the other is cleared and filled (no Maps per epoch). */
  private states = new Map<
    string,
    { s: [PrevState, PrevState]; cur: number }
  >();
  private pairInfo = new Map<string, PairInfo[]>();
  private sfInfo = new Map<string, { lbl: string; sigKey: string }>();
  private events: CycleSlipEvent[] = [];
  private interval: number;
  /** GLONASS PRN → channel k for FDMA frequency computation. */
  private gloChannels: Record<string, number>;
  private onSlip?: OnSlipDetected;

  // Per-signal epoch/slip counting
  private signalEpochs = new Map<string, number>();
  private signalSlips = new Map<string, number>();
  private signalSats = new Map<string, Set<string>>();
  private slipEpochs = 0;
  private testedEpochs = 0;
  private perSystem: CycleSlipResult['perSystem'] = {};
  /** Per-call flags folded into slipEpochs / testedEpochs. */
  private tested = false;
  private slipped = false;

  constructor(header: RinexHeader, onSlip?: OnSlipDetected) {
    this.interval = header.interval ?? 30;
    this.obsIndices = buildObsIndices(header);
    this.gloChannels = buildGloChannelMap(header.glonassSlots);
    this.onSlip = onSlip;
  }

  private recordSlip(
    sigKey: string,
    time: number,
    prn: string,
    signal: string,
    magnitude: number,
    bands: Set<string>
  ) {
    this.events.push({ time, prn, signal, magnitude });
    this.slipped = true;
    this.signalSlips.set(sigKey, (this.signalSlips.get(sigKey) ?? 0) + 1);
    if (!this.signalSats.has(sigKey)) this.signalSats.set(sigKey, new Set());
    this.signalSats.get(sigKey)!.add(prn);
    this.onSlip?.(time, prn, bands);
  }

  private countEpoch(sigKey: string) {
    this.tested = true;
    this.signalEpochs.set(sigKey, (this.signalEpochs.get(sigKey) ?? 0) + 1);
  }

  private pairsOf(sys: string): PairInfo[] {
    let p = this.pairInfo.get(sys);
    if (!p) {
      p = (DUAL_FREQ_PAIRS[sys] ?? []).map(([b1, b2]) => {
        const lbl1 = BAND_LABELS[sys]?.[b1] ?? b1;
        const lbl2 = BAND_LABELS[sys]?.[b2] ?? b2;
        const mwSignal = `MW ${lbl1}-${lbl2}`;
        const gfSignal = `GF ${lbl1}-${lbl2}`;
        return {
          b1,
          b2,
          key: `${b1}-${b2}`,
          mwSignal,
          mwSigKey: `${sys}:${mwSignal}`,
          gfSignal,
          gfSigKey: `${sys}:${gfSignal}`,
        };
      });
      this.pairInfo.set(sys, p);
    }
    return p;
  }

  private sfOf(sys: string, band: string) {
    const k = sys + band;
    let i = this.sfInfo.get(k);
    if (!i) {
      const lbl = BAND_LABELS[sys]?.[band] ?? band;
      this.sfInfo.set(k, (i = { lbl, sigKey: `${sys}:${lbl}` }));
    }
    return i;
  }

  /** Resolve frequency for a given PRN + band. Handles GLONASS FDMA. */
  private getFreqForPrn(prn: string, band: string): number | undefined {
    return getFreq(this.gloChannels, prn, band);
  }

  onObservation = (
    time: number,
    prn: string,
    _codes: string[],
    values: (number | null)[]
  ) => {
    const sys = prn[0]!;
    const idxMap = this.obsIndices.get(sys) ?? this.obsIndices.get('_v2');
    if (!idxMap) return;
    // For non-GLONASS, need FREQ entry; for GLONASS, resolved per-satellite
    if (sys !== 'R' && !FREQ[sys]) return;

    let st = this.states.get(prn);
    if (!st)
      this.states.set(prn, (st = { s: [newState(), newState()], cur: 0 }));
    const prevState = st.s[st.cur]!;
    const next = st.s[1 - st.cur]!;

    // Extract phase (cycles→metres) and code (metres) per band
    const phaseM = next.phase; // band → L in metres
    const codeM = next.code; // band → C/P in metres
    phaseM.clear();
    codeM.clear();
    for (const [band, { L, C }] of idxMap) {
      const freq = this.getFreqForPrn(prn, band);
      if (!freq) continue;
      const lVal = values[L];
      if (lVal != null && lVal !== 0) phaseM.set(band, lVal * (C_LIGHT / freq));
      if (C !== null) {
        const cVal = values[C];
        if (cVal != null && cVal !== 0) codeM.set(band, cVal);
      }
    }
    if (phaseM.size === 0) return;
    this.tested = false;
    this.slipped = false;

    const prev = prevState.valid ? prevState : undefined;
    const gap = prev ? (time - prev.time) / 1000 : 0;
    const isArcBreak = !prev || gap > this.interval * ARC_GAP_FACTOR;

    // Carry forward or initialise MW smoothers
    const mwSmooth = next.mwSmooth;
    const mwPending = next.mwPending;
    const sfPending = next.sfPending;
    const gfMap = next.gf;
    mwSmooth.clear();
    mwPending.clear();
    sfPending.clear();
    gfMap.clear();
    const pairs = this.pairsOf(sys);

    for (const pi of pairs) {
      const { b1, b2 } = pi;
      const l1 = phaseM.get(b1);
      const l2 = phaseM.get(b2);
      const f1 = this.getFreqForPrn(prn, b1);
      const f2 = this.getFreqForPrn(prn, b2);
      if (!f1 || !f2) continue;
      const pairKey = pi.key;

      // GF: always computable if both L available
      if (l1 !== undefined && l2 !== undefined) {
        gfMap.set(pairKey, l1 - l2);
      }

      // MW: requires both L and both C
      const c1 = codeM.get(b1);
      const c2 = codeM.get(b2);
      if (
        l1 !== undefined &&
        l2 !== undefined &&
        c1 !== undefined &&
        c2 !== undefined
      ) {
        // φ_WL (WL cycles) = (f1·L1_m − f2·L2_m) / c  =  φ1_cyc − φ2_cyc
        // P_NL (WL cycles) = (f1·P1 + f2·P2) / ((f1+f2) · λ_WL)
        // MW = φ_WL − P_NL  (should equal N_WL, constant absent slips)
        const lambda_wl = C_LIGHT / (f1 - f2);
        const phi_wl = (f1 * l1 - f2 * l2) / C_LIGHT;
        const P_nl = (f1 * c1 + f2 * c2) / ((f1 + f2) * lambda_wl);
        const mw = phi_wl - P_nl;

        const prevSmooth = isArcBreak ? undefined : prev?.mwSmooth.get(pairKey);

        if (prevSmooth && prevSmooth.n >= MW_MIN_EPOCHS) {
          const signal = pi.mwSignal;
          const sigKey = pi.mwSigKey;
          this.countEpoch(sigKey);

          const stddev = mwSmoothStddev(prevSmooth);
          const threshold = Math.max(
            MW_MIN_THRESHOLD,
            MW_SIGMA_FACTOR * stddev
          );
          const deviation = Math.abs(mw - prevSmooth.mean);
          const pending = prev?.mwPending.get(pairKey);

          if (pending) {
            if (deviation <= threshold) {
              // Back at the old level: the candidate was an outlier.
              mwSmooth.set(pairKey, mwSmoothUpdate(prevSmooth, mw));
            } else if (
              pending.gfJump <= MW_GF_CONFIRM_M &&
              pending.deviation < MW_UNAMBIGUOUS
            ) {
              // MW moved and stayed, but the phase didn't jump: a code-level
              // shift (multipath), not a slip. Follow the new level.
              mwSmooth.set(
                pairKey,
                mwSmoothUpdate(mwSmoothInit(pending.mw), mw)
              );
            } else {
              // Still off the old level: the jump persisted — a slip at the
              // candidate's epoch. Restart the smoother on the new level.
              this.recordSlip(
                sigKey,
                pending.time,
                prn,
                signal,
                pending.deviation,
                new Set([b1, b2])
              );
              mwSmooth.set(
                pairKey,
                Math.abs(mw - pending.mw) <= threshold
                  ? mwSmoothUpdate(mwSmoothInit(pending.mw), mw)
                  : mwSmoothInit(mw)
              );
            }
          } else if (deviation > threshold) {
            // Candidate: hold the smoother until the next epoch decides.
            mwSmooth.set(pairKey, prevSmooth);
            const gfNow = gfMap.get(pairKey);
            const gfPrev = prev?.gf.get(pairKey);
            mwPending.set(pairKey, {
              mw,
              time,
              deviation,
              gfJump:
                gfNow !== undefined && gfPrev !== undefined
                  ? Math.abs(gfNow - gfPrev)
                  : Infinity,
            });
          } else {
            mwSmooth.set(pairKey, mwSmoothUpdate(prevSmooth, mw));
          }
        } else if (prevSmooth) {
          // Still accumulating (< MW_MIN_EPOCHS)
          mwSmooth.set(pairKey, mwSmoothUpdate(prevSmooth, mw));
        } else {
          // First epoch or arc break
          mwSmooth.set(pairKey, mwSmoothInit(mw));
        }
      }
    }

    if (!isArcBreak && prev) {
      const dualChecked = new Set<string>(); // bands covered by MW or GF
      // GF is the fallback for a satellite without code on two bands. When
      // MW already covers it, a phase-only band adds noise, not coverage:
      // BeiDou GEO C03 at POL2 (Javad) carries L7I without C7I, its L7I
      // jitters by 10–25 cm, and GF on B1I–B2I flagged 75 % of its epochs
      // while MW on B1I–B3I was clean.
      const mwCovered = pairs.some((pi) => mwSmooth.has(pi.key));

      for (const pi of pairs) {
        const { b1, b2 } = pi;
        const pairKey = pi.key;

        // --- 1. Melbourne-Wübbena (already handled above during smoothing) ---
        if (mwSmooth.has(pairKey)) {
          dualChecked.add(b1);
          dualChecked.add(b2);
          continue;
        }

        // --- 2. Geometry-Free (fallback) ---
        if (mwCovered) continue;
        const curGf = gfMap.get(pairKey);
        const prevGf = prev.gf.get(pairKey);
        if (curGf !== undefined && prevGf !== undefined) {
          const signal = pi.gfSignal;
          const sigKey = pi.gfSigKey;
          this.countEpoch(sigKey);
          const jump = Math.abs(curGf - prevGf);
          if (jump > GF_THRESHOLD_M) {
            this.recordSlip(sigKey, time, prn, signal, jump, new Set([b1, b2]));
          }
          dualChecked.add(b1);
          dualChecked.add(b2);
        }
      }

      // --- 3. Single-frequency phase-code fallback ---
      // Skipped for SBAS: the SF test |Δφ − ΔP| is driven by pseudorange noise,
      // and SBAS geostationary L1 C/A code is noisy enough (metre-level jitter
      // epoch-to-epoch) that it trips the threshold almost every epoch — a
      // false-slip storm (~900/1000) on a satellite that isn't slipping. RTKLIB
      // and teqc likewise don't cycle-slip-QC SBAS L1. Dual-frequency MW/GF on
      // SBAS (L1-L5) is unaffected and still runs above.
      // Like MW, a jump is only a candidate until the next epoch: a slip
      // shifts phase − code for good, a code outlier flips back. Unconfirmed,
      // low-elevation GLONASS C/A noise was most SF "slips" on clean sites.
      if (sys !== 'S') {
        for (const [band, lm] of phaseM) {
          if (dualChecked.has(band)) continue;
          const prevLm = prev.phase.get(band);
          if (prevLm === undefined) continue;
          const cm = codeM.get(band);
          const prevCm = prev.code.get(band);
          if (cm === undefined || prevCm === undefined) continue;
          const d = lm - cm;
          const { lbl, sigKey } = this.sfOf(sys, band);
          this.countEpoch(sigKey);
          const pending = prev.sfPending.get(band);
          if (pending) {
            if (Math.abs(d - pending.ref) > SF_THRESHOLD_M)
              this.recordSlip(
                sigKey,
                pending.time,
                prn,
                lbl,
                pending.magnitude,
                new Set([band])
              );
            continue;
          }
          const ref = prevLm - prevCm;
          const jumpM = Math.abs(d - ref);
          if (jumpM > SF_THRESHOLD_M)
            sfPending.set(band, { time, magnitude: jumpM, ref });
        }
      }
    }

    if (this.tested || this.slipped) {
      const ps = (this.perSystem[sys] ??= { slipEpochs: 0, testedEpochs: 0 });
      if (this.tested) {
        this.testedEpochs++;
        ps.testedEpochs++;
      }
      if (this.slipped) {
        this.slipEpochs++;
        ps.slipEpochs++;
      }
    }

    next.time = time;
    next.valid = true;
    st.cur = 1 - st.cur;
  };

  finalize(): CycleSlipResult {
    const satSlipCounts: Record<string, number> = {};
    for (const ev of this.events) {
      satSlipCounts[ev.prn] = (satSlipCounts[ev.prn] ?? 0) + 1;
    }

    const signalStats: CycleSlipSignalStats[] = [];
    const allKeys = new Set([
      ...this.signalEpochs.keys(),
      ...this.signalSlips.keys(),
    ]);
    for (const sigKey of allKeys) {
      const [sys, ...rest] = sigKey.split(':');
      const signal = rest.join(':');
      const totalEpochs = this.signalEpochs.get(sigKey) ?? 0;
      const totalSlips = this.signalSlips.get(sigKey) ?? 0;
      const sysName = SYSTEM_NAMES[sys!] ?? sys!;
      signalStats.push({
        label: `${signal} (${sysName})`,
        system: sys!,
        totalSlips,
        satellites: this.signalSats.get(sigKey)?.size ?? 0,
        totalEpochs,
        slipRate: totalEpochs > 0 ? (totalSlips / totalEpochs) * 1000 : 0,
      });
    }

    const sysOrder = 'GRECIJS';
    signalStats.sort((a, b) => {
      const da = sysOrder.indexOf(a.system);
      const db = sysOrder.indexOf(b.system);
      if (da !== db) return (da === -1 ? 99 : da) - (db === -1 ? 99 : db);
      return a.label.localeCompare(b.label);
    });

    return {
      events: this.events,
      signalStats,
      satSlipCounts,
      slipEpochs: this.slipEpochs,
      testedEpochs: this.testedEpochs,
      perSystem: this.perSystem,
    };
  }
}
