/**
 * Ocean tide loading the way IERS Conventions (2010) 7.1.2 asks for it:
 * the BLQ's 11 constituents with their nodal modulation (f, u), plus the
 * minor tides inferred from the main ones by admittance interpolation —
 * the "about 342 constituents" principle of the Conventions' HARDISP,
 * implemented here from the text, not from that program.
 *
 *  - Nodal modulation: the 18.6-year lunar node N changes the lunar tides'
 *    amplitude by f (K1 ±11 %, O1/Q1 ±19 %, K2 ±29 %, M2/N2 ±4 %) and their
 *    phase by u. Standard Doodson/Schureman expressions (as tabulated in
 *    Pugh, Tides, Surges and Mean Sea-Level, 1987, Table 4.3).
 *  - Minor tides: each diurnal/semidiurnal minor line (2N2, μ2, ν2, λ2, L2,
 *    T2, R2; 2Q1, σ1, ρ1, M1, π1, ψ1, φ1, J1, OO1) takes the admittance
 *    (displacement / tidal-potential amplitude, complex) interpolated in
 *    frequency by a natural cubic spline through the main constituents of
 *    its band (held flat beyond them), times its own potential amplitude
 *    (Cartwright–Tayler–Edden).
 *
 * Arguments use the Doodson variables of {@link doodsonArguments}; the main
 * constituents' phase offsets (K1 +90°, O1/P1/Q1 −90°) are those of the
 * Schwiderski convention BLQ phases refer to.
 */
import { getGpsLeap } from '../time/utc';
import { doodsonArguments } from './solid-earth-tide';
import type { OceanLoadingCoefficients } from './ocean-loading';

const D2R = Math.PI / 180;
/** Doodson variable rates (deg/hour): τ s h p N' ps. */
const RATES = [
  14.4920521, 0.5490165, 0.0410686, 0.0046418, 0.0022064, 0.000002,
];

type Nodal = 'M2' | 'K2' | 'K1' | 'O1' | 'Mf' | 'Mm' | 'J1' | 'OO1' | 'none';

interface Line {
  /** Doodson multipliers τ s h p N' ps. */
  k: readonly number[];
  /** Cartwright–Tayler–Edden potential amplitude (signed). */
  h: number;
  nodal: Nodal;
}

/** The BLQ constituents (BLQ order) — Doodson numbers + CTE amplitudes. */
const MAIN: readonly Line[] = [
  { k: [2, 0, 0, 0, 0, 0], h: 0.63192, nodal: 'M2' }, // M2 255.555
  { k: [2, 2, -2, 0, 0, 0], h: 0.294, nodal: 'none' }, // S2 273.555
  { k: [2, -1, 0, 1, 0, 0], h: 0.12099, nodal: 'M2' }, // N2 245.655
  { k: [2, 2, 0, 0, 0, 0], h: 0.07996, nodal: 'K2' }, // K2 275.555
  { k: [1, 1, 0, 0, 0, 0], h: 0.36878, nodal: 'K1' }, // K1 165.555
  { k: [1, -1, 0, 0, 0, 0], h: -0.26221, nodal: 'O1' }, // O1 145.555
  { k: [1, 1, -2, 0, 0, 0], h: -0.12203, nodal: 'none' }, // P1 163.555
  { k: [1, -2, 0, 1, 0, 0], h: -0.0502, nodal: 'O1' }, // Q1 135.655
  { k: [0, 2, 0, 0, 0, 0], h: 0.06663, nodal: 'Mf' }, // Mf 075.555
  { k: [0, 1, 0, -1, 0, 0], h: 0.03518, nodal: 'Mm' }, // Mm 065.455
  { k: [0, 0, 2, 0, 0, 0], h: 0.031, nodal: 'none' }, // Ssa 057.555
];

