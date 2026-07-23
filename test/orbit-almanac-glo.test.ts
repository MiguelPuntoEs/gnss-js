import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseSbfAlmanac } from '../src/sbf/nav';
import type { SbfGlonassAlmanac } from '../src/sbf/nav';
import {
  glonassAlmanacPosition,
  glonassAlmanacEpochMs,
} from '../src/orbit/almanac-glo';

const ALM_FILE = join(__dirname, '../test-fixtures/dlf2_alm_slice.sbf');

const dist = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * GLONASS ICD Edition 5.1 (2008), Appendix A.3.2.3 — the worked
 * example of coordinate calculation from almanac. Input almanac
 * (semicircle fields converted to rad, matching the SBF decoder's
 * normalization): NA = 615 of the four-year interval N4 = 2
 * (2001-09-06). weekAlm/toaSec are the GPS week/tow of that day; the
 * propagator derives its epoch from n4/nDay/tLambda, not from them.
 */
const ICD_ALM: SbfGlonassAlmanac = {
  system: 'R',
  prn: 'R01',
  freqNr: 0,
  weekAlm: 1130,
  toaSec: 366900,
  epsilon: 0.00148201,
  lambda: -0.189986229 * Math.PI,
  tLambda: 27122.09375,
  deltaI: 0.011929512 * Math.PI,
  omega: 0.4402771 * Math.PI,
  deltaT: -2655.76171875,
  deltaTDot: 0.000549316,
  tau: 0,
  health: 1,
  nDay: 615,
  n4: 2,
};

/** Example query instant: ti = 33300 s (Moscow) of day N0 = 615. */
const ICD_TI_SEC = 33300;
/** True sidereal time at Greenwich midnight of day N0 (given). */
const ICD_S0 = 6.02401539573;
/** Earth rotation rate used by the ICD algorithm, rad/s. */
const OMEGA_Z = 0.7292115e-4;
/** Expected coordinates in the absolute (inertial) frame OXaYaZa, m. */
const ICD_EXPECTED_INERTIAL = {
  x: 10947.021572e3,
  y: 13078.978287e3,
  z: 18922.063362e3,
};

describe('glonassAlmanacPosition — ICD 5.1 A.3.2.3 worked example', () => {
  // ti − tλ keeps the test independent of the leap-second table (the
  // epoch helper and this offset use the same scale by construction).
  const timeMs =
    glonassAlmanacEpochMs(ICD_ALM) + (ICD_TI_SEC - ICD_ALM.tLambda) * 1000;

  it('reproduces the expected coordinates to sub-metre level', () => {
    // The ICD result is inertial (offset from Greenwich by true
    // sidereal time); rotate it to ECEF with S(ti) = S0 + ωз(ti − 3ʰ)
    // — ti is Moscow time, so ti − 10800 s is the Greenwich instant.
    const s = ICD_S0 + OMEGA_Z * (ICD_TI_SEC - 10800);
    const expected = {
      x:
        ICD_EXPECTED_INERTIAL.x * Math.cos(s) +
        ICD_EXPECTED_INERTIAL.y * Math.sin(s),
      y:
        -ICD_EXPECTED_INERTIAL.x * Math.sin(s) +
        ICD_EXPECTED_INERTIAL.y * Math.cos(s),
      z: ICD_EXPECTED_INERTIAL.z,
    };
    const pos = glonassAlmanacPosition(ICD_ALM, timeMs);
    // Observed agreement: 0.14 m (the ICD prints mm precision; the
    // residual is its own convergence/rounding).
    expect(dist(pos, expected)).toBeLessThan(1);
  });

  it('keeps a nominal orbit radius at the example instant', () => {
    const pos = glonassAlmanacPosition(ICD_ALM, timeMs);
    const r = Math.hypot(pos.x, pos.y, pos.z);
    expect(r).toBeGreaterThan(25.4e6);
    expect(r).toBeLessThan(25.6e6);
  });

  it('reports −τnA as the clock bias (repo tauN sign convention)', () => {
    const alm = { ...ICD_ALM, tau: 42e-6 };
    expect(glonassAlmanacPosition(alm, timeMs).clockBias).toBe(-42e-6);
    expect(glonassAlmanacPosition(alm, timeMs + 86400_000).clockBias).toBe(
      -42e-6
    );
  });
});

describe.skipIf(!existsSync(ALM_FILE))(
  'glonassAlmanacPosition (DLF2 GLOAlm fixture)',
  () => {
    const glo = existsSync(ALM_FILE)
      ? (parseSbfAlmanac(
          new Uint8Array(readFileSync(ALM_FILE))
        ).almanacs.filter((a) => a.system === 'R') as SbfGlonassAlmanac[])
      : null!;

    it('decodes GLONASS almanacs from the slice', () => {
      expect(glo.length).toBeGreaterThan(0);
    });

    it('sits on the ascending node at the almanac epoch tλ', () => {
      // At tλ the satellite crosses the equator northbound at
      // Greenwich longitude λ — the ICD's own definition of the
      // almanac reference. This pins the N4/NA/tλ (Moscow time)
      // epoch reconstruction and the Greenwich node handling.
      for (const alm of glo) {
        const p = glonassAlmanacPosition(alm, glonassAlmanacEpochMs(alm));
        expect(Math.abs(p.z)).toBeLessThan(1); // metres
        expect(Math.atan2(p.y, p.x)).toBeCloseTo(alm.lambda, 9);
      }
    });

    it('holds a nominal orbit radius across ±3 days', () => {
      for (const alm of glo) {
        const t0 = glonassAlmanacEpochMs(alm);
        for (let day = -3; day <= 3; day++) {
          for (const frac of [0, 0.29, 0.61]) {
            const p = glonassAlmanacPosition(
              alm,
              t0 + (day + frac) * 86400_000
            );
            const r = Math.hypot(p.x, p.y, p.z);
            expect(r).toBeGreaterThan(25.4e6);
            expect(r).toBeLessThan(25.6e6);
          }
        }
      }
    });

    it('does not fold multi-day offsets into a half-week window', () => {
      const alm = glo[0]!;
      const t0 = glonassAlmanacEpochMs(alm);
      // A ±302400 s fold would alias +5 d onto −2 d.
      const plus5d = glonassAlmanacPosition(alm, t0 + 5 * 86400_000);
      const minus2d = glonassAlmanacPosition(alm, t0 - 2 * 86400_000);
      expect(dist(plus5d, minus2d)).toBeGreaterThan(1e5);
      const r = Math.hypot(plus5d.x, plus5d.y, plus5d.z);
      expect(r).toBeGreaterThan(25.4e6);
      expect(r).toBeLessThan(25.6e6);
    });
  }
);
