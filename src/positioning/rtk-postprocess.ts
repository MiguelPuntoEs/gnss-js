/**
 * Offline RTK post-processing — the `rnx2rtkp`-style batch driver.
 *
 * Pairs a base and rover observation stream by epoch time and feeds each
 * synchronized pair to a single {@link RtkFloatEngine} (float, with optional
 * LAMBDA integer fixing), collecting the rover track. The estimation is
 * entirely the float/fixed engine already validated on live streams; this
 * module is only the batch loop + epoch pairing around it, so a recorded
 * base/rover pair (RINEX, or any decoded receiver stream) can be processed
 * to a fixed/float track the same way the live path does.
 */
import { ecefToGeodetic } from '../coordinates';
import {
  RtkFloatEngine,
  solveDgnss,
  toRtkEpoch,
  type EphemerisSource,
  type RawObservation,
  type RtkFloatOptions,
} from './rtk';
import { RtkSlipDetector, type RtkSlipOptions } from './rtk-slips';

/** One observation epoch (base or rover) — the shape the receiver/RINEX
 *  parsers already produce (`parseNovatelRange().epochs`, etc.). */
export interface RtkObsEpoch {
  /** Epoch, GPS-scale milliseconds. */
  timeMs: number;
  meas: readonly RawObservation[];
}

/** Either a bare epoch array or a `{ epochs }` parser result. */
export type RtkObsInput =
  readonly RtkObsEpoch[] | { readonly epochs: readonly RtkObsEpoch[] };

export interface RtkTrackPoint {
  /** Epoch, GPS-scale milliseconds. */
  timeMs: number;
  /** Rover position ECEF (m) — ambiguity-fixed when `status === 'fixed'`. */
  position: [number, number, number];
  /** Geodetic latitude, longitude (radians) and ellipsoidal height (m). */
  lat: number;
  lon: number;
  height: number;
  /** Rover − base baseline in the base's local ENU frame (m). */
  enu: [number, number, number];
  /** 'fixed' (integer AR passed), 'float', or 'dgnss' (code-only). */
  status: 'fixed' | 'float' | 'dgnss';
  /** LAMBDA validation ratio, when a fix was attempted. */
  ratio?: number;
  /** Satellites contributing this epoch. */
  nSats: number;
  /** Integer-fixed ambiguities, when fixed. */
  nFixed?: number;
}

export interface RtkPostProcessOptions extends RtkFloatOptions {
  /**
   * Maximum age of the base epoch paired with a rover epoch (ms): each
   * rover epoch takes the nearest base epoch, which the engine models at
   * its own time. Default 15 000, so a 30 s base serves a 1 Hz or 5 Hz
   * rover (DJI M300 at 5 Hz, 44 m from its base, against a commercial
   * trajectory: fixed epochs 0.3 cm horizontal / 0.5 cm vertical median
   * with a 1 Hz base, 0.7 / 0.7 cm with a 30 s one).
   */
  pairToleranceMs?: number;
  /**
   * Code-only differential (DGNSS): solve each epoch from double-differenced
   * pseudoranges via {@link solveDgnss} instead of the carrier-phase float
   * engine. Every epoch is independent (no filter), so there is no ambiguity
   * fixing — a robust metre→sub-metre fallback that needs no carrier phase.
   * Track points come back with `status: 'dgnss'`. Default false.
   */
  codeOnly?: boolean;
  /**
   * Cycle-slip detection on both receivers' phases ahead of the engine
   * ({@link RtkSlipDetector}: the files' loss-of-lock flags and jumps in
   * the geometry-free combination), or `false` to rely on the observations'
   * own lock times and the engine's phase-minus-code gate. Default on.
   */
  slipDetection?: boolean | RtkSlipOptions;
  /**
   * Carrier frequencies per satellite: 1 (the L1 band) or 2 (plus GPS L2,
   * Galileo E5a, QZSS L2, BeiDou B3I/B2I — see {@link toRtkEpoch}). Two
   * frequencies are what `ionosphere: 'estimate'` needs. Default 1.
   */
  frequencies?: 1 | 2;
  /**
   * Static sessions on a baseline longer than this (km, from a code
   * solution on the first epochs) switch to the long-baseline model: two
   * frequencies, the ionosphere estimated per satellite and the relative
   * troposphere estimated — unless `frequencies`, `ionosphere` or
   * `estimateTroposphere` is given. `false` keeps the single-frequency
   * short-baseline model at every length. Default 8 (EPN pairs from 8.6 to
   * 16.9 km: better in every week but at CEBR–MADR, 10 km; 2–5× better
   * from 16 km on). Kinematic sessions use {@link kinematicLongBaselineKm}.
   */
  longBaselineKm?: number | false;
  /**
   * The same switch for kinematic sessions. Default 20: on EPN pairs
   * processed epoch by epoch the long-baseline model fixes less often up
   * to 17 km and fixes more often, with fewer wrong fixes, from 24 km on.
   */
  kinematicLongBaselineKm?: number | false;
}

