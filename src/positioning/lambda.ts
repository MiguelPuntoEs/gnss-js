/**
 * Integer ambiguity resolution: LAMBDA decorrelation + MLAMBDA
 * integer least-squares search.
 *
 * Port of RTKLIB's `lambda.c` (demo5 / rtklibexplorer fork,
 * src/lambda.c, Copyright (c) 2007-2008 T. Takasu, BSD-2-Clause),
 * cross-checked against the reference papers where the C comments are
 * thin:
 *
 * - [1] P.J.G. Teunissen, "The least-squares ambiguity decorrelation
 *   adjustment: a method for fast GPS ambiguity estimation",
 *   J. Geodesy 70, 65-82, 1995.
 * - [2] X.-W. Chang, X. Yang, T. Zhou, "MLAMBDA: A modified LAMBDA
 *   method for integer least-squares estimation", J. Geodesy 79,
 *   552-565, 2005.
 *
 * Pipeline (identical to RTKLIB's `lambda()`):
 * 1. LᵀDL factorization of the float covariance, Q = Lᵀ·diag(D)·L
 *    with L unit lower triangular (RTKLIB's `LD`).
 * 2. LAMBDA reduction [1]: integer Gauss transformations interleaved
 *    with symmetric permutations until the transformed D is
 *    (approximately) descending — producing a unimodular Z with
 *    Qz = ZᵀQZ = Lᵀ·diag(D)·L far better conditioned than Q.
 * 3. MLAMBDA search [2] in the decorrelated space: depth-first
 *    enumeration over a shrinking ellipsoid, keeping the `m` smallest
 *    residual quadratic forms (z−ž)ᵀQz⁻¹(z−ž).
 * 4. Back-transform the candidates to the original space, a = Z⁻ᵀ·ž
 *    (RTKLIB solves ZᵀF = E; Z is unimodular so F is exactly integer).
 *
 * Deviations from lambda.c:
 * - matrices are `Float64Array` in the same column-major layout, with
 *   allocation-failure paths dropped (JS throws instead),
 * - failures (non-positive-definite Q, search loop overflow) return
 *   `null` instead of a status code + stderr message,
 * - back-transformed candidates are rounded to the nearest integer:
 *   F = Z⁻ᵀ·ž is exactly integer in ℤ arithmetic and the rounding only
 *   removes the ~1e-12 fuzz of the floating-point triangular solve,
 * - the ratio s₂/s₁ used by the RTKLIB caller (`rtkpos.c`) is returned
 *   alongside the candidates (∞ when s₁ = 0, i.e. noise-free input).
 */

const LOOPMAX = 10000; // maximum count of search loop

const ROUND = (x: number): number => Math.floor(x + 0.5);
const SGN = (x: number): number => (x <= 0 ? -1 : 1);

/**
 * LᵀDL factorization Q = Lᵀ·diag(D)·L (RTKLIB `LD`): L unit lower
 * triangular, D positive diagonal; column-major, processed bottom-up.
 * Returns false when Q is not positive definite.
 */
function ldFactor(
  n: number,
  Q: Float64Array,
  L: Float64Array,
  D: Float64Array
): boolean {
  const A = Float64Array.from(Q);
  for (let i = n - 1; i >= 0; i--) {
    D[i] = A[i + i * n];
    if (D[i] <= 0) return false;
    const a = Math.sqrt(D[i]);
    for (let j = 0; j <= i; j++) L[i + j * n] = A[i + j * n] / a;
    for (let j = 0; j <= i - 1; j++)
      for (let k = 0; k <= j; k++) A[j + k * n] -= L[i + k * n] * L[i + j * n];
    for (let j = 0; j <= i; j++) L[i + j * n] /= L[i + i * n];
  }
  return true;
}

/**
 * Integer Gauss transformation (RTKLIB `gauss`): subtract
 * round(L[i,j]) times column i from column j of L (and of Z), driving
 * the off-diagonal |L[i,j]| ≤ 1/2 while keeping Z unimodular.
 */
function gauss(
  n: number,
  L: Float64Array,
  Z: Float64Array,
  i: number,
  j: number
): void {
  const mu = ROUND(L[i + j * n]);
  if (mu !== 0) {
    for (let k = i; k < n; k++) L[k + n * j] -= mu * L[k + i * n];
    for (let k = 0; k < n; k++) Z[k + n * j] -= mu * Z[k + i * n];
  }
}

/**
 * Symmetric permutation of adjacent states j, j+1 (RTKLIB `perm`),
 * updating L, D and the accumulated Z in place. `del` is the new
 * D[j+1] = D[j] + L[j+1,j]²·D[j+1] computed by the caller.
 */
