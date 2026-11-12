import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseAntex,
  parseSatellitePrns,
  antexWithPrns,
  writeAntex14,
  writeAntex20,
  type AntexFile,
} from '../src/antex';

// The IGS excerpts of antex20.test.ts: JAVRINGANT_G5T NONE, 3S-02-TSADM
// NONE and GPS SVN G074 in ANTEX 1.4 and 2.0 (release 2026:312).
const fx = (f: string) =>
  readFileSync(join(__dirname, '../test-fixtures', f), 'utf8');
const t14 = fx('antex14_slice.atx');
const t20 = fx('antex20_slice.atx2');
const prns = parseSatellitePrns(fx('sat_metadata_prn_slice.snx'));

/** Data lines, comments dropped (the parser doesn't keep record comments). */
const lines = (t: string) =>
  t
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l !== '' && !l.endsWith('COMMENT'));

/** Every antenna/band's offsets and patterns, keyed for comparison. */
function data(f: AntexFile, noazi = true) {
  const out: Record<string, unknown> = {};
  for (const a of f.antennas)
    for (const b of a.frequencies)
      out[
        `${a.isSatellite ? a.serialNo : a.type} ${a.validFrom} ${b.frequency}`
      ] = {
        pco: [b.pcoN, b.pcoE, b.pcoU],
        grid: [a.dazi, a.zen1, a.zen2, a.dzen],
        pcv: b.pcv,
        ...(noazi ? { noazi: b.pcvNoazi } : {}),
      };
  return out;
}

describe('ANTEX writers', () => {
  it('writes a parsed 1.4 file back line for line', () => {
    expect(lines(writeAntex14(parseAntex(t14)))).toEqual(lines(t14));
  });

  it('writes a parsed 2.0 file back line for line', () => {
    expect(lines(writeAntex20(parseAntex(t20)))).toEqual(lines(t20));
  });

  it('converts 1.4 → 2.0 without changing offsets or patterns', () => {
    const v14 = parseAntex(t14);
    const out = writeAntex20(v14, { release: '2026312' });
    expect(out.startsWith('     2.0')).toBe(true);
    const back = antexWithPrns(parseAntex(out), prns);
    // 2.0 has no NOAZI row for azimuth-dependent patterns.
    expect(data(back, false)).toEqual(data(v14, false));
    // Receiver PCO written East first (x), North second (y).
    const jav = out.split('\n');
    const i = jav.findIndex((l) => l.startsWith('JAVRINGANT_G5T  NONE'));
    const xyz = jav.slice(i).find((l) => l.includes('X / Y / Z'))!;
    expect(xyz.substring(0, 30)).toBe('      2.27      0.78     48.07');
    // The 1.4 date "09-JUN-19" in 2.0's form.
    expect(jav[i + 3]).toContain('2019/06/09');
  });

  it('converts 2.0 → 1.4 without changing offsets or patterns', () => {
    const v20 = antexWithPrns(parseAntex(t20), prns);
    const out = writeAntex14(v20);
    const back = parseAntex(out);
    expect(back.version).toBe(1.4);
    expect(data(back, false)).toEqual(data(v20, false));
    // 2.0's NOAZI (the azimuth mean) is written to 0.01 mm.
    v20.antennas.forEach((a, i) =>
      a.frequencies.forEach((f, j) =>
        f.pcvNoazi.forEach((v, k) =>
          expect(
            Math.abs(v - back.antennas[i]!.frequencies[j]!.pcvNoazi[k]!)
          ).toBeLessThanOrEqual(0.005 + 1e-9)
        )
      )
    );
    expect(out).toContain('      0.78      2.27     48.07');
    // 2.0's "2019/06/09" in 1.4's IGS form.
    expect(out).toContain('09-JUN-19');
  });

  it('agrees with the other version of the IGS file after converting', () => {
    const v14 = parseAntex(t14);
    const v20 = antexWithPrns(parseAntex(t20), prns);
    const from20 = parseAntex(writeAntex14(v20));
    const from14 = antexWithPrns(parseAntex(writeAntex20(v14)), prns);
    const d14 = data(v14, false);
    const d20 = data(v20, false);
    // Bands both files have (2.0 adds a few, 1.4 has GLONASS CDMA ones).
    for (const [k, v] of Object.entries(data(from20, false)))
      if (k in d14) expect(v).toEqual(d14[k]);
    for (const [k, v] of Object.entries(data(from14, false)))
      if (k in d20) expect(v).toEqual(d20[k]);
  });

  it('1.4 → 2.0 → 1.4 gives the 1.4 file back', () => {
    const v14 = parseAntex(t14);
    const back = writeAntex14(
      antexWithPrns(parseAntex(writeAntex20(v14, { prns })), prns)
    );
    // SINEX CODE and COSPAR ID have no place in 2.0, nor the NOAZI row of
    // an azimuth-dependent pattern (one followed by azimuth rows); the
    // NOAZI-only pattern of 3S-02-TSADM must come back.
    const strip = (t: string) =>
      lines(t)
        .filter(
          (l, k, all) =>
            !l.endsWith('SINEX CODE') &&
            !(l.startsWith('   NOAZI') && all[k + 1]?.startsWith('     0.0'))
        )
        .map((l) =>
          l.endsWith('TYPE / SERIAL NO') ? l.substring(0, 50).trimEnd() : l
        );
    expect(strip(back)).toEqual(strip(t14));
  });

  it('2.0 → 1.4 → 2.0 gives the 2.0 file back', () => {
    const v20 = parseAntex(t20);
    const back = writeAntex20(
      parseAntex(writeAntex14(antexWithPrns(v20, prns))),
      { prns, release: v20.release, referenceFrame: v20.referenceFrame }
    );
    expect(lines(back)).toEqual(lines(t20));
  });

  it('keeps missing values blank in 2.0 and writes 0 in 1.4', () => {
    const l = (c: string, label: string) => c.padEnd(60) + label;
    const src = [
      l('     2.0', 'ANTEX VERSION'),
      l('', 'START OF HEADER'),
      l('RECEIVER', 'ANTENNA TYPES'),
      l('2026100', 'RELEASE'),
      l('', 'END OF HEADER'),
      l('', 'START OF ANTENNA'),
      l('TEST            NONE', 'TYPE / SN'),
      l('', 'START OF CALIB'),
      l('PHASE          1', 'TYPE / # OF FREQS'),
      l('ROBOT               ME', 'METH / BY / # / DATE'),
      l('   360.0', 'DAZI'),
      l('     0.0  90.0  45.0', 'ZEN1 / ZEN2 / DZEN'),
      l('   G01', 'START OF PHASE'),
      l('      1.00      2.00     50.00', 'X / Y / Z'),
      '     0.0    0.10            0.30',
      '   360.0    0.10            0.30',
      l('', 'END OF PHASE'),
      l('', 'END OF CALIB'),
      l('', 'END OF ANTENNA'),
    ].join('\n');
    const f = parseAntex(src);
    expect(lines(writeAntex20(f))).toEqual(lines(src));
    const v14 = writeAntex14(f);
    expect(v14).toContain('   NOAZI    0.10    0.00    0.30');
    expect(v14).toContain('      2.00      1.00     50.00');
  });
});
