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
  gimSlantIonoDelayL1,
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

  it('three and four frequencies: code biases, the L5 clock bias', () => {
    const GPS3 = [...GPS_L1L2, { band: '5', freq: FREQ.G!['5']!, code: '5Q' }];
    const GAL4 = [
      ...GAL_E1E5a,
      { band: '7', freq: FREQ.E!['7']!, code: '7Q' },
      { band: '6', freq: FREQ.E!['6']!, code: '6C' },
    ];
    const scen = {
      source,
      rcv,
      t0Ms: T0,
      epochs: 480,
      stepS: 30,
      codeSigma: 0.3,
      phaseSigma: 0.002,
      rcvCodeBias: { '2W': 2.1, '5Q': 1.7, '7Q': -0.8, '6C': 0.5 },
      // Satellite biases of the extra signals that no OSB removes here.
      satCodeBias: (prn: string, code: string) =>
        code === '5Q' || code === '7Q' || code === '6C'
          ? 0.4 * Math.sin(Number(prn.slice(1)) + code.charCodeAt(0))
          : 0,
      l5IfcbM: 0.05,
      horizonDeg: 12,
    };
    const three = simulate({ ...scen, signals: { G: GPS3, E: GAL4 } });
    const two = simulate({
      ...scen,
      signals: { G: GPS_L1L2, E: GAL_E1E5a },
    });
    const opts = { ...base, codeSigma: 0.3, phaseSigma: 0.002 };
    const uc3 = solvePppUncombined(three.epochs, source, opts);
    const uc2 = solvePppUncombined(two.epochs, source, opts);
    const noIfcb = solvePppUncombined(three.epochs, source, {
      ...opts,
      l5PhaseBias: false,
    });
    const e3 = Math.hypot(...enuMm(uc3.position, rcv));
    const e2 = Math.hypot(...enuMm(uc2.position, rcv));
    const eNo = Math.hypot(...enuMm(noIfcb.position, rcv));
    const at = (s: typeof uc3, i: number) =>
      Math.hypot(...enuMm(s.series[i]!.position, rcv));
    // Millimetres after 4 h, with or without the extra carriers; the
    // L5 clock bias left unmodelled costs centimetres.
    expect(e3).toBeLessThan(3);
    expect(e2).toBeLessThan(3);
    expect(at(uc3, 120)).toBeLessThan(10);
    expect(eNo).toBeGreaterThan(3 * e3);
    expect(at(noIfcb, 120)).toBeGreaterThan(30);
    // States: 2 per satellite more with 4 carriers (ambiguity + code bias).
    expect(uc3.nStates).toBeGreaterThan(uc2.nStates);

    // A slip on one further carrier only (no flag): found by its
    // geometry-free change against the first, that carrier re-initialised.
    const inView = (sys: string) =>
      three.epochs[190]!.obs.find(
        (o) =>
          o.prn[0] === sys &&
          three.epochs
            .slice(190, 260)
            .every((e) => e.obs.some((q) => q.prn === o.prn))
      )!.prn;
    const hit = [inView('G'), inView('E')];
    const slipped = three.epochs.map((e, i) => ({
      ...e,
      obs: e.obs.map((o) =>
        i >= 200 && hit.includes(o.prn)
          ? {
              ...o,
              signals: o.signals.map((s) =>
                s.band === (o.prn[0] === 'G' ? '5' : '7')
                  ? { ...s, cp: s.cp + 3 }
                  : s
              ),
            }
          : o
      ),
    }));
    const ucSlip = solvePppUncombined(slipped, source, opts);
    expect(Math.hypot(...enuMm(ucSlip.position, rcv))).toBeLessThan(3);
    const more = (k: string) => (ucSlip.resets[k] ?? 0) - (uc3.resets[k] ?? 0);
    expect(more('G5')).toBe(1);
    expect(more('E7')).toBe(1);
    expect(more('G1') + more('G2') + more('E1') + more('E5')).toBe(0);
  });
});

