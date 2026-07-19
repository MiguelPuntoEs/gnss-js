import { describe, it, expect } from 'vitest';
import { phiBPSK, phiBOCs, phiAltBOC, computePsdDb } from '../src/signals/psd';
import { CONSTELLATIONS, FREQ_GPS_L1 } from '../src/signals/definitions';

const F0 = 1.023e6;

describe('PSD functions', () => {
  it('BPSK peaks at f = 0 and nulls at multiples of the chip rate', () => {
    const peak = phiBPSK(0, F0, 1);
    expect(peak).toBeGreaterThan(0);
    // First null at n·f0
    expect(phiBPSK(F0, F0, 1)).toBeLessThan(peak * 1e-6);
    // Symmetric
    expect(phiBPSK(0.3 * F0, F0, 1)).toBeCloseTo(phiBPSK(-0.3 * F0, F0, 1), 12);
  });

  it('BOCs(1,1) has a null at f = 0 (split spectrum)', () => {
    const atZero = phiBOCs(1, F0, 1, 1); // f→0 limit, avoid exact 0/0
    const atSubcarrier = phiBOCs(F0, F0, 1, 1);
    expect(atSubcarrier).toBeGreaterThan(atZero);
  });

  it('AltBOC(15,10) concentrates power near ±15 f0, not at the carrier', () => {
    // Scan around the sub-carrier offset — the exact multiple can be a null
    let nearLobe = 0;
    for (let k = 14.0; k <= 16.0; k += 0.05) {
      nearLobe = Math.max(nearLobe, phiAltBOC(k * F0, F0, 15, 10));
    }
    const atZero = phiAltBOC(0.01 * F0, F0, 15, 10);
    expect(nearLobe).toBeGreaterThan(atZero);
  });
});

describe('computePsdDb', () => {
  it('returns a centered frequency axis with the peak at the carrier', () => {
    const { freqsMHz, psdDb } = computePsdDb(FREQ_GPS_L1, 2, 101, (f) =>
      phiBPSK(f, F0, 1)
    );
    expect(freqsMHz).toHaveLength(101);
    expect(psdDb).toHaveLength(101);
    // Center of the axis is the carrier
    expect(freqsMHz[50]).toBeCloseTo(FREQ_GPS_L1, 6);
    // BPSK peak at the carrier
    const max = Math.max(...psdDb);
    expect(psdDb[50]).toBeCloseTo(max, 6);
    // Non-positive φ values are clamped to the floor; all values finite
    for (const v of psdDb) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('signal catalog', () => {
  it('every catalogued signal sits in the L/S GNSS bands', () => {
    const signals = CONSTELLATIONS.flatMap((c) => c.signals);
    expect(signals.length).toBeGreaterThan(10);
    for (const s of signals) {
      expect(s.centerMHz, s.label).toBeGreaterThan(1000);
      expect(s.centerMHz, s.label).toBeLessThan(2600);
    }
  });
});
