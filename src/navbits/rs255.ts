/**
 * Reed-Solomon (255,32) erasure decoding over GF(2^8) — the "vertical"
 * outer code of the Galileo High Accuracy Service (Galileo HAS SIS ICD
 * Issue 1.0, §5.2 and Annex C): field polynomial
 * p(x) = x^8 + x^4 + x^3 + x^2 + 1 (0x11D, α = 2), generator polynomial
 * g(x) = Π_{i=1..223} (x − α^i), systematic codeword layout
 * [32 information octets | 223 parity octets].
 *
 * A HAS message of MS ≤ 32 pages fills the first MS information octets
 * of each of the 53 codeword columns (the remaining information octets
 * are zero), and the page with page ID p carries codeword symbol p − 1
 * of every column. Any MS pages with distinct page IDs therefore
 * determine the message: the corresponding MS rows of the generator
 * matrix, truncated to their first MS columns, form an invertible
 * MS×MS system over GF(2^8) (an MDS-code property).
 *
 * The construction was cross-checked entry for entry (255×32 = 8160
 * octets) against the generator matrix shipped with FGI's HASlib
 * reference decoder (github.com/nlsfi/HASlib, EUPL-1.2,
 * galileo_has_decoder/resources/genMatrix.txt).
 */

/** Codeword length n of the HAS outer code (octets/pages). */
export const RS255_N = 255;

/** Information length k of the HAS outer code (octets/pages). */
export const RS255_K = 32;

/* ── GF(2^8) tables, field polynomial 0x11D ────────────────────── */

const EXP = new Uint8Array(510);
const LOG = new Int16Array(256).fill(-1);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 510; i++) EXP[i] = EXP[i - 255]!;
}

const gfMul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;

const gfInv = (a: number): number => EXP[255 - LOG[a]!]!;

/* ── Generator polynomial and matrix ───────────────────────────── */

/** g(x) = Π_{i=1..223} (x − α^i), degree-descending, g[0] = 1. */
const GEN_POLY = (() => {
  let g = new Uint8Array([1]);
  for (let i = 1; i <= 223; i++) {
    const root = EXP[i]!;
    const next = new Uint8Array(g.length + 1);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j]!; // x · g
      next[j + 1] ^= gfMul(g[j]!, root); // α^i · g
    }
    g = next;
  }
  return g;
})();

/**
 * Systematically encode up to 32 information octets (zero-padded to
 * k = 32) into one 255-octet codeword: information first, then the 223
 * parity octets (the remainder of m(x)·x^223 divided by g(x)).
 */
export function rs255Encode(info: Uint8Array): Uint8Array {
  if (info.length > RS255_K)
    throw new RangeError(`rs255Encode: info length ${info.length} > 32`);
  const cw = new Uint8Array(RS255_N);
  cw.set(info, 0);
  const work = new Uint8Array(RS255_N);
  work.set(info, 0);
  for (let i = 0; i < RS255_K; i++) {
    const coef = work[i]!;
    if (coef === 0) continue;
    for (let j = 1; j < GEN_POLY.length; j++)
      work[i + j] ^= gfMul(GEN_POLY[j]!, coef);
  }
  cw.set(work.subarray(RS255_K), RS255_K);
  return cw;
}

/** Full 255×32 generator matrix; row p−1 belongs to page ID p. */
let genMatrix: Uint8Array[] | null = null;

function generatorMatrix(): Uint8Array[] {
  if (genMatrix) return genMatrix;
  const rows: Uint8Array[] = [];
  for (let r = 0; r < RS255_N; r++) rows.push(new Uint8Array(RS255_K));
  for (let c = 0; c < RS255_K; c++) {
    const e = new Uint8Array(RS255_K);
    e[c] = 1;
    const cw = rs255Encode(e);
    for (let r = 0; r < RS255_N; r++) rows[r]![c] = cw[r]!;
  }
  genMatrix = rows;
  return rows;
}

/**
 * One row of the 255×32 generator matrix: the 32 coefficients that map
 * the information octets to the codeword symbol carried by `pageId`
 * (1-based, 1…255). Rows 1…32 are unit vectors (systematic code).
 */
