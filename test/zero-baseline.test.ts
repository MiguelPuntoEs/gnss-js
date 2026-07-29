import { describe, it, expect } from 'vitest';
import { ZeroBaselineEngine } from '../src/positioning';
import type { RawObservation } from '../src/positioning/rtk';
import { C_LIGHT, FREQ } from '../src/constants/gnss';

/**
 * Synthetic zero-baseline: two receivers on one antenna. The rover's code/phase
 * differ from the reference only by a common relative clock c·Δdt(t) plus an
 * inter-system bias (GPS = datum, Galileo offset) — the exact model the engine
 * inverts. We recover Δdt and the Galileo ISB.
 */
const SATS = ['G01', 'G05', 'G12', 'G20', 'E03', 'E11', 'E24'];
const CODE: Record<string, string> = { G: '1C', E: '1C' };
const ISB_E = 0.42; // Galileo code ISB vs GPS (m)

function lambda(prn: string): number {
  return C_LIGHT / FREQ[prn[0]!]!['1']!;
}
/** Relative clock (m) at epoch index i — a constant + a slow linear drift. */
function clk(i: number): number {
  return 2.5 + 0.002 * i;
}
// Deterministic ±noise so the test is stable.
function jit(seed: number, amp: number): number {
  return amp * Math.sin(seed * 12.9898) * 0.5;
}

function epoch(i: number): {
  timeMs: number;
  obs: Record<string, RawObservation[]>;
} {
  const ref: RawObservation[] = [];
  const rov: RawObservation[] = [];
  for (let k = 0; k < SATS.length; k++) {
    const prn = SATS[k]!;
    const sys = prn[0]!;
    const basePr = 22_000_000 + k * 137_000 + i * 10; // arbitrary geometry
    const baseCp = basePr / lambda(prn) + k * 1000; // arbitrary ambiguity
    const isb = sys === 'E' ? ISB_E : 0;
    const dClk = clk(i);
    ref.push({ prn, code: CODE[sys]!, pr: basePr, cp: baseCp, lockTimeS: 100 });
    rov.push({
      prn,
      code: CODE[sys]!,
      // code SD = dClk + isb (+ mm noise); phase SD = dClk + isb (+ sub-mm).
      pr: basePr + dClk + isb + jit(i * 7 + k, 0.004),
      cp: baseCp + (dClk + isb + jit(i * 9 + k, 0.0004)) / lambda(prn),
      lockTimeS: 100,
    });
  }
  return { timeMs: 1_700_000_000_000 + i * 1000, obs: { REF: ref, ROV: rov } };
}

describe('ZeroBaselineEngine — single-difference relative clock + ISB', () => {
  it('recovers the relative clock and the Galileo ISB', () => {
    const eng = new ZeroBaselineEngine({
      reference: 'REF',
      referenceSystem: 'G',
    });
    const codeErr: number[] = [];
    const phaseErr: number[] = [];
    for (let i = 0; i < 120; i++) {
      const [s] = eng.process(epoch(i));
      expect(s!.receiver).toBe('ROV');
      // Code clock ≈ truth within its mm noise; phase clock tighter.
      codeErr.push(Math.abs(s!.clockOffsetM! - clk(i)));
      phaseErr.push(Math.abs(s!.clockOffsetPhaseM! - clk(i)));
      expect(s!.used).toBeGreaterThan(5);
      expect(s!.rejected).toBe(0);
    }
    // Code clock recovered to a few mm; residual RMS small.
    const meanCode = codeErr.reduce((a, b) => a + b, 0) / codeErr.length;
    expect(meanCode).toBeLessThan(0.01);
    // Phase-smoothed clock is tighter than the code clock.
    const meanPhase = phaseErr.reduce((a, b) => a + b, 0) / phaseErr.length;
    expect(meanPhase).toBeLessThan(meanCode);

    // Galileo ISB recovered.
    const isb = eng
      .biases()
      .find((b) => b.receiver === 'ROV' && b.system === 'E');
    expect(isb).toBeDefined();
    expect(isb!.biasM).toBeCloseTo(ISB_E, 2);
    // Datum system reports no ISB.
    expect(eng.biases().some((b) => b.system === 'G')).toBe(false);
  });

  it('handles a reference-only / empty epoch and reset()', () => {
    const eng = new ZeroBaselineEngine({ reference: 'REF' });
    expect(eng.process({ timeMs: 0, obs: { REF: [] } })).toEqual([]);
    eng.process(epoch(0));
    expect(eng.biases().length).toBeGreaterThan(0);
    eng.reset();
    expect(eng.biases()).toEqual([]);
  });
});
