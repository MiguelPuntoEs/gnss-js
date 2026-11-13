/**
 * Small dense least squares through normal equations — the accumulator the
 * network product estimators (regional ionosphere, satellite clocks) share.
 * N is kept full and symmetric (row-major Float64Array); a few hundred to a
 * couple of thousand parameters are cheap enough this way.
 */

export class DenseNeq {
  readonly n: number;
  readonly N: Float64Array;
  readonly b: Float64Array;
  /** Σ w·l² of the reduced observations (for σ₀). */
  ltpl = 0;
  nObs = 0;

  constructor(n: number) {
    this.n = n;
    this.N = new Float64Array(n * n);
    this.b = new Float64Array(n);
  }

  /** One observation l = Σ a_k·x[idx_k] with weight w (1/σ²). */
  add(idx: readonly number[], a: readonly number[], l: number, w: number) {
    const { N, b, n } = this;
    for (let i = 0; i < idx.length; i++) {
      const ii = idx[i]!;
      const wa = w * a[i]!;
      b[ii]! += wa * l;
      const row = ii * n;
      for (let j = 0; j < idx.length; j++) N[row + idx[j]!]! += wa * a[j]!;
    }
    this.ltpl += w * l * l;
    this.nObs++;
  }

  /** Solve N x = b (Cholesky); with `covariance` also N⁻¹. Throws when N
   *  isn't positive definite (a datum defect). */
  solve(covariance = false): { x: Float64Array; Qxx?: Float64Array } {
    const n = this.n;
    const L = choleskyDecompose(this.N, n);
    const x = choleskySolve(L, n, this.b);
    if (!covariance) return { x };
    const Q = new Float64Array(n * n);
    const e = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      e.fill(0);
      e[j] = 1;
      const c = choleskySolve(L, n, e);
      for (let i = 0; i < n; i++) Q[i * n + j] = c[i]!;
    }
    return { x, Qxx: Q };
  }
}

/** Lower-triangular L with L·Lᵀ = A (row-major). */
export function choleskyDecompose(A: Float64Array, n: number): Float64Array {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j]!;
      const ri = i * n;
      const rj = j * n;
      for (let k = 0; k < j; k++) s -= L[ri + k]! * L[rj + k]!;
      if (i === j) {
        if (!(s > 0))
          throw new Error(`Normal matrix not positive definite at ${i}.`);
        L[ri + i] = Math.sqrt(s);
      } else L[ri + j] = s / L[rj + j]!;
    }
  }
  return L;
}

/** Solve L·Lᵀ·x = b. */
export function choleskySolve(
  L: Float64Array,
  n: number,
  b: ArrayLike<number>
): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= L[i * n + k]! * y[k]!;
    y[i] = s / L[i * n + i]!;
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!;
    for (let k = i + 1; k < n; k++) s -= L[k * n + i]! * x[k]!;
    x[i] = s / L[i * n + i]!;
  }
  return x;
}