export function rs255GeneratorRow(pageId: number): Uint8Array {
  if (pageId < 1 || pageId > RS255_N)
    throw new RangeError(`rs255GeneratorRow: page ID ${pageId} out of range`);
  return generatorMatrix()[pageId - 1]!.slice();
}

/**
 * Encode a k×width octet message (row-major: row r = page ID r + 1)
 * into the full 255×width code block, column by column. Row p − 1 of
 * the result is the page broadcast with page ID p.
 */
export function rs255EncodeBlock(message: Uint8Array, k: number): Uint8Array {
  if (k < 1 || k > RS255_K || message.length % k !== 0)
    throw new RangeError('rs255EncodeBlock: bad message length or k');
  const width = message.length / k;
  const out = new Uint8Array(RS255_N * width);
  const col = new Uint8Array(RS255_K);
  for (let c = 0; c < width; c++) {
    col.fill(0);
    for (let r = 0; r < k; r++) col[r] = message[r * width + c]!;
    const cw = rs255Encode(col);
    for (let r = 0; r < RS255_N; r++) out[r * width + c] = cw[r]!;
  }
  return out;
}

/** One received code symbol: a page ID (1…255) and its octets. */
export interface RsPage {
  /** 1-based codeword symbol index (the HAS page ID). */
  pageId: number;
  /** Symbol octets; every page of one block has the same width. */
  octets: Uint8Array;
}

/**
 * Erasure-decode a message of `k` pages from any set of received
 * pages with distinct page IDs (extra pages beyond the first `k`
 * distinct ones are ignored — the code corrects erasures, not errors).
 * Returns the k×width information octets (row-major, row r = page ID
 * r + 1), or null when fewer than `k` distinct valid page IDs are
 * present. Cost is one k×k Gauss-Jordan inversion over GF(2^8).
 */
export function rs255DecodeErasures(
  pages: RsPage[],
  k: number
): Uint8Array | null {
  if (k < 1 || k > RS255_K) return null;
  const seen = new Set<number>();
  const use: RsPage[] = [];
  for (const p of pages) {
    if (p.pageId < 1 || p.pageId > RS255_N || seen.has(p.pageId)) continue;
    seen.add(p.pageId);
    use.push(p);
    if (use.length === k) break;
  }
  if (use.length < k) return null;
  const width = use[0]!.octets.length;
  if (use.some((p) => p.octets.length !== width)) return null;

  // A · m = received  →  m = A⁻¹ · received, A = G[pids−1, 0..k−1].
  const G = generatorMatrix();
  const a: Uint8Array[] = use.map((p) => G[p.pageId - 1]!.slice(0, k));
  const inv: Uint8Array[] = use.map((_, r) => {
    const row = new Uint8Array(k);
    row[r] = 1;
    return row;
  });
  for (let c = 0; c < k; c++) {
    let pivot = -1;
    for (let r = c; r < k; r++)
      if (a[r]![c] !== 0) {
        pivot = r;
        break;
      }
    if (pivot < 0) return null; // cannot happen for an MDS code
    [a[c], a[pivot]] = [a[pivot]!, a[c]!];
    [inv[c], inv[pivot]] = [inv[pivot]!, inv[c]!];
    const s = gfInv(a[c]![c]!);
    for (let j = 0; j < k; j++) {
      a[c]![j] = gfMul(a[c]![j]!, s);
      inv[c]![j] = gfMul(inv[c]![j]!, s);
    }
    for (let r = 0; r < k; r++) {
      if (r === c || a[r]![c] === 0) continue;
      const f = a[r]![c]!;
      for (let j = 0; j < k; j++) {
        a[r]![j] ^= gfMul(a[c]![j]!, f);
        inv[r]![j] ^= gfMul(inv[c]![j]!, f);
      }
    }
  }

  const out = new Uint8Array(k * width);
  for (let r = 0; r < k; r++)
    for (let c = 0; c < width; c++) {
      let v = 0;
      for (let j = 0; j < k; j++) v ^= gfMul(inv[r]![j]!, use[j]!.octets[c]!);
      out[r * width + c] = v;
    }
  return out;
}
