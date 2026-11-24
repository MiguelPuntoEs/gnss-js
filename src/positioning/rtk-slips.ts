/**
 * Cycle-slip detection for one receiver's RTK input.
 *
 * The RTK engine resets a satellite's ambiguity when its lock time goes
 * backwards (`RtkMeasurement.lockTimeMs`). Decoders of receiver streams
 * report lock times; RINEX files do not, and many receivers flag only a
 * few of their slips there. A slip that is smaller than the engine's
 * phase-minus-code gate (5 m, ~26 L1 cycles) then goes unnoticed, and in a
 * static solution, where ambiguities barely move, it bends the position.
 *
 * This detector keeps a lock clock per satellite and restarts it when the
 * satellite's phase shows a slip, then writes it into the observations as
 * `lockTimeS`:
 *
 * - the receiver says so: a loss-of-lock indicator (LLI bit 0) on any of
 *   the satellite's carriers, or its own lock time going backwards;
 * - the geometry-free combination λ₁φ₁ − λ₂φ₂ jumps: with two carriers it
 *   holds only the ionosphere (smooth over seconds to a minute) and the
 *   ambiguities, so a jump against its linear prediction from the two
 *   previous epochs above `gfThresholdM` is a slip on either carrier.
 *   Single-frequency satellites rely on the receiver's flags alone.
 *
 * A gap longer than `maxGapS` restarts the history without a slip: the
 * engine resets on gaps itself.
 */
import { carrierFreqHz, type RawObservation } from './rtk';
import { C_LIGHT } from '../constants/gnss';

export interface RtkSlipOptions {
  /** Geometry-free jump (m) taken as a slip. Default 0.05 (one L1 cycle
   *  is 0.19 m in it, one L2 cycle 0.24 m, an equal slip on both 0.05). */
  gfThresholdM?: number;
  /** Longest gap (s) the geometry-free prediction bridges. Default 120. */
  maxGapS?: number;
}

/** Second-carrier bands to pair with the first, by system, in order. */
const SECOND_BANDS: Record<string, string[]> = {
  G: ['2', '5'],
  J: ['2', '5'],
  E: ['5', '7', '8', '6'],
  C: ['7', '6', '5', '2', '1'],
  R: ['2', '3'],
};

interface Track {
  /** Lock start (ms); the lock time is now − start. */
  startMs: number;
  lastMs: number;
  /** Receiver lock time at the previous epoch (s), if it reports one. */
  rcvLockS?: number;
  /** Carriers the geometry-free history was formed from. */
  pair?: string;
  gf: { t: number; v: number }[];
}

export class RtkSlipDetector {
  private readonly thr: number;
  private readonly maxGapMs: number;
  private readonly tracks = new Map<string, Track>();
  /** Slips found so far, by cause. */
  readonly counts = { receiver: 0, geometryFree: 0 };

  constructor(opts: RtkSlipOptions = {}) {
    this.thr = opts.gfThresholdM ?? 0.05;
    this.maxGapMs = (opts.maxGapS ?? 120) * 1000;
  }

  /** One epoch's observations with `lockTimeS` set from this detector's
   *  lock clock (every observation of a satellite gets the same). */
  annotate(timeMs: number, meas: readonly RawObservation[]): RawObservation[] {
    const byPrn = new Map<string, RawObservation[]>();
    for (const m of meas) {
      const list = byPrn.get(m.prn);
      if (list) list.push(m);
      else byPrn.set(m.prn, [m]);
    }
    const lock = new Map<string, number>();
    for (const [prn, list] of byPrn) {
      const phases = list.filter(
        (m) => m.cp != null && Number.isFinite(m.cp) && m.cp !== 0
      );
      let tr = this.tracks.get(prn);
      if (!tr || timeMs - tr.lastMs > this.maxGapMs) {
        tr = { startMs: timeMs, lastMs: timeMs, gf: [] };
        this.tracks.set(prn, tr);
      }
      const first = tr.lastMs === timeMs && tr.gf.length === 0;
      let slip = false;
      // The receiver's word: LLI, or its lock time going backwards.
      if (!first) {
        if (phases.some((m) => m.lli != null && (m.lli & 1) === 1)) slip = true;
        const rcv = list.find((m) => m.lockTimeS !== undefined)?.lockTimeS;
        if (rcv !== undefined && tr.rcvLockS !== undefined && rcv < tr.rcvLockS)
          slip = true;
        if (slip) this.counts.receiver++;
      }
      tr.rcvLockS = list.find((m) => m.lockTimeS !== undefined)?.lockTimeS;
      // The geometry-free combination.
      const gf = geometryFree(prn, phases, tr.pair);
      if (!gf || gf.pair !== tr.pair) {
        tr.gf = [];
        tr.pair = gf?.pair;
      }
      if (gf) {
        const h = tr.gf;
        if (!slip && h.length > 0) {
          const pred =
            h.length >= 2
              ? h[1]!.v +
                ((h[1]!.v - h[0]!.v) * (timeMs - h[1]!.t)) / (h[1]!.t - h[0]!.t)
              : h[0]!.v;
          if (Math.abs(gf.v - pred) > this.thr) {
            slip = true;
            this.counts.geometryFree++;
          }
        }
        if (slip) h.length = 0;
        h.push({ t: timeMs, v: gf.v });
        if (h.length > 2) h.shift();
      }
      if (slip) tr.startMs = timeMs;
      tr.lastMs = timeMs;
      lock.set(prn, (timeMs - tr.startMs) / 1000);
    }
    return meas.map((m) => ({ ...m, lockTimeS: lock.get(m.prn) }));
  }
}

/** λ₁φ₁ − λ₂φ₂ (m) from the first L1-band carrier and a second band,
 *  keeping the previous pair while both carriers are there. */
function geometryFree(
  prn: string,
  phases: readonly RawObservation[],
  prevPair: string | undefined
): { v: number; pair: string } | null {
  const sys = prn[0]!;
  const second = SECOND_BANDS[sys];
  if (!second || phases.length < 2) return null;
  const k = phases.find((m) => m.gloChannel != null)?.gloChannel ?? null;
  const lam = (m: RawObservation) => {
    const f = carrierFreqHz(sys, m.code, k);
    return f > 0 ? C_LIGHT / f : 0;
  };
  const pick = (codes: string[]) =>
    codes.map((c) => phases.find((m) => m.code === c));
  if (prevPair) {
    const [a, b] = pick(prevPair.split('/'));
    if (a && b && lam(a) && lam(b))
      return { v: lam(a) * a.cp! - lam(b) * b.cp!, pair: prevPair };
  }
  const firstBand = sys === 'C' ? ['2', '1'] : ['1'];
  const a = firstBand
    .map((band) => phases.find((m) => m.code[0] === band))
    .find((m) => m && lam(m));
  if (!a) return null;
  const b = second
    .filter((band) => band !== a.code[0])
    .map((band) => phases.find((m) => m.code[0] === band))
    .find((m) => m && lam(m));
  if (!b) return null;
  return { v: lam(a) * a.cp! - lam(b) * b.cp!, pair: `${a.code}/${b.code}` };
}
