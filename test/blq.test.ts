import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  oceanLoadingEnu,
  parseBlq,
  type OceanLoadingCoefficients,
} from '../src/positioning/ocean-loading';
import { parseBlqFile, writeBlq } from '../src/positioning/blq';
import { oceanLoadingEnuIers } from '../src/positioning/ocean-loading-iers';

// Onsala-service BLQ (FES2004, 2013) for ONSA, REYK and WTZR, sliced from
// DSOlab/iers2010 data/NTUA.BLQ (header kept whole).
const text = readFileSync(
  join(__dirname, '..', 'test-fixtures', 'ntua_blq_slice.blq'),
  'utf8'
);
const lines = (t: string) => t.split(/\r?\n/).map((l) => l.trimEnd());

/* IERS Conventions (2010) ch. 7 HARDISP.F test case (2009-06-25 01:10:45
 * UTC, 24 hourly epochs), numbers copied from the program's header. Its
 * Onsala coefficients are the ONSA block of the fixture, digit for digit;
 * Reykjavik's (CSR4.0) are given here. Output columns: dU, dS, dW (m). */
const HARDISP_ONSALA = `
      0.003094     -0.001538     -0.000895
      0.001812     -0.000950     -0.000193
      0.000218     -0.000248      0.000421
     -0.001104      0.000404      0.000741
     -0.001668      0.000863      0.000646
     -0.001209      0.001042      0.000137
      0.000235      0.000926     -0.000667
      0.002337      0.000580     -0.001555
      0.004554      0.000125     -0.002278
      0.006271     -0.000291     -0.002615
      0.006955     -0.000537     -0.002430
      0.006299     -0.000526     -0.001706
      0.004305     -0.000244     -0.000559
      0.001294      0.000245      0.000793
     -0.002163      0.000819      0.002075
     -0.005375      0.001326      0.003024
     -0.007695      0.001622      0.003448
     -0.008669      0.001610      0.003272
     -0.008143      0.001262      0.002557
     -0.006290      0.000633      0.001477
     -0.003566     -0.000155      0.000282
     -0.000593     -0.000941     -0.000766
      0.001992     -0.001561     -0.001457
      0.003689     -0.001889     -0.001680`;
const REYKJAVIK_BLQ = `  REYKJAVIK
  .02359 .01481 .00448 .00419 .00273 .00033 .00088 .00005 .00081 .00034 .00034
  .00514 .00280 .00089 .00078 .00106 .00074 .00035 .00018 .00004 .00001 .00003
  .00209 .00077 .00051 .00021 .00151 .00066 .00047 .00019 .00014 .00008 .00006
    78.5  102.3   76.3  104.1  -52.0 -160.4  -52.6 -128.0 -174.8 -175.7 -178.1
    54.2   93.8   38.9   96.9    2.3  -12.5    3.1  -31.6 -144.4 -122.6 -173.5
   156.2 -167.1  141.9 -164.9  155.9  178.7  155.6 -168.5  177.7  178.7  179.7`;
const HARDISP_REYKJAVIK = `
     -0.005940     -0.001245     -0.000278
      0.013516     -0.001086      0.003212
      0.029599     -0.000353      0.005483
      0.038468      0.000699      0.005997
      0.038098      0.001721      0.004690
      0.028780      0.002363      0.001974
      0.013016      0.002371     -0.001369
     -0.005124      0.001653     -0.004390
     -0.021047      0.000310     -0.006225
     -0.030799     -0.001383     -0.006313
     -0.032056     -0.003048     -0.004549
     -0.024698     -0.004288     -0.001314
     -0.010814     -0.004794      0.002623
      0.005849     -0.004416      0.006291
      0.020857     -0.003208      0.008766
      0.030226     -0.001413      0.009402
      0.031437      0.000594      0.007996
      0.024079      0.002389      0.004844
      0.009945      0.003606      0.000663
     -0.007426      0.004022     -0.003581
     -0.023652      0.003601     -0.006911
     -0.034618      0.002505     -0.008585
     -0.037515      0.001044     -0.008270
     -0.031544     -0.000402     -0.006125`;
const T0 = Date.UTC(2009, 5, 25, 1, 10, 45);

const table = (s: string) =>
  s
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number) as [number, number, number]);
const rms = (v: number[]) =>
  Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length);

/** RMS of (ours − HARDISP) per ENU component, and of HARDISP's signal,
 *  under a given mapping of HARDISP (dU, dS, dW) to (E, N, U). */
