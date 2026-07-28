import { describe, it, expect } from 'vitest';
import { SbasProcessor } from '../src/positioning';
import { crc24q } from '../src/navbits/cnav';

/** Set `len` bits (MSB-first) at bit `pos` in a 250-bit SBAS message buffer. */
function setBitU(buf: Uint8Array, pos: number, len: number, val: number): void {
  for (let i = 0; i < len; i++) {
    const bit = (val >>> (len - 1 - i)) & 1;
    const bytePos = (pos + i) >> 3;
    const bitPos = 7 - ((pos + i) & 7);
    if (bit) buf[bytePos]! |= 1 << bitPos;
    else buf[bytePos]! &= ~(1 << bitPos);
  }
}

/** Build a CRC-valid SBAS L1 message of the given type with field writes. */
function mkMsg(type: number, writes: [number, number, number][]): Uint8Array {
  const m = new Uint8Array(32);
  setBitU(m, 0, 8, 0x53); // a valid L1 preamble
  setBitU(m, 8, 6, type);
  for (const [pos, len, val] of writes) setBitU(m, pos, len, val);
  setBitU(m, 226, 24, crc24q(m, 226));
  return m;
}

// MT1: mask GPS slot 1 (→ G01), IODP field at bits 224–225.
const mt1 = (iodp: number, slotBit = 14) =>
  mkMsg(1, [
    [slotBit, 1, 1],
    [224, 2, iodp],
  ]);
// MT2 fast corrections: IODP at 16–17 (must match the mask), a PRC at bit 18
// and a small UDRE index (raw 2 → stored 3, i.e. usable) at bit 174 (slot 0).
const mt2 = (iodp: number) =>
  mkMsg(2, [
    [16, 2, iodp],
    [18, 12, 8],
    [174, 4, 2],
  ]);

describe('SBAS re-broadcast must not wipe accumulated corrections', () => {
  const week = 2300;
  const tow = 100000;

  it('keeps fast corrections when MT1 repeats the same mask (DO-229 §A.4.4.2)', () => {
    const p = new SbasProcessor();
    p.update(mt1(0), week, tow);
    p.update(mt2(0), week, tow);
    // The fast correction is live after MT1 + MT2.
    expect(p.coverage(week, tow).fast).toBe(1);

    // A re-broadcast of the *identical* mask (SBAS repeats MT1 every few
    // seconds) must not reset the sat list and drop the fast correction.
    p.update(mt1(0), week, tow + 1);
    expect(p.coverage(week, tow + 1).fast).toBe(1); // regression: was 0
  });

  it('does reset corrections when the mask actually changes (new IODP/PRN set)', () => {
    const p = new SbasProcessor();
    p.update(mt1(0), week, tow);
    p.update(mt2(0), week, tow);
    expect(p.coverage(week, tow).fast).toBe(1);

    // A genuinely different mask (different IODP + different masked slot) must
    // rebuild the sat list — the old slot-0 fast correction no longer applies.
    p.update(mt1(1, 15), week, tow + 1); // mask slot 2 (G02) at IODP 1
    expect(p.coverage(week, tow + 1).fast).toBe(0);
  });
});
