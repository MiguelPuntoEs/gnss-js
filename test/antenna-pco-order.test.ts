import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseAntex } from '../src/antex';
import {
  buildPppAntenna,
  buildRtkAntenna,
  createPppCorrections,
  rcvAntennaRangeM,
  type PppAntennaModel,
} from '../src/positioning';

// ANTEX gives receiver PCOs as North/East/Up. At lat 0, lon 0 the local
// East is ECEF +Y and North is ECEF +Z, so a purely North offset must move
// the range to a northern satellite and leave an eastern one alone.
const NORTH_PCO = {
  pco: [0.1, 0, 0] as [number, number, number],
  pcvZen1Deg: 0,
  pcvDzenDeg: 0,
  pcvNoazi: [] as number[],
};
const TO_NORTH: [number, number, number] = [0, 0, 1];
const TO_EAST: [number, number, number] = [0, 1, 0];

describe('receiver PCO is North/East/Up (ANTEX order)', () => {
  it('RTK: rcvAntennaRangeM', () => {
    expect(rcvAntennaRangeM(NORTH_PCO, TO_NORTH, 0, 0, 0)).toBeCloseTo(-0.1, 9);
    expect(rcvAntennaRangeM(NORTH_PCO, TO_EAST, 0, 0, 0)).toBeCloseTo(0, 9);
  });

  it('PPP: createPppCorrections', () => {
    const antenna: PppAntennaModel = {
      satOffset: () => null,
      rcvOffset: () => NORTH_PCO,
    };
    const corr = createPppCorrections({
      antenna,
      rcvAntType: 'TEST',
      tides: false,
      windup: false,
    });
    const range = (los: [number, number, number], azRad: number) =>
      corr.evaluate!(
        {
          prn: 'G01',
          satEcef: [0, 0, 0],
          rcvEcef: [6378137, 0, 0],
          los,
          elRad: 0,
          azRad,
          f1: 1575.42e6,
          f2: 1227.6e6,
          band1: 'G01',
          band2: 'G02',
          g: 2.546,
        },
        null
      ).rangeM;
    expect(range(TO_NORTH, 0)).toBeCloseTo(-0.1, 9);
    expect(range(TO_EAST, Math.PI / 2)).toBeCloseTo(0, 9);
  });
});

// Independent of our parser and axis mapping: ANTEX 2.0 defines the antenna
// frame (x East, y North, z Up), the line of sight e = (sin A sin θ,
// cos A sin θ, cos θ) (eq. 1) and the PCO range correction ζ = −eᵀΔr (eq. 4).
// The receiver PCO read raw from the 2.0 text must give our PPP (iono-free)
// and RTK (per frequency) corrections, built from either ANTEX version.
describe('receiver PCO correction = ANTEX 2.0 eq. (1) + (4)', () => {
  const fx = (f: string) =>
    readFileSync(join(__dirname, '../test-fixtures', f), 'utf8');
  const raw20 = fx('antex20_slice.atx2');
  const TYPE = 'JAVRINGANT_G5T  NONE';
  // X / Y / Z per band, straight from the text.
  const X: Record<string, number[]> = {};
  let bands: string[] = [];
  for (const l of raw20
    .split('\n')
    .slice(raw20.split('\n').findIndex((l) => l.startsWith(TYPE)))) {
    if (l.includes('END OF ANTENNA')) break;
    if (l.includes('START OF PHASE'))
      bands = l.substring(0, 60).trim().split(/\s+/);
    if (l.includes('X / Y / Z'))
      for (const b of bands)
        X[b] = [0, 10, 20].map((c) => +l.substring(c, c + 10) / 1000);
  }
  const lat = (47 * Math.PI) / 180;
  const lon = (12 * Math.PI) / 180;
  const enuToEcefV = ([e, n, u]: number[]): [number, number, number] => {
    const [sl, cl, so, co] = [
      Math.sin(lat),
      Math.cos(lat),
      Math.sin(lon),
      Math.cos(lon),
    ];
    return [
      -so * e! - sl * co * n! + cl * co * u!,
      co * e! - sl * so * n! + cl * so * u!,
      cl * n! + sl * u!,
    ];
  };
  const N = 6378137 / Math.sqrt(1 - 6.69437999014e-3 * Math.sin(lat) ** 2);
  const rcvEcef: [number, number, number] = [
    N * Math.cos(lat) * Math.cos(lon),
    N * Math.cos(lat) * Math.sin(lon),
    N * (1 - 6.69437999014e-3) * Math.sin(lat),
  ];
  const f1 = 1575.42e6;
  const f2 = 1227.6e6;
  const g = (f1 * f1) / (f1 * f1 - f2 * f2);
  const noPcv = (m: PppAntennaModel): PppAntennaModel => ({
    satOffset: () => null,
    rcvOffset: (...a) => {
      const o = m.rcvOffset(...a);
      return o && { pco: o.pco, pcvZen1Deg: 0, pcvDzenDeg: 0, pcvNoazi: [] };
    },
  });

  for (const [name, file] of [
    ['1.4', 'antex14_slice.atx'],
    ['2.0', 'antex20_slice.atx2'],
  ] as const)
    it(`holds for a model built from ANTEX ${name}`, () => {
      const antex = parseAntex(fx(file));
      const rtk = buildRtkAntenna(antex).rcvOffset(TYPE, 'G01')!;
      const corr = createPppCorrections({
        antenna: noPcv(buildPppAntenna(antex)),
        rcvAntType: TYPE,
        satPco: false,
        tides: false,
        windup: false,
      });
      for (let A = 0; A < 360; A += 30)
        for (const E of [10, 30, 60]) {
          const a = (A * Math.PI) / 180;
          const th = ((90 - E) * Math.PI) / 180;
          const e = [
            Math.sin(a) * Math.sin(th),
            Math.cos(a) * Math.sin(th),
            Math.cos(th),
          ];
          const zeta = (b: string) =>
            -(e[0]! * X[b]![0]! + e[1]! * X[b]![1]! + e[2]! * X[b]![2]!);
          const los = enuToEcefV(e);
          const el = (E * Math.PI) / 180;
          expect(
            rcvAntennaRangeM({ ...rtk, pcvNoazi: [] }, los, lat, lon, el)
          ).toBeCloseTo(zeta('G01'), 12);
          const ppp = corr.evaluate!(
            {
              prn: 'G01',
              satEcef: [0, 0, 0],
              rcvEcef,
              los,
              elRad: el,
              azRad: a,
              f1,
              f2,
              band1: 'G01',
              band2: 'G02',
              g,
            },
            null
          ).rangeM;
          expect(ppp).toBeCloseTo(g * zeta('G01') - (g - 1) * zeta('G02'), 12);
        }
    });
});
