import { describe, it, expect } from 'vitest';
import { createPppCorrections } from '../src/positioning/ppp-corrections';
import type { PppAntennaModel } from '../src/positioning/ppp-antenna';
import { ecefToGeodetic } from '../src/coordinates/ecef';
import { solidPoleTideEnu, wobble } from '../src/positioning/pole-tide';
import { gpsMsToUtcMjd } from '../src/positioning/eop';
import { atmosphericTideEnu } from '../src/positioning/atmospheric-tide-loading';

const antenna = {} as PppAntennaModel;
const WTZR: [number, number, number] = [4075580.3, 931854.0, 4801568.2];
const t = Date.UTC(2024, 0, 8, 6) + 18_000;

/** Displacement difference (ECEF) projected on local ENU. */
function enuOf(d: number[]) {
  const [lat, lon] = ecefToGeodetic(WTZR[0], WTZR[1], WTZR[2]);
  const [sl, cl, so, co] = [
    Math.sin(lat),
    Math.cos(lat),
    Math.sin(lon),
    Math.cos(lon),
  ];
  return [
    -so * d[0]! + co * d[1]!,
    -sl * co * d[0]! - sl * so * d[1]! + cl * d[2]!,
    cl * co * d[0]! + cl * so * d[1]! + sl * d[2]!,
  ];
}

describe('createPppCorrections: IERS station displacements', () => {
  const base = createPppCorrections({ antenna, rcvAntType: '' }).epochContext!(
    t,
    WTZR
  );

  it('adds the solid-earth pole tide from an EOP value', () => {
    const pole = { xp: 0.1232, yp: 0.2066 };
    const ctx = createPppCorrections({ antenna, rcvAntType: '', eop: pole })
      .epochContext!(t, WTZR);
    const got = enuOf(ctx.tideDisp.map((v, k) => v - base.tideDisp[k]!));
    const [lat, lon] = ecefToGeodetic(WTZR[0], WTZR[1], WTZR[2]);
    const { m1, m2 } = wobble(pole.xp, pole.yp, gpsMsToUtcMjd(t));
    const want = solidPoleTideEnu(lat, lon, m1, m2);
    for (let k = 0; k < 3; k++) expect(got[k]!).toBeCloseTo(want[k]!, 9);
    expect(Math.abs(want[2])).toBeGreaterThan(0.001);
  });

  it('adds the S1/S2 atmospheric tide and nothing without EOP', () => {
    const h = {
      cos: [0.001, 0.0002, 0.0001] as [number, number, number],
      sin: [0, 0, 0] as [number, number, number],
    };
    const c = { s1: h, s2: h };
    const ctx = createPppCorrections({
      antenna,
      rcvAntType: '',
      atmosphericTides: c,
      poleTide: true,
    }).epochContext!(t, WTZR);
    const got = enuOf(ctx.tideDisp.map((v, k) => v - base.tideDisp[k]!));
    const want = atmosphericTideEnu(c, t);
    for (let k = 0; k < 3; k++) expect(got[k]!).toBeCloseTo(want[k]!, 9);
  });

  it('degree2 model differs from IERS 2010 by mm (K1 resonance ≤ 13 mm), not cm', () => {
    const d2 = createPppCorrections({
      antenna,
      rcvAntType: '',
      tideModel: 'degree2',
    }).epochContext!(t, WTZR);
    const diff = Math.hypot(
      ...d2.tideDisp.map((v, k) => v - base.tideDisp[k]!)
    );
    expect(diff).toBeGreaterThan(1e-4);
    expect(diff).toBeLessThan(0.015);
  });
});
