import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Rtcm3Decoder } from '../src/rtcm3';

/**
 * Rtcm3Decoder.decode is linear: a whole log in one call gives the same
 * frames as any chunking of it (and garbage between frames is skipped the
 * same way), without copying the buffer per frame.
 */
const LOG = new Uint8Array(
  readFileSync(`${__dirname}/../test-fixtures/dlf100_rtcm_rtk_base.rtcm`)
);

const frames = (chunks: Uint8Array[]) => {
  const d = new Rtcm3Decoder();
  return chunks.flatMap((c) =>
    d.decode(c).map((f) => [f.messageType, f.length, [...f.payload].join()])
  );
};

function chunked(b: Uint8Array, sizes: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let o = 0, i = 0; o < b.length; i++) {
    const n = sizes[i % sizes.length]!;
    out.push(b.subarray(o, o + n));
    o += n;
  }
  return out;
}

describe('Rtcm3Decoder', () => {
  it('whole = chunked, also with garbage between frames', () => {
    // Noise (including stray 0xD3 sync bytes) spliced in every ~5 kB.
    const noisy: number[] = [];
    for (let i = 0; i < LOG.length; i++) {
      noisy.push(LOG[i]!);
      if (i % 4999 === 0) noisy.push(0xd3, 0x00, 0x13, 0x42, 0xd3, 0xff, 7);
    }
    for (const b of [LOG, new Uint8Array(noisy)]) {
      const whole = frames([b]);
      expect(whole.length).toBeGreaterThan(100);
      for (const sizes of [[1], [7, 1000, 3], [16384], [65536, 5]])
        expect(frames(chunked(b, sizes))).toEqual(whole);
    }
  });

  it('decodes megabytes in one call quickly', () => {
    const reps = Math.ceil((8 * 2 ** 20) / LOG.length);
    const big = new Uint8Array(LOG.length * reps);
    for (let i = 0; i < reps; i++) big.set(LOG, i * LOG.length);
    const t = performance.now();
    const n = new Rtcm3Decoder().decode(big).length;
    // Quadratic copying took ~10 s for 10 MB; linear is well under 1 s.
    expect(performance.now() - t).toBeLessThan(3000);
    expect(n).toBe(frames([LOG]).length * reps);
  });
});
