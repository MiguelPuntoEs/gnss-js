/**
 * Realistic velocity uncertainties for GNSS coordinate series: white plus
 * flicker (power-law, spectral index −1) noise, estimated by maximum
 * likelihood — the approach of CATS (Williams 2003) and Hector (Bos et al.
 * 2013), reduced to the essentials.
 *
 * Daily positions are not independent: their errors are correlated over
 * days to years (flicker noise), so a white-noise velocity error is too
 * small, typically by 2–5× for daily series and more for long spans. Here
 * the covariance is C = σ²[(1 − φ)·I + φ·F], F the flicker covariance of
 * the samples' positions on a regular grid (Hosking's fractional
 * differencing, d = 0.5); φ is found by maximising the likelihood of the
 * generalised-least-squares fit, σ² analytically, and the velocity variance
 * is σ²·[(AᵀC₀⁻¹A)⁻¹]₁₁.
 */

/** In-place Cholesky of an n×n SPD matrix (row-major, lower triangle). */
function cholesky(M: Float64Array, n: number): boolean {
  for (let j = 0; j < n; j++) {
    let d = M[j * n + j]!;
    for (let k = 0; k < j; k++) d -= M[j * n + k]! ** 2;
    if (d <= 0) return false;
    d = Math.sqrt(d);
    M[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let s = M[i * n + j]!;
      for (let k = 0; k < j; k++) s -= M[i * n + k]! * M[j * n + k]!;
      M[i * n + j] = s / d;
    }
  }
  return true;
}

/** Solve L·x = b in place (forward substitution). */
function forward(L: Float64Array, n: number, b: Float64Array): void {
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= L[i * n + k]! * b[k]!;
    b[i] = s / L[i * n + i]!;
  }
}

/** Flicker covariance between grid indices, from Hosking's coefficients. */
function flickerCovariance(idx: readonly number[]): Float64Array {
  const N = idx[idx.length - 1]! + 1;
  const h = new Float64Array(N);
  h[0] = 1;
  for (let i = 1; i < N; i++) h[i] = (h[i - 1]! * (i - 1 + 0.5)) / i;
  // (T·Tᵀ)[a][b] = Σ_k h[a−k]·h[b−k], k ≤ min(a, b)
  const n = idx.length;
  const F = new Float64Array(n * n);
  for (let a = 0; a < n; a++)
    for (let b = 0; b <= a; b++) {
      const ia = idx[a]!;
      const ib = idx[b]!;
      let s = 0;
      for (let k = 0; k <= ib; k++) s += h[ia - k]! * h[ib - k]!;
      F[a * n + b] = s;
      F[b * n + a] = s;
    }
  // Normalise to unit mean diagonal so φ is a variance share.
  let tr = 0;
  for (let a = 0; a < n; a++) tr += F[a * n + a]!;
  const scale = n / tr;
  for (let i = 0; i < F.length; i++) F[i] *= scale;
  return F;
}

export interface NoiseFit {
  /** Share of the variance that is flicker noise (0 = white only). */
  flickerShare: number;
  /** Velocity 1σ under the white + flicker model (same unit as y / yr). */
  velocitySigma: number;
  /** Velocity estimate under that model. */
  velocity: number;
}

/** Most samples the full-covariance fit takes (n³ work); longer series
 *  are thinned evenly. */
const MAX_SAMPLES = 360;

/**
 * Fit white + flicker noise to one coordinate component. `A` is the design
 * (rows per sample, column 1 = velocity in per-year units), `y` the values,
 * `tYears` the sample times. Returns null when the series is too short.
 */
