import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseAntex,
  parseSatellitePrns,
  antexWithPrns,
  type AntennaEntry,
} from '../src/antex';
import { buildPppAntenna } from '../src/positioning';

// Excerpts of the IGS igs20.atx (ANTEX 1.4), igs20_rcv.atx2 + igs20_sat.atx2
// (ANTEX 2.0, release 2026:312) and igs_satellite_metadata.snx: the receiver
// antennas JAVRINGANT_G5T NONE (large, different North/East offsets) and
// 3S-02-TSADM NONE (no azimuth dependence), and GPS SVN G074 (PRN G04).
const fx = (f: string) =>
  readFileSync(join(__dirname, '../test-fixtures', f), 'utf8');
const v14 = parseAntex(fx('antex14_slice.atx'));
const v20 = parseAntex(fx('antex20_slice.atx2'));
const prns = parseSatellitePrns(fx('sat_metadata_prn_slice.snx'));

const rcv = (file: typeof v14, type: string) =>
  file.antennas.find((a) => !a.isSatellite && a.type === type)!;
const freq = (a: AntennaEntry, code: string) =>
  a.frequencies.find((f) => f.frequency === code)!;

/** Build an 80-column ANTEX line: content padded so the label starts at col 60. */
function l(content: string, label: string): string {
  return content.padEnd(60) + label;
}

