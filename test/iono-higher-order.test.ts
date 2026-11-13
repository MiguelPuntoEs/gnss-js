import { describe, it, expect } from 'vitest';
import {
  higherOrderIonoCoefficients,
  higherOrderIonoIonoFree,
} from '../src/positioning/iono-higher-order';
import { igrfField } from '../src/positioning/igrf';

const D2R = Math.PI / 180;
const F1 = 1575.42e6;
const F2 = 1227.6e6;

/** A zenith ray over WTZR: LOS = local up; B from IGRF-14 at 450 km. */
function zenith(vtec: number) {
  const lat = 49.14 * D2R;
  const lon = 12.88 * D2R;
  const up: [number, number, number] = [
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat),
  ];
  const b = igrfField(lat, lon, 450e3, Date.UTC(2024, 0, 8)).ecef;
  return higherOrderIonoCoefficients(vtec, b, up, vtec);
}

describe('higher-order ionosphere (HP07)', () => {
  it('B·k̂ at a mid-latitude zenith ≈ the downward field (k̂ points down)', () => {
    const t = zenith(50);
    expect(t.bParallelNt).toBeGreaterThan(30000);
    expect(t.bParallelNt).toBeLessThan(45000);
  });

  it('zenith 2nd order on L1 is 0–2 cm, 3rd order 0–2 mm (Bassiri & Hajj 1993)', () => {
    for (const vtec of [10, 50, 80]) {
      const t = zenith(vtec);
      const second = t.s / F1 ** 3;
      const third = t.r / F1 ** 4;
      expect(second).toBeGreaterThan(0);
      expect(second).toBeLessThan(0.02);
      expect(third).toBeGreaterThan(0);
      expect(third).toBeLessThan(0.002);
    }
    // 50 TECU: ≈ 1 cm (code) — HP07's order of magnitude for mid-latitudes.
    expect(zenith(50).s / F1 ** 3).toBeGreaterThan(0.007);
  });

  it('iono-free residual: closed forms, mm level, phase = −½ code (2nd order)', () => {
    const t = zenith(50);
    const only2 = higherOrderIonoIonoFree(t, F1, F2, false);
    expect(only2.phase).toBeCloseTo(t.s / (2 * F1 * F2 * (F1 + F2)), 12);
    expect(only2.code).toBeCloseTo(-t.s / (F1 * F2 * (F1 + F2)), 12);
    expect(Math.abs(only2.phase)).toBeGreaterThan(0.0005);
    expect(Math.abs(only2.phase)).toBeLessThan(0.005);
    const both = higherOrderIonoIonoFree(t, F1, F2);
    // 3rd order: + r/(3 f1² f2²) on the phase.
    expect(both.phase - only2.phase).toBeCloseTo(
      t.r / (3 * F1 * F1 * F2 * F2),
      12
    );
    expect(Math.abs(both.phase - only2.phase)).toBeLessThan(0.0005);
  });
});
