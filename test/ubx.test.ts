import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseUbxRawx } from '../src/ubx';

const FILE = join(__dirname, '../test-fixtures/f9p_rawx_slice.ubx');

/**
 * The slice is the first five RXM-RAWX frames of rtklibexplorer's
 * public F9P PPP dataset (2020-12-24). Expected values are pinned from
 * RTKLIB convbin's RINEX conversion of the same log — the full-file
 * comparison (269k pseudoranges/Dopplers, 237k phases) agreed to the
 * 0.0005 printing quantum across all 4521 epochs.
 */
describe.skipIf(!existsSync(FILE))('parseUbxRawx (F9P slice)', () => {
  // Guarded read: describe bodies execute even under skipIf, so a
  // missing fixture must not crash collection.
  const res = existsSync(FILE)
    ? parseUbxRawx(new Uint8Array(readFileSync(FILE)))
    : null!;

  it('frames the stream: five RAWX epochs, clean checksums', () => {
    expect(res.epochs.length).toBe(5);
    expect(res.badChecksums).toBe(0);
    expect(res.messageCounts['02-15']).toBe(5);
    expect(res.messageCounts['02-13']).toBeGreaterThan(50); // SFRBX
  });

  it('decodes receiver time in the RINEX parser convention', () => {
    // > 2020 12 24 21 28 42.0050000 in the reference RINEX
    expect(res.epochs[0]!.timeMs).toBe(Date.UTC(2020, 11, 24, 21, 28, 42, 5));
    expect(res.epochs[0]!.leapS).toBe(18);
    expect(res.epochs[1]!.timeMs - res.epochs[0]!.timeMs).toBe(1000);
  });

  it('maps signals to the RTKLIB obs-code convention', () => {
    expect(res.obsCodes['G']).toEqual(['1C', '2X']);
    expect(res.obsCodes['E']).toContain('1X');
    expect(res.obsCodes['C']).toContain('2I');
    expect(res.obsCodes['R']).toContain('1C');
  });

  const at = (prn: string, code: string) =>
    res.epochs[0]!.meas.find((m) => m.prn === prn && m.code === code);

  it('matches convbin observables (GPS L1 + L2)', () => {
    const g04 = at('G04', '1C')!;
    expect(Math.abs(g04.pr! - 21756763.556)).toBeLessThan(5e-4);
    expect(Math.abs(g04.cp! - 114332579.336)).toBeLessThan(5e-4);
    expect(Math.abs(g04.doppler - -1109.248)).toBeLessThan(5e-4);
    expect(g04.cn0).toBe(46);
    const g04l2 = at('G04', '2X')!;
    expect(Math.abs(g04l2.pr! - 21756759.495)).toBeLessThan(5e-4);
    expect(Math.abs(g04l2.cp! - 89090283.431)).toBeLessThan(5e-4);
  });

  it('matches convbin observables (BeiDou B1I + B2I)', () => {
    const c14 = at('C14', '2I')!;
    expect(Math.abs(c14.pr! - 23691039.556)).toBeLessThan(5e-4);
    const c14b2 = at('C14', '7I')!;
    expect(Math.abs(c14b2.pr! - 23691030.139)).toBeLessThan(5e-4);
    expect(Math.abs(c14b2.cp! - 95393962.957)).toBeLessThan(5e-4);
    expect(Math.abs(c14b2.doppler - -769.384)).toBeLessThan(5e-4);
    expect(c14b2.cn0).toBe(49);
  });

  it('only emits valid observables', () => {
    for (const e of res.epochs) {
      for (const m of e.meas) {
        if (m.pr !== null) expect(m.pr).toBeGreaterThan(1e6);
        if (m.cp !== null) expect(m.cp).not.toBe(0);
        expect(m.cn0).toBeGreaterThan(10);
        expect(m.cn0).toBeLessThan(65);
      }
    }
  });

  it('reads trkStat bit 2 as "half cycle valid", not ambiguous', () => {
    // u-blox M8 protocol §31.19.4.2 RXM-RAWX trkStat: bit0 prValid,
    // bit1 cpValid, bit2 halfCyc "Half cycle valid", bit3 subHalfCyc.
    // Every phase in the slice has trkStat 7 or 15 (half cycle resolved);
    // RTKLIB convbin agrees (no LLI bit 1 on any phase). Before the fix
    // every one of them was flagged half-cycle ambiguous.
    const withPhase = res.epochs.flatMap((e) =>
      e.meas.filter((m) => m.cp !== null)
    );
    expect(withPhase.length).toBe(300);
    expect(withPhase.every((m) => !m.halfCycleAmbiguous)).toBe(true);
    // A measurement without phase is never "ambiguous" either.
    for (const e of res.epochs) {
      for (const m of e.meas)
        if (m.cp === null) expect(m.halfCycleAmbiguous).toBe(false);
    }
  });

  it('flags an unresolved half cycle (trkStat 3: phase valid, halfCyc clear)', () => {
    const bytes = new Uint8Array(readFileSync(FILE));
    // Patch the first measurement's trkStat in the first RAWX frame, then
    // fix the Fletcher checksum.
    const start = bytes.findIndex(
      (b, i) =>
        b === 0xb5 &&
        bytes[i + 1] === 0x62 &&
        bytes[i + 2] === 0x02 &&
        bytes[i + 3] === 0x15
    );
    const len = bytes[start + 4]! | (bytes[start + 5]! << 8);
    const payload = start + 6;
    bytes[payload + 16 + 30] = 3;
    let a = 0;
    let b = 0;
    for (let i = start + 2; i < payload + len; i++) {
      a = (a + bytes[i]!) & 0xff;
      b = (b + a) & 0xff;
    }
    bytes[payload + len] = a;
    bytes[payload + len + 1] = b;
    const m = parseUbxRawx(bytes).epochs[0]!.meas[0]!;
    expect(m.cp).not.toBeNull();
    expect(m.halfCycleAmbiguous).toBe(true);
  });
});