export function fitWhiteFlicker(
  A: readonly (readonly number[])[],
  y: readonly number[],
  tYears: readonly number[]
): NoiseFit | null {
  let rows = A.map((_, i) => i);
  if (rows.length > MAX_SAMPLES) {
    const step = rows.length / MAX_SAMPLES;
    rows = Array.from({ length: MAX_SAMPLES }, (_, k) => Math.floor(k * step));
  }
  const n = rows.length;
  const p = A[0]?.length ?? 0;
  if (n < p + 5) return null;
  // Regular grid at the typical spacing.
  const dts = rows
    .slice(1)
    .map((r, k) => tYears[r]! - tYears[rows[k]!]!)
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  const dt = dts[dts.length >> 1] ?? 1 / 365.25;
  const t0 = tYears[rows[0]!]!;
  const idx = rows.map((r) => Math.round((tYears[r]! - t0) / dt));
  for (let k = 1; k < n; k++)
    if (idx[k]! <= idx[k - 1]!) idx[k] = idx[k - 1]! + 1;
  const F = flickerCovariance(idx);

  const evaluate = (phi: number) => {
    const C = new Float64Array(n * n);
    for (let i = 0; i < n * n; i++) C[i] = phi * F[i]!;
    for (let i = 0; i < n; i++) C[i * n + i] += 1 - phi;
    if (!cholesky(C, n)) return null;
    // Whitened design and data: L⁻¹A, L⁻¹y.
    const Aw = Array.from({ length: p }, (_, j) => {
      const col = Float64Array.from(rows, (r) => A[r]![j]!);
      forward(C, n, col);
      return col;
    });
    const yw = Float64Array.from(rows, (r) => y[r]!);
    forward(C, n, yw);
    const N = Array.from({ length: p }, (_, a) =>
      Array.from({ length: p }, (_, b) => {
        let s = 0;
        for (let i = 0; i < n; i++) s += Aw[a]![i]! * Aw[b]![i]!;
        return s;
      })
    );
    const rhs = Array.from({ length: p }, (_, a) => {
      let s = 0;
      for (let i = 0; i < n; i++) s += Aw[a]![i]! * yw[i]!;
      return s;
    });
    const Ninv = invert(N);
    if (!Ninv) return null;
    const beta = Ninv.map((row) => row.reduce((s, v, k) => s + v * rhs[k]!, 0));
    let rss = 0;
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = 0; j < p; j++) m += Aw[j]![i]! * beta[j]!;
      rss += (yw[i]! - m) ** 2;
    }
    const sigma2 = rss / n;
    let logdet = 0;
    for (let i = 0; i < n; i++) logdet += 2 * Math.log(C[i * n + i]!);
    const logL = -0.5 * (n * Math.log(sigma2) + logdet + n);
    return {
      logL,
      velocity: beta[1]!,
      velocitySigma: Math.sqrt(sigma2 * Ninv[1]![1]!),
    };
  };

  // Grid search over the flicker share, then golden-section refinement.
  let best: {
    phi: number;
    r: NonNullable<ReturnType<typeof evaluate>>;
  } | null = null;
  for (let k = 0; k <= 20; k++) {
    const phi = Math.min(k / 20, 0.995);
    const r = evaluate(phi);
    if (r && (!best || r.logL > best.r.logL)) best = { phi, r };
  }
  if (!best) return null;
  let lo = Math.max(0, best.phi - 0.05);
  let hi = Math.min(0.995, best.phi + 0.05);
  const g = (Math.sqrt(5) - 1) / 2;
  for (let it = 0; it < 12; it++) {
    const a = hi - g * (hi - lo);
    const b = lo + g * (hi - lo);
    const ra = evaluate(a);
    const rb = evaluate(b);
    if (!ra || !rb) break;
    if (ra.logL > rb.logL) {
      hi = b;
      if (ra.logL > best.r.logL) best = { phi: a, r: ra };
    } else {
      lo = a;
      if (rb.logL > best.r.logL) best = { phi: b, r: rb };
    }
  }
  return {
    flickerShare: best.phi,
    velocitySigma: best.r.velocitySigma,
    velocity: best.r.velocity,
  };
}

function invert(N: number[][]): number[][] | null {
  const p = N.length;
  const M = N.map((row, i) => [
    ...row,
    ...Array.from({ length: p }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++)
      if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r;
    if (Math.abs(M[piv]![c]!) < 1e-14) return null;
    [M[c], M[piv]] = [M[piv]!, M[c]!];
    const d = M[c]![c]!;
    for (let k = 0; k < 2 * p; k++) M[c]![k] /= d;
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = M[r]![c]!;
      if (f === 0) continue;
      for (let k = 0; k < 2 * p; k++) M[r]![k] -= f * M[c]![k]!;
    }
  }
  return M.map((row) => row.slice(p));
}
