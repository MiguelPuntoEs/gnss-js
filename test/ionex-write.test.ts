import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseIonex, writeIonex, type IonexGrid } from '../src/rinex';
import { gimVerticalTec } from '../src/positioning/gim';

const DIR = join(__dirname, '../test-fixtures');
const T0 = Date.UTC(2024, 0, 1, 0, 0, 0);

/**
 * Asymmetric 3 × 3 grid, two hourly maps: every cell distinct, so a
 * swapped axis, a flipped latitude/longitude order or a wrong unit shows.
 * Row i = latitude lats[i], column j = longitude lons[j].
 */
function grid(lats: number[]): IonexGrid {
  const lons = [-5, 0, 5];
  const cells = [12.3, 45.6, 78.9, 100, 200, 300, 1, 2, NaN];
  const m = (k: number) => Float32Array.from(cells, (v) => v + k);
  return { epochs: [T0, T0 + 3600_000], lats, lons, maps: [m(0), m(10)] };
}

describe('writeIonex: convention locks', () => {
  const g = grid([2.5, 0, -2.5]);
  const text = writeIonex(g);
  const out = text.split('\n');
  const rows = (k: number) =>
    out
      .filter((l) => l.endsWith('LAT/LON1/LON2/DLON/H'))
      .slice(k * 3, k * 3 + 3);

  it('rows north → south as given, longitudes west → east', () => {
    expect(rows(0).map((l) => l.slice(2, 8))).toEqual([
      '   2.5',
      '   0.0',
      '  -2.5',
    ]);
    // 2X,5F6.1: LAT, LON1, LON2, DLON, H
    expect(rows(0)[0]!.slice(0, 32)).toBe('     2.5  -5.0   5.0   5.0 450.0');
    const first = out.indexOf(rows(0)[0]!);
    // mI5 in 0.1 TECU (EXPONENT −1): 12.3 TECU → 123; 9999 = no value
    expect(out[first + 1]!.trimEnd()).toBe('  123  456  789');
    expect(out[first + 5]!.trimEnd()).toBe('   10   20 9999');
  });

  it('header: grid definitions, exponent, epochs in UT', () => {
    const hdr = (label: string) =>
      out
        .find((l) => l.slice(60).trim() === label)!
        .slice(0, 60)
        .trimEnd();
    expect(hdr('LAT1 / LAT2 / DLAT')).toBe('     2.5  -2.5  -2.5');
    expect(hdr('LON1 / LON2 / DLON')).toBe('    -5.0   5.0   5.0');
    expect(hdr('EXPONENT')).toBe('    -1');
    expect(hdr('EPOCH OF FIRST MAP')).toBe(
      '  2024     1     1     0     0     0'
    );
    expect(hdr('EPOCH OF LAST MAP')).toBe(
      '  2024     1     1     1     0     0'
    );
    expect(hdr('INTERVAL')).toBe('  3600');
    expect(hdr('# OF MAPS IN FILE')).toBe('     2');
  });

  it('a different exponent changes the integers, not the TEC', () => {
    const t2 = writeIonex({ ...g, exponent: -2 });
    expect(t2).toContain('\n 1230 4560 7890');
    const back = parseIonex(t2);
    expect(back.maps[0]![0]).toBeCloseTo(12.3, 5);
  });

  it('parse(write(g)) returns the same grid', () => {
    const back = parseIonex(text);
    expect(back.lats).toEqual(g.lats);
    expect(back.lons).toEqual(g.lons);
    expect(back.epochs).toEqual(g.epochs);
    expect(back.maps.map((m) => Array.from(m))).toEqual(
      g.maps.map((m) => Array.from(m))
    );
    expect(writeIonex(back)).toBe(text);
  });

  for (const [order, lats] of [
    ['north → south', [2.5, 0, -2.5]],
    ['south → north', [-2.5, 0, 2.5]],
  ] as const) {
    it(`gimVerticalTec reads the written corners (${order} rows)`, () => {
      const src = grid([...lats]);
      const back = parseIonex(writeIonex(src));
      const at = (lat: number, lon: number) =>
        gimVerticalTec(back, T0, lat, lon);
      // first row = lats[0], first column = westernmost longitude
      expect(at(lats[0], -5)).toBeCloseTo(12.3, 4);
      expect(at(lats[0], 5)).toBeCloseTo(78.9, 4);
      expect(at(lats[2], -5)).toBeCloseTo(1, 4);
      expect(at(0, -5)).toBeCloseTo(100, 4);
    });
  }

  it('Appendix B example: blank system = GPS, biases + comments kept', () => {
    // Appendix B Table 2 (PRN / BIAS / RMS: 3X,A1,I2.2,2F10.3)
    const L = (c: string, l: string) => c.padEnd(60) + l;
    const aux = [
      L('DIFFERENTIAL CODE BIASES', 'START OF AUX DATA'),
      L('    01     0.000     0.000', 'PRN / BIAS / RMS'),
      L('    31    -1.250     0.125', 'PRN / BIAS / RMS'),
      L('l1-l2 biases and rms in ns', 'COMMENT'),
      L('sum of biases constrained to zero', 'COMMENT'),
      L('DIFFERENTIAL CODE BIASES', 'END OF AUX DATA'),
    ];
    const t = text.replace(
      /^.*END OF HEADER/m,
      (m) => aux.join('\n') + '\n' + m
    );
    const back = parseIonex(t);
    expect(back.aux!.sats).toEqual([
      { prn: 'G01', biasNs: 0, rmsNs: 0 },
      { prn: 'G31', biasNs: -1.25, rmsNs: 0.125 },
    ]);
    expect(back.aux!.comments).toEqual([
      'l1-l2 biases and rms in ns',
      'sum of biases constrained to zero',
    ]);
    // written with the system letter
    expect(writeIonex(back)).toContain(
      L('   G31    -1.250     0.125', 'PRN / BIAS / RMS')
    );
  });

  it('refuses 3-D maps', () => {
    expect(() => writeIonex({ ...g, mapDimension: 3 })).toThrow(/2-D/);
  });
});

