import { describe, it, expect } from 'vitest';
import { createHash, createHmac, generateKeyPairSync, sign } from 'crypto';
import { sha256, hmacSha256 } from '../src/osnma/sha256';
import { p256PublicKey, p256Verify } from '../src/osnma/p256';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const enc = (s: string) => new TextEncoder().encode(s);

describe('sha256 / hmacSha256', () => {
  it('matches the FIPS 180-4 examples', () => {
    expect(hex(sha256(enc('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect(hex(sha256(new Uint8Array(0)))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(
      hex(
        sha256(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
      )
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('matches node:crypto on every length around the block boundaries', () => {
    for (let n = 0; n < 200; n++) {
      const m = new Uint8Array(n).map((_, i) => (i * 37 + n) & 0xff);
      expect(hex(sha256(m))).toBe(createHash('sha256').update(m).digest('hex'));
      // Split input hashes the same as the joined one.
      expect(hex(sha256(m.subarray(0, n >> 1), m.subarray(n >> 1)))).toBe(
        hex(sha256(m))
      );
      const key = m.subarray(0, (n * 7) % 90);
      expect(hex(hmacSha256(key, m))).toBe(
        createHmac('sha256', key).update(m).digest('hex')
      );
    }
  });
});

describe('p256Verify', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const raw = new Uint8Array(spki.subarray(spki.length - 65)); // 04 ‖ X ‖ Y
  const compressed = new Uint8Array(33);
  compressed[0] = 2 + (raw[64]! & 1);
  compressed.set(raw.subarray(1, 33), 1);

  it('decompresses a public key to the same point', () => {
    expect(p256PublicKey(compressed)).toEqual(p256PublicKey(raw));
    expect(p256PublicKey(raw)).not.toBeNull();
  });

  it('accepts node-made signatures and rejects tampered ones', () => {
    for (let i = 0; i < 5; i++) {
      const msg = enc(`OSNMA DSM-KROOT ${i}`);
      const sig = new Uint8Array(
        sign('sha256', msg, { key: privateKey, dsaEncoding: 'ieee-p1363' })
      );
      expect(p256Verify(compressed, msg, sig)).toBe(true);
      expect(p256Verify(raw, msg, sig)).toBe(true);
      const bad = sig.slice();
      bad[10]! ^= 1;
      expect(p256Verify(compressed, msg, bad)).toBe(false);
      expect(p256Verify(compressed, enc(`OSNMA DSM-KROOT ${i + 1}`), sig)).toBe(
        false
      );
    }
  });
});
