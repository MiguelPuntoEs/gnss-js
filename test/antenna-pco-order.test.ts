import { describe, it, expect } from 'vitest';
import {
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
