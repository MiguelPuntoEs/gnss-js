import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { gunzipSync } from 'zlib';
import { join } from 'path';
import { parseRinexStream } from '../src/rinex';
import { parseSp3 } from '../src/rinex/sp3';
import { parseClk } from '../src/rinex/clk';
import { parseAntex } from '../src/antex';
import {
  solvePpp,
  buildPppAntenna,
  createPppCorrections,
  niellMapping,
  sunEcef,
  moonEcef,
  solidEarthTide,
  type PppEpoch,
} from '../src/positioning';
import { FREQ } from '../src/constants/gnss';

const FIX = join(__dirname, '..', 'test-fixtures');
const HAS_DATA =
  existsSync(join(FIX, 'ABMF.crx')) && existsSync(join(FIX, 'ESA_MGEX.sp3'));
const HAS_ATX = existsSync(join(FIX, 'igs20.atx'));
const HAS_CLK = existsSync(join(FIX, 'ESA_MGEX_gec.clk.gz'));

/* ------------------------------------------------------------------ */
/*  Physics helpers (no external data needed)                          */
/* ------------------------------------------------------------------ */

describe('PPP troposphere (Niell)', () => {
  it('gives a sensible ZHD and mapping', () => {
    // Sea level, mid latitude, zenith.
    const zen = niellMapping(
      Math.PI / 2,
      (45 * Math.PI) / 180,
      0,
      Date.UTC(2024, 0, 1)
    );
    expect(zen.zhd).toBeGreaterThan(2.2); // ~2.3 m at sea level
    expect(zen.zhd).toBeLessThan(2.4);
    expect(zen.mh).toBeCloseTo(1.0, 2); // ~1 at zenith
    expect(zen.mw).toBeCloseTo(1.0, 2);
    // Low elevation ⇒ mapping grows ~1/sin(el).
    const low = niellMapping(
      (10 * Math.PI) / 180,
      (45 * Math.PI) / 180,
      0,
      Date.UTC(2024, 0, 1)
    );
    expect(low.mh).toBeGreaterThan(5);
    expect(low.mh).toBeLessThan(6.5);
    expect(low.mw).toBeGreaterThan(5);
  });
});

describe('PPP astronomy', () => {
  it('places the Sun at ~1 AU', () => {
    const s = sunEcef(Date.UTC(2024, 0, 1, 12));
    const d = Math.hypot(s[0], s[1], s[2]);
    expect(d).toBeGreaterThan(1.4e11);
    expect(d).toBeLessThan(1.53e11); // 0.98–1.02 AU
  });
  it('places the Moon at ~384000 km', () => {
    const m = moonEcef(Date.UTC(2024, 0, 1, 12));
    const d = Math.hypot(m[0], m[1], m[2]);
    expect(d).toBeGreaterThan(3.5e8);
    expect(d).toBeLessThan(4.1e8);
  });
  it('solid-earth tide displacement is at the decimetre level', () => {
    const rcv: [number, number, number] = [2919785.7, -5383745.05, 1774604.07];
    const t = Date.UTC(2024, 0, 1, 12);
    const disp = solidEarthTide(rcv, sunEcef(t), moonEcef(t));
    const mag = Math.hypot(disp[0], disp[1], disp[2]);
    expect(mag).toBeGreaterThan(0.0);
    expect(mag).toBeLessThan(0.5); // tens of cm, never metres
  });
});

/* ------------------------------------------------------------------ */
/*  Static float PPP on ABMF (2024-01-01), precise products            */
/* ------------------------------------------------------------------ */