/** The model a run used (after the long-baseline choice). */
export interface RtkModelChoice {
  frequencies: 1 | 2;
  ionosphere: 'off' | 'estimate';
  troposphere: boolean;
  /** Baseline length from the code solution (km), when one was made. */
  baselineKm: number | null;
}

export interface RtkPostProcessResult {
  /** Solved rover epochs in time order. */
  track: RtkTrackPoint[];
  /** Rover epochs paired with a base epoch and solved. */
  solved: number;
  /** Rover epochs with no base epoch within tolerance. */
  unmatched: number;
  /** Fraction of solved epochs with an integer-fixed solution (0–1). */
  fixRate: number;
  /** Slips the detector found on the base and the rover (zero when
   *  `slipDetection` is off). */
  slips: { base: number; rover: number };
  /** The model used: frequencies, ionosphere and troposphere estimation. */
  model: RtkModelChoice;
  /**
   * The session's baseline for static processing: the last ambiguity-fixed
   * epoch (the static filter has used every epoch up to it), else the last
   * float one; null with no carrier-phase solution (or `codeOnly`).
   */
  final: {
    timeMs: number;
    status: 'fixed' | 'float';
    /** Rover − base, ECEF (m). */
    baseline: [number, number, number];
    /** Its covariance, ECEF (m²): given the integers when fixed. */
    covariance: number[][];
    ratio?: number;
  } | null;
}

const epochsOf = (o: RtkObsInput): readonly RtkObsEpoch[] =>
  Array.isArray(o) ? o : (o as { epochs: readonly RtkObsEpoch[] }).epochs;

