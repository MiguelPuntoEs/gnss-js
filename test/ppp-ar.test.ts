import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  parseBiasSinex,
  biasMetres,
  findSatBias,
} from '../src/rinex/bias-sinex';
import {
  resolvePppAmbiguities,
  fixPppPosition,
  nlWavelength,
  wlWavelength,
  type ArSat,
  type PppFixState,
} from '../src/positioning';
import { FREQ } from '../src/constants/gnss';

const FIX = join(__dirname, '..', 'test-fixtures');
const HAS_BIA = existsSync(join(FIX, 'ESA0OPSFIN_DCB.BIA'));

/* ------------------------------------------------------------------ */
/*  Bias-SINEX parser                                                  */
/* ------------------------------------------------------------------ */

// A minimal synthetic Bias-SINEX with satellite phase OSBs — the record
// kind PPP-AR needs (the real ESA fixture carries only code DSBs).
const SYNTH_OSB = `%=BIA 1.00 TST 2024:001:00000 TST 2024:001:00000 2024:002:00000 R 00000010
+BIAS/SOLUTION
*BIAS SVN_ PRN STATION__ OBS1 OBS2 BIAS_START____ BIAS_END______ UNIT __ESTIMATED_VALUE____ _STD_DEV___
 OSB  G001 G01           L1C       2024:001:00000 2024:002:00000 ns   0.123456789012345E+00 .100000E-02
 OSB  G001 G01           L2W       2024:001:00000 2024:002:00000 ns   -.234567890123456E+00 .100000E-02
 DSB  G001 G01           C1W  C2W  2024:001:00000 2024:002:00000 ns   0.500000000000000E+01 .100000E-02
-BIAS/SOLUTION
`;

describe('Bias-SINEX parser', () => {
  it('parses satellite phase OSB and code DSB records', () => {
    const b = parseBiasSinex(SYNTH_OSB);
    expect(b.records.length).toBe(3);
    const l1 = findSatBias(b, 'G01', 'L1C');
    expect(l1).not.toBeNull();
    expect(l1!.type).toBe('OSB');
    expect(l1!.value).toBeCloseTo(0.123456789, 6);
    expect(l1!.unit).toBe('ns');
    // ns → m via c.
    expect(biasMetres(l1!)).toBeCloseTo(0.123456789e-9 * 299792458, 6);
    // OSB is single-observable: lookup with obs2 must not match it.
    expect(findSatBias(b, 'G01', 'L1C', 'L2W')).toBeNull();
    // DSB by its pair.
    const dsb = findSatBias(b, 'G01', 'C1W', 'C2W');
    expect(dsb!.type).toBe('DSB');
    expect(dsb!.value).toBeCloseTo(5.0, 6);
    // Validity window filtering.
    expect(
      findSatBias(b, 'G01', 'L1C', undefined, Date.UTC(2024, 0, 1, 12))
    ).not.toBeNull();
    expect(
      findSatBias(b, 'G01', 'L1C', undefined, Date.UTC(2023, 0, 1))
    ).toBeNull();
  });

  it.skipIf(!HAS_BIA)('parses the real ESA bias-SINEX file', () => {
    const b = parseBiasSinex(
      readFileSync(join(FIX, 'ESA0OPSFIN_DCB.BIA'), 'utf8')
    );
    expect(b.records.length).toBeGreaterThan(50);
    // Galileo E01 C1C–C5Q DSB ≈ −0.3587 ns (from the file).
    const e01 = findSatBias(b, 'E01', 'C1C', 'C5Q');
    expect(e01).not.toBeNull();
    expect(e01!.type).toBe('DSB');
    expect(e01!.value).toBeCloseTo(-0.3587, 3);
    expect(e01!.unit).toBe('ns');
  });
});

/* ------------------------------------------------------------------ */
/*  PPP-AR resolver (synthetic, known-integer)                         */
/* ------------------------------------------------------------------ */

const F1 = FREQ.G!['1']!;
const F2 = FREQ.G!['2']!;