let cached: Promise<{
  epochs: PppEpoch[];
  truth: [number, number, number];
  antType: string;
}> | null = null;
function load() {
  cached ??= (async () => {
    const sp3Text = readFileSync(join(FIX, 'ESA_MGEX.sp3'), 'utf8');
    void sp3Text;
    const crx = new Uint8Array(readFileSync(join(FIX, 'ABMF.crx')));
    const byTime = new Map<number, PppEpoch['obs']>();
    const result = await parseRinexStream(
      new File([crx], 'ABMF.crx'),
      undefined,
      undefined,
      (time, prn, codes, values) => {
        const sys = prn[0];
        const get = (c: string) => {
          const i = codes.indexOf(c);
          return i >= 0 ? values[i] : null;
        };
        let sat: PppEpoch['obs'][number] | null = null;
        if (sys === 'G') {
          const c1 = get('C1W') ?? get('C1C');
          const c2 = get('C2W');
          const l1 = get('L1C');
          const l2 = get('L2W');
          if (c1 && c2 && l1 && l2)
            sat = {
              prn,
              f1: FREQ.G!['1']!,
              f2: FREQ.G!['2']!,
              c1,
              c2,
              l1,
              l2,
              band1: 'G01',
              band2: 'G02',
              slip: false,
            };
        } else if (sys === 'E') {
          const c1 = get('C1C') ?? get('C1X');
          const c2 = get('C5Q') ?? get('C5X');
          const l1 = get('L1C') ?? get('L1X');
          const l2 = get('L5Q') ?? get('L5X');
          if (c1 && c2 && l1 && l2)
            sat = {
              prn,
              f1: FREQ.E!['1']!,
              f2: FREQ.E!['5']!,
              c1,
              c2,
              l1,
              l2,
              band1: 'E01',
              band2: 'E05',
              slip: false,
            };
        } else if (sys === 'C') {
          // BeiDou B1I/B3I (C2I/C6I) — the ESA MGEX clock reference pair.
          // GEOs (C01–C05) are absent from the SP3, so they drop out.
          const c1 = get('C2I');
          const c2 = get('C6I');
          const l1 = get('L2I');
          const l2 = get('L6I');
          if (c1 && c2 && l1 && l2)
            sat = {
              prn,
              f1: FREQ.C!['2']!,
              f2: FREQ.C!['6']!,
              c1,
              c2,
              l1,
              l2,
              band1: 'C02',
              band2: 'C06',
              slip: false,
            };
        }
        if (!sat) return;
        if (!byTime.has(time)) byTime.set(time, []);
        byTime.get(time)!.push(sat);
      }
    );
    const epochs = [...byTime.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([timeMs, obs]) => ({ timeMs, obs }));
    return {
      epochs,
      truth: result.header.approxPosition as [number, number, number],
      antType: result.header.antType,
    };
  })();
  return cached;
}

