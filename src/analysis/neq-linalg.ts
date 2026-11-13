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

/**
 * Eigen-decomposition of a symmetric matrix (cyclic Jacobi): values and
 * row-major eigenvectors (column k = vector k). O(n³) per sweep — for the
 * few hundred parameters of a solution whose covariance is singular.
 */
export function symmetricEigen(
  a: ArrayLike<number>,
  n: number
): { values: Float64Array; vectors: Float64Array } {
  const A = Float64Array.from(a as ArrayLike<number>);
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    let diag = 0;
    for (let i = 0; i < n; i++) {
      diag += A[i * n + i]! ** 2;
      for (let j = i + 1; j < n; j++) off += A[i * n + j]! ** 2;
    }
    if (off <= 1e-30 * diag) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        const apq = A[p * n + q]!;
        if (Math.abs(apq) < 1e-300) continue;
        const app = A[p * n + p]!;
        const aqq = A[q * n + q]!;
        const theta = (aqq - app) / (2 * apq);
        const t =
          Math.sign(theta || 1) /
          (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k * n + p]!;
          const akq = A[k * n + q]!;
          A[k * n + p] = c * akp - s * akq;
          A[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p * n + k]!;
          const aqk = A[q * n + k]!;
          A[p * n + k] = c * apk - s * aqk;
          A[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p]!;
          const vkq = V[k * n + q]!;
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
  }
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = A[i * n + i]!;
  return { values, vectors: V };
}

/**
 * Pseudo-inverse of a symmetric positive semi-definite matrix: eigenvalues
 * below `relTol` × the largest are treated as zero (directions the matrix
 * carries no information on). Returns the rank too.
 */
export function pseudoInverseSymmetric(
  a: ArrayLike<number>,
  n: number,
  relTol = 1e-9
): { inverse: Float64Array; rank: number } {
  const { values, vectors: V } = symmetricEigen(a, n);
  const max = Math.max(...values);
  const inv = new Float64Array(n * n);
  let rank = 0;
  for (let k = 0; k < n; k++) {
    const l = values[k]!;
    if (!(l > relTol * max)) continue;
    rank++;
    const f = 1 / l;
    for (let i = 0; i < n; i++) {
      const vi = V[i * n + k]! * f;
      if (vi === 0) continue;
      for (let j = 0; j < n; j++) inv[i * n + j] += vi * V[j * n + k]!;
    }
  }
  return { inverse: inv, rank };
}
