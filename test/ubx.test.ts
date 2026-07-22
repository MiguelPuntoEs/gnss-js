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
  const res = parseUbxRawx(new Uint8Array(readFileSync(FILE)));

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
});