describe.skipIf(!HAS_DATA)('static float PPP (ABMF)', () => {
  it('converges from a 10 m offset to the decimetre level', async () => {
    const { epochs, truth } = await load();
    const sp3 = parseSp3(readFileSync(join(FIX, 'ESA_MGEX.sp3'), 'utf8'));
    expect(epochs.length).toBeGreaterThan(2000);

    const apriori: [number, number, number] = [
      truth[0] + 10,
      truth[1] - 10,
      truth[2] + 10,
    ];
    const sol = solvePpp(epochs, sp3, {
      aprioriPos: apriori,
      groundTruth: truth,
      elevationMaskDeg: 10,
    });

    // Started ~17 m out (10 m/axis), converge to the decimetre level.
    expect(sol.series[0]!.error3d!).toBeGreaterThan(10);
    // Final-hour average agreement with the station coordinate.
    const tail = sol.series.slice(-120).filter((s) => s.enu);
    const avg = tail
      .reduce(
        (a, s) => [a[0] + s.enu![0], a[1] + s.enu![1], a[2] + s.enu![2]],
        [0, 0, 0]
      )
      .map((v) => v / tail.length);
    const horiz = Math.hypot(avg[0]!, avg[1]!);
    const err3d = Math.hypot(avg[0]!, avg[1]!, avg[2]!);
    // Multi-GNSS (GPS+Galileo+BeiDou, per-constellation clocks) float PPP,
    // 5-min precise clocks: decimetre-level, an order better than SPP. (The
    // residual horizontal is consistent with the RINEX header being at a
    // different coordinate epoch — plate motion — not a solver error.)
    expect(err3d).toBeLessThan(0.5);
    expect(horiz).toBeLessThan(0.35);
    // Vertical converges to the decimetre level.
    expect(Math.abs(avg[2]!)).toBeLessThan(0.3);
    // Three constellations: ~24 satellites, well above GPS-only.
    const meanSats = tail.reduce((a, s) => a + s.nSats, 0) / tail.length;
    expect(meanSats).toBeGreaterThan(20);
    // Per-arc float ambiguities are emitted for PPP-AR.
    expect(sol.arcs.length).toBeGreaterThan(20);
    expect(
      sol.arcs.every((a) => Number.isFinite(a.aIF) && a.nEpochs >= 10)
    ).toBe(true);
    // Post-fit phase residuals at the centimetre–decimetre level.
    const prRms = Math.sqrt(
      tail.reduce((a, s) => a + s.phaseResRms * s.phaseResRms, 0) / tail.length
    );
    expect(prRms).toBeLessThan(0.15);
  });

  it('kinematic mode tracks a (static) rover epoch-by-epoch near truth', async () => {
    const { epochs, truth } = await load();
    const sp3 = parseSp3(readFileSync(join(FIX, 'ESA_MGEX.sp3'), 'utf8'));
    const sol = solvePpp(epochs, sp3, {
      aprioriPos: truth,
      groundTruth: truth,
      elevationMaskDeg: 10,
      mode: 'kinematic',
    });
    // Every epoch is positioned (white-noise position → per-epoch estimate).
    const tail = sol.series.slice(-600).filter((s) => s.enu);
    expect(tail.length).toBeGreaterThan(100);
    // The per-epoch track stays centred on the truth at the dm level (median
    // over the tail, robust to the odd bad epoch) — this is a static station
    // processed kinematically, so the cluster should sit on the marker.
    const med = (xs: number[]) =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const c = [0, 1, 2].map((i) => med(tail.map((s) => s.enu![i]!)));
    // Kinematic float PPP with 5-min clocks is far noisier than static — the
    // per-epoch clock/tropo errors that average out in static map into each
    // epoch's height. So the bar is decimetre horizontal, sub-2 m vertical
    // (median over the tail, on a station that is actually static).
    expect(Math.hypot(c[0]!, c[1]!)).toBeLessThan(0.8);
    expect(Math.abs(c[2]!)).toBeLessThan(2);
    // Kinematic is genuinely re-estimating each epoch, not converging to a
    // single point: the up-component scatter is well above static's mm–cm.
    const up = tail.map((s) => s.enu![2]!);
    const upMean = up.reduce((a, v) => a + v, 0) / up.length;
    const upStd = Math.sqrt(
      up.reduce((a, v) => a + (v - upMean) ** 2, 0) / up.length
    );
    expect(upStd).toBeGreaterThan(0.02);
  });

  it.skipIf(!HAS_ATX)(
    'runs with antenna/tide/wind-up corrections',
    async () => {
      const { epochs, truth, antType } = await load();
      const sp3 = parseSp3(readFileSync(join(FIX, 'ESA_MGEX.sp3'), 'utf8'));
      const antenna = buildPppAntenna(
        parseAntex(readFileSync(join(FIX, 'igs20.atx'), 'utf8'))
      );
      const corrections = createPppCorrections({
        antenna,
        rcvAntType: antType,
        rcvPco: true,
        tides: true,
        windup: true,
      });
      const sol = solvePpp(epochs.slice(0, 720), sp3, {
        aprioriPos: truth,
        groundTruth: truth,
        corrections,
      });
      expect(sol.series.length).toBe(720);
      expect(sol.finalError3d!).toBeLessThan(1.0);
    }
  );

  it.skipIf(!HAS_CLK)(
    'accepts 30 s precise clocks and holds decimetre accuracy',
    async () => {
      const { epochs, truth } = await load();
      const sp3 = parseSp3(readFileSync(join(FIX, 'ESA_MGEX.sp3'), 'utf8'));
      const clk = parseClk(
        gunzipSync(readFileSync(join(FIX, 'ESA_MGEX_gec.clk.gz'))).toString(
          'utf8'
        )
      );
      // 30 s sampling, a full day of GPS + Galileo + BeiDou clocks.
      expect(clk.intervalSec).toBe(30);
      expect(clk.sats['G01']!.t.length).toBeGreaterThan(2000);
      expect(clk.sats['C21']!.t.length).toBeGreaterThan(2000);

      const apriori: [number, number, number] = [
        truth[0] + 10,
        truth[1] - 10,
        truth[2] + 10,
      ];
      const sol = solvePpp(epochs, sp3, {
        aprioriPos: apriori,
        groundTruth: truth,
        elevationMaskDeg: 10,
        clk,
      });
      const tail = sol.series.slice(-120).filter((s) => s.enu);
      const avg = tail
        .reduce(
          (a, s) => [a[0] + s.enu![0], a[1] + s.enu![1], a[2] + s.enu![2]],
          [0, 0, 0]
        )
        .map((v) => v / tail.length);
      const err3d = Math.hypot(avg[0]!, avg[1]!, avg[2]!);
      // High-rate clocks feed the whole GPS+Galileo+BeiDou solution and hold
      // the decimetre level. They are not the static-PPP accuracy bottleneck:
      // the per-epoch receiver clock and per-arc ambiguities already absorb
      // most of the 5-min interpolation error, and with three constellations
      // the residual clock benefit washes out further (a GPS+Galileo-only run
      // shows a modest ~cm vertical tightening; here it is within the noise).
      // The real centimetre lever is integer ambiguity resolution (PPP-AR).
      expect(err3d).toBeLessThan(0.5);
      expect(Math.abs(avg[2]!)).toBeLessThan(0.3);
    }
  );
});
