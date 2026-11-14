import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseAntex } from '../src/antex';
import {
  buildPppAntenna,
  createPppCorrections,
  type PppAntennaModel,
} from '../src/positioning';

// A satellite with no antenna calibration at all must be left out, not
// ranged to its centre of mass while its clock refers to the antenna
// (0.5–2 m apart); a known satellite on a band its entry lacks still gets
// its offset from the other band.

const SAT_PCO = {
  pco: [0, 0, 1.5] as [number, number, number],
  pcvZen1Deg: 0,
  pcvDzenDeg: 0,
  pcvNoazi: [] as number[],
};

describe('satellite antenna calibration missing', () => {
  const antenna: PppAntennaModel = {
    satOffset: (prn) => (prn === 'G01' ? SAT_PCO : null),
    rcvOffset: () => null,
  };
  const corr = createPppCorrections({
    antenna,
    rcvAntType: 'TEST',
    tides: false,
    windup: false,
  });
  const rcv: [number, number, number] = [6378137, 0, 0];
  const t = Date.UTC(2024, 0, 15, 12);
  const ctx = corr.epochContext!(t, rcv);
  const evaluate = (prn: string) =>
    corr.evaluate!(
      {
        prn,
        satEcef: [26_000_000, 0, 0],
        rcvEcef: rcv,
        los: [1, 0, 0],
        elRad: Math.PI / 2,
        azRad: 0,
        f1: 1575.42e6,
        f2: 1227.6e6,
        band1: 'G01',
        band2: 'G02',
        g: 2.546,
      },
      ctx
    );

  it('a calibrated satellite is corrected', () => {
    const r = evaluate('G01');
    expect(r.exclude).toBeFalsy();
    expect(Math.abs(r.rangeM)).toBeGreaterThan(1);
  });

  it('an uncalibrated satellite is excluded', () => {
    expect(evaluate('G32').exclude).toBe(true);
  });

  it('is kept when satellite offsets are switched off', () => {
    const off = createPppCorrections({
      antenna,
      rcvAntType: 'TEST',
      tides: false,
      windup: false,
      satPco: false,
    });
    const r = off.evaluate!(
      {
        prn: 'G32',
        satEcef: [26_000_000, 0, 0],
        rcvEcef: rcv,
        los: [1, 0, 0],
        elRad: Math.PI / 2,
        azRad: 0,
        f1: 1575.42e6,
        f2: 1227.6e6,
        band1: 'G01',
        band2: 'G02',
        g: 2.546,
      },
      off.epochContext!(t, rcv)
    );
    expect(r.exclude).toBeFalsy();
  });
});

describe('buildPppAntenna: a known satellite on a band its entry lacks', () => {
  const atx = parseAntex(
    readFileSync(
      join(__dirname, '../test-fixtures/antex_ppp_slice.atx'),
      'utf8'
    )
  );
  const model = buildPppAntenna(atx);
  const t = Date.UTC(2005, 0, 1);

  it('takes the other band (G04 has only G01/G02)', () => {
    const l1l2 = model.satOffset('G04', t, 'G01', 'G02', 1575.42e6, 1227.6e6);
    const l1l5 = model.satOffset('G04', t, 'G01', 'G05', 1575.42e6, 1176.45e6);
    expect(l1l2).not.toBeNull();
    expect(l1l5).not.toBeNull();
  });

  it('is null only for an unknown satellite', () => {
    expect(
      model.satOffset('G99', t, 'G01', 'G02', 1575.42e6, 1227.6e6)
    ).toBeNull();
  });
});
