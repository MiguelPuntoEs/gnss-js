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
  toRtkEpoch,
  type EphemerisSource,
  type RawObservation,
  type RtkFloatOptions,
} from './rtk';

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
   * Maximum |base − rover| epoch-time difference to accept a pair (ms).
   * Default 500. Base and rover are matched by rounded second, so this
   * mainly rejects a base gap rather than sub-second offsets.
   */
  pairToleranceMs?: number;
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
}

const epochsOf = (o: RtkObsInput): readonly RtkObsEpoch[] =>
  Array.isArray(o) ? o : (o as { epochs: readonly RtkObsEpoch[] }).epochs;

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
  const tol = opts.pairToleranceMs ?? 500;
  const round = (ms: number) => Math.round(ms / 1000) * 1000;

  // Base epochs keyed by rounded second for synchronized lookup.
  const baseByT = new Map<number, RtkObsEpoch>();
  for (const e of epochsOf(base)) baseByT.set(round(e.timeMs), e);

  const engine = new RtkFloatEngine(baseEcef, ephemerides, opts);

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

  const sorted = [...epochsOf(rover)].sort((a, b) => a.timeMs - b.timeMs);
  for (const rEp of sorted) {
    if (seen.has(rEp.timeMs)) continue; // drop RANGE/RANGECMP-style repeats
    seen.add(rEp.timeMs);
    const bEp = baseByT.get(round(rEp.timeMs));
    if (!bEp || Math.abs(bEp.timeMs - rEp.timeMs) > tol) {
      unmatched++;
      continue;
    }
    const sol = engine.process(
      toRtkEpoch(rEp.meas),
      toRtkEpoch(bEp.meas),
      rEp.timeMs
    );
    if (!sol) continue;
    solved++;
    if (sol.status === 'fixed') fixed++;
    const [lat, lon, height] = ecefToGeodetic(
      sol.position[0],
      sol.position[1],
      sol.position[2]
    );
    track.push({
      timeMs: rEp.timeMs,
      position: sol.position,
      lat,
      lon,
      height,
      enu: enuOf(sol.position),
      status: sol.status,
      ratio: sol.ratio,
      nSats: sol.nSats,
      nFixed: sol.nFixed,
    });
  }

  return { track, solved, unmatched, fixRate: solved ? fixed / solved : 0 };
}
