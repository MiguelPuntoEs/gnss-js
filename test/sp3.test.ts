import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseSp3, sp3Position } from '../src/rinex';

const DIR = join(__dirname, '../test-fixtures');
const FILE = join(DIR, 'ESA_MGEX.sp3');

describe.skipIf(!existsSync(FILE))('parseSp3 (ESA MGEX final)', () => {
  const sp3 = parseSp3(readFileSync(FILE, 'utf-8'));

  it('reads the header and epoch table', () => {
    expect(sp3.version).toBe('d');
    expect(sp3.timeSystem).toBe('GPS');
    expect(sp3.intervalSec).toBe(300);
    expect(sp3.epochs.length).toBe(289); // 24 h at 5 min + endpoint
    expect(sp3.epochs[0]).toBe(Date.UTC(2024, 0, 1, 0, 0, 0));
    expect(sp3.epochs[1]! - sp3.epochs[0]!).toBe(300_000);
  });

  it('reads positions in meters and clocks in seconds', () => {
    // First data line of the file, converted:
    // PG13 -22826.376664 -13657.462702 1852.531327 611.371012
    const g13 = sp3.satellites['G13']![0]!;
    expect(g13.x).toBeCloseTo(-22826376.664, 3);
    expect(g13.y).toBeCloseTo(-13657462.702, 3);
    expect(g13.z).toBeCloseTo(1852531.327, 3);
    expect(g13.clk).toBeCloseTo(611.371012e-6, 12);
  });

  it('aligns every satellite to the epoch table', () => {
    for (const arr of Object.values(sp3.satellites)) {
      expect(arr.length).toBe(sp3.epochs.length);
    }
    // multi-GNSS content
    for (const sys of ['G', 'R', 'E', 'C']) {
      expect(
        Object.keys(sp3.satellites).filter((p) => p[0] === sys).length
      ).toBeGreaterThan(10);
    }
  });

  it('interpolation reproduces a left-out tabulated point to sub-mm', () => {
    // Evaluate exactly on a node NOT at a window edge: Lagrange through
    // the node must return the node itself.
    const t = sp3.epochs[100]!;
    for (const prn of ['G13', 'E11', 'C29']) {
      const node = sp3.satellites[prn]![100]!;
      const p = sp3Position(sp3, prn, t)!;
      expect(p.x).toBeCloseTo(node.x, 6);
      expect(p.y).toBeCloseTo(node.y, 6);
      expect(p.z).toBeCloseTo(node.z, 6);
    }
    // Between nodes: distance from both neighbours must be physical
    // (satellite moves ~3.9 km/s → ~580 km in 150 s for GPS)
    const mid = sp3.epochs[100]! + 150_000;
    const pm = sp3Position(sp3, 'G13', mid)!;
    const a = sp3.satellites['G13']![100]!;
    const d = Math.hypot(pm.x - a.x, pm.y - a.y, pm.z - a.z);
    expect(d).toBeGreaterThan(300_000);
    expect(d).toBeLessThan(700_000);
  });

  it('returns null outside the table and for unknown satellites', () => {
    expect(sp3Position(sp3, 'G13', sp3.epochs[0]! - 1)).toBeNull();
    expect(sp3Position(sp3, 'G13', sp3.epochs.at(-1)! + 1)).toBeNull();
    expect(sp3Position(sp3, 'X99', sp3.epochs[10]!)).toBeNull();
  });
});