for (const file of ['ESA_GIM.inx', 'ESA_GIM_2024001.inx']) {
  describe.skipIf(!existsSync(join(DIR, file)))(
    `writeIonex: ${file}`,
    { timeout: 60_000 },
    () => {
      const text = existsSync(join(DIR, file))
        ? readFileSync(join(DIR, file), 'utf8')
        : '';
      const g = parseIonex(text);
      const out = writeIonex(g);

      it('write(parse(x)) is byte-identical', () => {
        expect(out).toBe(text);
      });

      it('parse(write(parse(x))) deep-equals parse(x)', () => {
        expect(parseIonex(out)).toEqual(g);
      });

      it('keeps the header, RMS maps and the DCB block', () => {
        expect(g.version).toBe(1.0);
        expect(g.system).toBe('GPS');
        expect(g.mappingFunction).toBe('NONE');
        expect(g.baseRadius).toBe(6371.0);
        expect(g.hgt).toEqual({ from: 450, to: 450, step: 0 });
        expect(g.latDef).toEqual({ from: 87.5, to: -87.5, step: -2.5 });
        expect(g.lonDef).toEqual({ from: -180, to: 180, step: 5 });
        expect(g.exponent).toBe(-1);
        expect(g.rmsMaps).toHaveLength(g.maps.length);
        expect(g.aux!.name).toBe('DIFFERENTIAL CODE BIASES');
        expect(g.aux!.stationsFirst).toBe(true);
      });

      it('DCB oracle: satellite biases (ns) are zero-mean per system', () => {
        // the block's own comment: "zero-mean condition wrt satellite
        // values" — holds for G (and E/C when present) to the printed
        // 0.001 ns; not for GLONASS
        for (const sys of ['G', 'E', 'C']) {
          const b = g.aux!.sats.filter((s) => s.prn[0] === sys);
          if (sys !== 'G' && !b.length) continue;
          const sum = b.reduce((a, s) => a + s.biasNs, 0);
          expect(b.length).toBeGreaterThan(20);
          expect(Math.abs(sum)).toBeLessThanOrEqual(0.0005 * b.length + 1e-9);
        }
      });
    }
  );
}

describe.skipIf(!existsSync(join(DIR, 'ESA_GIM.inx')))(
  'IONEX spec oracle (ESA rapid GIM 2026-07-20)',
  () => {
    const g = existsSync(join(DIR, 'ESA_GIM.inx'))
      ? parseIonex(readFileSync(join(DIR, 'ESA_GIM.inx'), 'utf8'))
      : (null as unknown as IonexGrid);

    it('first map, first row (87.5° N) from −180° eastward, 0.1 TECU', () => {
      // "    87.5-180.0 180.0   5.0 450.0  LAT/LON1/LON2/DLON/H"
      // "  157  158  159  159  160 ..."
      expect(g.epochs[0]).toBe(Date.UTC(2026, 6, 20, 0, 0, 0));
      expect(g.lats[0]).toBe(87.5);
      expect(g.lons[0]).toBe(-180);
      expect(g.lons[1]).toBe(-175);
      expect(Array.from(g.maps[0]!.slice(0, 5))).toEqual(
        [15.7, 15.8, 15.9, 15.9, 16.0].map(Math.fround)
      );
      // its RMS map: "    3    3    3    2 ..."
      expect(g.rmsMaps![0]![0]).toBeCloseTo(0.3, 6);
    });

    it('DCB records: PRN and station biases in ns', () => {
      // "   G01     2.297     0.017"  PRN / BIAS / RMS
      expect(g.aux!.sats[0]).toEqual({
        prn: 'G01',
        biasNs: 2.297,
        rmsNs: 0.017,
      });
      // " G    ABPO 33302M001          -1.599     0.024"  STATION / BIAS / RMS
      expect(g.aux!.stations[0]).toEqual({
        sys: 'G',
        name: 'ABPO',
        id: '33302M001',
        biasNs: -1.599,
        rmsNs: 0.024,
      });
      // GLONASS FDMA: per-satellite receiver biases ("R02  ABPO ...")
      expect(g.aux!.stations.find((s) => s.sys === 'R02')!.name).toBe('ABPO');
    });
  }
);
