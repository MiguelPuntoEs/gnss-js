/**
 * Dense symmetric linear algebra for normal equations: Cholesky, solve,
 * inverse and the Schur complement (pre-elimination). Matrices are
 * row-major Float64Array n×n; only the lower triangle is read where a
 * matrix is symmetric. Sized for networks of a few thousand parameters
 * (n³/3 flops per factorisation).
 */

/**
 * In-place Cholesky factorisation A = L·Lᵀ (lower triangle of `a` becomes
 * L; the upper triangle is left untouched). Returns the index of the first
 * non-positive pivot, or -1 when A is positive definite. A pivot below
 * `relTol` × its original diagonal also counts as singular: it is a
 * direction the data do not determine (a datum defect).
 */
export function choleskyInPlace(
  a: Float64Array,
  n: number,
  relTol = 1e-12
): number {
  for (let j = 0; j < n; j++) {
    const rj = j * n;
    let s = a[rj + j]!;
    const d0 = s;
    for (let k = 0; k < j; k++) s -= a[rj + k]! * a[rj + k]!;
    if (!(s > relTol * Math.abs(d0)) || !(s > 0)) return j;
    const ljj = Math.sqrt(s);
    a[rj + j] = ljj;
    for (let i = j + 1; i < n; i++) {
      const ri = i * n;
      let t = a[ri + j]!;
      for (let k = 0; k < j; k++) t -= a[ri + k]! * a[rj + k]!;
      a[ri + j] = t / ljj;
    }
  }
  return -1;
}

/** Solve L·Lᵀ·x = b given the factor from `choleskyInPlace`. */
export function choleskySolve(
  l: Float64Array,
  n: number,
  b: ArrayLike<number>
): Float64Array {
  const y = Float64Array.from(b as ArrayLike<number>);
  for (let i = 0; i < n; i++) {
    const ri = i * n;
    let s = y[i]!;
    for (let k = 0; k < i; k++) s -= l[ri + k]! * y[k]!;
    y[i] = s / l[ri + i]!;
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!;
    for (let k = i + 1; k < n; k++) s -= l[k * n + i]! * y[k]!;
    y[i] = s / l[i * n + i]!;
  }
  return y;
}

/** (L·Lᵀ)⁻¹ as a full symmetric matrix, from the Cholesky factor. */
export function choleskyInverse(l: Float64Array, n: number): Float64Array {
  // W = L⁻¹ (lower), then A⁻¹ = Wᵀ·W.
  const w = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    w[j * n + j] = 1 / l[j * n + j]!;
    for (let i = j + 1; i < n; i++) {
      const ri = i * n;
      let s = 0;
      for (let k = j; k < i; k++) s -= l[ri + k]! * w[k * n + j]!;
      w[ri + j] = s / l[ri + i]!;
    }
  }
  const inv = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      // Σ_k≥i W[k][i]·W[k][j]
      let s = 0;
      for (let k = i; k < n; k++) s += w[k * n + i]! * w[k * n + j]!;
      inv[i * n + j] = s;
      inv[j * n + i] = s;
    }
  return inv;
}

/** Inverse of a symmetric positive-definite matrix; null if singular. */
export function invertSymmetric(
  a: ArrayLike<number>,
  n: number
): Float64Array | null {
  const l = Float64Array.from(a as ArrayLike<number>);
  if (choleskyInPlace(l, n) >= 0) return null;
  return choleskyInverse(l, n);
}

/** Copy the lower triangle onto the upper one. */
export function symmetrize(a: Float64Array, n: number): void {
  for (let i = 0; i < n; i++)
    for (let j = 0; j < i; j++) a[j * n + i] = a[i * n + j]!;
}

/**
 * Schur complement: reduce N·x = b by the unknowns `elim`, keeping `keep`.
 *   N' = N_kk − N_ke·N_ee⁻¹·N_ek,  b' = b_k − N_ke·N_ee⁻¹·b_e,
 *   ltpl' = ltpl − b_eᵀ·N_ee⁻¹·b_e.
 * A singular N_ee (an eliminated parameter the data do not determine) is
 * regularised with a tiny diagonal so it drops out without effect.
 */
export function schurComplement(
  N: Float64Array,
  b: Float64Array,
  n: number,
  keep: readonly number[],
  elim: readonly number[]
): { N: Float64Array; b: Float64Array; dLtpl: number } {
  const nk = keep.length;
  const ne = elim.length;
  const outN = new Float64Array(nk * nk);
  const outB = new Float64Array(nk);
  for (let i = 0; i < nk; i++) {
    const ri = keep[i]! * n;
    outB[i] = b[keep[i]!]!;
    for (let j = 0; j < nk; j++) outN[i * nk + j] = N[ri + keep[j]!]!;
  }
  if (ne === 0) return { N: outN, b: outB, dLtpl: 0 };
  const Lee = new Float64Array(ne * ne);
  let maxDiag = 0;
  for (let i = 0; i < ne; i++) {
    const ri = elim[i]! * n;
    for (let j = 0; j < ne; j++) Lee[i * ne + j] = N[ri + elim[j]!]!;
    maxDiag = Math.max(maxDiag, Math.abs(Lee[i * ne + i]!));
  }
  if (choleskyInPlace(Lee, ne) >= 0) {
    // Regularise: parameters without information (or a datum defect among
    // the eliminated ones) get a negligible pseudo-observation.
    for (let i = 0; i < ne; i++) {
      const ri = elim[i]! * n;
      for (let j = 0; j < ne; j++) Lee[i * ne + j] = N[ri + elim[j]!]!;
      Lee[i * ne + i] += Math.max(maxDiag, 1) * 1e-10;
    }
    if (choleskyInPlace(Lee, ne, 0) >= 0)
      throw new Error('schurComplement: eliminated block not decomposable');
  }
  // Y = L⁻¹·N_ek (ne × nk), z = L⁻¹·b_e
  const Y = new Float64Array(ne * nk);
  const z = new Float64Array(ne);
  for (let i = 0; i < ne; i++) {
    const ri = elim[i]! * n;
    const li = i * ne;
    const yi = i * nk;
    for (let j = 0; j < nk; j++) Y[yi + j] = N[ri + keep[j]!]!;
    let zi = b[elim[i]!]!;
    for (let k = 0; k < i; k++) {
      const lik = Lee[li + k]!;
      if (lik === 0) continue;
      const yk = k * nk;
      for (let j = 0; j < nk; j++) Y[yi + j] -= lik * Y[yk + j]!;
      zi -= lik * z[k]!;
    }
    const d = Lee[li + i]!;
    for (let j = 0; j < nk; j++) Y[yi + j] /= d;
    z[i] = zi / d;
  }
  // N' −= Yᵀ·Y, b' −= Yᵀ·z
  for (let k = 0; k < ne; k++) {
    const yk = k * nk;
    const zk = z[k]!;
    for (let i = 0; i < nk; i++) {
      const yki = Y[yk + i]!;
      if (yki === 0) continue;
      outB[i] -= yki * zk;
      const ri = i * nk;
      for (let j = 0; j <= i; j++) outN[ri + j] -= yki * Y[yk + j]!;
    }
  }
  symmetrize(outN, nk);
  let dLtpl = 0;
  for (let k = 0; k < ne; k++) dLtpl += z[k]! * z[k]!;
  return { N: outN, b: outB, dLtpl };
}
