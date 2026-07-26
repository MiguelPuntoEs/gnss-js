/**
 * Troposphere for PPP: a-priori Saastamoinen zenith hydrostatic delay
 * (ZHD) and the Niell (NMF) hydrostatic + wet mapping functions.
 *
 * The estimator carries the zenith WET delay as a state; the dry (ZHD)
 * part is fixed from the standard atmosphere. Niell 1996 ("Global mapping
 * functions for the atmosphere delay at radio wavelengths", JGR 101).
 */

/* Niell hydrostatic coefficients, tabulated at lat 15/30/45/60/75°. */
const HYD_AVG_A = [
  1.2769934e-3, 1.268323e-3, 1.2465397e-3, 1.2196049e-3, 1.2045996e-3,
];
const HYD_AVG_B = [
  2.9153695e-3, 2.9152299e-3, 2.9288445e-3, 2.9022565e-3, 2.9024912e-3,
];
const HYD_AVG_C = [
  62.610505e-3, 62.837393e-3, 63.721774e-3, 63.824265e-3, 64.258455e-3,
];
const HYD_AMP_A = [0.0, 1.2709626e-5, 2.6523662e-5, 3.4000452e-5, 4.1202191e-5];
const HYD_AMP_B = [0.0, 2.1414979e-5, 3.0160779e-5, 7.2562722e-5, 11.723375e-5];
const HYD_AMP_C = [0.0, 9.01284e-5, 4.3497037e-5, 84.795348e-5, 170.37206e-5];
const HT_A = 2.53e-5;
const HT_B = 5.49e-3;
const HT_C = 1.14e-3;

/* Niell wet coefficients (no seasonal / height terms). */
const WET_A = [
  5.8021897e-4, 5.6794847e-4, 5.8118019e-4, 5.9727542e-4, 6.1641693e-4,
];
const WET_B = [
  1.4275268e-3, 1.5138625e-3, 1.4572752e-3, 1.5007428e-3, 1.7599082e-3,
];
const WET_C = [
  4.3472961e-2, 4.672951e-2, 4.3908931e-2, 4.4626982e-2, 5.4736038e-2,
];

const LATS = [15, 30, 45, 60, 75];

/** Interpolate a tabulated coefficient by |latitude| (deg), clamped. */
function interpLat(table: number[], absLatDeg: number): number {
  if (absLatDeg <= 15) return table[0]!;
  if (absLatDeg >= 75) return table[4]!;
  let i = 0;
  while (i < 4 && absLatDeg > LATS[i + 1]!) i++;
  const t = (absLatDeg - LATS[i]!) / (LATS[i + 1]! - LATS[i]!);
  return table[i]! + t * (table[i + 1]! - table[i]!);
}

/** Marini continued fraction, normalised so m(90°)=1. */
function marini(sinEl: number, a: number, b: number, c: number): number {
  const num = 1 + a / (1 + b / (1 + c));
  const den = sinEl + a / (sinEl + b / (sinEl + c));
  return num / den;
}

/** UTC day-of-year (1–366) from GPS-scale epoch ms (leap-second offset is
 * negligible for the seasonal term). */
function dayOfYear(timeMs: number): number {
  const d = new Date(timeMs);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((timeMs - start) / 86400000) + 1;
}

export interface TropoMapping {
  /** A-priori zenith hydrostatic delay (m). */
  zhd: number;
  /** Hydrostatic mapping factor at the elevation. */
  mh: number;
  /** Wet mapping factor at the elevation. */
  mw: number;
}

/**
 * Saastamoinen ZHD + Niell hydrostatic/wet mapping at an elevation.
 * @param elRad elevation (rad), @param latRad geodetic latitude (rad),
 * @param heightM ellipsoidal height (m), @param timeMs epoch (GPS ms).
 */
export function niellMapping(
  elRad: number,
  latRad: number,
  heightM: number,
  timeMs: number
): TropoMapping {
  const sinEl = Math.sin(Math.max(elRad, 1e-3));
  const absLat = Math.abs((latRad * 180) / Math.PI);
  const hKm = heightM / 1000;

  // Seasonal hydrostatic coefficients (northern-hemisphere reference DOY 28;
  // shift by half a year in the south).
  let doy = dayOfYear(timeMs);
  if (latRad < 0) doy += 365.25 / 2;
  const yfrac = Math.cos((2 * Math.PI * (doy - 28)) / 365.25);
  const ah =
    interpLat(HYD_AVG_A, absLat) - interpLat(HYD_AMP_A, absLat) * yfrac;
  const bh =
    interpLat(HYD_AVG_B, absLat) - interpLat(HYD_AMP_B, absLat) * yfrac;
  const ch =
    interpLat(HYD_AVG_C, absLat) - interpLat(HYD_AMP_C, absLat) * yfrac;

  // Height correction (Niell): (1/sinEl − m(ht)) · height[km].
  const mHt = marini(sinEl, HT_A, HT_B, HT_C);
  const dmdh = 1 / sinEl - mHt;
  const mh = marini(sinEl, ah, bh, ch) + dmdh * hKm;

  const aw = interpLat(WET_A, absLat);
  const bw = interpLat(WET_B, absLat);
  const cw = interpLat(WET_C, absLat);
  const mw = marini(sinEl, aw, bw, cw);

  // Saastamoinen zenith hydrostatic delay from standard-atmosphere pressure.
  const h = heightM < 0 ? 0 : heightM > 1e4 ? 1e4 : heightM;
  const pres = 1013.25 * Math.pow(1 - 2.2557e-5 * h, 5.2568);
  const zhd =
    (0.0022768 * pres) /
    (1 - 0.00266 * Math.cos(2 * latRad) - 0.00028 * (h / 1000));

  return { zhd, mh, mw };
}
