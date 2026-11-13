/**
 * RINEX navigation files: reader field positions (spec oracle), and
 * 2.11 ↔ 3.04 ↔ 4.02 round trips through our writers.
 */
import { describe, expect, it } from 'vitest';
import { parseNavFile, type KeplerEphemeris } from '../src/rinex/nav';
import { hasFixture, readText } from './nav-sources';

const HAS_V4 = hasFixture('brdc_v4_dlr.nav');

describe('reader: blank (BNK) fields keep their slot', () => {
  it.skipIf(!HAS_V4)(
    'RINEX 4 NavIC LNAV orbit-5 "IDOT, BNK, IRN week" reads week 2399',
    () => {
      // brdc_v4_dlr.nav, > EPH I02 LNAV, BROADCAST ORBIT-5 (RINEX 4.02
      // Table A30): "-1.035400271434e-09" + 19 blanks + "2.399000000000e+03".
      // Collapsing the blank made the week 0.
      const nav = parseNavFile(readText('brdc_v4_dlr.nav'));
      const navic = nav.ephemerides.filter(
        (e) => e.system === 'I'
      ) as KeplerEphemeris[];
      expect(navic.length).toBeGreaterThan(100);
      const i02 = navic.find((e) => e.prn === 'I02')!;
      expect(i02.idot).toBe(-1.035400271434e-9);
      expect(i02.week).toBe(2399);
      // orbit-6 "URA, health, TGD, BNK": TGD stays in slot 3
      expect(i02.tgd).toBe(-1.862645149231e-9);
      for (const e of navic) expect(e.week, e.prn).toBe(2399);
    }
  );

  it('a blank mid-line field is 0 and the next field keeps its column', () => {
    const blank = ' '.repeat(19);
    const text = [
      '     3.05           N: GNSS NAV DATA    G: GPS              RINEX VERSION / TYPE',
      '                                                            END OF HEADER',
      'G05 2026 01 01 02 00 00 1.000000000000E-04 2.000000000000E-12 0.000000000000E+00',
      '     5.000000000000E+01 1.100000000000E+01 4.000000000000E-09 1.000000000000E+00',
      '     1.000000000000E-06 1.000000000000E-02 2.000000000000E-06 5.153000000000E+03',
      '     3.528000000000E+05 1.000000000000E-07 2.000000000000E+00 3.000000000000E-08',
      '     9.600000000000E-01 2.000000000000E+02 1.000000000000E+00-8.000000000000E-09',
      `     2.000000000000E-10${blank} 2.399000000000E+03`,
      `     2.000000000000E+00 0.000000000000E+00-4.000000000000E-09 5.000000000000E+01`,
      `${blank.slice(0, 4)}${blank} 4.000000000000E+00`,
    ].join('\n');
    const [g] = parseNavFile(text).ephemerides as KeplerEphemeris[];
    expect(g!.week).toBe(2399);
    expect(g!.ttm).toBeUndefined(); // blank t_tm = not known
  });
});
