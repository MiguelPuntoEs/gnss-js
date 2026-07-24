import { describe, it, expect } from 'vitest';
import {
  gimVerticalTec,
  gimSlantIonoDelayL1,
  IONO_L1_M_PER_TECU,
} from '../src/positioning/gim';
import type { IonexGrid } from '../src/rinex/ionex';

const T0 = Date.UTC(2024, 0, 1, 0, 0, 0);
const HOUR = 3600_000;

/** Uniform-TEC grid over two hourly epochs (5×5, −20…20 in both axes). */
function uniformGrid(tecu: number): IonexGrid {
  const lats = [20, 10, 0, -10, -20]; // descending, like real IONEX
  const lons = [-20, -10, 0, 10, 20];
  const map = () => new Float32Array(lats.length * lons.length).fill(tecu);
  return { epochs: [T0, T0 + HOUR], lats, lons, maps: [map(), map()] };
}

/** Grid whose TEC rises linearly with longitude (10 → 30 TECU). */
function lonGradientGrid(): IonexGrid {
  const lats = [20, 10, 0, -10, -20];
  const lons = [-20, -10, 0, 10, 20];
  const build = () => {
    const m = new Float32Array(lats.length * lons.length);
    for (let i = 0; i < lats.length; i++)
      for (let j = 0; j < lons.length; j++) m[i * lons.length + j] = 10 + j * 5;
    return m;
  };
  return { epochs: [T0, T0 + HOUR], lats, lons, maps: [build(), build()] };
}

describe('gimVerticalTec', () => {
  it('returns the grid value where it is uniform', () => {
    const g = uniformGrid(15);
    expect(gimVerticalTec(g, T0, 0, 0)).toBeCloseTo(15, 6);
    expect(gimVerticalTec(g, T0 + HOUR / 2, 5, -5)).toBeCloseTo(15, 6);
  });

  it('bilinearly interpolates a spatial gradient', () => {
    const g = lonGradientGrid();
    // lon 0 → j=2 → 20 TECU; lon -5 is halfway between j1(15) and j2(20) → 17.5
    expect(gimVerticalTec(g, T0, 0, 0)).toBeCloseTo(20, 5);
    expect(gimVerticalTec(g, T0, 0, -5)).toBeCloseTo(17.5, 5);
  });

  it('is null outside the time span', () => {
    const g = uniformGrid(10);
    expect(gimVerticalTec(g, T0 - 1, 0, 0)).toBeNull();
    expect(gimVerticalTec(g, T0 + HOUR + 1, 0, 0)).toBeNull();
  });

  it('is null where the map marks no value (NaN)', () => {
    const g = uniformGrid(10);
    g.maps[0]!.fill(NaN);
    expect(gimVerticalTec(g, T0, 0, 0)).toBeNull();
  });
});

describe('gimSlantIonoDelayL1', () => {
  it('equals K·VTEC at zenith (mapping = 1)', () => {
    const g = uniformGrid(20);
    const d = gimSlantIonoDelayL1(g, 0, 0, 0, Math.PI / 2, T0);
    expect(d).not.toBeNull();
    expect(d!).toBeCloseTo(IONO_L1_M_PER_TECU * 20, 6);
    // sanity on the physical constant: ~0.162 m/TECU
    expect(IONO_L1_M_PER_TECU).toBeCloseTo(0.1624, 3);
  });

  it('grows with the obliquity factor at low elevation', () => {
    const g = uniformGrid(20);
    const zenith = gimSlantIonoDelayL1(g, 0, 0, 0, Math.PI / 2, T0)!;
    const low = gimSlantIonoDelayL1(g, 0, 0, 0, (10 * Math.PI) / 180, T0)!;
    expect(low).toBeGreaterThan(zenith);
    // thin-shell mapping at 10° elevation is ~2.7×
    expect(low / zenith).toBeGreaterThan(2);
    expect(low / zenith).toBeLessThan(3.5);
  });

  it('is null at or below the horizon', () => {
    const g = uniformGrid(20);
    expect(gimSlantIonoDelayL1(g, 0, 0, 0, 0, T0)).toBeNull();
    expect(gimSlantIonoDelayL1(g, 0, 0, 0, -0.1, T0)).toBeNull();
  });

  it('clamps a pierce point beyond the grid to the edge value (global maps)', () => {
    // Real GIMs are global, so spatial coverage is total; a synthetic
    // partial grid clamps to its nearest edge rather than returning null
    // (null is reserved for time gaps and no-value cells). With uniform
    // TEC the clamped edge value is still the same, so the delay stays
    // finite and positive.
    const g = uniformGrid(20);
    const d = gimSlantIonoDelayL1(
      g,
      (19 * Math.PI) / 180,
      (19 * Math.PI) / 180,
      0, // due north — pierce point runs off the +20° lat edge
      (15 * Math.PI) / 180,
      T0
    );
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(0);
  });
});
