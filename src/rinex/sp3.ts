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
 *
 * Everything else the format carries (header descriptors, satellite list
 * and accuracy exponents, %f bases, comments, standard-deviation exponents,
 * E/P/M/P flags, EP/V/EV records, all-zero position lines) is kept in
 * optional fields so {@link writeSp3} can write the file back unchanged.
 * Column positions are those of the SP3-c (sp3c.txt) and SP3-d (sp3d.pdf)
 * line descriptions.
 */

/** Standard-deviation exponents of a P or V record (cols 62–73); the
 *  standard deviation is base^n with the %f bases, null = blank (unknown). */
export interface Sp3SdevExp {
  x: number | null;
  y: number | null;
  z: number | null;
  clk: number | null;
}

/**
 * EP / EV correlation record, as written (null = blank field). EP: x/y/z in
 * mm, clk in ps. EV: x/y/z in 10⁻⁴ mm/s, clk in 10⁻⁴ ps/s. Correlation
 * coefficients are the file's 8-digit integers divided by 10⁷.
 */
export interface Sp3Correlation {
  xSdev: number | null;
  ySdev: number | null;
  zSdev: number | null;
  clkSdev: number | null;
  xy: number | null;
  xz: number | null;
  xc: number | null;
  yz: number | null;
  yc: number | null;
  zc: number | null;
}

/** V record (velocity and clock rate-of-change), converted to SI. */
export interface Sp3Velocity {
  /** ECEF m/s (SP3 tabulates dm/s); bad/absent = 0, as written. */
  vx: number;
  vy: number;
  vz: number;
  /** Clock rate in s/s (SP3: 10⁻⁴ µs/s), or null when flagged bad. */
  clkRate: number | null;
  sdevExp?: Sp3SdevExp;
  /** The EV record that followed, if any. */
  ev?: Sp3Correlation;
}

export interface Sp3Sample {
  /** ECEF meters. */
  x: number;
  y: number;
  z: number;
  /** Satellite clock offset in seconds, or null when flagged bad. */
  clk: number | null;
  /** cols 62–73, when any is present. */
  sdevExp?: Sp3SdevExp;
  /** col 75 'E': clock discontinuity since the previous epoch. */
  clockEvent?: boolean;
  /** col 76 'P': clock predicted. */
  clockPredicted?: boolean;
  /** col 79 'M': orbit manoeuvre since the previous epoch. */
  maneuver?: boolean;
  /** col 80 'P': position predicted. */
  orbitPredicted?: boolean;
  /** The EP record that followed, if any. */
  ep?: Sp3Correlation;
  /** The V (+EV) record that followed, if any. */
  vel?: Sp3Velocity;
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

  /* ── Optional: the rest of the header, for writing the file back ── */
  /** Line 1 col 3: 'P' positions only, 'V' with velocity records. */
  pvFlag?: string;
  /** Line 1 cols 33–39, as declared (writers use epochs.length). */
  numEpochs?: number;
  /** Line 1 descriptors, trimmed: data used (e.g. 'u+U', 'ORBIT'),
   *  coordinate system ('IGS20'), orbit type ('FIT'), agency ('GFZ'). */
  dataUsed?: string;
  coordSys?: string;
  orbitType?: string;
  agency?: string;
  /** Line 2 as declared: GPS week, seconds of week, MJD and day fraction
   *  of the first epoch (writers derive them from epochs[0]). */
  gpsWeek?: number;
  sowStart?: number;
  mjdStart?: number;
  fracDayStart?: number;
  /** Satellite IDs in header order (= record order at every epoch). */
  satIds?: string[];
  /** Orbit accuracy exponents (2^n mm, 0 = unknown), aligned to satIds. */
  accuracy?: number[];
  /** First %c line cols 4–5: 'G', 'R', 'E', 'C', 'J', 'M', ... */
  fileType?: string;
  /** First %f line: floating-point bases for position/velocity and
   *  clock/rate standard deviations (e.g. 1.25 and 1.025; 0 = none). */
  posBase?: number;
  clkBase?: number;
  /** Comment lines, text after "/* " (trailing blanks removed). */
  comments?: string[];
  /** Records written with an all-zero ("bad or absent") position:
   *  prn → epoch index → the record (x = y = z = 0). Their slot in
   *  `satellites` is null. */
  badPositions?: Record<string, Record<number, Sp3Sample>>;
}

/** Bad/absent clock: "the six integer nines are required, whereas the
 *  fractional part nines are optional" (SP3-c/-d), so ≥ 999999 is bad. */
const BAD_CLOCK = 999999;

