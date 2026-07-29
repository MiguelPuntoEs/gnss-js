import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  postProcessRtk,
  buildRtkAntenna,
  rcvAntennaRangeM,
  satClockCorrection,
  type RtkObsEpoch,
} from '../src/positioning';
import { parseNovatelRange, parseNovatelNav } from '../src/novatel';
import { parseAntex } from '../src/antex';
import { computeSatPosition, ecefToAzEl } from '../src/orbit';
import { ecefToGeodetic } from '../src/coordinates/ecef';
import { FREQ } from '../src/constants/gnss';

const ANTEX_FIX = join(__dirname, '../test-fixtures/antex_rtk_pair.atx');
const A = 'TRM59800.00     NONE';
const B = 'LEIAR25.R3      NONE';

describe.skipIf(!existsSync(ANTEX_FIX))(
  'buildRtkAntenna (per-frequency)',
  () => {
    const model = buildRtkAntenna(parseAntex(readFileSync(ANTEX_FIX, 'utf8')));

    it('returns per-frequency receiver PCO/PCV (metres, not IF-combined)', () => {
      const g1 = model.rcvOffset(A, 'G01');
      const g2 = model.rcvOffset(A, 'G02');
      expect(g1).not.toBeNull();
      expect(g2).not.toBeNull();
      // Known igs20 values for TRM59800.00 NONE (mm → m); L1 ≠ L2.
      expect(g1!.pco[2]).toBeCloseTo(0.0893, 3);
      expect(g2!.pco[2]).not.toBeCloseTo(g1!.pco[2], 3);
      expect(g1!.pcvNoazi.length).toBeGreaterThan(2);
      expect(model.rcvOffset(B, 'G01')!.pco[2]).toBeCloseTo(0.1606, 3);
    });

    it('is null for an unknown antenna or uncalibrated frequency', () => {
      expect(model.rcvOffset('NO SUCH ANTENNA', 'G01')).toBeNull();
      expect(model.rcvOffset(A, 'X99')).toBeNull();
    });

    it('rcvAntennaRangeM projects a straight-up PCO onto a zenith line of sight', () => {
      // PCO purely Up, satellite at zenith (los = local up), no PCV → range loses
      // the full offset (APC above the marker ⇒ shorter marker→sat range).
      const off = {
        pco: [0, 0, 0.1] as [number, number, number],
        pcvZen1Deg: 0,
        pcvDzenDeg: 0,
        pcvNoazi: [],
      };
      const up: [number, number, number] = [0, 0, 1]; // at lat 90°, ENU up = +Z
      const m = rcvAntennaRangeM(off, up, Math.PI / 2, 0, Math.PI / 2);
      expect(m).toBeCloseTo(-0.1, 6);
    });
  }
);

// ── Integration on the WHU short baseline (both receivers physically the same
//    antenna). Same-antenna corrections must cancel in the double difference;
//    a simulated mixed-antenna rover must bias the baseline, and the matching
//    correction must recover it. ───────────────────────────────────────────
const BASE_FIX = join(__dirname, '../test-fixtures/oem719_rtk_base.gps');
const ROVER_FIX = join(__dirname, '../test-fixtures/oem719_rtk_rover.gps');
const WHU_BASE: [number, number, number] = [
  -2267335.669351269, 5008649.155499206, 3222374.973582075,
];
const WHU_ROVER_TRUTH: [number, number, number] = [
  -2267808.336856440175, 5009321.489190992899, 3221021.847353241406,
];
const C = 299792458;

