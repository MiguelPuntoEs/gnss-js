/**
 * Apply SSR / HAS orbit + clock corrections to a broadcast ephemeris to obtain
 * a precise satellite ECEF position and clock offset — the bridge between the
 * decode-only SSR/HAS decoders (`rtcm3/ssr`, `rtcm3/igs-ssr`, `navbits/has`)
 * and a PPP/SPP solve.
 *
 * Convention (internal, "additive"): the orbit deltas are stored in the
 * satellite radial / along-track / cross-track (RAC) frame such that
 *
 *     correctedPos   = broadcastPos   + R·Δ(radial, along, cross)
 *     correctedClock = broadcastClock + (c0 + c1·dt + c2·dt²)/c
 *
 * This matches Galileo HAS directly (ICD §7.2–7.3). RTCM-SSR and IGS-SSR use
 * the **opposite** orbit sign, so their adapters negate the orbit deltas when
 * building an {@link OrbitClockCorrection} (see `ssrToOrbitClock`, added with
 * the RTCM/IGS wiring). Clock and bias sign conventions are handled per source
 * in the adapters, not here.
 */
import type { Ephemeris, KeplerEphemeris } from '../rinex/nav';
import { computeSatPosition } from '../orbit';
import { C_LIGHT } from '../constants/gnss';
import type { HasOrbitCorrection, HasClockCorrection } from '../navbits/has';

/**
 * A normalized per-satellite orbit + clock correction, ready to apply to a
 * broadcast ephemeris. Additive convention (see file header). Orbit deltas are
 * in the RAC frame in metres, referenced to the broadcast issue-of-data `iod`
 * at `refTimeMs`; optional `dot*` give their linear rate (RTCM/IGS SSR carry
 * these, HAS does not). Clock is a metres polynomial about `refTimeMs`.
 */
export interface OrbitClockCorrection {
  prn: string;
  /** Broadcast IODE (GPS/…) or IODnav (Galileo) the deltas refer to. */
  iod: number;
  /** Correction reference epoch, GPS-scale ms (matches `computeSatPosition`). */
  refTimeMs: number;
  radial: number;
  along: number;
  cross: number;
  dotRadial?: number;
  dotAlong?: number;
  dotCross?: number;
  /** Clock polynomial (m): c0 + c1·dt + c2·dt². */
  clockC0: number;
  clockC1?: number;
  clockC2?: number;
  /** Additive high-rate clock term (m), when a separate high-rate stream is combined. */
  highRateClock?: number;
  /** Validity window (s) from `refTimeMs`; null = unbounded / unknown. */
  validitySeconds?: number | null;
}

/** A corrected satellite state: ECEF position (m) + the clock offset (s) to ADD
 *  to the broadcast satellite clock. The caller forms the total clock as
 *  `satClockCorrection(eph, t) + clockOffsetS`. */
export interface AppliedOrbitClock {
  x: number;
  y: number;
  z: number;
  clockOffsetS: number;
}

const cross = (
  a: readonly number[],
  b: readonly number[]
): [number, number, number] => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const norm = (a: readonly number[]) => Math.hypot(a[0]!, a[1]!, a[2]!);
const unit = (a: readonly number[]): [number, number, number] => {
  const n = norm(a);
  return n > 0 ? [a[0]! / n, a[1]! / n, a[2]! / n] : [0, 0, 0];
};

/**
 * Corrected satellite ECEF position + clock offset at emission time `timeMs`,
 * from a broadcast ephemeris and an SSR/HAS orbit-clock correction. Returns
 * null when the correction's IOD doesn't match the ephemeris, the correction
 * has expired, or the orbit can't be computed.
 */
export function applyOrbitClock(
  eph: Ephemeris,
  corr: OrbitClockCorrection,
  timeMs: number
): AppliedOrbitClock | null {
  // SSR/HAS orbit corrections reference a Keplerian issue-of-data (IODE/IODnav);
  // GLONASS/SBAS ephemerides don't carry one and aren't corrected here.
  if (eph.system === 'R' || eph.system === 'S') return null;
  // The deltas are only valid against the ephemeris issue they reference.
  if ((eph as KeplerEphemeris).iode !== corr.iod) return null;
  const age = (timeMs - corr.refTimeMs) / 1000;
  if (corr.validitySeconds != null && (age < -1 || age > corr.validitySeconds))
    return null;

  const s = computeSatPosition(eph, timeMs);
  if (!Number.isFinite(s.x)) return null;
  const p: [number, number, number] = [s.x, s.y, s.z];
  const v: [number, number, number] = [s.vx, s.vy, s.vz];

  // Satellite RAC unit vectors: radial (out), cross-track (orbit normal),
  // along-track (= cross × radial, ~velocity direction).
  const er = unit(p);
  const en = unit(cross(p, v));
  const ea = cross(en, er);

  const dr = corr.radial + (corr.dotRadial ?? 0) * age;
  const da = corr.along + (corr.dotAlong ?? 0) * age;
  const dc = corr.cross + (corr.dotCross ?? 0) * age;

  const x = s.x + dr * er[0] + da * ea[0] + dc * en[0];
  const y = s.y + dr * er[1] + da * ea[1] + dc * en[1];
  const z = s.z + dr * er[2] + da * ea[2] + dc * en[2];

  const clockM =
    corr.clockC0 +
    (corr.clockC1 ?? 0) * age +
    (corr.clockC2 ?? 0) * age * age +
    (corr.highRateClock ?? 0);

  return { x, y, z, clockOffsetS: clockM / C_LIGHT };
}

/**
 * Build a normalized {@link OrbitClockCorrection} from a Galileo-HAS orbit
 * correction (+ optional matching clock correction). HAS already uses the
 * additive convention, so no sign flip. Returns null when the orbit deltas are
 * flagged "not available". `refTimeMs` is the message ToH as GPS-scale ms.
 */
export function hasToOrbitClock(
  orbit: HasOrbitCorrection,
  clock: HasClockCorrection | undefined,
  refTimeMs: number,
  validitySeconds: number | null
): OrbitClockCorrection | null {
  if (
    orbit.deltaRadial == null ||
    orbit.deltaInTrack == null ||
    orbit.deltaCrossTrack == null
  )
    return null;
  const clockC0 =
    clock && clock.deltaClock != null && !clock.notUsable
      ? clock.deltaClock
      : 0;
  return {
    prn: orbit.prn,
    iod: orbit.gnssIod,
    refTimeMs,
    radial: orbit.deltaRadial,
    along: orbit.deltaInTrack,
    cross: orbit.deltaCrossTrack,
    clockC0,
    validitySeconds,
  };
}
