/** Small shared statistics helpers for the analysis modules (internal). */

/** Minimum epochs for a continuous arc to contribute to statistics. */
export const MIN_ARC_LENGTH = 10;

/** Median of a numeric array. */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Low percentile of a sample array (robust minimum). */
export function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
}
