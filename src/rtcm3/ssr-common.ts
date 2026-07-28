/**
 * Shared SSR field decoders and enums used by both the RTCM-SSR messages
 * (1057–1068, {@link ./ssr}) and IGS-SSR 4076 ({@link ./igs-ssr}). IGS-SSR
 * mirrors the RTCM-SSR orbit/clock/URA encoding field-for-field (DF365–370 ≡
 * IDF013–018, DF376–378 ≡ IDF019–021, DF389 ≡ IDF034, DF391 ≡ IDF004), so the
 * bit widths and scale factors live here once. Not re-exported from the rtcm3
 * barrel — internal to the two SSR decoders.
 */
import type { BitReader } from './decoder';
import type { SsrSatCorrection } from './ssr';

/** DF391 / IDF004 SSR Update Interval enum → seconds. */
export const UPDATE_INTERVAL_S = [
  1, 2, 5, 10, 15, 30, 60, 120, 240, 300, 600, 900, 1800, 3600, 7200, 10800,
];

/** DF389 / IDF034 SSR URA (6-bit CLASS/VALUE) → 1σ millimetres, or null. */
export function ssrUraMm(v: number): number | null {
  if (v === 0) return null; // undefined / unknown
  const cls = (v >> 3) & 0x7;
  const val = v & 0x7;
  return 3 ** cls * (1 + val / 4) - 1; // millimetres
}

/** IODE (8) + the six orbit correction fields (radial/along/cross + rates). */
export function readSsrOrbit(r: BitReader, sat: SsrSatCorrection): void {
  sat.iode = r.readU(8); // DF071/DF392 / IDF012
  sat.deltaRadial = r.readS(22) * 0.0001; // DF365 / IDF013 0.1 mm
  sat.deltaAlongTrack = r.readS(20) * 0.0004; // DF366 / IDF014 0.4 mm
  sat.deltaCrossTrack = r.readS(20) * 0.0004; // DF367 / IDF015 0.4 mm
  sat.dotRadial = r.readS(21) * 0.000001; // DF368 / IDF016 0.001 mm/s
  sat.dotAlongTrack = r.readS(19) * 0.000004; // DF369 / IDF017 0.004 mm/s
  sat.dotCrossTrack = r.readS(19) * 0.000004; // DF370 / IDF018 0.004 mm/s
}

/** The three clock polynomial coefficients c0/c1/c2. */
export function readSsrClock(r: BitReader, sat: SsrSatCorrection): void {
  sat.c0 = r.readS(22) * 0.0001; // DF376 / IDF019 0.1 mm
  sat.c1 = r.readS(21) * 0.000001; // DF377 / IDF020 0.001 mm/s
  sat.c2 = r.readS(27) * 0.00000002; // DF378 / IDF021 0.00002 mm/s²
}
