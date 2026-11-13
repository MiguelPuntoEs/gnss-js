import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { join } from 'path';
import { parseSp3, sp3Position, writeSp3, type Sp3File } from '../src/rinex';

const DIR = join(__dirname, '../test-fixtures');
const gz = (f: string) => gunzipSync(readFileSync(join(DIR, f))).toString();

/**
 * SP3-d Example 2 (sp3d.pdf p. 3: "A GPS-only SP3-d file with all record
 * types (P, EP, V, EV)"), cut to G01/G02 and its first and last epoch.
 * Record lines are laid out by the column tables of the same document
 * (the PDF's rendering is not column-exact); the epoch count and the
 * satellite list are the excerpt's own (2 epochs, 2 satellites).
 */
const EXAMPLE2 = [
  '#dV2001  8  8  0  0  0.00000000       2 ORBIT IGS97 HLM MGEX',
  '## 1126 259200.00000000   900.00000000 52129 0.0000000000000',
  '+    2   G01G02  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0',
  '+          0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0',
  '+          0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0',
  '+          0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0',
  '+          0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0',
  '++         7  8  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0',
  '++         0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0',
  '++         0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0',
  '++         0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0',
  '++         0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0  0',
  '%c G  cc GPS ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc',
  '%c cc cc ccc ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc',
  '%f  1.2500000  1.025000000  0.00000000000  0.000000000000000',
  '%f  0.0000000  0.000000000  0.00000000000  0.000000000000000',
  '%i    0    0    0    0      0      0      0      0         0',
  '%i    0    0    0    0      0      0      0      0         0',
  '/* AN EXAMPLE ULTRA RAPID ORBIT, GPS ONLY.',
  '/* NOTE THE "PREDICTED DATA" FLAGS FOR THE LAST EPOCH (IN COLUMNS 76 and 80).',
  '/* CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
  '/* CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
  '*  2001  8  8  0  0  0.00000000',
  'PG01 -11044.805800 -10475.672350  21929.418200    189.163300 18 18 18 219',
  'EP    55   55   55     222  1234567 -1234567  5999999      -30       21 -1230000',
  'VG01  20298.880364 -18462.044804   1381.387685     -4.534317 14 14 14 191',
  'EV    22   22   22     111  1234567  1234567  1234567  1234567  1234567  1234567',
  'PG02 -12593.593500  10170.327650 -20354.534400    -55.976000 18 18 18 219     M',
  'EP    55   55   55     222  1234567 -1234567  5999999      -30       21 -1230000',
  'VG02  -9481.923808 -25832.652567  -7277.160056      8.801258 14 14 14 191',
  'EV    22   22   22     111  1234567  1234567  1234567  1234567  1234567  1234567',
  '*  2001  8  9 23 45  0.00000000',
  'PG01 -11044.805800 -10475.672350  21929.418200    189.163300 18 18 18 219  P   P',
  'EP    55   55   55     222  1234567 -1234567  5999999      -30       21 -1230000',
  'VG01  20298.880364 -18462.044804   1381.387685     -4.534317 14 14 14 191',
  'EV    22   22   22     111  1234567  1234567  1234567  1234567  1234567  1234567',
  'PG02 -12593.593500  10170.327650 -20354.534400    -55.976000 18 18 18 219  P   P',
  'EP    55   55   55     222  1234567 -1234567  5999999      -30       21 -1230000',
  'VG02  -9481.923808 -25832.652567  -7277.160056      8.801258 14 14 14 191',
  'EV    22   22   22     111  1234567  1234567  1234567  1234567  1234567  1234567',
  'EOF',
].join('\n');

const trimmed = (t: string) => t.split('\n').map((l) => l.trimEnd());