function perm(
  n: number,
  L: Float64Array,
  D: Float64Array,
  j: number,
  del: number,
  Z: Float64Array
): void {
  const eta = D[j] / del;
  const lam = (D[j + 1] * L[j + 1 + j * n]) / del;
  D[j] = eta * D[j + 1];
  D[j + 1] = del;
  for (let k = 0; k <= j - 1; k++) {
    const a0 = L[j + k * n];
    const a1 = L[j + 1 + k * n];
    L[j + k * n] = -L[j + 1 + j * n] * a0 + a1;
    L[j + 1 + k * n] = eta * a0 + lam * a1;
  }
  L[j + 1 + j * n] = lam;
  for (let k = j + 2; k < n; k++) {
    const t = L[k + j * n];
    L[k + j * n] = L[k + (j + 1) * n];
    L[k + (j + 1) * n] = t;
  }
  for (let k = 0; k < n; k++) {
    const t = Z[k + j * n];
    Z[k + j * n] = Z[k + (j + 1) * n];
    Z[k + (j + 1) * n] = t;
  }
}

/**
 * LAMBDA reduction (RTKLIB `reduction`, ref [1]): alternate integer
 * Gauss transformations and permutations until no swap decreases
 * D[j+1] — i.e. z = Zᵀ·a with Qz = ZᵀQZ = Lᵀ·diag(D)·L decorrelated.
 */
function reduction(
  n: number,
  L: Float64Array,
  D: Float64Array,
  Z: Float64Array
): void {
  let j = n - 2;
  let k = n - 2;
  while (j >= 0) {
    if (j <= k) for (let i = j + 1; i < n; i++) gauss(n, L, Z, i, j);
    const del = D[j] + L[j + 1 + j * n] * L[j + 1 + j * n] * D[j + 1];
    if (del + 1e-6 < D[j + 1]) {
      // compared considering numerical error
      perm(n, L, D, j, del, Z);
      k = j;
      j = n - 2;
    } else j--;
  }
}

/**
 * MLAMBDA search (RTKLIB `search`, ref [2]): find the `m` integer
 * vectors minimizing (z−ž)ᵀ(LᵀDL)⁻¹(z−ž) by depth-first enumeration
 * with a shrinking bound. `zn` receives the candidates column-major
 * (n×m), `s` the corresponding quadratic forms. Returns false on
 * search loop overflow.
 */
function search(
  n: number,
  m: number,
  L: Float64Array,
  D: Float64Array,
  zs: Float64Array,
  zn: Float64Array,
  s: Float64Array
): boolean {
  let nn = 0;
  let imax = 0;
  let maxdist = 1e99;
  const S = new Float64Array(n * n);
  const dist = new Float64Array(n);
  const zb = new Float64Array(n);
  const z = new Float64Array(n);
  const step = new Float64Array(n);

  let k = n - 1;
  dist[k] = 0;
  zb[k] = zs[k];
  z[k] = ROUND(zb[k]);
  let y = zb[k] - z[k];
  step[k] = SGN(y); // step towards closest integer
  let c = 0;
  for (; c < LOOPMAX; c++) {
    const newdist = dist[k] + (y * y) / D[k]; // Σ (z(j)-zb(j))²/d(j)
    if (newdist < maxdist) {
      // Case 1: move down
      if (k !== 0) {
        dist[--k] = newdist;
        for (let i = 0; i <= k; i++)
          S[k + i * n] =
            S[k + 1 + i * n] + (z[k + 1] - zb[k + 1]) * L[k + 1 + i * n];
        zb[k] = zs[k] + S[k + k * n];
        z[k] = ROUND(zb[k]); // next valid integer
        y = zb[k] - z[k];
        step[k] = SGN(y);
      } else {
        // Case 2: store the candidate and try the next valid integer
        if (nn < m) {
          // store the first m initial points
          if (nn === 0 || newdist > s[imax]) imax = nn;
          for (let i = 0; i < n; i++) zn[i + nn * n] = z[i];
          s[nn++] = newdist;
        } else {
          if (newdist < s[imax]) {
            for (let i = 0; i < n; i++) zn[i + imax * n] = z[i];
            s[imax] = newdist;
            imax = 0;
            for (let i = 0; i < m; i++) if (s[imax] < s[i]) imax = i;
          }
          maxdist = s[imax];
        }
        z[0] += step[0]; // next valid integer
        y = zb[0] - z[0];
        step[0] = -step[0] - SGN(step[0]);
      }
    } else {
      // Case 3: exit or move up
      if (k === n - 1) break;
      k++; // move up
      z[k] += step[k]; // next valid integer
      y = zb[k] - z[k];
      step[k] = -step[k] - SGN(step[k]);
    }
  }
  for (let i = 0; i < m - 1; i++) {
    // sort by s
    for (let j = i + 1; j < m; j++) {
      if (s[i] < s[j]) continue;
      const t = s[i];
      s[i] = s[j];
      s[j] = t;
      for (let l = 0; l < n; l++) {
        const u = zn[l + i * n];
        zn[l + i * n] = zn[l + j * n];
        zn[l + j * n] = u;
      }
    }
  }
  return c < LOOPMAX;
}

/**
 * Solve Zᵀ·X = E (n×n, m right-hand sides, column-major) by Gaussian
 * elimination with partial pivoting — RTKLIB's `solve("T",Z,E,n,m,F)`.
 * Returns null when Zᵀ is singular (cannot happen for a unimodular Z
 * built by the reduction, kept as a guard).
 */
