import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseNovatelRange } from '../src/novatel';

const FILE = join(__dirname, '../test-fixtures/oemv_rangecmp.gps');

/**
 * The fixture is RTKLIB's OEMV sample log (test/data/rcvraw,
 * BSD-2-Clause): RANGECMP observations plus GLOEPHEMERIS for the
 * GLONASS frequency channels. Expected values pinned from RTKLIB
 * demo5 convbin's RINEX conversion of the same file — the full-file
 * comparison (4140 observables, 46 epochs) agreed to the 0.0005
 * printing quantum with CN0 exact.
 */
describe.skipIf(!existsSync(FILE))('parseNovatelRange (OEMV RANGECMP)', () => {
  const res = parseNovatelRange(new Uint8Array(readFileSync(FILE)));

  it('frames the stream and decodes every epoch', () => {
    expect(res.epochs.length).toBe(46);
    expect(res.badCrc).toBe(0);
    expect(res.messageCounts[140]).toBe(46); // RANGECMP
    expect(res.messageCounts[723]).toBe(8); // GLOEPHEMERIS
  });

  it('decodes receiver time in the RINEX parser convention', () => {
    // > 2009 12 18 23 07 00.0000000 in the reference RINEX
    expect(res.epochs[0]!.timeMs).toBe(Date.UTC(2009, 11, 18, 23, 7, 0));
  });

  it('maps signals to the RTKLIB obs-code convention', () => {
    expect(res.obsCodes['G']).toEqual(['1C', '2W']);
    expect(res.obsCodes['R']).toEqual(['1C', '2P']);
    expect(res.obsCodes['S']).toEqual(['1C']);
  });

  const at = (prn: string, code: string) =>
    res.epochs[0]!.meas.find((m) => m.prn === prn && m.code === code);

  it('matches convbin observables incl. reconstructed phase', () => {
    const g03 = at('G03', '1C')!;
    expect(Math.abs(g03.pr! - 20213930.641)).toBeLessThan(6e-4);
    expect(Math.abs(g03.cp! - 106224932.512)).toBeLessThan(6e-4);
    expect(g03.cn0).toBe(51);
    const g03l2 = at('G03', '2W')!;
    expect(Math.abs(g03l2.pr! - 20213929.547)).toBeLessThan(6e-4);
    expect(Math.abs(g03l2.cp! - 82772666.965)).toBeLessThan(6e-4);
    expect(g03l2.cn0).toBe(45);
  });

  it('recovers GLONASS channels and phases from GLOEPHEMERIS', () => {
    const withGlo = res.epochs.flatMap((e) =>
      e.meas.filter((m) => m.prn[0] === 'R' && m.cp !== null)
    );
    expect(withGlo.length).toBeGreaterThan(50);
    for (const m of withGlo.slice(0, 20)) {
      expect(m.gloChannel).not.toBeNull();
      expect(m.gloChannel!).toBeGreaterThanOrEqual(-7);
      expect(m.gloChannel!).toBeLessThanOrEqual(6);
    }
  });
});