describe('writeSp3: SP3-d Example 2 (all record types)', () => {
  const sp3 = parseSp3(EXAMPLE2);

  it('writes the example back line for line', () => {
    expect(trimmed(writeSp3(sp3))).toEqual(trimmed(EXAMPLE2 + '\n'));
  });

  it('spec oracle: P record — km → m, µs → s, sdev exponents, flags', () => {
    // cols 5–18 / 19–32 / 33–46 x/y/z (km, F14.6); 47–60 clock (µs)
    const g01 = sp3.satellites['G01']![0]!;
    expect(g01.x).toBeCloseTo(-11044805.8, 4);
    expect(g01.y).toBeCloseTo(-10475672.35, 4);
    expect(g01.z).toBeCloseTo(21929418.2, 4);
    expect(g01.clk).toBeCloseTo(189.1633e-6, 13);
    // cols 62–73: 1.25^18 mm ≈ 56 mm, 1.025^219 ps ≈ 223 ps (spec text)
    expect(g01.sdevExp).toEqual({ x: 18, y: 18, z: 18, clk: 219 });
    expect(sp3.posBase! ** g01.sdevExp!.x!).toBeCloseTo(55.5112, 4);
    expect(sp3.clkBase! ** g01.sdevExp!.clk!).toBeCloseTo(223.1138, 3);
    // col 79 'M' on G02 at the first epoch; cols 76 + 80 'P' at the last
    expect(sp3.satellites['G02']![0]!.maneuver).toBe(true);
    expect(g01.clockPredicted).toBeUndefined();
    const last = sp3.satellites['G01']![1]!;
    expect([last.clockEvent, last.clockPredicted]).toEqual([undefined, true]);
    expect([last.maneuver, last.orbitPredicted]).toEqual([undefined, true]);
  });

  it('spec oracle: V record — dm/s → m/s, 10⁻⁴ µs/s → s/s', () => {
    const v = sp3.satellites['G01']![0]!.vel!;
    expect(v.vx).toBeCloseTo(2029.8880364, 7);
    expect(v.vy).toBeCloseTo(-1846.2044804, 7);
    expect(v.vz).toBeCloseTo(138.1387685, 7);
    expect(v.clkRate).toBeCloseTo(-4.534317e-10, 18);
    expect(v.sdevExp).toEqual({ x: 14, y: 14, z: 14, clk: 191 });
    // a GPS satellite moves at ~3.9 km/s: the dm/s scaling is right
    expect(Math.hypot(v.vx, v.vy, v.vz)).toBeGreaterThan(2500);
    expect(Math.hypot(v.vx, v.vy, v.vz)).toBeLessThan(4500);
  });

  it('spec oracle: EP / EV records (mm, ps, correlation × 10⁷)', () => {
    const s = sp3.satellites['G01']![0]!;
    expect(s.ep).toEqual({
      xSdev: 55,
      ySdev: 55,
      zSdev: 55,
      clkSdev: 222,
      xy: 0.1234567,
      xz: -0.1234567,
      xc: 0.5999999,
      yz: -0.000003,
      yc: 0.0000021,
      zc: -0.123,
    });
    expect(s.vel!.ev!.clkSdev).toBe(111);
  });

  it('header: line 1 descriptors, line 2 derived from the first epoch', () => {
    expect(sp3.pvFlag).toBe('V');
    expect([sp3.dataUsed, sp3.coordSys, sp3.orbitType, sp3.agency]).toEqual([
      'ORBIT',
      'IGS97',
      'HLM',
      'MGEX',
    ]);
    // 2001-08-08 00:00 GPS = week 1126, 259200 s (Wednesday), MJD 52129 —
    // the spec's own numbers; writeSp3 recomputes them from epochs[0].
    expect([sp3.gpsWeek, sp3.sowStart, sp3.mjdStart]).toEqual([
      1126, 259200, 52129,
    ]);
    const l2 = writeSp3(sp3).split('\n')[1]!;
    expect(l2.slice(3, 7)).toBe('1126');
    expect(l2.slice(8, 23).trim()).toBe('259200.00000000');
    expect(l2.slice(39, 44)).toBe('52129');
    expect(sp3.fileType).toBe('G');
    expect(sp3.satIds).toEqual(['G01', 'G02']);
    expect(sp3.accuracy).toEqual([7, 8]);
  });

  it('writes SP3-c: 4 comment lines of ≤ 57 characters', () => {
    const c = writeSp3(sp3, { version: 'c' });
    expect(c.startsWith('#cV2001')).toBe(true);
    const comments = c.split('\n').filter((l) => l.startsWith('/*'));
    expect(comments).toHaveLength(4);
    expect(comments[1]!.trimEnd()).toBe(
      '/* NOTE THE "PREDICTED DATA" FLAGS FOR THE LAST EPOCH (IN CO'
    );
    const back = parseSp3(c);
    expect(back.version).toBe('c');
    expect(back.satellites).toEqual(sp3.satellites);
  });
});

