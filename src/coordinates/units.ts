import { MINUTES_IN_DEGREE, SECONDS_IN_DEGREE } from "../constants/coordinates";
import { SECONDS_IN_MINUTE } from "../constants/time";
import { Hms } from "../types/coordinates";

export function rad2deg(radians: number): number {
  return (radians * 180.0) / Math.PI;
}
export function deg2rad(degrees: number): number {
  return (degrees * Math.PI) / 180.0;
}
export function deg2hms(deg: number): Hms {
  if (Number.isNaN(deg)) return { h: NaN, m: NaN, s: NaN };

  let h = Math.floor(deg);
  let m = Math.floor(deg * MINUTES_IN_DEGREE) % MINUTES_IN_DEGREE;
  let s = (deg * SECONDS_IN_DEGREE) % SECONDS_IN_MINUTE;

  if (Number.parseFloat(s.toFixed(3)) === 60.0) {
    m += 1;
    s = 0;
  }

  if (m === 60) {
    h += 1;
    m = 0;
  }

  return { h, m, s };
}
