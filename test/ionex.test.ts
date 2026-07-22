import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseIonex } from '../src/rinex/ionex';

const FIX = join(__dirname, '../test-fixtures/ESA_GIM.inx');

describe.skipIf(!existsSync(FIX))('parseIonex (ESA rapid GIM)', () => {
  const grid = parseIonex(readFileSync(FIX, 'utf-8'));

  it('reads the advertised grid and epoch structure', () => {
    expect(grid.epochs).toHaveLength(25); // hourly + both midnights
    expect(grid.lats).toHaveLength(71); // 87.5..-87.5 step -2.5
    expect(grid.lons).toHaveLength(73); // -180..180 step 5
    expect(grid.epochs[1]! - grid.epochs[0]!).toBe(3600_000);
  });

  it('TEC values are physically plausible (solar-max day)', () => {
    // Noon map: equatorial TEC tens of TECU, polar values lower.
    const m = grid.maps[12]!;
    const at = (latDeg: number, lonDeg: number) => {
      const li = grid.lats.findIndex((v) => Math.abs(v - latDeg) < 1e-6);
      const gi = grid.lons.findIndex((v) => Math.abs(v - lonDeg) < 1e-6);
      return m[li * grid.lons.length + gi]!;
    };
    const equator = at(0, 0);
    const pole = at(87.5, 0);
    expect(equator).toBeGreaterThan(3);
    expect(equator).toBeLessThan(250);
    expect(pole).toBeGreaterThan(0);
    expect(pole).toBeLessThan(equator);
    // Whole map finite fraction is high
    const finite = m.filter((v) => Number.isFinite(v)).length;
    expect(finite / m.length).toBeGreaterThan(0.95);
  });

  it('all maps share the grid size', () => {
    for (const m of grid.maps)
      expect(m.length).toBe(grid.lats.length * grid.lons.length);
  });
});
