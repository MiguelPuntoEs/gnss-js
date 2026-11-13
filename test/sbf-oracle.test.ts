/**
 * Septentrio SBF against the AsteRx-m3 Pro+ v4.15.1 Reference Guide. RTKLIB
 * 2.4.2 has no SBF reader, so the oracle is the guide itself: an independent
 * MeasEpoch decoder written straight from its field tables (§4.2.1 pp.
 * 273–277, §4.1.9 SVID, §4.1.10 signal numbers; a Python script, not this
 * library) agreed with parseSbfMeas on all 28 644 values of the DLF500 slice
 * once the two bugs pinned below were fixed. Values here are hand-decoded
 * from the raw bytes with those tables.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseSbfMeas } from '../src/sbf';
import { svidToPrn } from '../src/sbf/frame';

const FIX = join(__dirname, '..', 'test-fixtures');
const bytes = new Uint8Array(
  readFileSync(join(FIX, 'dlf500_sbf_nav_slice.sbf'))
);
const res = parseSbfMeas(bytes);

describe('SBF SVID numbering (§4.1.9)', () => {
  it('maps every defined range, BeiDou up to C63', () => {
    expect(svidToPrn(1)).toBe('G01');
    expect(svidToPrn(38)).toBe('R01');
    expect(svidToPrn(61)).toBe('R24');
    expect(svidToPrn(62)).toBeNull(); // GLONASS, slot unknown
    expect(svidToPrn(63)).toBe('R25');
    expect(svidToPrn(71)).toBe('E01');
    expect(svidToPrn(106)).toBe('E36');
    expect(svidToPrn(120)).toBe('S20');
    expect(svidToPrn(141)).toBe('C01');
    expect(svidToPrn(180)).toBe('C40');
    expect(svidToPrn(181)).toBe('J01');
    expect(svidToPrn(191)).toBe('I01');
    expect(svidToPrn(198)).toBe('S41');
    expect(svidToPrn(216)).toBe('I08');
    expect(svidToPrn(223)).toBe('C41');
    // SVID 240 is C58, which the DLF500 slice tracks on B3I; it was dropped.
    expect(svidToPrn(240)).toBe('C58');
    expect(svidToPrn(245)).toBe('C63');
  });

  it('keeps C58 B3I from the DLF500 MeasEpoch', () => {
    const c58 = res.epochs[0]!.meas.find((m) => m.prn === 'C58');
    expect(c58?.code).toBe('6I');
    expect(c58!.pr).toBeGreaterThan(2e7);
  });
});

describe('MeasEpoch (4027) field tables, hand-decoded', () => {
  it('labels Galileo E6 as 6B when CommonFlags bit 6 (E6B used) is set', () => {
    // §4.1.10: signal 19 is "6C or 6B (∗) — see the E6B Used bit". The
    // DLF500 MeasEpoch blocks carry CommonFlags 0x4D (bits 0, 2, 3, 6).
    const start = bytes.findIndex(
      (b, i) =>
        b === 0x24 &&
        bytes[i + 1] === 0x40 &&
        ((bytes[i + 4]! | (bytes[i + 5]! << 8)) & 0x1fff) === 4027
    );
    expect(bytes[start + 17]).toBe(0x4d);
    expect(res.obsCodes['E']).toContain('6B');
    expect(res.obsCodes['E']).not.toContain('6C');
  });
});
