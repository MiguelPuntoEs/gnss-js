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
});
