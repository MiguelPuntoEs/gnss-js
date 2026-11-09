/**
 * ECDSA P-256 / SHA-256 signature verification (FIPS 186-4), BigInt
 * arithmetic in Jacobian coordinates. Verification only — no secrets
 * are handled, so constant-time arithmetic is not a concern. OSNMA
 * signs each DSM-KROOT once per chain update, so speed is not either.
 */

import { sha256 } from './sha256';

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

const mod = (a: bigint, m: bigint) => {
  const r = a % m;
  return r < 0n ? r + m : r;
};

function powMod(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

const inv = (a: bigint, m: bigint) => powMod(a, m - 2n, m); // m prime

/** Jacobian point (X, Y, Z); Z = 0 is the point at infinity. */
type Jp = [bigint, bigint, bigint];
const INF: Jp = [0n, 1n, 0n];

function dbl([x, y, z]: Jp): Jp {
  if (z === 0n || y === 0n) return INF;
  // a = −3: M = 3(X − Z²)(X + Z²)
  const z2 = (z * z) % P;
  const m = mod(3n * (x - z2) * (x + z2), P);
  const y2 = (y * y) % P;
  const s = (4n * x * y2) % P;
  const x3 = mod(m * m - 2n * s, P);
  const y3 = mod(m * (s - x3) - 8n * y2 * y2, P);
  const z3 = (2n * y * z) % P;
  return [x3, y3, z3];
}

function add(p: Jp, q: Jp): Jp {
  if (p[2] === 0n) return q;
  if (q[2] === 0n) return p;
  const z1z1 = (p[2] * p[2]) % P;
  const z2z2 = (q[2] * q[2]) % P;
  const u1 = (p[0] * z2z2) % P;
  const u2 = (q[0] * z1z1) % P;
  const s1 = (p[1] * q[2] * z2z2) % P;
  const s2 = (q[1] * p[2] * z1z1) % P;
  if (u1 === u2) return s1 === s2 ? dbl(p) : INF;
  const h = mod(u2 - u1, P);
  const r = mod(s2 - s1, P);
  const h2 = (h * h) % P;
  const h3 = (h * h2) % P;
  const x3 = mod(r * r - h3 - 2n * u1 * h2, P);
  const y3 = mod(r * (u1 * h2 - x3) - s1 * h3, P);
  const z3 = (h * p[2] * q[2]) % P;
  return [x3, y3, z3];
}

/** u1·G + u2·Q (Shamir's trick). */
function mulAdd(u1: bigint, u2: bigint, q: Jp): Jp {
  const g: Jp = [GX, GY, 1n];
  const gq = add(g, q);
  let r = INF;
  const bits = Math.max(u1.toString(2).length, u2.toString(2).length);
  for (let i = bits - 1; i >= 0; i--) {
    r = dbl(r);
    const b1 = (u1 >> BigInt(i)) & 1n;
    const b2 = (u2 >> BigInt(i)) & 1n;
    if (b1 && b2) r = add(r, gq);
    else if (b1) r = add(r, g);
    else if (b2) r = add(r, q);
  }
  return r;
}

const toBig = (b: Uint8Array) => {
  let x = 0n;
  for (const v of b) x = (x << 8n) | BigInt(v);
  return x;
};

/**
 * Decode a SEC1 public key — compressed (33 bytes, 02/03 prefix, as
 * OSNMA broadcasts it) or uncompressed (65 bytes, 04 prefix) — into an
 * affine point on the curve, or null when it isn't one.
 */
export function p256PublicKey(key: Uint8Array): [bigint, bigint] | null {
  if (key.length === 65 && key[0] === 4) {
    const x = toBig(key.subarray(1, 33));
    const y = toBig(key.subarray(33));
    return mod(y * y - (x * x * x - 3n * x + B), P) === 0n ? [x, y] : null;
  }
  if (key.length !== 33 || (key[0] !== 2 && key[0] !== 3)) return null;
  const x = toBig(key.subarray(1));
  if (x >= P) return null;
  const rhs = mod(x * x * x - 3n * x + B, P);
  let y = powMod(rhs, (P + 1n) / 4n, P); // P ≡ 3 (mod 4)
  if ((y * y) % P !== rhs) return null;
  if (Number(y & 1n) !== (key[0] & 1)) y = P - y;
  return [x, y];
}

/**
 * Verify an ECDSA P-256/SHA-256 signature `sig` (r ‖ s, 64 bytes) of
 * `msg` under the SEC1-encoded public key `pubKey`.
 */
export function p256Verify(
  pubKey: Uint8Array,
  msg: Uint8Array,
  sig: Uint8Array
): boolean {
  const q = p256PublicKey(pubKey);
  if (!q || sig.length !== 64) return false;
  const r = toBig(sig.subarray(0, 32));
  const s = toBig(sig.subarray(32));
  if (r <= 0n || r >= N || s <= 0n || s >= N) return false;
  const e = toBig(sha256(msg));
  const w = inv(s, N);
  const x = mulAdd((e * w) % N, (r * w) % N, [q[0], q[1], 1n]);
  if (x[2] === 0n) return false;
  const zi = inv(x[2], P);
  const ax = (x[0] * zi * zi) % P;
  return ax % N === r;
}
