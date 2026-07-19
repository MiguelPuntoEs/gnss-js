import { describe, it, expect } from 'vitest';
import { parseAntex, frequencyLabel } from '../src/antex';

/** Build an 80-column ANTEX line: content padded so the label starts at col 60. */
function l(content: string, label: string): string {
  return content.padEnd(60) + label;
}

const MINIMAL_ANTEX = [
  l('     1.4            G', 'ANTEX VERSION / SYST'),
  l('A', 'PCV TYPE / REFANT'),
  l('Test file', 'COMMENT'),
  l('', 'END OF HEADER'),
  l('', 'START OF ANTENNA'),
  l('LEIAR20         LEIM', 'TYPE / SERIAL NO'),
  l(
    'ROBOT               GEO++ GmbH               0    29-JAN-17',
    'METH / BY / # / DATE'
  ),
  l('     0.0', 'DAZI'),
  l('     0.0  90.0  45.0', 'ZEN1 / ZEN2 / DZEN'),
  l('     1', '# OF FREQUENCIES'),
  l('   G01', 'START OF FREQUENCY'),
  l('      1.20      2.30      3.40', 'NORTH / EAST / UP'),
  '   NOAZI    0.50    0.60    0.70',
  l('   G01', 'END OF FREQUENCY'),
  l('', 'END OF ANTENNA'),
].join('\n');

describe('parseAntex', () => {
  it('parses header fields', () => {
    const f = parseAntex(MINIMAL_ANTEX);
    expect(f.version).toBeCloseTo(1.4, 5);
    expect(f.system).toBe('G');
    expect(f.pcvType).toBe('A');
    expect(f.comments).toContain('Test file');
  });

  it('parses a receiver antenna with one frequency', () => {
    const f = parseAntex(MINIMAL_ANTEX);
    expect(f.antennas).toHaveLength(1);
    const ant = f.antennas[0]!;
    expect(ant.type).toBe('LEIAR20         LEIM');
    expect(ant.isSatellite).toBe(false);
    expect(ant.zen1).toBe(0);
    expect(ant.zen2).toBe(90);
    expect(ant.dzen).toBe(45);
    expect(ant.frequencies).toHaveLength(1);
    const g01 = ant.frequencies[0]!;
    expect(g01.frequency).toBe('G01');
    expect(g01.pcoN).toBeCloseTo(1.2, 5);
    expect(g01.pcoE).toBeCloseTo(2.3, 5);
    expect(g01.pcoU).toBeCloseTo(3.4, 5);
    // zen 0..90 step 45 → 3 NOAZI values
    expect(g01.pcvNoazi).toEqual([0.5, 0.6, 0.7]);
    expect(g01.pcv).toEqual([]); // dazi = 0 → no azimuth grid
  });

  it('returns an empty file for empty input', () => {
    const f = parseAntex('');
    expect(f.antennas).toEqual([]);
  });
});

describe('frequencyLabel', () => {
  it('maps common codes to human labels', () => {
    expect(frequencyLabel('G01')).toMatch(/L1/);
    expect(frequencyLabel('E05')).toMatch(/E5a/i);
  });

  it('falls back to the raw code for unknown inputs', () => {
    expect(frequencyLabel('X99')).toContain('X99');
  });
});