/** Minor diurnal and semidiurnal lines inferred by admittance. */
const MINOR: readonly Line[] = [
  { k: [2, -2, 0, 2, 0, 0], h: 0.01604, nodal: 'M2' }, // 2N2 235.755
  { k: [2, -2, 2, 0, 0, 0], h: 0.01935, nodal: 'M2' }, // μ2 237.555
  { k: [2, -1, 2, -1, 0, 0], h: 0.02298, nodal: 'M2' }, // ν2 247.455
  { k: [2, 1, -2, 1, 0, 0], h: -0.00467, nodal: 'M2' }, // λ2 263.655
  { k: [2, 1, 0, -1, 0, 0], h: -0.01787, nodal: 'M2' }, // L2 265.455
  { k: [2, 2, -3, 0, 0, 1], h: 0.0172, nodal: 'none' }, // T2 272.556
  { k: [2, 2, -1, 0, 0, -1], h: -0.00246, nodal: 'none' }, // R2 274.554
  { k: [1, -3, 0, 2, 0, 0], h: -0.00664, nodal: 'O1' }, // 2Q1 125.755
  { k: [1, -3, 2, 0, 0, 0], h: -0.00802, nodal: 'O1' }, // σ1 127.555
  { k: [1, -2, 2, -1, 0, 0], h: -0.00953, nodal: 'O1' }, // ρ1 137.455
  { k: [1, 0, 0, 1, 0, 0], h: 0.02062, nodal: 'none' }, // M1 155.655
  { k: [1, 1, -3, 0, 0, 1], h: -0.01029, nodal: 'none' }, // π1 162.556
  { k: [1, 1, 1, 0, 0, -1], h: 0.00294, nodal: 'none' }, // ψ1 166.554
  { k: [1, 1, 2, 0, 0, 0], h: 0.00525, nodal: 'none' }, // φ1 167.555
  { k: [1, 2, 0, -1, 0, 0], h: 0.02062, nodal: 'J1' }, // J1 175.455
  { k: [1, 3, 0, 0, 0, 0], h: 0.01128, nodal: 'OO1' }, // OO1 185.555
];

/** Nodal factor f and phase u (rad) at node longitude N (rad). */
function nodal(kind: Nodal, N: number): [number, number] {
  const c = Math.cos(N);
  const c2 = Math.cos(2 * N);
  const s = Math.sin(N);
  const s2 = Math.sin(2 * N);
  switch (kind) {
    case 'M2':
      return [1 - 0.037 * c, -2.1 * s * D2R];
    case 'K2':
      return [1.024 + 0.286 * c + 0.008 * c2, (-17.7 * s + 0.7 * s2) * D2R];
    case 'K1':
      return [1.006 + 0.115 * c - 0.009 * c2, (-8.9 * s + 0.7 * s2) * D2R];
    case 'O1':
      return [1.009 + 0.187 * c - 0.015 * c2, (10.8 * s - 1.3 * s2) * D2R];
    case 'Mf':
      return [1.043 + 0.414 * c, (-23.7 * s + 2.7 * s2) * D2R];
    case 'Mm':
      return [1 - 0.13 * c, 0];
    case 'J1':
      return [1.013 + 0.168 * c - 0.017 * c2, (-12.9 * s + 1.3 * s2) * D2R];
    case 'OO1':
      return [1.0 + 0.64 * c + 0.134 * c2, (-36.68 * s + 4.02 * s2) * D2R];
    default:
      return [1, 0];
  }
}

/** Phase offset (rad) of a line: diurnal ±90° and negative-amplitude 180°
 *  so that every line is |H| cos(argument + offset). */
function offset(l: Line): number {
  if (l.k[0] === 1) return l.h > 0 ? Math.PI / 2 : -Math.PI / 2;
  return l.h >= 0 ? 0 : Math.PI;
}

