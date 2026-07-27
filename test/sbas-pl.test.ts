import { describe, it, expect } from 'vitest';
import { sbasProtectionLevels } from '../src/positioning';

const D2R = Math.PI / 180;

/** A satellite row from az/el (deg) with a given error std (m). */
const sat = (azDeg: number, elDeg: number, sigmaM = 1) => ({
  azRad: azDeg * D2R,
  elRad: elDeg * D2R,
  variance: sigmaM * sigmaM,
});

// A decent-geometry SBAS set: one high sat + a spread ring.
const GEOM = [
  sat(0, 80),
  sat(45, 25),
  sat(135, 30),
  sat(225, 20),
  sat(315, 28),
  sat(180, 55),
];

describe('sbasProtectionLevels', () => {
  it('needs at least four satellites', () => {
    expect(sbasProtectionLevels(GEOM.slice(0, 3))).toBeNull();
    expect(sbasProtectionLevels(GEOM.slice(0, 4))).not.toBeNull();
  });

  it('returns positive, finite protection levels with VPL ≥ HPL', () => {
    const pl = sbasProtectionLevels(GEOM)!;
    expect(pl.hpl).toBeGreaterThan(0);
    expect(pl.vpl).toBeGreaterThan(0);
    expect(Number.isFinite(pl.hpl) && Number.isFinite(pl.vpl)).toBe(true);
    // Vertical is the weaker component in GNSS geometry — VPL exceeds HPL.
    expect(pl.vpl).toBeGreaterThan(pl.hpl);
    // The K-factor relationship: HPL = 6.0·d_major, VPL = 5.33·d_U.
    expect(pl.hpl).toBeCloseTo(6.0 * pl.dMajor, 6);
    expect(pl.vpl).toBeCloseTo(5.33 * pl.dU, 6);
  });

  it('scales with the measurement error (4× variance → 2× PL)', () => {
    const base = sbasProtectionLevels(GEOM)!;
    const noisier = sbasProtectionLevels(
      GEOM.map((s) => ({ ...s, variance: s.variance * 4 }))
    )!;
    expect(noisier.hpl / base.hpl).toBeCloseTo(2, 1);
    expect(noisier.vpl / base.vpl).toBeCloseTo(2, 1);
  });

  it('improves (lower PL) as geometry strengthens with more satellites', () => {
    const few = sbasProtectionLevels(GEOM.slice(0, 4))!;
    const many = sbasProtectionLevels(GEOM)!;
    expect(many.hpl).toBeLessThan(few.hpl);
    expect(many.vpl).toBeLessThan(few.vpl);
  });

  it('honours custom K-factors', () => {
    const a = sbasProtectionLevels(GEOM)!;
    const b = sbasProtectionLevels(GEOM, { kH: 12, kV: 12 })!;
    expect(b.hpl / a.hpl).toBeCloseTo(12 / 6.0, 6);
  });
});
