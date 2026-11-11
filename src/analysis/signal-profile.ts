/**
 * Per-signal observation profile for QC: how many observations each signal
 * has above a ladder of elevations (Anubis "Ele>0 … Ele>70" — shows which
 * signals die at low elevation), and C/N0 per signal (teqc "Mean S1 S2"
 * with standard deviation).
 */
import { BAND_LABELS, SYSTEM_NAMES } from '../constants/gnss';

/** Elevation ladder (degrees) for the cumulative counts. */
export const ELEVATION_LADDER = [0, 5, 10, 15, 20, 30, 50, 70] as const;

export interface SignalProfileRow {
  system: string;
  /** RINEX observation code, e.g. "L1C". */
  code: string;
  /** Human label, e.g. "L1C (GPS L1)". */
  label: string;
  /** Observations at or above each {@link ELEVATION_LADDER} step. */
  aboveElevation: number[];
  /** Observations whose satellite had no elevation (no ephemeris). */
  noElevation: number;
}

export interface Cn0Row {
  system: string;
  code: string;
  label: string;
  n: number;
  mean: number;
  sd: number;
}

export interface SignalProfileResult {
  ladder: readonly number[];
  /** Carrier-phase (L) and code (C) signals. */
  signals: SignalProfileRow[];
  /** C/N0 per S signal, over the observations QC graded (above the mask). */
  cn0: Cn0Row[];
}

const ORDER = 'GRECJIS';
const rank = (s: string) =>
  ORDER.includes(s) ? ORDER.indexOf(s) : ORDER.length;
const label = (sys: string, code: string) =>
  `${code} (${SYSTEM_NAMES[sys] ?? sys} ${BAND_LABELS[sys]?.[code[1]!] ?? code[1]})`;

export class SignalProfileAccumulator {
  private counts = new Map<string, { above: number[]; none: number }>();
  private cn0 = new Map<string, { n: number; sum: number; sum2: number }>();

  /** Every observation, with its elevation (null if unknown). */
  onObservation(
    prn: string,
    codes: string[],
    values: (number | null)[],
    elevationDeg: number | null
  ) {
    const sys = prn[0]!;
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code[0] !== 'L' && code[0] !== 'C') continue;
      const v = values[i];
      if (v == null || v === 0) continue;
      const key = `${sys}:${code}`;
      let c = this.counts.get(key);
      if (!c)
        this.counts.set(
          key,
          (c = { above: ELEVATION_LADDER.map(() => 0), none: 0 })
        );
      if (elevationDeg === null) {
        c.none++;
        continue;
      }
      for (let k = 0; k < ELEVATION_LADDER.length; k++)
        if (elevationDeg >= ELEVATION_LADDER[k]!) c.above[k]!++;
    }
  }

  /** Observations QC grades (above the mask): C/N0 statistics. */
  onGradedObservation(prn: string, codes: string[], values: (number | null)[]) {
    const sys = prn[0]!;
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code[0] !== 'S') continue;
      const v = values[i];
      if (v == null || v <= 0) continue;
      const key = `${sys}:${code}`;
      let c = this.cn0.get(key);
      if (!c) this.cn0.set(key, (c = { n: 0, sum: 0, sum2: 0 }));
      c.n++;
      c.sum += v;
      c.sum2 += v * v;
    }
  }

  finalize(): SignalProfileResult {
    const sortKey = (a: { system: string; code: string }, b: typeof a) =>
      rank(a.system) - rank(b.system) || a.code.localeCompare(b.code);
    const signals: SignalProfileRow[] = [...this.counts].map(([key, c]) => {
      const [system, code] = key.split(':') as [string, string];
      return {
        system,
        code,
        label: label(system, code),
        aboveElevation: c.above,
        noElevation: c.none,
      };
    });
    const cn0: Cn0Row[] = [...this.cn0].map(([key, c]) => {
      const [system, code] = key.split(':') as [string, string];
      const mean = c.sum / c.n;
      return {
        system,
        code,
        label: label(system, code),
        n: c.n,
        mean,
        sd: c.n > 1 ? Math.sqrt(Math.max(0, c.sum2 / c.n - mean * mean)) : 0,
      };
    });
    return {
      ladder: ELEVATION_LADDER,
      signals: signals.sort(sortKey),
      cn0: cn0.sort(sortKey),
    };
  }
}