/** Natural cubic spline through (xs, ys) evaluated at x (xs ascending). */
function spline(xs: number[], ys: number[], x: number): number {
  const n = xs.length;
  if (n < 3) {
    if (n === 1) return ys[0]!;
    const t = (x - xs[0]!) / (xs[1]! - xs[0]!);
    return ys[0]! + t * (ys[1]! - ys[0]!);
  }
  // Second derivatives (tridiagonal solve, natural ends).
  const m = new Array<number>(n).fill(0);
  const c = new Array<number>(n).fill(0);
  const d = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const h0 = xs[i]! - xs[i - 1]!;
    const h1 = xs[i + 1]! - xs[i]!;
    const a = h0 / 6;
    const b = (h0 + h1) / 3;
    const r = (ys[i + 1]! - ys[i]!) / h1 - (ys[i]! - ys[i - 1]!) / h0;
    const den = b - a * c[i - 1]!;
    c[i] = h1 / 6 / den;
    d[i] = (r - a * d[i - 1]!) / den;
  }
  for (let i = n - 2; i >= 1; i--) m[i] = d[i]! - c[i]! * m[i + 1]!;
  let j = 0;
  while (j < n - 2 && xs[j + 1]! < x) j++;
  const h = xs[j + 1]! - xs[j]!;
  const A = (xs[j + 1]! - x) / h;
  const B = (x - xs[j]!) / h;
  return (
    A * ys[j]! +
    B * ys[j + 1]! +
    (((A * A * A - A) * m[j]! + (B * B * B - B) * m[j + 1]!) * h * h) / 6
  );
}

const freq = (l: Line) => l.k.reduce((a, k, i) => a + k * RATES[i]!, 0);

/**
 * Ocean loading displacement (m), local [East, North, Up], at `utcMs`:
 * the BLQ constituents with nodal corrections, plus (unless
 * `minorTides: false`) the minor tides by admittance interpolation.
 * `nodal: false` drops the nodal modulation (then, without minor tides, it
 * is {@link oceanLoadingEnu}'s model).
 */
export function oceanLoadingEnuIers(
  c: OceanLoadingCoefficients,
  utcMs: number,
  opts: { minorTides?: boolean; nodal?: boolean } = {}
): [number, number, number] {
  const gpsMs = utcMs + getGpsLeap(new Date(utcMs)) * 1000;
  const beta = doodsonArguments(gpsMs);
  const N = -beta[4]!; // N' = −Ω
  const useNodal = opts.nodal ?? true;
  const fu = (kind: Nodal): [number, number] =>
    useNodal ? nodal(kind, N) : [1, 0];
  const arg = (l: Line) =>
    l.k.reduce((a, k, i) => a + k * beta[i]!, 0) + offset(l);
  const dp = [0, 0, 0]; // radial, west, south
  // Complex admittance per main line and component (BLQ phase is a lag).
  const adm = MAIN.map((l, i) =>
    [0, 1, 2].map((k) => {
      const a = c.amplitude[i]![k]! / Math.abs(l.h);
      const p = -c.phase[i]![k]! * D2R;
      return [a * Math.cos(p), a * Math.sin(p)] as const;
    })
  );
  for (let i = 0; i < MAIN.length; i++) {
    const l = MAIN[i]!;
    const [f, u] = fu(l.nodal);
    const x = arg(l) + u;
    for (let k = 0; k < 3; k++)
      dp[k]! += f * c.amplitude[i]![k]! * Math.cos(x - c.phase[i]![k]! * D2R);
  }
  if (opts.minorTides ?? true) {
    for (const l of MINOR) {
      const w = freq(l);
      // Main lines of the same band, by frequency.
      const band = MAIN.map((m, i) => ({ i, w: freq(m), b: m.k[0] }))
        .filter((m) => m.b === l.k[0])
        .sort((a, b) => a.w - b.w);
      const xs = band.map((m) => m.w);
      const wc = Math.max(xs[0]!, Math.min(xs[xs.length - 1]!, w));
      const [f, u] = fu(l.nodal);
      const x = arg(l) + u;
      const cx = Math.cos(x);
      const sx = Math.sin(x);
      for (let k = 0; k < 3; k++) {
        // Natural cubic spline through the band's main lines (in-phase and
        // quadrature separately); held flat beyond the band's ends.
        const re = spline(
          xs,
          band.map((m) => adm[m.i]![k]![0]),
          wc
        );
        const im = spline(
          xs,
          band.map((m) => adm[m.i]![k]![1]),
          wc
        );
        dp[k]! += f * Math.abs(l.h) * (re * cx - im * sx);
      }
    }
  }
  return [-dp[1]!, -dp[2]!, dp[0]!];
}
