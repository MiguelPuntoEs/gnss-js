/**
 * Broadcast accuracy and fit-interval codes ↔ the values RINEX prints:
 * GPS/QZSS/BDS/NavIC URA index ↔ metres (RINEX 3.05 Table A6 note:
 * N = 0-6: 2^(1+N/2) rounded to 0.1 m, N = 7-15: 2^(N-2)), Galileo SISA
 * index ↔ metres (Galileo OS SIS ICD §5.1.12), GPS fit-interval flag ↔
 * hours.
 *
 * RTKLIB 2.4.2 prints the URA as the upper bound of each index's range
 * (2.4, 3.4, 4.85, … m) rather than the RINEX nominal values used here.
 */

const URA_M = [
  2, 2.8, 4, 5.7, 8, 11.3, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192,
];

/** URA index → metres (RINEX nominal value). */
export function uraMeters(index: number): number {
  return URA_M[Math.max(0, Math.min(15, index))]!;
}

/** Metres → the smallest URA index whose nominal value covers them. */
export function uraIndex(m: number): number {
  const i = URA_M.findIndex((v) => v >= m - 1e-9);
  return i < 0 ? 15 : i;
}

/** Galileo SISA index → metres; 255 (NAPA) → −1 (RINEX 3.05 Table A8). */
export function sisaMeters(n: number): number {
  if (n <= 49) return n * 0.01;
  if (n <= 74) return 0.5 + (n - 50) * 0.02;
  if (n <= 99) return 1 + (n - 75) * 0.04;
  if (n <= 125) return 2 + (n - 100) * 0.16;
  return -1;
}

/** Metres → Galileo SISA index (nearest), −1 / unknown → 255 (NAPA). */
export function sisaIndex(m: number): number {
  if (!(m >= 0)) return 255;
  let best = 255;
  let err = Infinity;
  for (let n = 0; n <= 125; n++) {
    const d = Math.abs(sisaMeters(n) - m);
    if (d < err) [best, err] = [n, d];
  }
  return err < 0.005 ? best : 255;
}

/**
 * GPS LNAV fit-interval flag → RINEX hours: 0 → 4 h (IS-GPS-200
 * 20.3.3.4.3.1); 1 (> 4 h, length set by the IODC table of the ICD) →
 * 0, as RTKLIB writes it.
 */
export function gpsFitHours(flag: number): number {
  return flag ? 0 : 4;
}

/** RINEX fit hours → flag: 4 h (or unknown) → 0, anything else → 1. */
export function gpsFitFlag(hours: number | undefined): number {
  return hours === undefined || hours === 4 ? 0 : 1;
}
