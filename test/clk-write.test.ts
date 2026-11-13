import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { join } from 'path';
import { clkBias, fortranE, parseClk, parseSp3, writeClk } from '../src/rinex';

const DIR = join(__dirname, '../test-fixtures');
const fx = (f: string) => readFileSync(join(DIR, f), 'utf8');
const gz = (f: string) => gunzipSync(readFileSync(join(DIR, f))).toString();
/** Trailing blanks are not significant (ESA pads every line to 80, GFZ
 *  and the spec examples don't). */
const lines = (t: string) =>
  t
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => l.trimEnd());

// rinex_clock304.txt Tables A17 (two analysis examples) and A18
// (calibration/discontinuity), verbatim.
const A17_1 = fx('clk304_example_a17_1.clk');
const A17_2 = fx('clk304_example_a17_2.clk');
const A18 = fx('clk304_example_a18.clk');

describe('writeClk: RINEX CLOCK 3.04 spec examples', () => {
  it('A17 (IGS combined example) writes back bar the value separator', () => {
    const c = parseClk(A17_2, { records: true });
    // Table A16 puts 2X between bias and sigma (as the first example and
    // A18 do); the IGS combination output quoted here uses 1X.
    const want = lines(A17_2).map((l) =>
      /^A[RS] /.test(l) ? l.slice(0, 64) + ' ' + l.slice(64) : l
    );
    expect(lines(writeClk(c))).toEqual(want);
  });

  it('A17 (first example) writes back bar documented differences', () => {
    const c = parseClk(A17_1, { records: true });
    const want = lines(A17_1);
    // The example zero-fills month/day in the # OF CLK REF epochs (I4,4I3
    // in the table): we write I3.
    want[12] = want[12]!
      .replace('1994 07 14', '1994  7 14')
      .replace('1994 07 14', '1994  7 14');
    want[14] = want[14]!
      .replace('1994 07 14', '1994  7 14')
      .replace('1994 07 14', '1994  7 14');
    // "-.123456789012E+00": we write Fortran's optional leading zero.
    want[13] = want[13]!.replace(' -.123', '-0.123');
    // The example declares 4 stations but lists 5; we count the list.
    want[16] = want[16]!.replace('     4', '     5');
    expect(lines(writeClk(c))).toEqual(want);
  });

  it('A18 (CR/DR) writes back bar the station name column', () => {
    const c = parseClk(A18, { records: true });
    const want = lines(A18);
    // "USNO 40451S003": A4,1X — the 3.04 table says A4,6X (or A9,1X).
    want[6] = 'USNO      40451S003'.padEnd(65) + 'STATION NAME / NUM';
    expect(lines(writeClk(c))).toEqual(want);
    expect([c.stationName, c.stationId]).toEqual(['USNO', '40451S003']);
    expect(c.stationClkRef).toBe(
      'UTC(USNO) MASTER CLOCK VIA CONTINUOUS CABLE MONITOR'
    );
  });

  it('spec oracle: record values, continuation lines, epochs', () => {
    const c = parseClk(A17_1, { records: true });
    const areq = c.records![0]!;
    expect([areq.type, areq.name]).toEqual(['AR', 'AREQ00USA']);
    expect(areq.t).toBe(Date.UTC(1994, 6, 14, 20, 59, 0));
    // bias, sigma (s); rate, rate sigma; acceleration, sigma — 6 values,
    // the last 4 on the "3X,4(E19.12,2X)" continuation line
    expect(areq.values).toEqual([
      -0.123456789012, -1.23456789012, -12.3456789012, -123.456789012,
      -1234.56789012, -12345.6789012,
    ]);
    expect(c.records!.map((r) => r.values.length)).toEqual([6, 2, 4, 2, 6]);
    // clock − reference, seconds: G16 is negative
    expect(c.sats['G16']!.c).toEqual([-0.123456789012]);
    expect(c.clkRefs).toEqual([
      {
        start: Date.UTC(1994, 6, 14),
        stop: Date.UTC(1994, 6, 14, 20, 59),
        refs: [{ name: 'USNO', id: '40451S003', constraint: -0.123456789012 }],
      },
      {
        start: Date.UTC(1994, 6, 14, 21),
        stop: Date.UTC(1994, 6, 14, 21, 59),
        refs: [{ name: 'TIDB', id: '50103M108', constraint: -0.123456789012 }],
      },
    ]);
    expect(c.analysisCenter).toEqual({
      id: 'USN',
      name: 'USNO USING GIPSY/OASIS-II',
    });
    expect(c.obsTypes).toEqual([
      { sys: 'G', types: ['C1W', 'L1W', 'C2W', 'L2W'] },
    ]);
    expect(c.dcbsApplied).toEqual([
      {
        sys: 'G',
        program: 'CC2NONCC',
        source: 'p1c1bias.hist @ goby.nrl.navy.mil',
      },
    ]);
    const dr = parseClk(A18, { records: true }).records![2]!;
    expect(dr.type).toBe('DR');
    expect(dr.t).toBe(Date.UTC(1995, 6, 14, 22, 23, 14, 500));
  });

  it('convention lock: header XYZ in millimetres, X/Y/Z in order', () => {
    const c = parseClk(A17_2);
    const brux = c.stations!.find((s) => s.name === 'BRUX')!;
    // BRUX 13101M010 = (4027881.412, 306998.697, 4919498.989) m
    expect([brux.xMm, brux.yMm, brux.zMm]).toEqual([
      4027881412, 306998697, 4919498989,
    ]);
    const r = Math.hypot(brux.xMm, brux.yMm, brux.zMm) / 1000;
    expect(r).toBeGreaterThan(6.36e6); // metres after ÷1000: on the Earth
    expect(r).toBeLessThan(6.37e6);
    expect(c.stations!.map((s) => s.name)).toContain('DGAR00GBR');
    expect(c.numStations).toBe(22);
    expect(c.trf).toBe('IGS14 : IGS REALIZATION of THE ITRF2014');
  });

  it('convention lock: 3.04 leap seconds are TAI−UTC, GNSS ones GPS−UTC', () => {
    const c = parseClk(A17_2);
    expect([c.leapSeconds, c.leapSecondsGnss]).toEqual([37, 18]);
    expect(c.timeSystem).toBe('GPS');
    expect(c.version).toBe(3.04);
  });

  it('convention lock: bias and sigma in seconds, not µs/ns', () => {
    const c = parseClk(A17_2, { records: true });
    const g02 = c.records!.find((r) => r.name === 'G02')!;
    expect(g02.values).toEqual([0.868606546478e-4, 0.104109157753e-10]);
    expect(clkBias(c, 'G02', Date.UTC(2017, 2, 11))).toBe(0.868606546478e-4);
  });

  it('pre-3.04 layout refuses 9-character names', () => {
    const c = parseClk(A17_2, { records: true });
    expect(() => writeClk(c, { version: 3.0 })).toThrow(/4-character/);
  });

  it('fortranE: E19.12 with the leading "0."', () => {
    expect(fortranE(0.000164996585578)).toBe(' 0.164996585578E-03');
    expect(fortranE(-1.23456789012e-11)).toBe('-0.123456789012E-10');
    expect(fortranE(0)).toBe(' 0.000000000000E+00');
    expect(fortranE(1)).toBe(' 0.100000000000E+01');
    expect(fortranE(0.9999999999999)).toBe(' 0.100000000000E+01');
    expect(fortranE(-12345.6789012)).toBe('-0.123456789012E+05');
  });
});