describe.skipIf(!existsSync(BASE_FIX) || !existsSync(ANTEX_FIX))(
  'RTK receiver-antenna corrections (WHU baseline)',
  () => {
    const baseRaw = new Uint8Array(readFileSync(BASE_FIX));
    const roverRaw = new Uint8Array(readFileSync(ROVER_FIX));
    const base = parseNovatelRange(baseRaw);
    const rover = parseNovatelRange(roverRaw);
    const ephs = [
      ...parseNovatelNav(baseRaw).ephemerides,
      ...parseNovatelNav(roverRaw).ephemerides,
    ];
    const model = buildRtkAntenna(parseAntex(readFileSync(ANTEX_FIX, 'utf8')));
    const OPT = {
      mode: 'static' as const,
      elevationMaskDeg: 15,
      ambiguityResolution: 'instant' as const,
    };

    // Restrict to the G/E signals both antennas are calibrated for, so every
    // used observation has a defined correction on both ends.
    const BAND: Record<string, string> = { '1': '1', '2': '2', '5': '5' };
    const antexFreq = (prn: string, code: string) => `${prn[0]}0${code[0]}`;
    const freqHz = (prn: string, code: string): number | null =>
      (FREQ as Record<string, Record<string, number>>)[prn[0]!]?.[
        BAND[code[0]!] ?? ''
      ] ?? null;
    const keep = (prn: string, code: string) =>
      ['G', 'E'].includes(prn[0]!) &&
      !!model.rcvOffset(A, antexFreq(prn, code)) &&
      !!model.rcvOffset(B, antexFreq(prn, code)) &&
      freqHz(prn, code) != null;
    const filt = (eps: readonly RtkObsEpoch[]) =>
      eps.map((e) => ({
        ...e,
        meas: e.meas.filter((m) => keep(m.prn, m.code)),
      }));

    const baseF = { epochs: filt(base.epochs) };
    const roverF = { epochs: filt(rover.epochs) };
    const finalPos = (r: ReturnType<typeof postProcessRtk>) =>
      r.track[r.track.length - 1]!.position;
    const dist = (
      a: readonly [number, number, number],
      b: readonly [number, number, number]
    ) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

    it('same antenna on both ends cancels in the DD (no baseline change)', () => {
      const none = finalPos(postProcessRtk(baseF, roverF, ephs, WHU_BASE, OPT));
      const same = finalPos(
        postProcessRtk(baseF, roverF, ephs, WHU_BASE, {
          ...OPT,
          antenna: { model, base: { type: A }, rover: { type: A } },
        })
      );
      // Identical antennas at both ends: the correction is common-mode and
      // differences away (a sub-mm residual from the 1.6 km geometry offset).
      expect(dist(same, none)).toBeLessThan(0.002);
    });

    it('recovers a simulated mixed-antenna baseline (bias → corrected)', () => {
      // Simulate the rover carrying antenna B (real hardware is A) by adding
      // the per-observation B−A range signature, then check that the matching
      // correction removes the resulting baseline bias.
      const ephByPrn = new Map<string, (typeof ephs)[number]>();
      for (const e of ephs) ephByPrn.set(e.prn, e);
      const [latDeg, lonDeg] = ecefToGeodetic(...WHU_ROVER_TRUTH);
      const latR = (latDeg * Math.PI) / 180;
      const lonR = (lonDeg * Math.PI) / 180;
      const roverInj = {
        epochs: roverF.epochs.map((ep) => ({
          ...ep,
          meas: ep.meas.flatMap((m) => {
            const eph = ephByPrn.get(m.prn);
            if (!eph || m.pr == null) return [m];
            const tx = ep.timeMs - (m.pr / C) * 1000;
            const dts = satClockCorrection(eph, tx);
            const sat = computeSatPosition(eph, tx - dts * 1000);
            if (!Number.isFinite(sat.x)) return [m];
            const rho = Math.hypot(
              sat.x - WHU_ROVER_TRUTH[0],
              sat.y - WHU_ROVER_TRUTH[1],
              sat.z - WHU_ROVER_TRUTH[2]
            );
            const los: [number, number, number] = [
              (sat.x - WHU_ROVER_TRUTH[0]) / rho,
              (sat.y - WHU_ROVER_TRUTH[1]) / rho,
              (sat.z - WHU_ROVER_TRUTH[2]) / rho,
            ];
            const el = ecefToAzEl(...WHU_ROVER_TRUTH, sat.x, sat.y, sat.z).el;
            const f = antexFreq(m.prn, m.code);
            const oa = model.rcvOffset(A, f)!;
            const ob = model.rcvOffset(B, f)!;
            const d =
              rcvAntennaRangeM(ob, los, latR, lonR, el) -
              rcvAntennaRangeM(oa, los, latR, lonR, el);
            const lam = C / freqHz(m.prn, m.code)!;
            return [
              { ...m, pr: m.pr + d, cp: m.cp != null ? m.cp + d / lam : m.cp },
            ];
          }),
        })),
      };

      const truth = finalPos(
        postProcessRtk(baseF, roverF, ephs, WHU_BASE, OPT)
      );
      const biased = finalPos(
        postProcessRtk(baseF, roverInj, ephs, WHU_BASE, OPT)
      );
      const fixed = finalPos(
        postProcessRtk(baseF, roverInj, ephs, WHU_BASE, {
          ...OPT,
          antenna: { model, base: { type: A }, rover: { type: B } },
        })
      );

      // The 7 cm PCO mismatch shifts the uncorrected baseline by centimetres.
      expect(dist(biased, truth)).toBeGreaterThan(0.03);
      // The matching correction recovers the original baseline to the mm.
      expect(dist(fixed, truth)).toBeLessThan(0.005);
    });
  }
);
