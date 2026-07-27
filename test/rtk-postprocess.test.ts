import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { postProcessRtk } from '../src/positioning';
import { parseNovatelRange, parseNovatelNav } from '../src/novatel';
import { getEnuDifference } from '../src/coordinates/ecef';

const BASE_FIX = join(__dirname, '../test-fixtures/oem719_rtk_base.gps');
const ROVER_FIX = join(__dirname, '../test-fixtures/oem719_rtk_rover.gps');

// Same WHU short-baseline dataset + truth as rtk.test.ts: base surveyed
// (FIXEDPOS), rover static ~1.58 km away (WHU RTK-GNSS reference mean).
const WHU_BASE: [number, number, number] = [
  -2267335.669351269, 5008649.155499206, 3222374.973582075,
];
const WHU_ROVER_TRUTH: [number, number, number] = [
  -2267808.336856440175, 5009321.489190992899, 3221021.847353241406,
];

describe.skipIf(!existsSync(BASE_FIX) || !existsSync(ROVER_FIX))(
  'postProcessRtk (WHU OEM719 short baseline)',
  () => {
    const baseRaw = new Uint8Array(readFileSync(BASE_FIX));
    const roverRaw = new Uint8Array(readFileSync(ROVER_FIX));
    const base = parseNovatelRange(baseRaw);
    const rover = parseNovatelRange(roverRaw);
    const ephs = [
      ...parseNovatelNav(baseRaw).ephemerides,
      ...parseNovatelNav(roverRaw).ephemerides,
    ];

    it('static solution converges to the surveyed rover at the decimetre level', () => {
      const res = postProcessRtk(base, rover, ephs, WHU_BASE, {
        mode: 'static',
        elevationMaskDeg: 15,
      });

      expect(res.solved).toBeGreaterThanOrEqual(100);
      expect(res.track.length).toBe(res.solved);
      expect(res.track.every((p) => p.timeMs > 0)).toBe(true);

      const last = res.track[res.track.length - 1]!;
      expect(last.nSats).toBeGreaterThanOrEqual(10);
      const [dE, dN, dU] = getEnuDifference(
        last.position[0],
        last.position[1],
        last.position[2],
        WHU_ROVER_TRUTH[0],
        WHU_ROVER_TRUTH[1],
        WHU_ROVER_TRUTH[2]
      );
      expect(Math.hypot(dE, dN)).toBeLessThan(0.3); // dm horizontal
      expect(Math.abs(dU)).toBeLessThan(0.6);

      // The reported ENU baseline is the ~1.58 km short baseline.
      const bl = Math.hypot(...last.enu);
      expect(bl).toBeGreaterThan(1570);
      expect(bl).toBeLessThan(1600);
    });

    it('produces integer-fixed epochs with instant AR', () => {
      const res = postProcessRtk(base, rover, ephs, WHU_BASE, {
        mode: 'static',
        elevationMaskDeg: 15,
        ambiguityResolution: 'instant',
      });
      expect(res.fixRate).toBeGreaterThan(0);
      expect(res.track.some((p) => p.status === 'fixed')).toBe(true);
    });

    it('code-only (DGNSS) solves every epoch to metre level, no fixes', () => {
      const res = postProcessRtk(base, rover, ephs, WHU_BASE, {
        elevationMaskDeg: 15,
        codeOnly: true,
      });
      expect(res.solved).toBeGreaterThanOrEqual(100);
      expect(res.fixRate).toBe(0);
      expect(res.track.every((p) => p.status === 'dgnss')).toBe(true);
      const last = res.track[res.track.length - 1]!;
      const [dE, dN, dU] = getEnuDifference(
        last.position[0],
        last.position[1],
        last.position[2],
        WHU_ROVER_TRUTH[0],
        WHU_ROVER_TRUTH[1],
        WHU_ROVER_TRUTH[2]
      );
      // Code differential: metre-level, far looser than the phase fix.
      expect(Math.hypot(dE, dN, dU)).toBeLessThan(5);
    });

    it('leaves rover epochs with no base epoch unmatched', () => {
      // Shift the rover an hour off — far past the ~2-min base window, so no
      // rover epoch finds a base within tolerance.
      const shifted = {
        epochs: rover.epochs.map((e) => ({
          ...e,
          timeMs: e.timeMs + 3_600_000,
        })),
      };
      const res = postProcessRtk(base, shifted, ephs, WHU_BASE, {
        pairToleranceMs: 500,
      });
      expect(res.solved).toBe(0);
      expect(res.unmatched).toBeGreaterThan(0);
    });
  }
);
