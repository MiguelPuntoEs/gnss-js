/**
 * A receiver's own navigation solution (position/velocity/time), normalised
 * across manufacturers: Septentrio PVTGeodetic, NovAtel BESTPOS, u-blox
 * NAV-PVT. Useful as a truth/reference to cross-check an independent SPP/SBAS
 * solution against (position + accuracy), and to know the receiver's own
 * solution mode.
 */
export interface ReceiverPvt {
  /** GPS-scale epoch time (ms). */
  timeMs: number;
  week: number;
  /** Time of week (s). */
  tow: number;
  /** Solution mode: 'standalone' | 'differential' | 'sbas-aided' |
   *  'rtk-float' | 'rtk-fixed' | 'ppp' | 'no-pvt' | 'fixed-location' | … */
  mode: string;
  latDeg: number | null;
  lonDeg: number | null;
  /** Ellipsoidal height (m). */
  heightM: number | null;
  /** Satellites used in the receiver's solution. */
  nrSV: number | null;
  /** Receiver horizontal accuracy estimate (m). */
  hAccuracyM: number | null;
  /** Receiver vertical accuracy estimate (m). */
  vAccuracyM: number | null;
}
