/** Convert radians to degrees. */
export function rad2deg(radians: number): number {
  return (radians * 180.0) / Math.PI;
}

/** Convert degrees to radians. */
export function deg2rad(degrees: number): number {
  return (degrees * Math.PI) / 180.0;
}

/**
 * Convert decimal degrees to [degrees, minutes, seconds].
 * Always returns positive values (use the sign of the input separately).
 */
export function deg2dms(deg: number): [number, number, number] {
  deg = Math.abs(deg);
  let d = Math.floor(deg);
  let m = Math.floor(deg * 60) % 60;
  let s = (deg * 3600) % 60;

  if (s >= 59.9995) {
    m += 1;
    s = 0;
  }

  if (m === 60) {
    d += 1;
    m = 0;
  }

  return [d, m, s];
}
