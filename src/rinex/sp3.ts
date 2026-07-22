/**
 * SP3-c/-d precise orbit and clock parser, with Lagrange interpolation
 * for evaluating positions between the tabulated epochs.
 *
 * Positions are converted to meters (SP3 tabulates km), clocks to
 * seconds (SP3 tabulates microseconds). Missing positions (all-zero
 * coordinates) and the 999999.999999 bad-clock sentinel become null.
 * Epoch tags are read in the file's own time scale (GPS for IGS/MGEX
 * products) as epoch milliseconds, matching the convention of the
 * RINEX parsers in this library.
 */

export interface Sp3Sample {
  /** ECEF meters. */
  x: number;
  y: number;
  z: number;
  /** Satellite clock offset in seconds, or null when flagged bad. */
  clk: number | null;
}

export interface Sp3File {
  version: string; // 'c' | 'd'
  /** Epoch timestamps (ms). */
  epochs: number[];
  /** Tabulated interval in seconds (from the ## header line). */
  intervalSec: number;
  /** Time system from the %c line, e.g. 'GPS'. */
  timeSystem: string;
  /** prn → per-epoch samples (null where the satellite is missing). */
  satellites: Record<string, (Sp3Sample | null)[]>;
}

const BAD_CLOCK = 999999.999999;

export function parseSp3(text: string): Sp3File {
  const lines = text.split('\n');
  const epochs: number[] = [];
  const satellites: Record<string, (Sp3Sample | null)[]> = {};
  let version = '';
  let intervalSec = 0;
  let timeSystem = 'GPS';
  let timeSystemSet = false;
  let epochIdx = -1;

  for (const line of lines) {
    if (!version && line.startsWith('#') && line.charAt(1) !== '#') {
      // "#dP2024  1  1 ..." — version char at column 2
      version = line.charAt(1);
    }
    if (line.startsWith('##')) {
      // "## week  sow  interval  mjd  frac"
      const f = line.slice(2).trim().split(/\s+/);
      intervalSec = Number(f[2]) || 0;
    } else if (line.startsWith('%c') && !timeSystemSet) {
      // only the FIRST %c line carries data; the second is all filler
      const sys = line.slice(9, 12).trim();
      if (sys && !/^c+$/.test(sys)) {
        timeSystem = sys;
        timeSystemSet = true;
      }
    } else if (line.startsWith('*')) {
      const f = line.slice(1).trim().split(/\s+/).map(Number);
      if (f.length >= 6 && f.every(Number.isFinite)) {
        const sec = f[5]!;
        epochs.push(
          Date.UTC(
            f[0]!,
            f[1]! - 1,
            f[2]!,
            f[3]!,
            f[4]!,
            Math.floor(sec),
            Math.round((sec % 1) * 1000)
          )
        );
        epochIdx++;
      }
    } else if (line.startsWith('P') && epochIdx >= 0) {
      const prn = line.slice(1, 4).replace(/\s/g, '0');
      const f = line.slice(4).trim().split(/\s+/).map(Number);
      if (f.length < 3) continue;
      const [xKm, yKm, zKm] = f as [number, number, number];
      let arr = satellites[prn];
      if (!arr) satellites[prn] = arr = [];
      // pad any epochs this satellite skipped
      while (arr.length < epochIdx) arr.push(null);
      if (xKm === 0 && yKm === 0 && zKm === 0) {
        arr.push(null);
        continue;
      }
      const clkUs = f[3];
      arr.push({
        x: xKm * 1000,
        y: yKm * 1000,
        z: zKm * 1000,
        clk:
          clkUs !== undefined && Math.abs(clkUs) < BAD_CLOCK
            ? clkUs * 1e-6
            : null,
      });
    }
  }

  // pad trailing gaps so every array matches epochs.length
  for (const arr of Object.values(satellites)) {
    while (arr.length < epochs.length) arr.push(null);
  }

  return { version, epochs, intervalSec, timeSystem, satellites };
}

/**
 * Satellite position at an arbitrary time by Lagrange interpolation
 * over the `order` nearest tabulated samples (default 9, the standard
 * choice for 5–15 min SP3 tables; centimetre-level between nodes).
 * Clock is interpolated linearly between the bracketing samples.
 *
 * Returns null outside the covered span, near data gaps, or when the
 * satellite is absent.
 */
export function sp3Position(
  sp3: Sp3File,
  prn: string,
  tMs: number,
  order = 9
): { x: number; y: number; z: number; clk: number | null } | null {
  const samples = sp3.satellites[prn];
  const { epochs } = sp3;
  const n = epochs.length;
  if (!samples || n < order) return null;
  if (tMs < epochs[0]! || tMs > epochs[n - 1]!) return null;

  // index of the last epoch <= t (binary search)
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (epochs[mid]! <= tMs) lo = mid;
    else hi = mid - 1;
  }

  // centred window, clamped to the table bounds
  let start = lo - (order >> 1) + (order % 2 === 0 ? 1 : 0);
  start = Math.max(0, Math.min(n - order, start));

  // all window samples must exist — no interpolating across gaps
  for (let i = start; i < start + order; i++) {
    if (!samples[i]) return null;
  }

  // Lagrange in seconds relative to the window start (conditioning)
  const t0 = epochs[start]!;
  const t = (tMs - t0) / 1000;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < order; i++) {
    const ti = (epochs[start + i]! - t0) / 1000;
    let w = 1;
    for (let j = 0; j < order; j++) {
      if (j === i) continue;
      const tj = (epochs[start + j]! - t0) / 1000;
      w *= (t - tj) / (ti - tj);
    }
    const s = samples[start + i]!;
    x += w * s.x;
    y += w * s.y;
    z += w * s.z;
  }

  // linear clock between the bracketing epochs
  let clk: number | null = null;
  const a = samples[lo];
  const b = samples[Math.min(lo + 1, n - 1)];
  if (a?.clk != null && b?.clk != null) {
    const span = epochs[Math.min(lo + 1, n - 1)]! - epochs[lo]!;
    const f = span > 0 ? (tMs - epochs[lo]!) / span : 0;
    clk = a.clk * (1 - f) + b.clk * f;
  } else if (a?.clk != null) {
    clk = a.clk;
  }

  return { x, y, z, clk };
}
