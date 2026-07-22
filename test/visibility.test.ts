import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseNavFile } from '../src/rinex';
import { computeVisibility } from '../src/orbit';

const DIR = join(__dirname, '../test-fixtures');
const HAS_DATA = existsSync(join(DIR, 'BRDC.nav'));

// ABMF (Guadeloupe) ECEF, from the obs header used elsewhere in the suite.
const ABMF: [number, number, number] = [2919785.712, -5383745.067, 1774604.692];
const START = Date.UTC(2024, 0, 1, 0, 0, 0);
const END = Date.UTC(2024, 0, 1, 6, 0, 0);

describe.skipIf(!HAS_DATA)('computeVisibility (ABMF, 6 h)', () => {
  const nav = parseNavFile(readFileSync(join(DIR, 'BRDC.nav'), 'utf-8'));
  const vis = computeVisibility(nav.ephemerides, ABMF, START, END, 300, 10);

  it('samples the whole window at the requested step', () => {
    expect(vis.times[0]).toBe(START);
    expect(vis.times[vis.times.length - 1]).toBe(END);
    expect(vis.times[1]! - vis.times[0]!).toBe(300_000);
  });

  it('keeps a healthy sky in view with usable DOP', () => {
    const mid = Math.floor(vis.times.length / 2);
    expect(vis.visibleCount[mid]).toBeGreaterThan(6);
    expect(vis.pdop[mid]).toBeGreaterThan(0.5);
    expect(vis.pdop[mid]).toBeLessThan(10);
    // GDOP ≥ PDOP ≥ HDOP by construction; VDOP present too
    expect(vis.gdop[mid]!).toBeGreaterThanOrEqual(vis.pdop[mid]!);
    expect(vis.pdop[mid]!).toBeGreaterThanOrEqual(vis.hdop[mid]!);
    expect(vis.vdop[mid]).toBeGreaterThan(0);
  });

  it('produces well-formed passes', () => {
    expect(vis.passes.length).toBeGreaterThan(5);
    for (const p of vis.passes) {
      expect(p.set).toBeGreaterThanOrEqual(p.rise);
      expect(p.peakTime).toBeGreaterThanOrEqual(p.rise);
      expect(p.peakTime).toBeLessThanOrEqual(p.set);
      expect(p.peakEl).toBeGreaterThan((10 * Math.PI) / 180);
      expect(p.peakEl).toBeLessThanOrEqual(Math.PI / 2 + 1e-6);
    }
  });

  it('a higher elevation mask never increases visibility', () => {
    const strict = computeVisibility(
      nav.ephemerides,
      ABMF,
      START,
      END,
      300,
      30
    );
    const mid = Math.floor(vis.times.length / 2);
    expect(strict.visibleCount[mid]!).toBeLessThanOrEqual(
      vis.visibleCount[mid]!
    );
  });
});