/** Median gap between consecutive (unique, sorted) epoch times, or null. */
function medianIntervalMs(epochs: readonly RtkObsEpoch[]): number | null {
  const times = [...new Set(epochs.map((e) => e.timeMs))].sort((a, b) => a - b);
  if (times.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}

/**
 * The long-baseline choice: explicit options win; otherwise a session
 * longer than `longBaselineKm` (static) or `kinematicLongBaselineKm`
 * gets two frequencies with the ionosphere and troposphere estimated.
 */
function chooseModel(
  opts: RtkPostProcessOptions,
  roverEpochs: readonly RtkObsEpoch[],
  pairBase: (timeMs: number) => RtkObsEpoch | null,
  dgnss: (
    rover: RtkObsEpoch,
    base: RtkObsEpoch
  ) => { baseline: [number, number, number] } | null
): RtkModelChoice {
  const explicit: RtkModelChoice = {
    frequencies: opts.frequencies ?? 1,
    ionosphere: opts.ionosphere ?? 'off',
    troposphere: opts.estimateTroposphere ?? false,
    baselineKm: null,
  };
  const limit =
    (opts.mode ?? 'kinematic') === 'static'
      ? (opts.longBaselineKm ?? 8)
      : (opts.kinematicLongBaselineKm ?? 20);
  if (
    limit === false ||
    opts.codeOnly ||
    opts.frequencies !== undefined ||
    opts.ionosphere !== undefined ||
    opts.estimateTroposphere !== undefined
  )
    return explicit;
  // The first few paired epochs with a code solution give the length.
  let tried = 0;
  for (const r of roverEpochs) {
    const b = pairBase(r.timeMs);
    if (!b) continue;
    const dg = dgnss(r, b);
    if (dg) {
      const km = Math.hypot(...dg.baseline) / 1000;
      return km > limit
        ? {
            frequencies: 2,
            ionosphere: 'estimate',
            troposphere: true,
            baselineKm: km,
          }
        : { ...explicit, baselineKm: km };
    }
    if (++tried >= 20) break;
  }
  return explicit;
}

/**
 * Post-process a base/rover observation pair into an RTK track.
 *
 * @param base        base-station observation epochs (needs a known position)
 * @param rover       rover observation epochs
 * @param ephemerides broadcast (or precise) ephemerides covering the window
 * @param baseEcef    surveyed base position, ECEF metres
 * @param opts        engine options (`mode`, `elevationMaskDeg`,
 *                    `ambiguityResolution`, …) plus `pairToleranceMs`
 */
export function postProcessRtk(
  base: RtkObsInput,
  rover: RtkObsInput,
  ephemerides: EphemerisSource,
  baseEcef: readonly [number, number, number],
  opts: RtkPostProcessOptions = {}
): RtkPostProcessResult {
  const tol = opts.pairToleranceMs ?? 15_000;
  const roverEpochs = epochsOf(rover);

  // Detect the rover sampling interval and, unless the caller pinned it,
  // scale the engine's cycle-slip gap gate to it. The engine default
  // (`maxGapMs` 10 s) is tuned for ~1 Hz streams; on 30 s RINEX every epoch
  // is >10 s from the last, so *every* satellite would be flagged as a slip
  // each epoch — resetting the float ambiguities and gutting the fix rate.
  // Tolerating ~2 missed epochs keeps the continuous float alive.
  const interval = medianIntervalMs(roverEpochs);
  // Each rover epoch is paired with the nearest base epoch within the
  // tolerance; the engine models the base at its own epoch, so a 1 Hz base
  // serves a 5 Hz rover.
  const baseEpochs = [...epochsOf(base)].sort((a, b) => a.timeMs - b.timeMs);
  const pairBase = (t: number): RtkObsEpoch | null => {
    let lo = 0;
    let hi = baseEpochs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (baseEpochs[mid]!.timeMs < t) lo = mid + 1;
      else hi = mid;
    }
    let best: RtkObsEpoch | null = null;
    for (const e of [baseEpochs[lo - 1], baseEpochs[lo]])
      if (
        e &&
        Math.abs(e.timeMs - t) <= tol &&
        (!best || Math.abs(e.timeMs - t) < Math.abs(best.timeMs - t))
      )
        best = e;
    return best;
  };

  const model = chooseModel(opts, roverEpochs, pairBase, (r, b) =>
    solveDgnss(
      toRtkEpoch(r.meas),
      toRtkEpoch(b.meas),
      baseEcef,
      ephemerides,
      r.timeMs,
      {
        elevationMaskDeg: opts.elevationMaskDeg,
        troposphere: opts.troposphere,
        codeSigmaM: opts.codeSigmaM,
        baseTimeMs: b.timeMs,
      }
    )
  );
  const engineOpts: RtkPostProcessOptions = {
    ...opts,
    ionosphere: model.ionosphere,
    estimateTroposphere: model.troposphere,
    ...(opts.maxGapMs != null || interval == null
      ? {}
      : { maxGapMs: Math.max(10_000, Math.round(interval * 2.5)) }),
  };

  const engine = new RtkFloatEngine(baseEcef, ephemerides, engineOpts);
  const fq = { frequencies: model.frequencies };
  const slipOpts =
    opts.slipDetection === false
      ? null
      : opts.slipDetection === true || opts.slipDetection === undefined
        ? {}
        : opts.slipDetection;
  const slipB = slipOpts ? new RtkSlipDetector(slipOpts) : null;
  const slipR = slipOpts ? new RtkSlipDetector(slipOpts) : null;

  // ECEF→ENU rotation at the base (constant), for the baseline readout.
  const [bLat, bLon] = ecefToGeodetic(baseEcef[0], baseEcef[1], baseEcef[2]);
  const [sLat, cLat, sLon, cLon] = [
    Math.sin(bLat),
    Math.cos(bLat),
    Math.sin(bLon),
    Math.cos(bLon),
  ];
  const enuOf = (
    p: readonly [number, number, number]
  ): [number, number, number] => {
    const dx = p[0] - baseEcef[0];
    const dy = p[1] - baseEcef[1];
    const dz = p[2] - baseEcef[2];
    return [
      -sLon * dx + cLon * dy,
      -sLat * cLon * dx - sLat * sLon * dy + cLat * dz,
      cLat * cLon * dx + cLat * sLon * dy + sLat * dz,
    ];
  };

  const track: RtkTrackPoint[] = [];
  const seen = new Set<number>();
  let solved = 0;
  let unmatched = 0;
  let fixed = 0;
  let lastFixed: RtkPostProcessResult['final'] = null;
  let lastFloat: RtkPostProcessResult['final'] = null;
  let lastBase: RtkObsEpoch | null = null;
  let lastBaseMeas: ReturnType<typeof toRtkEpoch> | null = null;

  const sorted = [...roverEpochs].sort((a, b) => a.timeMs - b.timeMs);
  for (const rEp of sorted) {
    if (seen.has(rEp.timeMs)) continue; // drop RANGE/RANGECMP-style repeats
    seen.add(rEp.timeMs);
    const bEp = pairBase(rEp.timeMs);
    if (!bEp) {
      unmatched++;
      continue;
    }
    let point: Omit<RtkTrackPoint, 'lat' | 'lon' | 'height' | 'enu'> | null;
    if (opts.codeOnly) {
      const dg = solveDgnss(
        toRtkEpoch(rEp.meas, fq),
        toRtkEpoch(bEp.meas, fq),
        baseEcef,
        ephemerides,
        rEp.timeMs,
        {
          elevationMaskDeg: opts.elevationMaskDeg,
          troposphere: opts.troposphere,
          codeSigmaM: opts.codeSigmaM,
          baseTimeMs: bEp.timeMs,
        }
      );
      point = dg
        ? {
            timeMs: rEp.timeMs,
            position: dg.position,
            status: 'dgnss',
            nSats: dg.nSats,
          }
        : null;
    } else {
      // A base epoch serving several rover epochs goes through its slip
      // detector once.
      if (bEp !== lastBase) {
        lastBase = bEp;
        lastBaseMeas = toRtkEpoch(
          slipB ? slipB.annotate(bEp.timeMs, bEp.meas) : bEp.meas,
          fq
        );
      }
      const sol = engine.process(
        toRtkEpoch(slipR ? slipR.annotate(rEp.timeMs, rEp.meas) : rEp.meas, fq),
        lastBaseMeas!,
        rEp.timeMs,
        bEp.timeMs
      );
      point = sol
        ? {
            timeMs: rEp.timeMs,
            position: sol.position,
            status: sol.status,
            ratio: sol.ratio,
            nSats: sol.nSats,
            nFixed: sol.nFixed,
          }
        : null;
      if (sol && (sol.status === 'fixed' || sol.status === 'float')) {
        const f = {
          timeMs: rEp.timeMs,
          status: sol.status,
          baseline: [
            sol.position[0] - baseEcef[0],
            sol.position[1] - baseEcef[1],
            sol.position[2] - baseEcef[2],
          ] as [number, number, number],
          covariance: sol.covariance,
          ...(sol.ratio != null ? { ratio: sol.ratio } : {}),
        };
        if (sol.status === 'fixed') lastFixed = f;
        else lastFloat = f;
      }
    }
    if (!point) continue;
    solved++;
    if (point.status === 'fixed') fixed++;
    const [lat, lon, height] = ecefToGeodetic(
      point.position[0],
      point.position[1],
      point.position[2]
    );
    track.push({ ...point, lat, lon, height, enu: enuOf(point.position) });
  }

  return {
    track,
    solved,
    unmatched,
    fixRate: solved ? fixed / solved : 0,
    slips: {
      base: slipB ? slipB.counts.receiver + slipB.counts.geometryFree : 0,
      rover: slipR ? slipR.counts.receiver + slipR.counts.geometryFree : 0,
    },
    final: lastFixed ?? lastFloat,
    model,
  };
}
