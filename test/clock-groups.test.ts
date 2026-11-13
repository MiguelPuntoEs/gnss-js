import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAntex, type AntennaEntry } from '../src/antex';
import { clockGroupFromBlocks, satelliteBlocks } from '../src/positioning';

const entry = (
  prn: string,
  type: string,
  validFrom = '2000 01 01 00 00 00.0',
  validUntil = ''
): AntennaEntry =>
  ({
    type,
    serialNo: prn,
    isSatellite: true,
    validFrom,
    validUntil,
  }) as unknown as AntennaEntry;

describe('BeiDou receiver-clock groups', () => {
  const blocks = satelliteBlocks(
    [
      entry('C11', 'BEIDOU-2M'),
      entry('C19', 'BEIDOU-3M-CAST'),
      entry('C25', 'BEIDOU-3M-SECM'),
      // A PRN reassigned: only the window containing the date counts.
      entry('C30', 'BEIDOU-2M', '2000 01 01', '2010 01 01'),
      entry('C30', 'BEIDOU-3M-SECM', '2018 01 01'),
    ],
    Date.UTC(2024, 0, 14)
  );

  it('reads the block valid at the date', () => {
    expect(blocks.get('C30')).toBe('BEIDOU-3M-SECM');
  });

  it('splits BeiDou-2 from BeiDou-3', () => {
    const g = clockGroupFromBlocks(blocks, 'bds2-bds3');
    expect(['C11', 'C19', 'C25', 'G05', 'E11'].map(g)).toEqual([
      'C2',
      'C3',
      'C3',
      'G',
      'E',
    ]);
    // Not in the ANTEX: BeiDou-3 from C19 by PRN.
    expect(g('C60')).toBe('C3');
    expect(g('C14')).toBe('C2');
  });

  it('splits BeiDou-3 by manufacturer', () => {
    const g = clockGroupFromBlocks(blocks, 'bds-maker');
    expect(['C11', 'C19', 'C25', 'C30'].map(g)).toEqual([
      'C2',
      'C3-CAST',
      'C3-SECM',
      'C3-SECM',
    ]);
  });

  const atx = join(__dirname, '..', 'test-fixtures', 'igs20.atx');
  it.skipIf(!existsSync(atx))('igs20: 2024 BeiDou-3 MEOs by maker', () => {
    const b = satelliteBlocks(
      parseAntex(readFileSync(atx, 'latin1')).antennas,
      Date.UTC(2024, 0, 14)
    );
    const g = clockGroupFromBlocks(b, 'bds-maker');
    // igs20 block names (IGS satellite metadata): C19 CAST, C25 SECM.
    expect(g('C19')).toBe('C3-CAST');
    expect(g('C25')).toBe('C3-SECM');
    expect(g('C12')).toBe('C2');
  });
});
