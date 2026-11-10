/**
 * Ocean tide loading: the crust deforms under the weight of the ocean
 * tides, up to several centimetres vertically near tidal coasts. Given a
 * station's BLQ coefficients (amplitude and phase of 11 tidal constituents
 * for the radial, west and south displacement — the format of Onsala's
 * ocean loading service), the displacement at any instant is the sum of the
 * constituents with their astronomical arguments (IERS ARG.f; the method of
 * RTKLIB's tide_oload, without nodal corrections).
 */

/** Constituent order of BLQ files. */
export const BLQ_CONSTITUENTS = [
  'M2',
  'S2',
  'N2',
  'K2',
  'K1',
  'O1',
  'P1',
  'Q1',
  'Mf',
  'Mm',
  'Ssa',
] as const;

/** One station's BLQ coefficients. */
export interface OceanLoadingCoefficients {
  /** Amplitudes (m) [radial, west, south] per constituent (BLQ order). */
  amplitude: [number, number, number][];
  /** Phases (degrees, Greenwich lag) [radial, west, south] per constituent. */
  phase: [number, number, number][];
}

// Angular speed (rad/s) and Doodson-like multipliers of the mean longitudes
// of the Sun (H0), Moon (S0) and lunar perigee (P0), plus a cycle fraction.
const ARGS: readonly (readonly [number, number, number, number, number])[] = [
  [1.40519e-4, 2, -2, 0, 0], // M2
  [1.45444e-4, 0, 0, 0, 0], // S2
  [1.3788e-4, 2, -3, 1, 0], // N2
  [1.45842e-4, 2, 0, 0, 0], // K2
  [0.72921e-4, 1, 0, 0, 0.25], // K1
  [0.67598e-4, 1, -2, 0, -0.25], // O1
  [0.72523e-4, -1, 0, 0, -0.25], // P1
  [0.64959e-4, 1, -3, 1, -0.25], // Q1
  [0.53234e-5, 0, 2, 0, 0], // Mf
  [0.26392e-5, 0, 1, -1, 0], // Mm
  [0.03982e-5, 2, 0, 0, 0], // Ssa
];

const D2R = Math.PI / 180;

/**
 * Ocean loading displacement (m) at `utcMs`, local [East, North, Up].
 * UTC stands in for UT1 (≤ 0.9 s, negligible for tides).
 */
export function oceanLoadingEnu(
  c: OceanLoadingCoefficients,
  utcMs: number
): [number, number, number] {
  const day = Math.floor(utcMs / 86_400_000);
  const fday = (utcMs - day * 86_400_000) / 1000; // seconds of day
  // Days since 1975-01-01 00:00 UT, + 1 (ARG.f convention).
  const days = day - Date.UTC(1975, 0, 1) / 86_400_000 + 1;
  const t = (27392.500528 + 1.000000035 * days) / 36525;
  const t2 = t * t;
  const t3 = t2 * t;
  const a = [
    fday,
    (279.69668 + 36000.768930485 * t + 3.03e-4 * t2) * D2R, // H0
    (270.434358 + 481267.88314137 * t - 0.001133 * t2 + 1.9e-6 * t3) * D2R, // S0
    (334.329653 + 4069.0340329577 * t - 0.010325 * t2 - 1.2e-5 * t3) * D2R, // P0
    2 * Math.PI,
  ];
  const dp = [0, 0, 0];
  for (let i = 0; i < ARGS.length; i++) {
    let ang = 0;
    for (let j = 0; j < 5; j++) ang += a[j]! * ARGS[i]![j]!;
    for (let k = 0; k < 3; k++)
      dp[k] += c.amplitude[i]![k]! * Math.cos(ang - c.phase[i]![k]! * D2R);
  }
  // BLQ is radial, west, south.
  return [-dp[1]!, -dp[2]!, dp[0]!];
}

/**
 * Read the coefficients of every station in a BLQ file (Onsala format:
 * `$$` comments, a station line, then 3 amplitude rows and 3 phase rows of
 * 11 values). Station names are upper-cased, keyed by their first word.
 */
export function parseBlq(text: string): Map<string, OceanLoadingCoefficients> {
  const out = new Map<string, OceanLoadingCoefficients>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim() || l.startsWith('$$')) continue;
    const name = l.trim().split(/\s+/)[0]!.toUpperCase();
    const rows: number[][] = [];
    let j = i + 1;
    while (j < lines.length && rows.length < 6) {
      const r = lines[j]!;
      j++;
      if (r.startsWith('$$') || !r.trim()) continue;
      const v = r.trim().split(/\s+/).map(Number);
      if (v.length !== 11 || v.some((x) => !Number.isFinite(x))) break;
      rows.push(v);
    }
    if (rows.length === 6) {
      out.set(name, {
        amplitude: BLQ_CONSTITUENTS.map(
          (_, k) =>
            [rows[0]![k]!, rows[1]![k]!, rows[2]![k]!] as [
              number,
              number,
              number,
            ]
        ),
        phase: BLQ_CONSTITUENTS.map(
          (_, k) =>
            [rows[3]![k]!, rows[4]![k]!, rows[5]![k]!] as [
              number,
              number,
              number,
            ]
        ),
      });
      i = j - 1;
    }
  }
  return out;
}
