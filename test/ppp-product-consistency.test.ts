import { describe, it, expect } from 'vitest';
import {
  createPppCorrections,
  withSatelliteAntennas,
  type AntennaOffset,
  type PppAntennaModel,
} from '../src/positioning';

const off = (up: number): AntennaOffset => ({
  pco: [0, 0, up],
  pcvZen1Deg: 0,
  pcvDzenDeg: 0,
  pcvNoazi: [],
});

describe('withSatelliteAntennas', () => {
  const base: PppAntennaModel = {
    satOffset: () => off(1),
    rcvOffset: () => off(0.1),
  };
  // ESA's BeiDou model: only some PRNs.
  const esa: PppAntennaModel = {
    satOffset: (prn) => (prn === 'C25' ? off(1.457) : null),
    rcvOffset: () => off(9),
  };

  it('takes satellites from the override, everything else from the base', () => {
    const m = withSatelliteAntennas(base, esa);
    expect(m.satOffset('C25', 0, 'C02', 'C06', 1, 2)!.pco[2]).toBe(1.457);
    // Not in the override → base.
    expect(m.satOffset('C45', 0, 'C02', 'C06', 1, 2)!.pco[2]).toBe(1);
    // Receivers always from the base.
    expect(m.rcvOffset('X', 'G01', 'G02', 1, 2)!.pco[2]).toBe(0.1);
  });

  it('limits the override to the given systems', () => {
    const all: PppAntennaModel = { ...esa, satOffset: () => off(5) };
    const m = withSatelliteAntennas(base, all, 'C');
    expect(m.satOffset('C25', 0, 'C02', 'C06', 1, 2)!.pco[2]).toBe(5);
    expect(m.satOffset('G01', 0, 'G01', 'G02', 1, 2)!.pco[2]).toBe(1);
  });
});

describe('receiver antenna without a calibration', () => {
  it('still applies the antenna height', () => {
    const corr = createPppCorrections({
      antenna: { satOffset: () => null, rcvOffset: () => null },
      rcvAntType: 'UNCALIBRATED    NONE',
      antDeltaEnu: [0, 0, 1.5],
      tides: false,
      windup: false,
    });
    // Receiver at lat 0, lon 0 (Up = ECEF +X), satellite at the zenith.
    const r = corr.evaluate!(
      {
        prn: 'G01',
        satEcef: [26_000_000, 0, 0],
        rcvEcef: [6378137, 0, 0],
        los: [1, 0, 0],
        elRad: Math.PI / 2,
        azRad: 0,
        f1: 1575.42e6,
        f2: 1227.6e6,
        band1: 'G01',
        band2: 'G02',
        g: 2.546,
      },
      null
    );
    expect(r.rangeM).toBeCloseTo(-1.5, 9);
  });
});
