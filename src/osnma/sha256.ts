/**
 * Synchronous SHA-256 (FIPS 180-4) and HMAC-SHA-256 (FIPS 198-1).
 *
 * OSNMA verification runs a TESLA chain of up to a few thousand hashes
 * per key and an HMAC per tag, page by page on a live stream; WebCrypto
 * is asynchronous only, so the library carries its own small, sync
 * implementation (checked against the NIST vectors in the tests).
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const W = new Uint32Array(64);

function compress(h: Uint32Array, block: Uint8Array, off: number): void {
  for (let i = 0; i < 16; i++) {
    const j = off + 4 * i;
    W[i] =
      (block[j]! << 24) |
      (block[j + 1]! << 16) |
      (block[j + 2]! << 8) |
      block[j + 3]!;
  }
  for (let i = 16; i < 64; i++) {
    const a = W[i - 15]!;
    const b = W[i - 2]!;
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) | 0;
  }
  let a = h[0]!;
  let b = h[1]!;
  let c = h[2]!;
  let d = h[3]!;
  let e = h[4]!;
  let f = h[5]!;
  let g = h[6]!;
  let hh = h[7]!;
  for (let i = 0; i < 64; i++) {
    const S1 =
      ((e >>> 6) | (e << 26)) ^
      ((e >>> 11) | (e << 21)) ^
      ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + S1 + ch + K[i]! + W[i]!) | 0;
    const S0 =
      ((a >>> 2) | (a << 30)) ^
      ((a >>> 13) | (a << 19)) ^
      ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    hh = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  h[0] = (h[0]! + a) | 0;
  h[1] = (h[1]! + b) | 0;
  h[2] = (h[2]! + c) | 0;
  h[3] = (h[3]! + d) | 0;
  h[4] = (h[4]! + e) | 0;
  h[5] = (h[5]! + f) | 0;
  h[6] = (h[6]! + g) | 0;
  h[7] = (h[7]! + hh) | 0;
}

/** SHA-256 of the concatenation of `parts`. */
export function sha256(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const padded = new Uint8Array(Math.ceil((len + 9) / 64) * 64);
  let o = 0;
  for (const p of parts) {
    padded.set(p, o);
    o += p.length;
  }
  padded[len] = 0x80;
  const bitLen = len * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  for (let off = 0; off < padded.length; off += 64) compress(h, padded, off);
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(4 * i, h[i]!);
  return out;
}

/** HMAC-SHA-256 of `msg` under `key`. */
export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const k = key.length > 64 ? sha256(key) : key;
  const ipad = new Uint8Array(64).fill(0x36);
  const opad = new Uint8Array(64).fill(0x5c);
  for (let i = 0; i < k.length; i++) {
    ipad[i]! ^= k[i]!;
    opad[i]! ^= k[i]!;
  }
  return sha256(opad, sha256(ipad, msg));
}
