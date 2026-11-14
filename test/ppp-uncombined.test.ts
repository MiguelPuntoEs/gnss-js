/**
 * Uncombined PPP: synthetic scenarios with a known truth, and the
 * equivalence with the ionosphere-free engine on real data — with two
 * frequencies, white-noise ionosphere and matching weights both estimate
 * the same position.
 */
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
  solvePppUncombined,
  buildPppAntenna,
  createPppCorrections,
  selectPppSignals,
  toDualFrequencyObs,
  type PppMultiEpoch,
  type PppEpoch,
} from '../src/positioning';
import { geodeticToEcef, getEnuDifference } from '../src/coordinates';
import { FREQ, buildGloChannelMap } from '../src/constants/gnss';
import { SyntheticSource, constellation, simulate } from './ppp-synthetic';

const FIX = join(__dirname, '..', 'test-fixtures');

/** Per-signal σ factor that gives a pair the ionosphere-free engine's σ. */
const ifScale = (f1: number, f2: number) => {
  const g = (f1 * f1) / (f1 * f1 - f2 * f2);
  return 1 / Math.hypot(g, g - 1);
};
const IF_SCALE = {
  G: ifScale(FREQ.G!['1']!, FREQ.G!['2']!),
  E: ifScale(FREQ.E!['1']!, FREQ.E!['5']!),
  R: ifScale(1602e6, 1246e6),
};
const sigmaScale = Object.fromEntries(
  Object.entries(IF_SCALE).map(([s, k]) => [s, { code: k, phase: k }])
);

const toDual = (multi: PppMultiEpoch[]): PppEpoch[] =>
  multi.map((e) => ({
    timeMs: e.timeMs,
    obs: e.obs
      .map((o) => toDualFrequencyObs(o))
      .filter((o): o is NonNullable<typeof o> => !!o),
  }));

const enuMm = (a: number[], b: number[]) =>
  getEnuDifference(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!).map(
    (v) => v * 1000
  );

/* ------------------------------------------------------------------ */
/*  Synthetic scenarios                                                 */
/* ------------------------------------------------------------------ */

const rcv = geodeticToEcef((48 * Math.PI) / 180, (11 * Math.PI) / 180, 500);
const source = new SyntheticSource([
  ...constellation('G', 24, 6, 26_560e3, 55),
  ...constellation('E', 24, 3, 29_600e3, 56, 0.3),
]);
const T0 = Date.UTC(2024, 0, 14);
const GPS_L1L2 = [
  { band: '1', freq: FREQ.G!['1']!, code: '1C' },
  { band: '2', freq: FREQ.G!['2']!, code: '2W' },
];
const GAL_E1E5a = [
  { band: '1', freq: FREQ.E!['1']!, code: '1C' },
  { band: '5', freq: FREQ.E!['5']!, code: '5Q' },
];
const base = {
  aprioriPos: [rcv[0] + 30, rcv[1] - 20, rcv[2] + 40] as [
    number,
    number,
    number,
  ],
  troposphere: false,
};

describe('uncombined PPP — synthetic', () => {
  it('two frequencies: recovers the position and equals the ionosphere-free engine', () => {
    const { epochs } = simulate({
      source,
      rcv,
      t0Ms: T0,
      epochs: 240,
      stepS: 30,
      signals: { G: GPS_L1L2, E: GAL_E1E5a },
      codeSigma: 0.3,
      phaseSigma: 0.002,
      rcvCodeBias: { '2W': 2.1, '5Q': -1.3 },
    });
    const uc = solvePppUncombined(epochs, source, {
      ...base,
      codeSigma: 3,
      phaseSigma: 0.01,
      systemSigmaScale: sigmaScale,
    });
    const ifs = solvePpp(toDual(epochs), source, {
      ...base,
      slipRepair: false,
    });
    const err = Math.hypot(...enuMm(uc.position, rcv));
    expect(err).toBeLessThan(5);
    const d = enuMm(uc.position, ifs.position);
    expect(Math.hypot(...d)).toBeLessThan(0.1);
    expect(uc.series).toHaveLength(240);
  });
});

/* ------------------------------------------------------------------ */
/*  Real data: equivalence with the ionosphere-free engine (ABMF)      */
/* ------------------------------------------------------------------ */

const HAS_DATA = [
  'ABMF.crx',
  'ESA_MGEX.sp3',
  'ESA_MGEX_gec.clk.gz',
  'igs20.atx',
]
  .map((f) => join(FIX, f))
  .every((f) => existsSync(f));

describe.skipIf(!HAS_DATA)('uncombined PPP — IF equivalence (ABMF)', () => {
  it('two frequencies, white ionosphere: the IF engine’s static position to < 0.1 mm', async () => {
    const raw: Parameters<typeof selectPppSignals>[] = [];
    const times: number[] = [];
    const res = await parseRinexStream(
      new File(
        [new Uint8Array(readFileSync(join(FIX, 'ABMF.crx')))],
        'ABMF.crx'
      ),
      undefined,
      undefined,
      (t, prn, codes, values, lli) => {
        if (!'GER'.includes(prn[0]!)) return;
        raw.push([prn, codes, values, lli ? { lli } : {}]);
        times.push(t);
      },
      true
    );
    const glo = buildGloChannelMap(res.header.glonassSlots ?? {});
    const byT = new Map<number, PppMultiEpoch['obs']>();
    raw.forEach(([prn, codes, values, o], i) => {
      const s = selectPppSignals(prn, codes, values, {
        ...o,
        gloChannels: glo,
      });
      if (!s || s.signals.length < 2) return;
      let a = byT.get(times[i]!);
      if (!a) byT.set(times[i]!, (a = []));
      a.push({ prn, signals: s.signals.slice(0, 2) });
    });
    const multi = [...byT.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([timeMs, obs]) => ({ timeMs, obs }));
    const sp3 = parseSp3(readFileSync(join(FIX, 'ESA_MGEX.sp3'), 'utf8'));
    const clk = parseClk(
      gunzipSync(readFileSync(join(FIX, 'ESA_MGEX_gec.clk.gz'))).toString()
    );
    const antenna = buildPppAntenna(
      parseAntex(readFileSync(join(FIX, 'igs20.atx'), 'latin1'))
    );
    const h = res.header;
    const delta = h.antDelta ?? [0, 0, 0];
    const corr = () =>
      createPppCorrections({
        antenna,
        rcvAntType: h.antType ?? '',
        antDeltaEnu: [delta[1], delta[2], delta[0]],
      });
    const common = {
      aprioriPos: h.approxPosition as [number, number, number],
      clk,
      estimateGradients: true,
    };
    const ifs = solvePpp(toDual(multi), sp3, {
      ...common,
      corrections: corr(),
      slipRepair: false,
    });
    const uc = solvePppUncombined(multi, sp3, {
      ...common,
      corrections: corr(),
      codeSigma: 3,
      phaseSigma: 0.01,
      systemSigmaScale: sigmaScale,
    });
    const d = enuMm(uc.position, ifs.position);
    expect(Math.abs(d[0]!)).toBeLessThan(0.1);
    expect(Math.abs(d[1]!)).toBeLessThan(0.1);
    expect(Math.abs(d[2]!)).toBeLessThan(0.1);
    // The whole series agrees once the filter has settled (first hour out).
    for (let i = 120; i < multi.length; i += 60)
      expect(
        Math.hypot(...enuMm(uc.series[i]!.position, ifs.series[i]!.position))
      ).toBeLessThan(0.5);
  }, 120_000);
});