/** Fixed-width numeric field; blank → null. */
function num(line: string, a: number, b: number): number | null {
  const s = line.slice(a, b).trim();
  if (s === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function sdevExp(line: string): Sp3SdevExp | undefined {
  const x = num(line, 61, 63);
  const y = num(line, 64, 66);
  const z = num(line, 67, 69);
  const clk = num(line, 70, 73);
  return x === null && y === null && z === null && clk === null
    ? undefined
    : { x, y, z, clk };
}

/** EP / EV record: I4 ×3 (cols 5–18), I7 (20–26), I8 ×6 (28–80). */
function correlation(line: string): Sp3Correlation {
  const c = (a: number) => {
    const v = num(line, a, a + 8);
    return v === null ? null : v / 1e7;
  };
  return {
    xSdev: num(line, 4, 8),
    ySdev: num(line, 9, 13),
    zSdev: num(line, 14, 18),
    clkSdev: num(line, 19, 26),
    xy: c(27),
    xz: c(36),
    xc: c(45),
    yz: c(54),
    yc: c(63),
    zc: c(72),
  };
}

export function parseSp3(text: string): Sp3File {
  const lines = text.split('\n');
  const epochs: number[] = [];
  const satellites: Record<string, (Sp3Sample | null)[]> = {};
  const badPositions: Record<string, Record<number, Sp3Sample>> = {};
  const satIds: string[] = [];
  const accuracy: number[] = [];
  const comments: string[] = [];
  const out: Partial<Sp3File> = {};
  let version = '';
  let intervalSec = 0;
  let timeSystem = 'GPS';
  let timeSystemSet = false;
  let fSet = false;
  let nSats = 0;
  let epochIdx = -1;
  // the record EP/V/EV lines attach to
  let lastP: Sp3Sample | null = null;
  let lastV: Sp3Velocity | null = null;

  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!version && line.startsWith('#') && line.charAt(1) !== '#') {
      // "#dP2024  1  1  0  0  0.00000000     289 ORBIT IGS20 FIT  GFZ"
      version = line.charAt(1);
      out.pvFlag = line.charAt(2);
      out.numEpochs = num(line, 32, 39) ?? undefined;
      out.dataUsed = line.slice(40, 45).trim();
      out.coordSys = line.slice(46, 51).trim();
      out.orbitType = line.slice(52, 55).trim();
      out.agency = line.slice(56, 60).trim();
    } else if (line.startsWith('##')) {
      // "## week  sow  interval  mjd  frac"
      const f = line.slice(2).trim().split(/\s+/);
      out.gpsWeek = Number(f[0]);
      out.sowStart = Number(f[1]);
      intervalSec = Number(f[2]) || 0;
      out.mjdStart = Number(f[3]);
      out.fracDayStart = Number(f[4]);
    } else if (line.startsWith('++')) {
      // accuracy exponents, I3 from col 10, same slots as the IDs
      for (let c = 9; c + 3 <= 60 && accuracy.length < nSats; c += 3) {
        accuracy.push(num(line, c, c + 3) ?? 0);
      }
    } else if (line.startsWith('+ ') && epochIdx < 0) {
      // first line: number of satellites (c: I2 cols 5–6, d: I3 cols 4–6)
      if (satIds.length === 0 && nSats === 0) nSats = num(line, 3, 6) ?? 0;
      for (let c = 9; c + 3 <= 60 && satIds.length < nSats; c += 3) {
        satIds.push(line.slice(c, c + 3).replace(/\s/g, '0'));
      }
    } else if (line.startsWith('%c') && !timeSystemSet) {
      // only the FIRST %c line carries data; the second is all filler
      out.fileType = line.slice(3, 5).trim();
      const sys = line.slice(9, 12).trim();
      if (sys && !/^c+$/.test(sys)) timeSystem = sys;
      timeSystemSet = true;
    } else if (line.startsWith('%f') && !fSet) {
      out.posBase = num(line, 3, 13) ?? 0;
      out.clkBase = num(line, 14, 26) ?? 0;
      fSet = true;
    } else if (line.startsWith('/*') && epochIdx < 0) {
      comments.push(line.slice(3).trimEnd());
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
      lastP = lastV = null;
    } else if (line.startsWith('P') && epochIdx >= 0) {
      lastV = null;
      lastP = null;
      const prn = line.slice(1, 4).replace(/\s/g, '0');
      // x, y, z (km) cols 5–46, clock (µs) cols 47–60: F14.6 each
      const xKm = num(line, 4, 18);
      const yKm = num(line, 18, 32);
      const zKm = num(line, 32, 46);
      if (xKm === null || yKm === null || zKm === null) continue;
      const clkUs = num(line, 46, 60);
      let arr = satellites[prn];
      if (!arr) satellites[prn] = arr = [];
      // pad any epochs this satellite skipped
      while (arr.length < epochIdx) arr.push(null);
      const s: Sp3Sample = {
        x: xKm * 1000,
        y: yKm * 1000,
        z: zKm * 1000,
        clk:
          clkUs !== null && Math.abs(clkUs) < BAD_CLOCK ? clkUs * 1e-6 : null,
      };
      const sd = sdevExp(line);
      if (sd) s.sdevExp = sd;
      if (line.charAt(74) === 'E') s.clockEvent = true;
      if (line.charAt(75) === 'P') s.clockPredicted = true;
      if (line.charAt(78) === 'M') s.maneuver = true;
      if (line.charAt(79) === 'P') s.orbitPredicted = true;
      lastP = s;
      if (xKm === 0 && yKm === 0 && zKm === 0) {
        arr.push(null);
        (badPositions[prn] ??= {})[epochIdx] = s;
        continue;
      }
      arr.push(s);
    } else if (line.startsWith('EP') && lastP) {
      lastP.ep = correlation(line);
    } else if (line.startsWith('V') && lastP) {
      // dm/s → m/s; clock rate 10⁻⁴ µs/s → s/s
      const rate = num(line, 46, 60);
      const v: Sp3Velocity = {
        vx: (num(line, 4, 18) ?? 0) * 0.1,
        vy: (num(line, 18, 32) ?? 0) * 0.1,
        vz: (num(line, 32, 46) ?? 0) * 0.1,
        clkRate:
          rate !== null && Math.abs(rate) < BAD_CLOCK ? rate * 1e-10 : null,
      };
      const sd = sdevExp(line);
      if (sd) v.sdevExp = sd;
      lastP.vel = lastV = v;
    } else if (line.startsWith('EV') && lastV) {
      lastV.ev = correlation(line);
    }
  }

  // pad trailing gaps so every array matches epochs.length
  for (const arr of Object.values(satellites)) {
    while (arr.length < epochs.length) arr.push(null);
  }

  return {
    version,
    epochs,
    intervalSec,
    timeSystem,
    satellites,
    ...out,
    satIds,
    accuracy,
    comments,
    ...(Object.keys(badPositions).length ? { badPositions } : {}),
  };
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