/** Build synthetic AR inputs with known integers and a diagonal covariance. */
function synth(
  truth: { prn: string; n1: number; nWl: number; elevDeg: number }[],
  ambStd: number, // per-satellite IF ambiguity std (m)
  noiseM: number[] // aIF error injected per satellite (m)
): { sats: ArSat[]; Q: Float64Array } {
  const lNl = nlWavelength(F1, F2);
  const sats: ArSat[] = truth.map((t, i) => {
    const aIF = lNl * t.n1 + lNl * (F2 / (F1 - F2)) * t.nWl + (noiseM[i] ?? 0);
    return {
      prn: t.prn,
      aIF,
      mwCyc: t.nWl, // MW already de-biased (wlBias 0)
      f1: F1,
      f2: F2,
      elevDeg: t.elevDeg,
    };
  });
  const n = truth.length;
  const Q = new Float64Array(n * n);
  for (let i = 0; i < n; i++) Q[i * n + i] = ambStd * ambStd;
  return { sats, Q };
}

describe('PPP-AR resolver', () => {
  const TRUTH = [
    { prn: 'G05', n1: 12, nWl: -3, elevDeg: 70 },
    { prn: 'G13', n1: -7, nWl: 5, elevDeg: 45 },
    { prn: 'G20', n1: 3, nWl: 1, elevDeg: 30 },
    { prn: 'G24', n1: -1, nWl: -2, elevDeg: 25 },
  ];

  it('recovers the correct integers from noise-free floats', () => {
    const { sats, Q } = synth(TRUTH, 0.02, [0, 0, 0, 0]);
    const r = resolvePppAmbiguities(sats, Q);
    expect(r.fixed).toBe(true);
    expect(r.ratio).toBeGreaterThan(3);
    // Reference is the highest-elevation satellite (G05).
    expect(r.refPrn).toBe('G05');
    // Between-satellite N1 differences must match truth exactly.
    const byPrn = new Map(r.sats.map((s) => [s.prn, s]));
    for (const t of TRUTH) {
      expect(byPrn.get(t.prn)!.nWl).toBe(t.nWl);
      const sdTruth = t.n1 - 12; // relative to G05 (n1 = 12)
      const sdFix = byPrn.get(t.prn)!.n1 - byPrn.get('G05')!.n1;
      expect(sdFix).toBe(sdTruth);
    }
  });

  it('still fixes under sub-decimetre ambiguity noise', () => {
    const { sats, Q } = synth(TRUTH, 0.03, [0.02, -0.015, 0.01, -0.02]);
    const r = resolvePppAmbiguities(sats, Q);
    expect(r.fixed).toBe(true);
    const byPrn = new Map(r.sats.map((s) => [s.prn, s]));
    const sdFix = byPrn.get('G13')!.n1 - byPrn.get('G05')!.n1;
    expect(sdFix).toBe(-7 - 12);
  });

  it('declines to fix when the float ambiguities are genuinely ambiguous', () => {
    // Put every between-satellite N1 float exactly on a half-integer (ref
    // error 0, all others +0.5 cycle): best and second-best integer grids
    // are equidistant ⇒ ratio ≈ 1 ⇒ the ratio test must decline.
    const lNl = nlWavelength(F1, F2);
    const { sats, Q } = synth(TRUTH, 0.05, [
      0,
      0.5 * lNl,
      0.5 * lNl,
      0.5 * lNl,
    ]);
    const r = resolvePppAmbiguities(sats, Q);
    expect(r.fixed).toBe(false);
    expect(r.ratio).toBeLessThan(3);
  });

  it('rejects a satellite whose wide-lane does not round confidently', () => {
    const { sats, Q } = synth(TRUTH, 0.02, [0, 0, 0, 0]);
    sats[2]!.mwCyc = 1.5; // G20 halfway between integers
    const r = resolvePppAmbiguities(sats, Q);
    expect(r.rejectedWl).toContain('G20');
    expect(r.sats.find((s) => s.prn === 'G20')).toBeUndefined();
  });

  it('applies satellite phase biases before rounding', () => {
    const { sats, Q } = synth(TRUTH, 0.02, [0, 0, 0, 0]);
    // Inject a WL bias so the raw MW is fractional; de-bias must recover it.
    for (const s of sats) {
      s.mwCyc = s.mwCyc + 0.3;
      s.wlBiasCyc = 0.3;
    }
    const r = resolvePppAmbiguities(sats, Q);
    expect(r.fixed).toBe(true);
    expect(r.rejectedWl.length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Ambiguity-fixed position (covariance conditioning)                 */
/* ------------------------------------------------------------------ */

describe('fixPppPosition', () => {
  const lamNl = nlWavelength(F1, F2);
  const lamWl = wlWavelength(F1, F2);
  const factor = F2 / (F1 - F2);
  void lamWl;

  /** IF ambiguity (m) implied by integer N1 / N_WL (zero FCBs). */
  const aif = (n1: number, nWl: number) => lamNl * n1 + lamNl * factor * nWl;

  const TRUTH = [
    { prn: 'G05', n1: 8, nWl: -2, elevDeg: 70 },
    { prn: 'G13', n1: -4, nWl: 3, elevDeg: 50 },
    { prn: 'G20', n1: 2, nWl: 1, elevDeg: 35 },
  ];

  /** Build a fix-state: position + 3 ambiguities, block-diagonal-ish PD cov. */
  function state(offsets: number[]): PppFixState {
    const nAmb = TRUTH.length;
    const n = 3 + nAmb; // [X,Y,Z, amb...]
    const P: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    // Position covariance (m²) and ambiguity covariance (m²), with a small
    // position↔ambiguity cross-correlation so a fixed ambiguity moves position.
    for (let i = 0; i < 3; i++) P[i]![i] = 0.04; // 20 cm
    for (let a = 0; a < nAmb; a++) {
      const i = 3 + a;
      P[i]![i] = 0.02 * 0.02; // 2 cm ambiguity σ
      for (let r = 0; r < 3; r++) {
        // Satellite-dependent position↔ambiguity cross-cov (different geometry
        // per satellite) so between-satellite differences don't cancel it.
        P[r]![i] = P[i]![r] = 1e-3 * (a + 1) * (1 + 0.1 * r);
      }
    }
    return {
      position: [1000, 2000, 3000],
      covariance: P,
      ambiguities: TRUTH.map((t, a) => ({
        prn: t.prn,
        index: 3 + a,
        aIF: aif(t.n1, t.nWl) + (offsets[a] ?? 0),
        mwCyc: t.nWl, // zero FCB ⇒ rounds to nWl
        f1: F1,
        f2: F2,
        elevDeg: t.elevDeg,
      })),
    };
  }

  const zeroFcb = {
    satWlFcb: new Map<string, number>(),
    satNlFcb: new Map<string, number>(),
  };

  it('fixes and leaves the position unchanged when floats are on integers', () => {
    const r = fixPppPosition(state([0, 0, 0]), zeroFcb, { ratioThreshold: 2 });
    expect(r.fixed).toBe(true);
    expect(r.refPrn).toBe('G05'); // highest elevation
    expect(r.nFixed).toBe(2); // 3 kept − 1 reference
    // z = 0 ⇒ no correction.
    expect(Math.hypot(...r.shift)).toBeLessThan(1e-9);
    expect(r.position).toEqual([1000, 2000, 3000]);
  });

  it('shifts the position toward the fixed integers when floats are offset', () => {
    // Offset one satellite's ambiguity by +3 cm (< half a narrow-lane, so it
    // still rounds to the same integer) — the fix must pull the position.
    const r = fixPppPosition(state([0, 0.03, 0]), zeroFcb, {
      ratioThreshold: 2,
    });
    expect(r.fixed).toBe(true);
    const mag = Math.hypot(...r.shift);
    expect(mag).toBeGreaterThan(0);
    expect(mag).toBeLessThan(0.03); // bounded by the ambiguity offset
    // The fixed position differs from the float by exactly `shift`.
    expect(r.position[1] - r.floatPosition[1]).toBeCloseTo(r.shift[1], 12);
  });

  it('returns the float position unchanged when it cannot fix', () => {
    // Put the single-difference ambiguity on a half-integer ⇒ ratio ≈ 1.
    const r = fixPppPosition(state([0, 0.5 * lamNl, 0]), zeroFcb, {
      ratioThreshold: 3,
    });
    expect(r.fixed).toBe(false);
    expect(r.position).toEqual(r.floatPosition);
    expect(Math.hypot(...r.shift)).toBe(0);
  });
});
