/**
 * Broadcast-ephemeris validity — whether an ephemeris may position its
 * satellite at a given epoch, and the nearest one that may.
 *
 * Each system's half-window |t − toc| follows its broadcast design, never
 * wider than the documented validity:
 *  - GPS / QZSS: the 4-h curve fit centred on toe → ±2 h (IS-GPS-200,
 *    IS-QZSS; RTKLIB MAXDTOE).
 *  - Galileo: 2.5 h, inside the 4-h nominal validity (RTKLIB MAXDTOE_GAL).
 *  - BeiDou: 90 min — ephemerides are refreshed hourly.
 *  - GLONASS: the immediate data cover a 30-min interval centred on tb →
 *    ±15 min.
 *  - NavIC: ±2 h (2-h update cycle).
 *  - SBAS GEO (MT9 state vector): 6 min (RTKLIB MAXDTOE_SBS) — a GEO
 *    extrapolated from an hours-old state vector is not an orbit.
 * Any other system is never valid.
 *
 * Time: `tGpsMs` is GPS-scale epoch ms, like everywhere in this module.
 * GLONASS and SBAS tocs are on the UTC axis (see {@link computeSatPosition}),
 * so for those t is moved to UTC first — on a ±15-min window the 18-s
 * leap-second offset matters.
 */

import type { Ephemeris } from '../rinex/nav';
import { getGpsLeap } from '../time/utc';

const H = 3_600_000;
const MIN = 60_000;

/** Validity half-window |t − toc| per system letter, in ms. */
export const EPHEMERIS_VALIDITY_MS: Readonly<Record<string, number>> = {
  G: 2 * H,
  J: 2 * H,
  E: 2.5 * H,
  C: 90 * MIN,
  R: 15 * MIN,
  I: 2 * H,
  S: 6 * MIN,
};

/** |t − toc| in ms on the ephemeris' own time scale. */
function tocDistanceMs(eph: Ephemeris, tGpsMs: number): number {
  const t =
    eph.system === 'R' || eph.system === 'S'
      ? tGpsMs - getGpsLeap(new Date(tGpsMs)) * 1000
      : tGpsMs;
  return Math.abs(eph.tocDate.getTime() - t);
}

/** May `eph` position its satellite at GPS-scale epoch `tGpsMs`? */
export function isEphemerisValid(eph: Ephemeris, tGpsMs: number): boolean {
  const w = EPHEMERIS_VALIDITY_MS[eph.system];
  return w !== undefined && tocDistanceMs(eph, tGpsMs) <= w;
}

/**
 * The ephemeris in `ephs` whose toc is nearest to `tGpsMs` among those valid
 * at `tGpsMs`, or null when none is. `ephs` may mix satellites; filter by PRN
 * first if it does.
 */
export function nearestValidEphemeris(
  ephs: readonly Ephemeris[] | undefined,
  tGpsMs: number
): Ephemeris | null {
  if (!ephs) return null;
  let best: Ephemeris | null = null;
  let bestDt = Infinity;
  for (const eph of ephs) {
    const dt = tocDistanceMs(eph, tGpsMs);
    const w = EPHEMERIS_VALIDITY_MS[eph.system];
    if (w === undefined || dt > w) continue;
    if (dt < bestDt) {
      bestDt = dt;
      best = eph;
    }
  }
  return best;
}
