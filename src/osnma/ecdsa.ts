/**
 * ECDSA signature verification (FIPS 186-4) on the two curves OSNMA
 * defines — P-256/SHA-256 and P-521/SHA-512 — with BigInt arithmetic
 * in Jacobian coordinates. Verification only — no secrets are handled,
 * so constant-time arithmetic is not a concern. OSNMA signs each
 * DSM-KROOT once per chain update, so speed is not either.
 */

import { sha256, sha512 } from './sha256';

interface Curve {
  p: bigint;
  n: bigint;
  b: bigint;
  gx: bigint;
  gy: bigint;
  /** Field element size in bytes. */
  size: number;
  hash: (m: Uint8Array) => Uint8Array;
}

const P256: Curve = {
  p: 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn,
  n: 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
  b: 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn,
  gx: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  gy: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
  size: 32,
  hash: (m) => sha256(m),
};

const P521: Curve = {
  p: (1n << 521n) - 1n,
  n: 0x01fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa51868783bf2f966b7fcc0148f709a5d03bb5c9b8899c47aebb6fb71e91386409n,
  b: 0x0051953eb9618e1c9a1f929a21a0b68540eea2da725b99b315f3b8b489918ef109e156193951ec7e937b1652c0bd3bb1bf073573df883d2c34f1ef451fd46b503f00n,
  gx: 0x00c6858e06b70404e9cd9e3ecb662395b4429c648139053fb521f828af606b4d3dbaa14b5e77efe75928fe1dc127a2ffa8de3348b3c1856a429bf97e7e31c2e5bd66n,
  gy: 0x011839296a789a3bc0045c8a5fb42c7d1bd998f54449579b446817afbd17273e662c97ee72995ef42640c550b9013fad0761353c7086a272c24088be94769fd16650n,
  size: 66,
  hash: (m) => sha512(m),
};

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

function dbl(P: bigint, [x, y, z]: Jp): Jp {
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

function add(P: bigint, p: Jp, q: Jp): Jp {
  if (p[2] === 0n) return q;
  if (q[2] === 0n) return p;
  const z1z1 = (p[2] * p[2]) % P;
  const z2z2 = (q[2] * q[2]) % P;
  const u1 = (p[0] * z2z2) % P;
  const u2 = (q[0] * z1z1) % P;
  const s1 = (p[1] * q[2] * z2z2) % P;
  const s2 = (q[1] * p[2] * z1z1) % P;
  if (u1 === u2) return s1 === s2 ? dbl(P, p) : INF;
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
function mulAdd(c: Curve, u1: bigint, u2: bigint, q: Jp): Jp {
  const g: Jp = [c.gx, c.gy, 1n];
  const gq = add(c.p, g, q);
  let r = INF;
  const bits = Math.max(u1.toString(2).length, u2.toString(2).length);
  for (let i = bits - 1; i >= 0; i--) {
    r = dbl(c.p, r);
    const b1 = (u1 >> BigInt(i)) & 1n;
    const b2 = (u2 >> BigInt(i)) & 1n;
    if (b1 && b2) r = add(c.p, r, gq);
    else if (b1) r = add(c.p, r, g);
    else if (b2) r = add(c.p, r, q);
  }
  return r;
}

const toBig = (b: Uint8Array) => {
  let x = 0n;
  for (const v of b) x = (x << 8n) | BigInt(v);
  return x;
};

function decodeKey(c: Curve, key: Uint8Array): [bigint, bigint] | null {
  const n = c.size;
  const onCurve = (x: bigint, y: bigint) =>
    mod(y * y - (x * x * x - 3n * x + c.b), c.p) === 0n;
  if (key.length === 2 * n + 1 && key[0] === 4) {
    const x = toBig(key.subarray(1, n + 1));
    const y = toBig(key.subarray(n + 1));
    return onCurve(x, y) ? [x, y] : null;
  }
  if (key.length !== n + 1 || (key[0] !== 2 && key[0] !== 3)) return null;
  const x = toBig(key.subarray(1));
  if (x >= c.p) return null;
  const rhs = mod(x * x * x - 3n * x + c.b, c.p);
  let y = powMod(rhs, (c.p + 1n) / 4n, c.p); // both primes ≡ 3 (mod 4)
  if ((y * y) % c.p !== rhs) return null;
  if (Number(y & 1n) !== (key[0] & 1)) y = c.p - y;
  return [x, y];
}

function verify(
  c: Curve,
  pubKey: Uint8Array,
  msg: Uint8Array,
  sig: Uint8Array
): boolean {
  const q = decodeKey(c, pubKey);
  if (!q || sig.length !== 2 * c.size) return false;
  const r = toBig(sig.subarray(0, c.size));
  const s = toBig(sig.subarray(c.size));
  if (r <= 0n || r >= c.n || s <= 0n || s >= c.n) return false;
  // The hash is never longer than the order here (256 ≤ 256, 512 < 521).
  const e = toBig(c.hash(msg));
  const w = inv(s, c.n);
  const x = mulAdd(c, (e * w) % c.n, (r * w) % c.n, [q[0], q[1], 1n]);
  if (x[2] === 0n) return false;
  const zi = inv(x[2], c.p);
  return ((x[0] * zi * zi) % c.p) % c.n === r;
}

/**
 * Decode a SEC1 P-256 public key — compressed (33 bytes, 02/03 prefix,
 * as OSNMA broadcasts it) or uncompressed (65 bytes, 04 prefix) — into
 * an affine point on the curve, or null when it isn't one.
 */
export const p256PublicKey = (key: Uint8Array) => decodeKey(P256, key);

/**
 * Verify an ECDSA P-256/SHA-256 signature `sig` (r ‖ s, 64 bytes) of
 * `msg` under the SEC1-encoded public key `pubKey`.
 */
export const p256Verify = (
  pubKey: Uint8Array,
  msg: Uint8Array,
  sig: Uint8Array
) => verify(P256, pubKey, msg, sig);

/**
 * Verify an ECDSA P-521/SHA-512 signature `sig` (r ‖ s, 66 bytes each)
 * of `msg` under the SEC1-encoded public key `pubKey` (67 bytes
 * compressed).
 */
export const p521Verify = (
  pubKey: Uint8Array,
  msg: Uint8Array,
  sig: Uint8Array
) => verify(P521, pubKey, msg, sig);
