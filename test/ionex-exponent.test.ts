import { describe, it, expect } from 'vitest';
import { parseIonex } from '../src/rinex/ionex';

// IONEX 1.0, Appendix A Table 1: EXPONENT is "Exponent defining the unit of
// the values listed in the following data block(s)" and Table 4 (example 2)
// repeats it inside a TEC map. A map-level EXPONENT must override the header
// one for the rows that follow it.
const L = (c: string, label: string) => c.padEnd(60) + label;
const ionex = (inMap: string | null) =>
  [
    L('     1.0            IONOSPHERE MAPS     GPS', 'IONEX VERSION / TYPE'),
    L('     2', 'MAP DIMENSION'),
    L('   450.0 450.0   0.0', 'HGT1 / HGT2 / DHGT'),
    L('     2.5  -2.5  -2.5', 'LAT1 / LAT2 / DLAT'),
    L('    -5.0   5.0   5.0', 'LON1 / LON2 / DLON'),
    L('    -1', 'EXPONENT'),
    L('', 'END OF HEADER'),
    L('     1', 'START OF TEC MAP'),
    L('  2024     1     1     0     0     0', 'EPOCH OF CURRENT MAP'),
    ...(inMap ? [L(inMap, 'EXPONENT')] : []),
    L('     2.5  -5.0   5.0   5.0 450.0', 'LAT/LON1/LON2/DLON/H'),
    '  123  456  789',
    L('     0.0  -5.0   5.0   5.0 450.0', 'LAT/LON1/LON2/DLON/H'),
    ' 1000 2000 9999',
    L('    -2.5  -5.0   5.0   5.0 450.0', 'LAT/LON1/LON2/DLON/H'),
    '   10   20   30',
    L('     1', 'END OF TEC MAP'),
    L('', 'END OF FILE'),
  ].join('\n');

describe('IONEX EXPONENT inside a map', () => {
  it('header exponent −1: values are 0.1 TECU', () => {
    const g = parseIonex(ionex(null));
    expect(Array.from(g.maps[0]!.slice(0, 3))).toEqual([
      Math.fround(12.3),
      Math.fround(45.6),
      Math.fround(78.9),
    ]);
  });

  it('a map-level EXPONENT −2 makes them 0.01 TECU', () => {
    const g = parseIonex(ionex('    -2'));
    expect(g.maps[0]![0]).toBeCloseTo(1.23, 5);
    expect(g.maps[0]![4]).toBeCloseTo(20, 5);
    expect(g.maps[0]![5]).toBeNaN(); // 9999 stays "no value"
    expect(g.maps[0]![8]).toBeCloseTo(0.3, 5);
  });
});
