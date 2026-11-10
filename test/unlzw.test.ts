import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRinexStream } from '../src/rinex/parser';
import { isUnixCompress, uncompressLzw } from '../src/rinex/unlzw';

const FIX = join(__dirname, '../test-fixtures');
const file = (name: string) => new File([readFileSync(join(FIX, name))], name);

describe('uncompressLzw (Unix compress, .Z)', () => {
  it('decodes the classic example (compress -c, 16-bit block mode)', () => {
    // printf 'TOBEORNOTTOBEORTOBEORNOT#' | compress -c
    const z = new Uint8Array([
      0x1f, 0x9d, 0x90, 0x54, 0x9e, 0x08, 0x29, 0xf2, 0x44, 0x8a, 0x93, 0x27,
      0x54, 0x02, 0x0e, 0x2c, 0xa8, 0x90, 0xa0, 0x41, 0x84, 0x23, 0x00,
    ]);
    expect(isUnixCompress(z)).toBe(true);
    expect(new TextDecoder().decode(uncompressLzw(z))).toBe(
      'TOBEORNOTTOBEORTOBEORNOT#'
    );
  });

  it('matches the original byte for byte (code widths up to 16 bits)', () => {
    const plain = readFileSync(join(FIX, 'anmg_crx_slice.crx'));
    const out = uncompressLzw(
      new Uint8Array(readFileSync(join(FIX, 'anmg_crx_slice.crx.Z')))
    );
    expect(Buffer.from(out).equals(plain)).toBe(true);
  });

  it('lets parseRinexStream read .Z archives directly', async () => {
    const a = await parseRinexStream(file('anmg_crx_slice.crx'));
    const b = await parseRinexStream(file('anmg_crx_slice.crx.Z'));
    expect(b.header.markerName).toBe(a.header.markerName);
    expect(b.epochs.length).toBe(a.epochs.length);
    expect(b.epochs.length).toBeGreaterThan(0);
  });
});