function compare(
  c: OceanLoadingCoefficients,
  expected: [number, number, number][],
  map: (u: number, s: number, w: number) => [number, number, number]
) {
  const d: number[][] = [[], [], []];
  const sig: number[][] = [[], [], []];
  expected.forEach(([u, s, w], i) => {
    const ours = oceanLoadingEnu(c, T0 + i * 3600e3);
    const ref = map(u, s, w);
    for (let k = 0; k < 3; k++) {
      d[k]!.push(ours[k]! - ref[k]!);
      sig[k]!.push(ref[k]!);
    }
  });
  return {
    diff: d.map(rms),
    signal: sig.map(rms),
    max: d.map((x) => Math.max(...x.map(Math.abs))),
  };
}
/** BLQ/HARDISP south, west → East = −west, North = −south. */
const SPEC = (u: number, s: number, w: number): [number, number, number] => [
  -w,
  -s,
  u,
];

describe('writeBlq — round trip', () => {
  it('writes the Onsala file back line for line', () => {
    expect(lines(writeBlq(parseBlqFile(text)))).toEqual(lines(text));
  });

  it('agrees with parseBlq and survives write → parse from a bare map', () => {
    const m = parseBlq(text);
    expect([...m.keys()]).toEqual(['ONSA', 'REYK', 'WTZR']);
    for (const s of parseBlqFile(text).stations)
      expect(s.coefficients).toEqual(m.get(s.name));
    const back = parseBlq(writeBlq(m));
    expect(back).toEqual(m);
  });

  it('keeps the printed precision: F7.5 m amplitudes, F7.1° phases', () => {
    const c = parseBlq(text).get('ONSA')!;
    const odd: OceanLoadingCoefficients = {
      amplitude: c.amplitude.map((a) => a.map((v) => v + 1.2e-6) as typeof a),
      phase: c.phase.map((p) => p.map((v) => v + 0.04) as typeof p),
    };
    const back = parseBlq(writeBlq(new Map([['X', odd]]))).get('X')!;
    expect(back).toEqual(c);
  });
});

describe('BLQ — spec oracle (Onsala header, HARDISP)', () => {
  const f = parseBlqFile(text);
  const onsa = f.stations[0]!;

  it('reads rows as radial/west/south amplitude then phase', () => {
    // Row 1, column 1: M2 radial amplitude .00352 m; row 2 col 5 K1
    // tangential EW .00053 m; row 6 col 6 O1 NS phase −55.1°.
    expect(onsa.coefficients.amplitude[0]![0]).toBe(0.00352);
    expect(onsa.coefficients.amplitude[4]![1]).toBe(0.00053);
    expect(onsa.coefficients.amplitude[4]![2]).toBe(0.00029);
    expect(onsa.coefficients.phase[5]![2]).toBe(-55.1);
    expect(onsa.coefficients.phase[0]).toEqual([-64.7, 85.5, 109.5]);
    // "lon/lat:   11.9255   57.3953   45.534" — longitude first.
    expect([onsa.lon, onsa.lat, onsa.height]).toEqual([
      11.9255, 57.3953, 45.534,
    ]);
    expect(f.stations[1]!.lon).toBe(338.0445); // REYK, 0–360 °E as written
    expect(f.header).toContain(
      '$$ Displacement is defined positive in upwards, South and West direction.'
    );
  });

  it('reproduces the IERS HARDISP Onsala test output', () => {
    const r = compare(onsa.coefficients, table(HARDISP_ONSALA), SPEC);
    // 11 constituents without nodal corrections vs HARDISP's 342 with:
    // ≤ 0.65 mm (U), 0.18 mm (N), 0.25 mm (E) on a ±8.7 mm signal.
    for (const m of r.max) expect(m).toBeLessThan(0.0008);
    for (let k = 0; k < 3; k++)
      expect(r.diff[k]!).toBeLessThan(0.2 * r.signal[k]!);
  });

  it('reproduces the IERS HARDISP Reykjavik test output', () => {
    const c = parseBlq(REYKJAVIK_BLQ).get('REYKJAVIK')!;
    const r = compare(c, table(HARDISP_REYKJAVIK), SPEC);
    // Larger tides, same ≈10 % model gap (no nodal modulation): ≤ 4.2 mm U
    // on ±38 mm, ≤ 0.7 mm horizontal.
    expect(r.max[2]).toBeLessThan(0.005);
    expect(Math.max(r.max[0]!, r.max[1]!)).toBeLessThan(0.001);
    for (let k = 0; k < 3; k++)
      expect(r.diff[k]!).toBeLessThan(0.15 * r.signal[k]!);
  });
});

