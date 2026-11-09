/**
 * Complete MSM1–3 ranges. Compact MSM carries each satellite's rough range
 * only modulo 1 ms (DF398, no DF397 integer milliseconds), so every decoded
 * pseudorange and phase is short by an unknown whole number of
 * light-milliseconds L ≈ 299.79 km. Predicting each range from an
 * approximate receiver position and the broadcast orbit + clock fixes that
 * number — up to the receiver clock, which shifts every satellite of the
 * epoch by the same unknown amount and may itself exceed a millisecond. So
 * the whole-millisecond counts are chosen against a common offset (the
 * circular mean of the per-satellite fractions), keeping the epoch
 * self-consistent: any whole-millisecond error left is common to all
 * satellites and ends up in the solved receiver clock, not the position.
 */
import { computeSatPosition } from '../orbit';
import type { Ephemeris } from '../rinex/nav';
import type { ObsEpoch, ObsSatObs } from '../rtcm3/msm';
import { C_LIGHT } from '../constants/gnss';
import { satClockCorrection } from './index';

/** One light-millisecond, metres. */
const LIGHT_MS = C_LIGHT / 1000;
/** A satellite whose prediction disagrees with the epoch's common offset by
 *  more than this fraction of L (~75 km) is dropped — bad orbit, bad
 *  approximate position, or a cycle of the modulo at the boundary. */
const MAX_FRACTION_MISFIT = 0.25;

export interface MsmResolveOptions {
  /** Epoch time, GPS-scale ms (as `obsEpochToDate` returns). */
  timeMs: number;
  /** Approximate receiver ECEF (m) — the station's 1005/1006, a sourcetable
   *  position, or a previous fix. Tens of km of error are tolerated. */
  rxEcef: readonly [number, number, number];
  /** Broadcast ephemeris for a PRN at this time, or null. */
  ephFor: (prn: string) => Ephemeris | null;
}

/** Predicted pseudorange less the receiver clock: ρ − c·dt_sat (m). */
function predictedRange(
  eph: Ephemeris,
  timeMs: number,
  rx: readonly [number, number, number]
): number | null {
  let tau = 0.075; // s — refined once by light time
  for (let i = 0; i < 2; i++) {
    const tEmit = timeMs - tau * 1000;
    const p = computeSatPosition(eph, tEmit);
    if (!Number.isFinite(p.x)) return null;
    const rho = Math.hypot(p.x - rx[0], p.y - rx[1], p.z - rx[2]);
    tau = rho / C_LIGHT;
    if (i === 1) return rho - C_LIGHT * satClockCorrection(eph, tEmit);
  }
  return null;
}

/** The epoch's modulo range for a satellite: a code signal's, else a phase
 *  signal's (MSM2) — all of a satellite's cells share its rough range. */
function moduloRange(sat: ObsSatObs): number | null {
  for (const s of sat.signals)
    if (s.pseudorange !== undefined) return s.pseudorange;
  for (const s of sat.signals)
    if (s.phase !== undefined && s.wavelength > 0)
      return s.phase * s.wavelength;
  return null;
}

/**
 * Add the missing whole light-milliseconds to an MSM1–3 epoch's ranges.
 * Returns the epoch with `rangeModulo1ms` cleared, keeping only satellites
 * whose range could be resolved (an ephemeris, and a prediction consistent
 * with the rest of the epoch). Epochs that aren't modulo-1-ms pass through.
 */
export function resolveMsmRanges(
  epoch: ObsEpoch,
  opts: MsmResolveOptions
): ObsEpoch {
  if (!epoch.rangeModulo1ms) return epoch;
  const cand: { sat: ObsSatObs; k: number }[] = [];
  for (const sat of epoch.observations) {
    const eph = opts.ephFor(sat.prn);
    const mod = moduloRange(sat);
    if (!eph || mod === null) continue;
    const pred = predictedRange(eph, opts.timeMs, opts.rxEcef);
    if (pred === null) continue;
    cand.push({ sat, k: (pred - mod) / LIGHT_MS });
  }
  const { rangeModulo1ms: _drop, ...rest } = epoch;
  if (cand.length === 0) return { ...rest, observations: [] };

  // Common offset (in L) = circular mean of the fractional parts.
  let sx = 0;
  let sy = 0;
  for (const c of cand) {
    sx += Math.cos(2 * Math.PI * c.k);
    sy += Math.sin(2 * Math.PI * c.k);
  }
  const b = Math.atan2(sy, sx) / (2 * Math.PI);

  const observations: ObsSatObs[] = [];
  for (const { sat, k } of cand) {
    const n = Math.round(k - b);
    if (Math.abs(k - b - n) > MAX_FRACTION_MISFIT) continue;
    const add = n * LIGHT_MS;
    observations.push({
      ...sat,
      signals: sat.signals.map((s) => ({
        ...s,
        ...(s.pseudorange !== undefined
          ? { pseudorange: s.pseudorange + add }
          : {}),
        ...(s.phase !== undefined && s.wavelength > 0
          ? { phase: s.phase + add / s.wavelength }
          : {}),
      })),
    });
  }
  return { ...rest, observations };
}