describe('uncombined PPP — ambiguity resolution (synthetic)', () => {
  // Satellite phase/code biases that an OSB product publishes, and receiver
  // phase biases (fractional cycles) that cancel between satellites.
  const satPhase = (prn: string, code: string) =>
    0.37 * Math.sin(Number(prn.slice(1)) * 1.7 + code.charCodeAt(0));
  const satCode = (prn: string, code: string) =>
    1.1 * Math.cos(Number(prn.slice(1)) * 0.9 + code.charCodeAt(0));
  const arSource = new SyntheticSource(
    [
      ...constellation('G', 24, 6, 26_560e3, 55),
      ...constellation('E', 24, 3, 29_600e3, 56, 0.3),
    ],
    { code: satCode, phase: satPhase }
  );
  const scen = (
    signals: Record<string, { band: string; freq: number; code: string }[]>
  ) =>
    simulate({
      source: arSource,
      signals,
      rcv,
      t0Ms: T0,
      epochs: 120,
      stepS: 30,
      codeSigma: 0.3,
      phaseSigma: 0.002,
      satCodeBias: satCode,
      satPhaseBias: satPhase,
      rcvPhaseBias: { '1C': 0.31, '2W': -0.12, '5Q': 0.44, '7Q': 0.08 },
      rcvCodeBias: { '5Q': 0.9, '7Q': -0.4 },
      horizonDeg: 12,
      seed: 7,
    }).epochs;
  const opts = {
    ...base,
    codeSigma: 0.3,
    phaseSigma: 0.002,
    l5PhaseBias: false as const,
    ar: true,
  };

  it('fixes the integers and the fixed position is millimetric', () => {
    const sol = solvePppUncombined(
      scen({ G: GPS_L1L2, E: GAL_E1E5a }),
      arSource,
      opts
    );
    expect(sol.ar!.firstFixSec).not.toBeNull();
    const fixed = sol.series.filter((r) => r.fixedPosition);
    expect(fixed.length).toBeGreaterThan(60);
    for (const r of fixed)
      expect(Math.hypot(...enuMm(r.fixedPosition!, rcv))).toBeLessThan(10);
    expect(Math.hypot(...enuMm(sol.ar!.position!, rcv))).toBeLessThan(3);
    expect(sol.ar!.lastAttempt!.nl).toBeGreaterThanOrEqual(10);
  });

  it('three frequencies: the extra-wide lanes fix first, the fix comes sooner', () => {
    const two = solvePppUncombined(
      scen({ G: GPS_L1L2, E: GAL_E1E5a }),
      arSource,
      opts
    );
    const three = solvePppUncombined(
      scen({
        G: [...GPS_L1L2, { band: '5', freq: FREQ.G!['5']!, code: '5Q' }],
        E: [...GAL_E1E5a, { band: '7', freq: FREQ.E!['7']!, code: '7Q' }],
      }),
      arSource,
      opts
    );
    expect(three.ar!.lastAttempt!.ewl).toBeGreaterThanOrEqual(10);
    // 4.5 vs 10 min here; a first partial fix (5 narrow lanes) sits within
    // 2 cm, none is wrong.
    expect(three.ar!.firstFixSec!).toBeLessThan(two.ar!.firstFixSec!);
    for (const r of three.series.filter((q) => q.fixedPosition))
      expect(Math.hypot(...enuMm(r.fixedPosition!, rcv))).toBeLessThan(20);
  });

  it('without phase biases there is no fix', () => {
    const plain = new SyntheticSource([
      ...constellation('G', 24, 6, 26_560e3, 55),
      ...constellation('E', 24, 3, 29_600e3, 56, 0.3),
    ]);
    const sol = solvePppUncombined(
      scen({ G: GPS_L1L2, E: GAL_E1E5a }),
      plain,
      opts
    );
    expect(sol.ar).toBeUndefined();
    expect(sol.series.every((r) => r.fixedPosition === null)).toBe(true);
  });
});

describe('uncombined PPP — ionosphere map (synthetic)', () => {
  // A uniform 25 TECU map; the observations carry exactly its delays.
  const t0 = T0 - 3600e3;
  const gim = {
    epochs: [t0, T0 + 4 * 3600e3],
    lats: [90, -90],
    lons: [-180, 180],
    maps: [new Float32Array(4).fill(25), new Float32Array(4).fill(25)],
  };
  const [lat, lon] = [(48 * Math.PI) / 180, (11 * Math.PI) / 180];
  const epochs = simulate({
    source,
    rcv,
    t0Ms: T0,
    epochs: 120,
    stepS: 30,
    // GPS dual-frequency, Galileo E1 only.
    signals: { G: GPS_L1L2, E: GAL_E1E5a.slice(0, 1) },
    codeSigma: 0.3,
    phaseSigma: 0.002,
    horizonDeg: 12,
    iono: (_prn, el, az, t) => gimSlantIonoDelayL1(gim, lat, lon, az, el, t)!,
  }).epochs;

  it('lets single-frequency satellites in, with a receiver code bias', () => {
    const opts = { ...base, codeSigma: 0.3, phaseSigma: 0.002 };
    const without = solvePppUncombined(epochs, source, opts);
    const withGim = solvePppUncombined(epochs, source, {
      ...opts,
      ionosphere: { gim, gimSigmaM: 0.1 },
    });
    const nWithout = without.series.at(-1)!.nSats;
    const nWith = withGim.series.at(-1)!.nSats;
    expect(nWith).toBeGreaterThan(nWithout);
    expect(Math.hypot(...enuMm(withGim.position, rcv))).toBeLessThan(20);
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
