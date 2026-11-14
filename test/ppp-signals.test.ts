/**
 * Multi-signal PPP input and the per-band antenna / correction model of the
 * uncombined engine: every per-band quantity, combined ionosphere-free over
 * a pair, must equal what the ionosphere-free API gives for that pair.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseAntex } from '../src/antex';
import { buildPppAntenna, interpPcv } from '../src/positioning/ppp-antenna';
import {
  createPppCorrections,
  selectPppSignals,
  toDualFrequencyObs,
  sunEcef,
  moonEcef,
  type SatGeom,
} from '../src/positioning';
import { FREQ } from '../src/constants/gnss';
import { geodeticToEcef } from '../src/coordinates';

const FIX = join(__dirname, '..', 'test-fixtures');

describe('selectPppSignals', () => {
  const codes = [
    'C1C',
    'L1C',
    'S1C',
    'C1W',
    'L1W',
    'C2W',
    'L2W',
    'C2L',
    'L2L',
    'C5Q',
    'L5Q',
  ];
  const values = [
    2.1e7,
    1.1e8,
    45,
    2.1e7 + 0.3,
    1.1e8 + 1,
    2.1e7 + 2,
    8.6e7,
    2.1e7 + 1.9,
    8.6e7 + 0.25,
    2.1e7 + 2.5,
    8.2e7,
  ];

  it('picks one tracking mode per band, in band order', () => {
    const s = selectPppSignals('G10', codes, values)!;
    expect(s.signals.map((x) => x.band)).toEqual(['1', '2', '5']);
    // GPS L1: P(Y) code with the C/A carrier (the clock-reference code).
    expect(s.signals[0]).toMatchObject({
      code: '1W',
      phaseCode: '1C',
      pr: 2.1e7 + 0.3,
      cp: 1.1e8,
      antexBand: 'G01',
      freq: FREQ.G!['1'],
      snr: 45,
    });
    expect(s.signals[1]).toMatchObject({ code: '2W', cp: 8.6e7 });
    expect(s.signals[1]!.phaseCode).toBeUndefined();
    expect(s.signals[2]).toMatchObject({ code: '5Q', antexBand: 'G05' });
  });

  it('restricts and reorders bands on request', () => {
    const s = selectPppSignals('G10', codes, values, { bands: { G: '51' } })!;
    expect(s.signals.map((x) => x.band)).toEqual(['5', '1']);
  });

  it('marks loss of lock per carrier', () => {
    const lli = codes.map((c) => (c === 'L2W' ? 1 : null));
    const s = selectPppSignals('G10', codes, values, { lli })!;
    expect(s.signals.map((x) => !!x.lli)).toEqual([false, true, false]);
    const d = toDualFrequencyObs(s)!;
    expect(d.slip).toBe(true);
  });

  it('needs both the code and the carrier of a band', () => {
    const s = selectPppSignals(
      'G10',
      ['C1C', 'L1C', 'C2W'],
      [2.1e7, 1.1e8, 2.1e7]
    );
    expect(s!.signals.map((x) => x.band)).toEqual(['1']);
    expect(toDualFrequencyObs(s!)).toBeNull();
  });

  it('Galileo E5 AltBOC only on request', () => {
    const c = ['C1C', 'L1C', 'C5Q', 'L5Q', 'C7Q', 'L7Q', 'C8Q', 'L8Q'];
    const v = [2.1e7, 1.1e8, 2.1e7, 8.2e7, 2.1e7, 8.4e7, 2.1e7, 8.3e7];
    const def = selectPppSignals('E11', c, v)!;
    expect(def.signals.map((x) => x.band)).toEqual(['1', '5', '7']);
    const alt = selectPppSignals('E11', c, v, { bands: { E: '18' } })!;
    expect(alt.signals.map((x) => x.band)).toEqual(['1', '8']);
  });

  it('GLONASS needs the frequency channels', () => {
    const c = ['C1P', 'L1P', 'C2P', 'L2P'];
    const v = [2.1e7, 1.1e8, 2.1e7, 8.6e7];
    expect(selectPppSignals('R01', c, v)).toBeNull();
    const s = selectPppSignals('R01', c, v, { gloChannels: { R01: 1 } })!;
    expect(s.signals[0]!.freq).toBeCloseTo(1602e6 + 0.5625e6, -1);
  });

  it('reduces to the ionosphere-free engine’s dual-frequency record', () => {
    const s = selectPppSignals('G10', codes, values)!;
    expect(toDualFrequencyObs(s)).toEqual({
      prn: 'G10',
      f1: FREQ.G!['1'],
      f2: FREQ.G!['2'],
      c1: 2.1e7 + 0.3,
      c2: 2.1e7 + 2,
      l1: 1.1e8,
      l2: 8.6e7,
      band1: 'G01',
      band2: 'G02',
      code1: '1W',
      code2: '2W',
      phase1: '1C',
      phase2: '2W',
      slip: false,
    });
    expect(toDualFrequencyObs(s, '15')!.band2).toBe('G05');
  });
});

describe('per-band antenna model', () => {
  const antex = parseAntex(
    readFileSync(join(FIX, 'antex_ppp_slice.atx'), 'latin1')
  );
  const f1 = FREQ.G!['1']!;
  const f2 = FREQ.G!['2']!;
  const f5 = FREQ.G!['5']!;
  const g = (a: number, b: number) => (a * a) / (a * a - b * b);

  // The same file with a GPS-only receiver calibration, for the fallbacks.
  const gpsOnly = {
    ...antex,
    antennas: antex.antennas.map((a) =>
      a.isSatellite
        ? a
        : {
            ...a,
            type: 'GPSONLY         NONE',
            frequencies: a.frequencies.filter((f) =>
              ['G01', 'G02'].includes(f.frequency)
            ),
          }
    ),
  };
  for (const missingBands of ['gps-bands', 'gps-if'] as const) {
    const model = buildPppAntenna(
      {
        ...antex,
        antennas: [
          ...antex.antennas,
          ...gpsOnly.antennas.filter((a) => !a.isSatellite),
        ],
      },
      { missingBands }
    );
    it(`satellite + receiver offsets combine to the pair’s (${missingBands})`, () => {
      const t = Date.UTC(2024, 0, 1);
      for (const [b2, fb] of [
        ['G02', f2],
        ['G05', f5],
      ] as const) {
        const ifo = model.satOffset('G04', t, 'G01', b2, f1, fb)!;
        const a = model.satBandOffset!('G04', t, 'G01')!;
        const b = model.satBandOffset!('G04', t, b2)!;
        const k = g(f1, fb);
        for (let i = 0; i < 3; i++)
          expect(k * a.pco[i]! - (k - 1) * b.pco[i]!).toBeCloseTo(
            ifo.pco[i]!,
            12
          );
        for (const nadir of [0, 3.3, 7.9, 13.1])
          expect(
            k * interpPcv(a, nadir) - (k - 1) * interpPcv(b, nadir)
          ).toBeCloseTo(interpPcv(ifo, nadir), 12);
      }
      expect(model.satBandOffset!('G04', t, 'G07')).toBeNull();

      // Receiver: calibrated GPS bands, and Galileo/BeiDou bands that this
      // calibration lacks (the GPS fallback).
      for (const ant of ['LEIAR25.R3      NONE', 'GPSONLY         NONE'])
        for (const [bands, fa, fb] of [
          [['G01', 'G02'], f1, f2],
          [['E01', 'E05'], FREQ.E!['1']!, FREQ.E!['5']!],
          [['C02', 'C06'], FREQ.C!['2']!, FREQ.C!['6']!],
        ] as const) {
          const ifo = model.rcvOffset(ant, bands[0], bands[1], fa, fb)!;
          const per = model.rcvBandOffsets!(ant, bands)!;
          const k = g(fa, fb);
          for (let i = 0; i < 3; i++)
            expect(k * per[0]!.pco[i]! - (k - 1) * per[1]!.pco[i]!).toBeCloseTo(
              ifo.pco[i]!,
              12
            );
          for (const [zen, az] of [
            [0, 0],
            [42.5, 17],
            [80, 300],
          ])
            expect(
              k * interpPcv(per[0]!, zen!, az) -
                (k - 1) * interpPcv(per[1]!, zen!, az)
            ).toBeCloseTo(interpPcv(ifo, zen!, az), 12);
        }
      const ant = 'LEIAR25.R3      NONE';
      // A third band the antenna lacks (GLONASS CDMA G3 here) takes GPS L5.
      const three = model.rcvBandOffsets!(ant, ['R01', 'R02', 'R03'])!;
      expect(three).toHaveLength(3);
      expect(three[2]!.pco).toEqual(
        model.rcvBandOffsets!(ant, ['G05'])![0]!.pco
      );
      expect(three[0]!.pco).toEqual(
        model.rcvBandOffsets!(ant, ['R01'])![0]!.pco
      );
      expect(model.rcvBandOffsets!('NOSUCHANT       NONE', ['G01'])).toBeNull();
    });
  }
});

describe('per-signal corrections', () => {
  const antex = parseAntex(
    readFileSync(join(FIX, 'antex_ppp_slice.atx'), 'latin1')
  );
  const antenna = buildPppAntenna(antex);
  it('combine ionosphere-free to the pair’s correction', () => {
    const t = Date.UTC(2024, 0, 1, 6);
    const rcv = geodeticToEcef(
      (47 * Math.PI) / 180,
      (12 * Math.PI) / 180,
      600
    ) as [number, number, number];
    const mk = () =>
      createPppCorrections({
        antenna,
        rcvAntType: 'LEIAR25.R3      NONE',
        antDeltaEnu: [0.01, -0.02, 0.15],
      });
    const ifCorr = mk();
    const ucCorr = mk();
    const f1 = FREQ.G!['1']!;
    const f2 = FREQ.G!['2']!;
    const k = (f1 * f1) / (f1 * f1 - f2 * f2);
    // A satellite over the station at a few positions along a pass.
    for (const [dx, dy, dz] of [
      [8e6, 1e7, 1.6e7],
      [9e6, 1.1e7, 1.5e7],
      [1e7, 1.2e7, 1.4e7],
    ]) {
      const sat: [number, number, number] = [
        rcv[0] + dx!,
        rcv[1] + dy!,
        rcv[2] + dz!,
      ];
      const d = [sat[0] - rcv[0], sat[1] - rcv[1], sat[2] - rcv[2]];
      const r = Math.hypot(d[0]!, d[1]!, d[2]!);
      const los: [number, number, number] = [d[0]! / r, d[1]! / r, d[2]! / r];
      const base = {
        prn: 'G04',
        satEcef: sat,
        rcvEcef: rcv,
        los,
        elRad: 0.9,
        azRad: 0.4,
      };
      const ctx = {
        timeMs: t,
        sun: sunEcef(t),
        moon: moonEcef(t),
        tideDisp: [0.05, -0.03, 0.12] as [number, number, number],
      };
      const geom: SatGeom = {
        ...base,
        f1,
        f2,
        band1: 'G01',
        band2: 'G02',
        g: k,
      };
      const a = ifCorr.evaluate!(geom, ctx);
      const b = ucCorr.evaluateSignals!(
        {
          ...base,
          signals: [
            { band: 'G01', freq: f1 },
            { band: 'G02', freq: f2 },
          ],
        },
        ctx
      );
      expect(b.missing).toEqual([false, false]);
      const codeIf = b.rangeM + k * b.codeM[0]! - (k - 1) * b.codeM[1]!;
      const phaseIf = b.rangeM + k * b.phaseM[0]! - (k - 1) * b.phaseM[1]!;
      expect(codeIf).toBeCloseTo(a.rangeM, 10);
      expect(phaseIf).toBeCloseTo(a.rangeM + a.phaseWindupM, 10);
      expect(b.windupCyc).not.toBe(0);
    }
  });
});