describe('BLQ — convention locks', () => {
  const onsa = parseBlq(text).get('ONSA')!;
  const exp = table(HARDISP_ONSALA);

  it('west/south are flipped into East/North, not swapped or kept', () => {
    const ok = compare(onsa, exp, SPEC);
    const wrong = {
      'west as east': (u: number, s: number, w: number) => [w, -s, u],
      'south as north': (u: number, s: number, w: number) => [-w, s, u],
      'E/N swapped': (u: number, s: number, w: number) => [-s, -w, u],
    } as Record<
      string,
      (u: number, s: number, w: number) => [number, number, number]
    >;
    for (const [name, map] of Object.entries(wrong)) {
      const r = compare(onsa, exp, map);
      const k = name === 'south as north' ? 1 : 0;
      expect(r.diff[k], name).toBeGreaterThan(5 * ok.diff[k]!);
    }
  });

  it('phase is a Greenwich lag: +φ delays the tide by φ/ω', () => {
    // M2 only, radial: lag 30° = 30/360 of 12.4206 h later.
    const one = (lag: number): OceanLoadingCoefficients => ({
      amplitude: onsa.amplitude.map((_, i) =>
        i === 0 ? [0.01, 0, 0] : [0, 0, 0]
      ),
      phase: onsa.phase.map((_, i) => (i === 0 ? [lag, 0, 0] : [0, 0, 0])),
    });
    const dt = (30 / 360) * 12.4206012 * 3600e3;
    for (let h = 0; h < 12; h++) {
      const t = T0 + h * 3600e3;
      expect(oceanLoadingEnu(one(30), t + dt)[2]).toBeCloseTo(
        oceanLoadingEnu(one(0), t)[2],
        6
      );
    }
  });

  it('writer puts west in row 2 and south in row 3 (asymmetric values)', () => {
    const z = onsa.amplitude.map(() => [0, 0, 0] as [number, number, number]);
    const amp = z.map((a, i) =>
      i === 0 ? ([0.001, 0.002, 0.003] as typeof a) : a
    );
    const ph = z.map((a, i) => (i === 0 ? ([10, 20, 30] as typeof a) : a));
    const out = lines(
      writeBlq(new Map([['TEST', { amplitude: amp, phase: ph }]]))
    );
    const at = out.indexOf('  TEST');
    expect(
      out.slice(at + 1, at + 7).map((l) => l.trim().split(/\s+/)[0])
    ).toEqual(['.00100', '.00200', '.00300', '10.0', '20.0', '30.0']);
  });
});

describe('oceanLoadingEnuIers — nodal modulation + minor tides (IERS 7.1.2)', () => {
  const onsa = parseBlqFile(text).stations[0]!.coefficients;
  const rey = parseBlq(REYKJAVIK_BLQ).get('REYKJAVIK')!;
  const run = (
    c: OceanLoadingCoefficients,
    exp: string,
    opts?: Parameters<typeof oceanLoadingEnuIers>[2]
  ) => {
    const d: number[][] = [[], [], []];
    table(exp).forEach((row, i) => {
      const ours = oceanLoadingEnuIers(c, T0 + i * 3600e3, opts);
      const ref = SPEC(...row);
      for (let k = 0; k < 3; k++) d[k]!.push(ours[k]! - ref[k]!);
    });
    return { max: d.map((x) => Math.max(...x.map(Math.abs))), rms: d.map(rms) };
  };

  it('without nodal/minor terms it is the 11-constituent model (Doodson arguments = ARG)', () => {
    for (let h = 0; h < 48; h += 3) {
      const t = T0 + h * 3600e3;
      const a = oceanLoadingEnu(rey, t);
      const b = oceanLoadingEnuIers(rey, t, {
        nodal: false,
        minorTides: false,
      });
      for (let k = 0; k < 3; k++)
        expect(Math.abs(a[k]! - b[k]!)).toBeLessThan(2e-5);
    }
  });

  it('Reykjavik: 4.1 mm → < 1 mm max (0.54 mm RMS) against HARDISP', () => {
    const r = run(rey, HARDISP_REYKJAVIK);
    expect(r.max[2]).toBeLessThan(0.001);
    expect(r.rms[2]).toBeLessThan(0.0006);
    expect(Math.max(r.max[0]!, r.max[1]!)).toBeLessThan(0.00025);
    // Nodal modulation alone is only part of the gap; the minor tides are most of it.
    expect(
      run(rey, HARDISP_REYKJAVIK, { minorTides: false }).max[2]
    ).toBeGreaterThan(0.003);
  });

  it('Onsala: ≤ 0.2 mm against HARDISP', () => {
    for (const m of run(onsa, HARDISP_ONSALA).max)
      expect(m).toBeLessThan(0.0002);
  });
});
