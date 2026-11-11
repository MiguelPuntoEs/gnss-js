import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRinexHeaderText } from '../src/rinex/parser';

describe('parseRinexHeaderText', () => {
  it('reads the occupation from a Hatanaka header alone', () => {
    const text = readFileSync(
      join(__dirname, '../test-fixtures/ABMF.crx'),
      'utf8'
    ).slice(0, 8000);
    const h = parseRinexHeaderText(text)!;
    expect(h.isCrx).toBe(true);
    expect(h.markerName).toBe('ABMF');
    expect(h.antType).toMatch(/^TRM57971\.00 +NONE$/);
    expect(h.antDelta![0]).toBeCloseTo(0, 4);
    expect(h.timeOfFirstObs!.toISOString().slice(0, 10)).toBe('2024-01-01');
  });

  it('is null without a complete header', () => {
    expect(parseRinexHeaderText('     3.04  OBSERVATION DATA')).toBeNull();
  });

  // RINEX header records: content in columns 1–60, label from column 61.
  const header = (version: string, bds: string) =>
    [
      `${version.padStart(9)}           OBSERVATION DATA    M`.padEnd(60) +
        'RINEX VERSION / TYPE',
      `C ${String(bds.split(' ').length).padStart(4)} ${bds}`.padEnd(60) +
        'SYS / # / OBS TYPES',
      ''.padEnd(60) + 'END OF HEADER',
    ].join('\n');

  it('renames BeiDou B1I from band 1 to band 2 in RINEX 3.00–3.02', () => {
    // GMSD (Trimble NetR9) and HKSL (Leica GR50) write 3.02 with C1I/L1I.
    const h302 = parseRinexHeaderText(
      header('3.02', 'C1I L1I D1I S1I C7I L7I')
    );
    expect(h302!.obsTypes['C']).toEqual([
      'C2I',
      'L2I',
      'D2I',
      'S2I',
      'C7I',
      'L7I',
    ]);
    // From 3.03 band 1 is B1C: left alone.
    const h304 = parseRinexHeaderText(header('3.04', 'C1P L1P C2I L2I'));
    expect(h304!.obsTypes['C']).toEqual(['C1P', 'L1P', 'C2I', 'L2I']);
    // A 3.02 file already using band 2 keeps its codes (no duplicates).
    const mixed = parseRinexHeaderText(header('3.02', 'C1I L1I C2I L2I'));
    expect(mixed!.obsTypes['C']).toEqual(['C1I', 'L1I', 'C2I', 'L2I']);
  });
});
