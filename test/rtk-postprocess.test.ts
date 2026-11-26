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

    it('chooses the model by baseline length', () => {
      const short = postProcessRtk(base, rover, ephs, WHU_BASE, {
        mode: 'static',
        elevationMaskDeg: 15,
      }).model;
      expect(short.frequencies).toBe(1);
      expect(short.ionosphere).toBe('off');
      expect(short.troposphere).toBe(false);
      expect(short.baselineKm!).toBeGreaterThan(1.5);
      expect(short.baselineKm!).toBeLessThan(1.7);

      // A 1 km limit makes the same 1.58 km session "long": two
      // frequencies, ionosphere and troposphere estimated. Minutes of data
      // on a short baseline are what the default limit keeps away from
      // this model (it lands 6 cm off here, the short model 3 mm) — it
      // must still solve and fix.
      const long = postProcessRtk(base, rover, ephs, WHU_BASE, {
        mode: 'static',
        elevationMaskDeg: 15,
        ambiguityResolution: 'instant',
        longBaselineKm: 1,
      });
      expect(long.model).toMatchObject({
        frequencies: 2,
        ionosphere: 'estimate',
        troposphere: true,
      });
      expect(long.fixRate).toBeGreaterThan(0.5);
      const f = long.final!;
      expect(f.status).toBe('fixed');
      const [dE, dN, dU] = getEnuDifference(
        WHU_BASE[0] + f.baseline[0],
        WHU_BASE[1] + f.baseline[1],
        WHU_BASE[2] + f.baseline[2],
        WHU_ROVER_TRUTH[0],
        WHU_ROVER_TRUTH[1],
        WHU_ROVER_TRUTH[2]
      );
      expect(Math.hypot(dE, dN, dU)).toBeLessThan(0.1);

      // Explicit options are never switched.
      const pinned = postProcessRtk(base, rover, ephs, WHU_BASE, {
        mode: 'static',
        frequencies: 1,
        longBaselineKm: 1,
      }).model;
      expect(pinned).toEqual({
        frequencies: 1,
        ionosphere: 'off',
        troposphere: false,
        baselineKm: null,
      });
      // Kinematic sessions have their own limit: the static one does not
      // apply, a kinematic one of 1 km does.
      const kin = (o: object) =>
        postProcessRtk(base, rover, ephs, WHU_BASE, {
          mode: 'kinematic',
          ...o,
        }).model;
      expect(kin({ longBaselineKm: 1 }).frequencies).toBe(1);
      const kinLong = kin({ kinematicLongBaselineKm: 1 });
      expect(kinLong.frequencies).toBe(2);
      expect(kinLong.baselineKm!).toBeGreaterThan(1.5);
    }, 30_000);

    it('produces integer-fixed epochs with instant AR', () => {
      const res = postProcessRtk(base, rover, ephs, WHU_BASE, {
        mode: 'static',
        elevationMaskDeg: 15,
        ambiguityResolution: 'instant',
      });
      expect(res.fixRate).toBeGreaterThan(0);
      expect(res.track.some((p) => p.status === 'fixed')).toBe(true);
    });

    it("applies an uncalibrated antenna's height (marker → ARP)", () => {
      const opts = {
        mode: 'static' as const,
        elevationMaskDeg: 15,
        ambiguityResolution: 'instant' as const,
      };
      const plain = postProcessRtk(base, rover, ephs, WHU_BASE, opts).final!;
      const noModel = { rcvOffset: () => null };
      const onPole = postProcessRtk(base, rover, ephs, WHU_BASE, {
        ...opts,
        antenna: {
          model: noModel,
          rover: { type: 'UNKNOWN', deltaEnu: [0, 0, 1] },
        },
      }).final!;
      // The marker sits 1 m below the antenna: 1 m lower along the up axis.
      const [dE, dN, dU] = getEnuDifference(
        WHU_BASE[0] + onPole.baseline[0],
        WHU_BASE[1] + onPole.baseline[1],
        WHU_BASE[2] + onPole.baseline[2],
        WHU_BASE[0] + plain.baseline[0],
        WHU_BASE[1] + plain.baseline[1],
        WHU_BASE[2] + plain.baseline[2]
      );
      expect(dU).toBeCloseTo(-1, 2);
      expect(Math.hypot(dE, dN)).toBeLessThan(0.01);
    });

    it('summarises the session: last fixed baseline and its covariance', () => {
      const res = postProcessRtk(base, rover, ephs, WHU_BASE, {
        mode: 'static',
        elevationMaskDeg: 15,
        ambiguityResolution: 'instant',
      });
      const f = res.final!;
      expect(f.status).toBe('fixed');
      const truth = WHU_ROVER_TRUTH.map((v, i) => v - WHU_BASE[i]!);
      const err = Math.hypot(...f.baseline.map((v, i) => v - truth[i]!));
      expect(err).toBeLessThan(0.3);
      // A valid covariance given the integers: symmetric, positive
      // diagonal, well below the float filter's decimetres.
      for (let i = 0; i < 3; i++) {
        expect(f.covariance[i]![i]!).toBeGreaterThan(0);
        expect(Math.sqrt(f.covariance[i]![i]!)).toBeLessThan(0.05);
        for (let j = 0; j < 3; j++)
          expect(f.covariance[i]![j]).toBeCloseTo(f.covariance[j]![i]!, 12);
      }
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

    it('models a slower base at its own epoch', () => {
      // Every 10th base epoch: the other rover epochs take a base up to 5 s
      // away. Modelled at the rover's time instead, the base ranges are off
      // by the satellites' motion (hundreds of metres in 5 s).
      const kin = {
        mode: 'kinematic',
        ambiguityResolution: 'instant',
      } as const;
      const full = postProcessRtk(base, rover, ephs, WHU_BASE, kin);
      const thin = {
        epochs: base.epochs.filter((_, i) => i % 10 === 0),
      };
      const res = postProcessRtk(thin, rover, ephs, WHU_BASE, kin);
      expect(res.unmatched).toBe(0);
      expect(res.solved).toBe(full.solved);
      expect(res.fixRate).toBeGreaterThan(0.9 * full.fixRate);
      const ref = new Map(full.track.map((p) => [p.timeMs, p.position]));
      let worst = 0;
      for (const p of res.track) {
        const q = ref.get(p.timeMs);
        if (p.status !== 'fixed' || !q) continue;
        worst = Math.max(
          worst,
          Math.hypot(...getEnuDifference(...p.position, ...q))
        );
      }
      expect(worst).toBeLessThan(0.03); // 1.2 cm
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