function solveZt(
  n: number,
  m: number,
  Z: Float64Array,
  E: Float64Array
): Float64Array | null {
  // M = [Zᵀ | E] row-major augmented (n rows, n+m columns).
  const w = n + m;
  const M = new Float64Array(n * w);
  for (let r = 0; r < n; r++) {
    for (let cIdx = 0; cIdx < n; cIdx++) M[r * w + cIdx] = Z[cIdx + r * n]; // (Zᵀ)[r][c] = Z[c][r]
    for (let cIdx = 0; cIdx < m; cIdx++) M[r * w + n + cIdx] = E[r + cIdx * n];
  }
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(M[r * w + col]) > Math.abs(M[piv * w + col])) piv = r;
    if (Math.abs(M[piv * w + col]) < 1e-12) return null;
    if (piv !== col) {
      for (let cIdx = col; cIdx < w; cIdx++) {
        const t = M[col * w + cIdx];
        M[col * w + cIdx] = M[piv * w + cIdx];
        M[piv * w + cIdx] = t;
      }
    }
    const d = M[col * w + col];
    for (let cIdx = col; cIdx < w; cIdx++) M[col * w + cIdx] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r * w + col];
      if (f === 0) continue;
      for (let cIdx = col; cIdx < w; cIdx++)
        M[r * w + cIdx] -= f * M[col * w + cIdx];
    }
  }
  const X = new Float64Array(n * m);
  for (let r = 0; r < n; r++)
    for (let cIdx = 0; cIdx < m; cIdx++) X[r + cIdx * n] = M[r * w + n + cIdx];
  return X;
}

/** Result of an integer least-squares search. */
export interface LambdaResult {
  /**
   * The `m` best integer candidate vectors (length n each), sorted by
   * ascending residual quadratic form; `candidates[0]` is the integer
   * least-squares minimizer.
   */
  candidates: Float64Array[];
  /**
   * Residual quadratic forms sᵢ = (a−ǎᵢ)ᵀQ⁻¹(a−ǎᵢ) matching
   * `candidates`, ascending.
   */
  residuals: Float64Array;
  /**
   * Ratio-test statistic s₂/s₁ (second-best over best); `Infinity`
   * when the best residual is exactly 0 (noise-free input). Callers
   * typically cap it (RTKLIB uses 999.9) before thresholding.
   */
  ratio: number;
}

/**
 * LAMBDA/MLAMBDA integer least-squares estimation (RTKLIB `lambda`):
 * decorrelate the float ambiguities, search the `m` best integer
 * vectors and back-transform them to the original space.
 *
 * @param a Float ambiguities (length ≥ n).
 * @param Q Their covariance, n×n (symmetric — row/column-major agree).
 * @param n Number of ambiguities.
 * @param m Number of candidates to return (default 2: best +
 *   second-best, what the ratio test needs).
 * @returns Candidates + residuals + ratio, or null when Q is not
 *   positive definite or the search does not terminate.
 */
export function lambdaSearch(
  a: Float64Array,
  Q: Float64Array,
  n: number,
  m = 2
): LambdaResult | null {
  if (n <= 0 || m <= 0 || a.length < n || Q.length < n * n) return null;
  const L = new Float64Array(n * n);
  const D = new Float64Array(n);
  if (!ldFactor(n, Q, L, D)) return null;

  // Z starts as the identity; reduction accumulates the unimodular
  // transform in it.
  const Z = new Float64Array(n * n);
  for (let i = 0; i < n; i++) Z[i + i * n] = 1;
  reduction(n, L, D, Z);

  // z = Zᵀ·a (decorrelated float ambiguities).
  const z = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let sum = 0;
    for (let k = 0; k < n; k++) sum += Z[k + j * n] * a[k];
    z[j] = sum;
  }

  const E = new Float64Array(n * m);
  const s = new Float64Array(m);
  if (!search(n, m, L, D, z, E, s)) return null;

  // F = Z⁻ᵀ·E: candidates in the original ambiguity space.
  const F = solveZt(n, m, Z, E);
  if (!F) return null;
  const candidates: Float64Array[] = [];
  for (let c = 0; c < m; c++) {
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = ROUND(F[i + c * n]);
    candidates.push(v);
  }
  const ratio = m >= 2 && s[0] > 0 ? s[1] / s[0] : Infinity;
  return { candidates, residuals: s, ratio };
}

/**
 * LAMBDA reduction only (RTKLIB `lambda_reduction`): the unimodular
 * decorrelation matrix Z (n×n, column-major) such that Qz = ZᵀQZ is
 * (near-)diagonally dominant. Exposed for diagnostics/tests; returns
 * null when Q is not positive definite.
 */
export function lambdaReduction(
  Q: Float64Array,
  n: number
): Float64Array | null {
  if (n <= 0 || Q.length < n * n) return null;
  const L = new Float64Array(n * n);
  const D = new Float64Array(n);
  if (!ldFactor(n, Q, L, D)) return null;
  const Z = new Float64Array(n * n);
  for (let i = 0; i < n; i++) Z[i + i * n] = 1;
  reduction(n, L, D, Z);
  return Z;
}
