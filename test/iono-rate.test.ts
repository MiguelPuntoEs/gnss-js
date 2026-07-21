/**
 * Ground-truth tests for the time-differenced ionosphere helpers.
 * A synthetic TEC(t) with known derivative pins the ROT computation;
 * differencing across arc boundaries and sample-rate dependence are
 * the two failure modes checked explicitly.
 */
import { describe, expect, it } from 'vitest';
import type { IonoResult, IonoSeries } from '../src/analysis/ionosphere';
import { computeIonoRate, detrendIonoArcs } from '../src/analysis/ionosphere';

const T0 = Date.UTC(2026, 0, 1);

/** TEC(t) = 20 + 5·sin(2π·t/7200): dTEC/dt peaks at ~0.26 TECU/min. */
const tec = (tMs: number) =>
  20 + 5 * Math.sin((2 * Math.PI * (tMs - T0)) / 7_200_000);
const RATE_PEAK = ((5 * 2 * Math.PI) / 7200) * 60; // TECU/min

function series(stepSec: number, n: number, arcStarts = [0]): IonoSeries {
  return {
    prn: 'G01',
    system: 'G',
    label: 'L1-L2',
    codes: ['C1C', 'C2W'],
    tecuPerNs: 2.85,
    points: Array.from({ length: n }, (_, i) => {
      const t = T0 + i * stepSec * 1000;
      return { time: t, stec: tec(t) };
    }),
    arcStarts,
  };
}

const asResult = (s: IonoSeries): IonoResult => ({
  series: [s],
  maxStec: 25,
  meanStec: 20,
});

describe('computeIonoRate', () => {
  it('native sequential differences track the true dTEC/dt', () => {
    const rates = computeIonoRate(asResult(series(30, 240)));
    const values = rates[0]!.points.map((p) => p.value);
    const peak = Math.max(...values.map(Math.abs));
    expect(peak).toBeGreaterThan(RATE_PEAK * 0.95);
    expect(peak).toBeLessThan(RATE_PEAK * 1.05);
  });

  it('standardized 60 s baseline is sample-rate independent', () => {
    const at30s = computeIonoRate(asResult(series(30, 240)), 60);
    const at1s = computeIonoRate(asResult(series(1, 7200)), 60);
    const peak30 = Math.max(...at30s[0]!.points.map((p) => Math.abs(p.value)));
    const peak1 = Math.max(...at1s[0]!.points.map((p) => Math.abs(p.value)));
    expect(peak30).toBeCloseTo(peak1, 1);
    // ~1-min pairs from 1 s data: many more of them, same magnitude
    expect(at1s[0]!.points.length).toBeGreaterThan(
      at30s[0]!.points.length * 10
    );
  });

  it('never differences across an arc boundary', () => {
    // Two arcs with a 100 TECU step between them (a slip's signature):
    // the step must NOT appear in the rate series.
    const s = series(30, 100, [0, 50]);
    for (let i = 50; i < 100; i++) s.points[i]!.stec += 100;
    const rates = computeIonoRate(asResult(s));
    expect(rates[0]!.points).toHaveLength(98); // 49 + 49, not 99
    const peak = Math.max(...rates[0]!.points.map((p) => Math.abs(p.value)));
    expect(peak).toBeLessThan(1); // the 100 TECU step would read ~200/min
  });

  it('second undivided difference is near zero for smooth TEC', () => {
    const d2 = computeIonoRate(asResult(series(30, 240)), undefined, 2);
    const peak = Math.max(...d2[0]!.points.map((p) => Math.abs(p.value)));
    expect(peak).toBeLessThan(0.01); // curvature of the slow sinusoid only
  });
});

describe('detrendIonoArcs', () => {
  it('anchors every arc at its first observation', () => {
    const s = series(30, 100, [0, 50]);
    for (let i = 50; i < 100; i++) s.points[i]!.stec += 7; // arc bias
    const out = detrendIonoArcs(asResult(s));
    const pts = out.series[0]!.points;
    expect(pts[0]!.stec).toBe(0);
    expect(pts[50]!.stec).toBe(0);
    // Variation within each arc is preserved
    expect(pts[10]!.stec).toBeCloseTo(
      s.points[10]!.stec - s.points[0]!.stec,
      9
    );
  });
});
