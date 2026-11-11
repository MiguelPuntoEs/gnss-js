import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  plateVelocity,
  propagatePosition,
  ITRF2020_PMM,
  type PmmPlate,
} from '../src/frames';
import { ecefToGeodetic } from '../src/coordinates/ecef';

/** IGS20 station velocities (ITRF2020), each with the PB2002 plate it sits
 *  on mapped to ITRF2020-PMM (null: a plate the model doesn't have). */
const { stations } = JSON.parse(
  readFileSync(
    new URL('../test-fixtures/igs20-velocities.json', import.meta.url),
    'utf8'
  )
) as {
  stations: {
    id: string;
    xyz: [number, number, number];
    vel: [number, number, number];
    plate: PmmPlate | null;
  }[];
};

/** East/north/up components (m/yr) of an ECEF vector at `xyz`. */
function enu(xyz: readonly number[], v: readonly number[]) {
  const [lat, lon] = ecefToGeodetic(xyz[0]!, xyz[1]!, xyz[2]!);
  const [sl, cl, sp, cp] = [
    Math.sin(lon),
    Math.cos(lon),
    Math.sin(lat),
    Math.cos(lat),
  ];
  return {
    e: -sl * v[0]! + cl * v[1]!,
    n: -sp * cl * v[0]! - sp * sl * v[1]! + cp * v[2]!,
    u: cp * cl * v[0]! + cp * sl * v[1]! + sp * v[2]!,
  };
}

function horizontalMisfit(s: (typeof stations)[number]): number {
  const p = enu(s.xyz, plateVelocity(s.xyz, s.plate!));
  const o = enu(s.xyz, s.vel);
  return Math.hypot(p.e - o.e, p.n - o.n) * 1000; // mm/yr
}

describe('plateVelocity (ITRF2020-PMM)', () => {
  it('reproduces IGS20 velocities on the 13 plates', () => {
    const misfit = stations
      .filter((s) => s.plate)
      .map(horizontalMisfit)
      .sort((a, b) => a - b);
    expect(misfit.length).toBe(297);
    const q = (f: number) => misfit[Math.floor(f * (misfit.length - 1))]!;
    // Rigid plates: sub-mm/yr in the interiors; boundaries make the tail.
    expect(q(0.5)).toBeLessThan(1.0);
    expect(q(0.75)).toBeLessThan(2.0);
  });

  it('fits stable-interior stations to about 1 mm/yr', () => {
    // Wettzell, Onsala, Algonquin, Brasília, Tidbinbilla, Hartebeesthoek,
    // Mauna Kea, Kerguelen.
    for (const id of [
      'WTZR',
      'ONSA',
      'ALGO',
      'BRAZ',
      'TID1',
      'HRAO',
      'MKEA',
      'KERG',
    ]) {
      const s = stations.find((x) => x.id === id);
      expect(s?.plate, id).toBeTruthy();
      expect(horizontalMisfit(s!), id).toBeLessThan(1.5);
    }
  });

  it('is horizontal, a few cm/yr, and Europe moves north-east', () => {
    const wtzr = stations.find((s) => s.id === 'WTZR')!;
    const v = enu(wtzr.xyz, plateVelocity(wtzr.xyz, 'EURA'));
    expect(Math.abs(v.u)).toBeLessThan(1e-9);
    expect(v.e).toBeGreaterThan(0.015);
    expect(v.n).toBeGreaterThan(0.01);
    expect(Math.hypot(v.e, v.n)).toBeLessThan(0.03);
    for (const plate of Object.keys(ITRF2020_PMM) as PmmPlate[]) {
      const sp = Math.hypot(...plateVelocity(wtzr.xyz, plate));
      expect(sp, plate).toBeLessThan(0.12);
    }
  });
});

describe('propagatePosition', () => {
  it('is linear in time and reversible', () => {
    const x: [number, number, number] = [4075580.4, 931853.9, 4801568.2];
    const v = plateVelocity(x, 'EURA');
    const later = propagatePosition(x, v, 2010.0, 2026.0);
    const d = Math.hypot(later[0] - x[0], later[1] - x[1], later[2] - x[2]);
    expect(d).toBeCloseTo(16 * Math.hypot(...v), 9);
    const back = propagatePosition(later, v, 2026.0, 2010.0);
    back.forEach((c, i) => expect(c).toBeCloseTo(x[i]!, 9));
  });
});