for (const [name, quirks] of [
  [
    'ESA_MGEX_gec.clk.gz',
    {
      // ESA's 21-character program name overflows the A17 field and the
      // source starts at col 29; we write it after two blanks (so the
      // program/source split survives a re-read).
      4: 'G Napeos 4.9 26/06/2023  IGS20_2290',
      5: 'R Napeos 4.9 26/06/2023  IGS20_2290',
      6: 'E Napeos 4.9 26/06/2023  GSAT_2187',
      7: 'C Napeos 4.9 26/06/2023  ESA14_2018',
      8: 'J Napeos 4.9 26/06/2023  IGS14_2194',
    },
  ],
  ['GBM_RAP_ge.clk.gz', {}],
] as const) {
  // full-day files: generous timeout for a loaded machine
  describe.skipIf(!existsSync(join(DIR, name)))(
    `writeClk: ${name}`,
    { timeout: 60_000 },
    () => {
      const text = existsSync(join(DIR, name)) ? gz(name) : '';
      const clk = parseClk(text, { records: true });
      const out = writeClk(clk);

      it('write(parse(x)) is line-identical (bar documented quirks)', () => {
        const want = lines(text);
        for (const [n, c] of Object.entries(quirks))
          want[+n - 1] = (c as string).padEnd(60) + 'SYS / PCVS APPLIED';
        expect(lines(out)).toEqual(want);
      });

      it('parse(write(parse(x))) deep-equals parse(x)', () => {
        expect(parseClk(out, { records: true })).toEqual(clk);
      });

      it('the lean parse (AS only) writes the same file', () => {
        expect(writeClk(parseClk(text))).toBe(out);
      });

      it('converts to 3.04 and back without changing a value', () => {
        const v304 = writeClk(clk, { version: 3.04 });
        expect(v304.startsWith('3.04                 C')).toBe(true);
        const back = parseClk(v304, { records: true });
        expect(back.records).toEqual(clk.records);
        expect(back.stations).toEqual(clk.stations);
        expect(back.prns).toEqual(clk.prns);
        expect(writeClk(back, { version: clk.version })).toBe(out);
      });
    }
  );
}

// Same analysis centre, same epoch, two formats: the CLK bias (s) and the
// SP3 clock (µs) must agree — pins both units against each other.
describe.skipIf(
  !existsSync(join(DIR, 'ESA_MGEX_gec.clk.gz')) ||
    !existsSync(join(DIR, 'ESA_MGEX.sp3'))
)('CLK seconds vs SP3 microseconds (ESA final 2024-01-01)', () => {
  it('G01 at 00:00: 0.164996585578E-03 s = 164.996586 µs', () => {
    const clk = parseClk(gz('ESA_MGEX_gec.clk.gz'));
    const sp3 = parseSp3(fx('ESA_MGEX.sp3'));
    const t = Date.UTC(2024, 0, 1);
    expect(clkBias(clk, 'G01', t)).toBe(0.164996585578e-3);
    expect(sp3.satellites['G01']![0]!.clk).toBeCloseTo(164.996586e-6, 12);
    expect(
      Math.abs(clkBias(clk, 'G01', t)! - sp3.satellites['G01']![0]!.clk!)
    ).toBeLessThan(1e-12);
  });
});