describe('ANTEX 2.0', () => {
  it('reads the 2.0 header', () => {
    expect(v20.version).toBe(2);
    expect(v20.antennaTypes).toBe('MIXED');
    expect(v20.referenceFrame).toBe('IGS20');
    expect(v20.release).toBe('2026:312');
  });

  it('reads a receiver PCO "X / Y / Z" (x = East) as North/East/Up', () => {
    const a = freq(rcv(v20, 'JAVRINGANT_G5T  NONE'), 'G01');
    // File: X / Y / Z = 2.27 / 0.78 / 48.07.
    expect([a.pcoN, a.pcoE, a.pcoU]).toEqual([0.78, 2.27, 48.07]);
  });

  it('gives every receiver band the same offsets and grid as 1.4', () => {
    for (const type of ['JAVRINGANT_G5T  NONE', '3S-02-TSADM     NONE']) {
      const a = rcv(v14, type);
      const b = rcv(v20, type);
      expect([b.dazi, b.zen1, b.zen2, b.dzen]).toEqual([
        a.dazi,
        a.zen1,
        a.zen2,
        a.dzen,
      ]);
      for (const fa of a.frequencies) {
        const fb = b.frequencies.find((f) => f.frequency === fa.frequency);
        if (!fb) continue; // a few 1.4-only bands (GLONASS CDMA)
        expect([fb.pcoN, fb.pcoE, fb.pcoU]).toEqual([
          fa.pcoN,
          fa.pcoE,
          fa.pcoU,
        ]);
        expect(fb.pcv).toEqual(fa.pcv);
        // 2.0 has no NOAZI row: the azimuth mean; 1.4's NOAZI is within a few 0.1 mm of it.
        fb.pcvNoazi.forEach((v, i) =>
          expect(Math.abs(v - fa.pcvNoazi[i]!)).toBeLessThan(0.5)
        );
      }
    }
  });

  it('expands a record shared by several bands to each band', () => {
    const a = rcv(v20, 'JAVRINGANT_G5T  NONE');
    const g = freq(a, 'G01');
    for (const b of g.bands!) expect(freq(a, b).pcoE).toBe(g.pcoE);
    expect(g.bands).toContain('E01');
  });

  it('treats DAZI 360 as no azimuth dependence (dazi 0, file row as NOAZI)', () => {
    const b = rcv(v20, '3S-02-TSADM     NONE');
    expect(b.dazi).toBe(0);
    const f = freq(b, 'G01');
    expect(f.pcv).toEqual([]);
    expect(f.pcvNoaziDerived).toBeUndefined();
    expect(f.pcvNoazi).toEqual(
      freq(rcv(v14, '3S-02-TSADM     NONE'), 'G01').pcvNoazi
    );
  });

  it('keys satellites by SVN, with body X/Y/Z as in 1.4', () => {
    const s = v20.antennas.filter((a) => a.isSatellite);
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((a) => a.svnCode === 'G074' && a.serialNo === '')).toBe(
      true
    );
    expect(s[0]!.origin).toBe('COM');
  });

  it('assigns PRNs from the satellite metadata and matches 1.4', () => {
    expect(prns).toHaveLength(2);
    expect(prns[1]!.untilMs).toBe(Infinity);
    const byPrn = antexWithPrns(v20, prns).antennas.filter(
      (a) => a.isSatellite
    );
    // Two PRN G04 periods (a gap in 2019 when G074 had no PRN).
    expect(byPrn.map((a) => [a.serialNo, a.validFrom, a.validUntil])).toEqual([
      ['G04', '2019-01-09 00:00', '2019-07-13 00:00'],
      ['G04', '2019-10-21 00:00', ''],
    ]);
    const s14 = v14.antennas.filter((a) => a.isSatellite);
    for (const [i, a] of s14.entries())
      for (const fa of a.frequencies) {
        const fb = freq(byPrn[i]!, fa.frequency);
        expect([fb.pcoN, fb.pcoE, fb.pcoU]).toEqual([
          fa.pcoN,
          fa.pcoE,
          fa.pcoU,
        ]);
      }
  });

  it('gives the same PPP antenna model from either version', () => {
    const m14 = buildPppAntenna(v14);
    const m20 = buildPppAntenna(antexWithPrns(v20, prns));
    const f1 = 1575.42e6;
    const f2 = 1227.6e6;
    const r14 = m14.rcvOffset('JAVRINGANT_G5T  NONE', 'G01', 'G02', f1, f2)!;
    const r20 = m20.rcvOffset('JAVRINGANT_G5T  NONE', 'G01', 'G02', f1, f2)!;
    r14.pco.forEach((v, i) => expect(r20.pco[i]).toBeCloseTo(v, 9));
    const t = Date.UTC(2024, 4, 1);
    const s14 = m14.satOffset('G04', t, 'G01', 'G02', f1, f2)!;
    const s20 = m20.satOffset('G04', t, 'G01', 'G02', f1, f2)!;
    s14.pco.forEach((v, i) => expect(s20.pco[i]).toBeCloseTo(v, 9));
  });

  it('reads CODE and GAIN calibrations and blank (missing) pattern values', () => {
    const text = [
      l('     2.0', 'ANTEX VERSION'),
      l('', 'START OF HEADER'),
      l('RECEIVER', 'ANTENNA TYPES'),
      l('2026100', 'RELEASE'),
      l('', 'END OF HEADER'),
      l('', 'START OF ANTENNA'),
      l('PEC2CR          NONESN99', 'TYPE / SN'),
      l('', 'START OF CALIB'),
      l('PHASE          1', 'TYPE / # OF FREQS'),
      l(
        'CHAMBER             COMPANY LTD.             1    2017/09/12',
        'METH / BY / # / DATE'
      ),
      l('   180.0', 'DAZI'),
      l('     0.0  90.0  45.0', 'ZEN1 / ZEN2 / DZEN'),
      l('   G01   E01', 'START OF PHASE'),
      l('      0.64      0.72     96.56', 'X / Y / Z'),
      '     0.0    0.70    0.60        ',
      '   180.0    0.90    0.80    1.00',
      '   360.0    0.70    0.60        ',
      l('', 'END OF PHASE'),
      l('', 'END OF CALIB'),
      l('', 'START OF CALIB'),
      l('CODE           1', 'TYPE / # OF FREQS'),
      l(
        'CHAMBER             RUAG                     1    2017/09/12',
        'METH / BY / # / DATE'
      ),
      l('   360.0', 'DAZI'),
      l('     0.0  90.0  45.0', 'ZEN1 / ZEN2 / DZEN'),
      l('   G01', 'START OF CODE'),
      l('      -1.9       0.8     137.9', 'X / Y / Z'),
      '     0.0     6.6     6.4    17.7',
      '   360.0     6.6     6.4    17.7',
      l('', 'END OF CODE'),
      l('', 'END OF CALIB'),
      l('', 'START OF CALIB'),
      l('GAIN           1', 'TYPE / # OF FREQS'),
      l(
        'CHAMBER             COMPANY LTD.             1    2017/09/12',
        'METH / BY / # / DATE'
      ),
      l('   360.0', 'DAZI'),
      l('     0.0  90.0  45.0', 'ZEN1 / ZEN2 / DZEN'),
      l('   G01', 'START OF GAIN'),
      l('      0.00', 'OFFSET'),
      '     0.0    8.97    3.00   -8.85',
      '   360.0    8.97    3.00   -8.85',
      l('', 'END OF GAIN'),
      l('', 'END OF CALIB'),
      l('', 'END OF ANTENNA'),
    ].join('\n');
    const f = parseAntex(text);
    expect(f.antennas).toHaveLength(1);
    const a = f.antennas[0]!;
    expect([a.type, a.serialNo, a.method, a.agency, a.date]).toEqual([
      'PEC2CR          NONE',
      'SN99',
      'CHAMBER',
      'COMPANY LTD.',
      '2017/09/12',
    ]);
    expect(a.frequencies.map((x) => x.frequency)).toEqual(['G01', 'E01']);
    const g = a.frequencies[0]!;
    expect([g.pcoN, g.pcoE, g.pcoU]).toEqual([0.72, 0.64, 96.56]);
    expect(a.dazi).toBe(180);
    expect(g.pcv[0]![2]).toBeNaN();
    expect(g.pcv[1]).toEqual([0.9, 0.8, 1.0]);
    // Azimuth mean over 0° and 180° (360° repeats 0°), skipping the blank.
    expect(g.pcvNoazi[0]).toBeCloseTo(0.8, 9);
    expect(g.pcvNoazi[2]).toBeCloseTo(1.0, 9);
    expect(g.pcvNoaziDerived).toBe(true);
    const code = a.codeCalibrations![0]!;
    expect(code.kind).toBe('CODE');
    expect(code.dazi).toBe(0);
    const c = code.frequencies[0]!;
    expect([c.pcoN, c.pcoE, c.pcoU]).toEqual([0.8, -1.9, 137.9]);
    expect(c.pcvNoazi).toEqual([6.6, 6.4, 17.7]);
    const gain = a.gainCalibrations![0]!.frequencies[0]!;
    expect(gain.gainOffsetDb).toBe(0);
    expect(gain.pcvNoazi).toEqual([8.97, 3.0, -8.85]);
    // A blank PCV counts as 0 in the PPP model, not NaN.
    const m = buildPppAntenna(f).rcvOffset(
      'PEC2CR          NONE',
      'G01',
      'E01',
      1575.42e6,
      1575.42e6 * 0.9
    );
    expect(m!.pcvAzi!.flat().every(Number.isFinite)).toBe(true);
  });
});
