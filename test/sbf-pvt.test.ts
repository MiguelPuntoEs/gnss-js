import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseSbfPvt } from '../src/sbf';

const FIX = join(__dirname, '../test-fixtures/dlf500_sbf_nav_slice.sbf');

describe.skipIf(!existsSync(FIX))('parseSbfPvt (DLF500 Septentrio)', () => {
  const data = new Uint8Array(readFileSync(FIX));
  const res = parseSbfPvt(data);

  it('decodes PVTGeodetic blocks', () => {
    expect(res.messages).toBeGreaterThan(0);
    expect(res.records.length).toBeGreaterThan(0);
  });

  it('reports the receiver at Delft with a sane accuracy and mode', () => {
    const fixed = res.records.filter((r) => r.latDeg != null);
    expect(fixed.length).toBeGreaterThan(0);
    const r = fixed[fixed.length - 1]!;
    // DLF500 is a TU Delft reference station (~52.0°N, 4.39°E).
    expect(r.latDeg!).toBeGreaterThan(51);
    expect(r.latDeg!).toBeLessThan(53);
    expect(r.lonDeg!).toBeGreaterThan(3);
    expect(r.lonDeg!).toBeLessThan(6);
    // A known solution mode, several satellites, metre-or-better accuracy.
    expect(r.mode).not.toMatch(/^mode-/);
    expect(r.nrSV!).toBeGreaterThan(4);
    if (r.hAccuracyM != null) {
      expect(r.hAccuracyM).toBeGreaterThan(0);
      expect(r.hAccuracyM).toBeLessThan(50);
    }
    expect(r.week).toBeGreaterThan(2000);
    expect(r.tow).toBeGreaterThanOrEqual(0);
    expect(r.tow).toBeLessThan(604800);
  });
});
