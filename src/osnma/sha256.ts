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

/* ------------------------------------------------------------------ */
/*  SHA-512 (FIPS 180-4) — for ECDSA P-521 only, so BigInt is fine.     */
/* ------------------------------------------------------------------ */

const K512 = [
  '428a2f98d728ae22',
  '7137449123ef65cd',
  'b5c0fbcfec4d3b2f',
  'e9b5dba58189dbbc',
  '3956c25bf348b538',
  '59f111f1b605d019',
  '923f82a4af194f9b',
  'ab1c5ed5da6d8118',
  'd807aa98a3030242',
  '12835b0145706fbe',
  '243185be4ee4b28c',
  '550c7dc3d5ffb4e2',
  '72be5d74f27b896f',
  '80deb1fe3b1696b1',
  '9bdc06a725c71235',
  'c19bf174cf692694',
  'e49b69c19ef14ad2',
  'efbe4786384f25e3',
  '0fc19dc68b8cd5b5',
  '240ca1cc77ac9c65',
  '2de92c6f592b0275',
  '4a7484aa6ea6e483',
  '5cb0a9dcbd41fbd4',
  '76f988da831153b5',
  '983e5152ee66dfab',
  'a831c66d2db43210',
  'b00327c898fb213f',
  'bf597fc7beef0ee4',
  'c6e00bf33da88fc2',
  'd5a79147930aa725',
  '06ca6351e003826f',
  '142929670a0e6e70',
  '27b70a8546d22ffc',
  '2e1b21385c26c926',
  '4d2c6dfc5ac42aed',
  '53380d139d95b3df',
  '650a73548baf63de',
  '766a0abb3c77b2a8',
  '81c2c92e47edaee6',
  '92722c851482353b',
  'a2bfe8a14cf10364',
  'a81a664bbc423001',
  'c24b8b70d0f89791',
  'c76c51a30654be30',
  'd192e819d6ef5218',
  'd69906245565a910',
  'f40e35855771202a',
  '106aa07032bbd1b8',
  '19a4c116b8d2d0c8',
  '1e376c085141ab53',
  '2748774cdf8eeb99',
  '34b0bcb5e19b48a8',
  '391c0cb3c5c95a63',
  '4ed8aa4ae3418acb',
  '5b9cca4f7763e373',
  '682e6ff3d6b2b8a3',
  '748f82ee5defb2fc',
  '78a5636f43172f60',
  '84c87814a1f0ab72',
  '8cc702081a6439ec',
  '90befffa23631e28',
  'a4506cebde82bde9',
  'bef9a3f7b2c67915',
  'c67178f2e372532b',
  'ca273eceea26619c',
  'd186b8c721c0c207',
  'eada7dd6cde0eb1e',
  'f57d4f7fee6ed178',
  '06f067aa72176fba',
  '0a637dc5a2c898a6',
  '113f9804bef90dae',
  '1b710b35131c471b',
  '28db77f523047d84',
  '32caab7b40c72493',
  '3c9ebe0a15c9bebc',
  '431d67c49c100d4c',
  '4cc5d4becb3e42b6',
  '597f299cfc657e2a',
  '5fcb6fab3ad6faec',
  '6c44198c4a475817',
].map((h) => BigInt('0x' + h));

const M64 = (1n << 64n) - 1n;
const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & M64;

/** SHA-512 of the concatenation of `parts`. */
export function sha512(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const padded = new Uint8Array(Math.ceil((len + 17) / 128) * 128);
  let o = 0;
  for (const p of parts) {
    padded.set(p, o);
    o += p.length;
  }
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setBigUint64(padded.length - 8, BigInt(len) * 8n);
  const h = [
    '6a09e667f3bcc908',
    'bb67ae8584caa73b',
    '3c6ef372fe94f82b',
    'a54ff53a5f1d36f1',
    '510e527fade682d1',
    '9b05688c2b3e6c1f',
    '1f83d9abfb41bd6b',
    '5be0cd19137e2179',
  ].map((x) => BigInt('0x' + x));
  const w: bigint[] = new Array(80);
  for (let off = 0; off < padded.length; off += 128) {
    for (let i = 0; i < 16; i++) w[i] = view.getBigUint64(off + 8 * i);
    for (let i = 16; i < 80; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 1n) ^ rotr(a, 8n) ^ (a >> 7n);
      const s1 = rotr(b, 19n) ^ rotr(b, 61n) ^ (b >> 6n);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) & M64;
    }
    let [a, b, c, d, e, f, g, hh] = h as [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    for (let i = 0; i < 80; i++) {
      const S1 = rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n);
      const ch = (e & f) ^ (~e & M64 & g);
      const t1 = (hh + S1 + ch + K512[i]! + w[i]!) & M64;
      const S0 = rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) & M64;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) & M64;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) & M64;
    }
    [a, b, c, d, e, f, g, hh].forEach((v, i) => (h[i] = (h[i]! + v) & M64));
  }
  const out = new Uint8Array(64);
  const ov = new DataView(out.buffer);
  h.forEach((v, i) => ov.setBigUint64(8 * i, v));
  return out;
}