describe('writeSp3: convention locks', () => {
  // asymmetric values: a swapped axis, flipped sign or wrong unit shows
  const sp3: Sp3File = {
    version: 'd',
    epochs: [Date.UTC(2024, 0, 1, 0, 0, 0), Date.UTC(2024, 0, 1, 0, 5, 0)],
    intervalSec: 300,
    timeSystem: 'GPS',
    satellites: {
      E05: [
        { x: 12_345_678.9, y: -23_456_789.012, z: 3_456.5, clk: -1.25e-4 },
        null,
      ],
      G07: [
        {
          x: 1_000_000,
          y: 2_000_000,
          z: 3_000_000,
          clk: 5e-6,
          vel: { vx: 1.5, vy: -2.5, vz: 3.25, clkRate: 2e-10 },
        },
        { x: 1, y: 2, z: 3, clk: null },
      ],
    },
  };
  const out = writeSp3(sp3).split('\n');
  const rec = (prefix: string) => out.filter((l) => l.startsWith(prefix));

  it('P record: x, y, z in km at cols 5–46, clock µs at 47–60', () => {
    const [p] = rec('PE05');
    expect(p!.slice(4, 18)).toBe('  12345.678900');
    expect(p!.slice(18, 32)).toBe(' -23456.789012');
    expect(p!.slice(32, 46)).toBe('      3.456500');
    expect(p!.slice(46, 60)).toBe('   -125.000000');
  });

  it('V record: dm/s and 10⁻⁴ µs/s', () => {
    const [v] = rec('VG07');
    expect(v!.slice(4, 18)).toBe('     15.000000');
    expect(v!.slice(18, 32)).toBe('    -25.000000');
    expect(v!.slice(32, 46)).toBe('     32.500000');
    expect(v!.slice(46, 60)).toBe('      2.000000');
    expect(out[0]!.charAt(2)).toBe('V');
  });

  it('null sample → bad/absent record; bad clock → 999999.999999', () => {
    const [, e05] = rec('PE05');
    expect(e05!.slice(4, 60)).toBe(
      '      0.000000      0.000000      0.000000 999999.999999'
    );
    const [, g07] = rec('PG07');
    expect(g07!.slice(46, 60)).toBe(' 999999.999999');
  });

  it('records follow satIds order; epochs keep the file time scale', () => {
    const back = parseSp3(out.join('\n'));
    expect(back.satIds).toEqual(['E05', 'G07']);
    expect(back.epochs).toEqual(sp3.epochs); // no GPS↔UTC shift
    expect(back.satellites['E05']![1]).toBeNull();
    expect(back.badPositions!['E05']![1]!.clk).toBeNull();
    const e05 = back.satellites['E05']![0]!;
    expect(e05.x).toBeCloseTo(12_345_678.9, 6);
    expect(e05.y).toBeCloseTo(-23_456_789.012, 6);
    expect(e05.z).toBeCloseTo(3_456.5, 6);
    expect(e05.clk).toBeCloseTo(-1.25e-4, 15);
  });

  it('sp3Position returns metres and seconds from what writeSp3 wrote', () => {
    const back = parseSp3(out.join('\n'));
    const p = sp3Position(back, 'E05', sp3.epochs[0]!, 1)!;
    expect(p.x).toBeCloseTo(12_345_678.9, 3);
    expect(p.clk).toBeCloseTo(-1.25e-4, 15);
  });

  it('a bad position with a good clock keeps its clock', () => {
    const bad = 'PE05' + '      0.000000'.repeat(3) + ' 999999.999999';
    const t = out.join('\n').replace(bad, bad.slice(0, 46) + '     12.500000');
    const back = parseSp3(t);
    expect(back.satellites['E05']![1]).toBeNull(); // no position
    expect(back.badPositions!['E05']![1]!.clk).toBeCloseTo(12.5e-6, 15);
    expect(writeSp3(back)).toBe(t);
  });
});

for (const [name, quirks] of [
  ['ESA_MGEX.sp3.gz', {}],
  [
    'GBM_RAP.sp3.gz',
    {
      // GFZ fills the unused satellite-ID slots with " 00" (A1,I2.2 of an
      // empty ID); the spec's examples, and we, write "  0".
      10: '+        R17R18R19R20R21R22R24  0  0  0  0  0  0  0  0  0  0',
      // GFZ pads the EOF line to 40 columns; we pad every line to 80.
      36605: 'EOF',
    },
  ],
] as const) {
  describe.skipIf(!existsSync(join(DIR, name)))(`writeSp3: ${name}`, () => {
    const text = existsSync(join(DIR, name)) ? gz(name) : '';
    const sp3 = parseSp3(text);
    const out = writeSp3(sp3);

    it('write(parse(x)) is line-identical (bar documented quirks)', () => {
      const want = text.split('\n');
      for (const [n, line] of Object.entries(quirks)) {
        want[+n - 1] = (line as string).padEnd(80);
      }
      expect(out.split('\n')).toEqual(want);
    });

    it('parse(write(parse(x))) deep-equals parse(x)', () => {
      expect(parseSp3(out)).toEqual(sp3);
    });
  });
}
