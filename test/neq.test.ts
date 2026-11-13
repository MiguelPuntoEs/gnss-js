import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  addObservations,
  changeApriori,
  constrainParameters,
  moveToEpoch,
  neqFromCovariance,
  preEliminate,
  scaleNeq,
  solveNeq,
  stackNeqs,
  stationNeq,
  MS_PER_YEAR,
} from '../src/analysis/neq';
import {
  choleskyInPlace,
  choleskyInverse,
  choleskySolve,
  schurComplement,
} from '../src/analysis/neq-linalg';
import { solveWithDatum } from '../src/analysis/neq-datum';
import {
  NeqCombination,
  segmentsFromEvents,
  tieVelocities,
} from '../src/analysis/neq-combination';
import type {
  NeqParameter,
  NormalEquations,
} from '../src/analysis/normal-equations';
import {
  parseSinex,
  parseSinexDiscontinuities,
  parseSsc,
  sinexToNeq,
  writeSinexCovariance,
  writeSinexNeq,
} from '../src/rinex/sinex-neq';
import { parseSinexEpoch } from '../src/rinex/sinex-format';
import { parseSinexEstimates, writeSinex } from '../src/rinex/sinex';
import { geodeticToEcef } from '../src/coordinates/ecef';

/** Deterministic pseudo-random numbers (LCG → normal). */
function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

const deg = Math.PI / 180;
const SITES = [
  ['WTZR', 49.14, 12.88],
  ['POTS', 52.38, 13.07],
  ['ONSA', 57.4, 11.93],
  ['BRUX', 50.8, 4.36],
  ['ZIMM', 46.88, 7.47],
  ['GRAZ', 47.07, 15.49],
  ['JOZE', 52.1, 21.03],
  ['MATE', 40.65, 16.7],
] as const;
const XYZ = SITES.map(([, la, lo]) => geodeticToEcef(la * deg, lo * deg, 500));
const T0 = Date.UTC(2020, 0, 1);

/**
 * A free network NEQ of station positions observed with σ per coordinate
 * but blind to a common translation (N = (I − 11ᵀ/m) ⊗ I₃ / σ²), observed
 * values `obs`, a-priori `apr`.
 */
function freeNeq(
  sites: readonly string[],
  obs: readonly (readonly number[])[],
  apr: readonly (readonly number[])[],
  epochMs: number,
  sigma = 0.002
): NormalEquations {
  const m = sites.length;
  const n = 3 * m;
  const params: NeqParameter[] = [];
  sites.forEach((site, s) =>
    ['STAX', 'STAY', 'STAZ'].forEach((type, k) =>
      params.push({
        type,
        site,
        solnId: '1',
        refEpochMs: epochMs,
        apriori: apr[s]![k]!,
        unit: 'm',
      })
    )
  );
  const N = new Float64Array(n * n);
  for (let a = 0; a < m; a++)
    for (let c = 0; c < m; c++)
      for (let k = 0; k < 3; k++)
        N[(3 * a + k) * n + 3 * c + k] =
          ((a === c ? 1 : 0) - 1 / m) / sigma ** 2;
  const d = new Float64Array(n);
  for (let s = 0; s < m; s++)
    for (let k = 0; k < 3; k++) d[3 * s + k] = obs[s]![k]! - apr[s]![k]!;
  const b = new Float64Array(n);
  let ltpl = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) b[i] += N[i * n + j]! * d[j]!;
    ltpl += d[i]! * b[i]!;
  }
  return {
    params,
    N,
    b,
    ltpl,
    nObs: n,
    nPreEliminated: 0,
    sigma0Apriori: 1,
    dataStartMs: epochMs - 43_200_000,
    dataEndMs: epochMs + 43_200_000,
  };
}

/** A small regular NEQ (random SPD). */
function randomNeq(n: number, seed: number): NormalEquations {
  const r = rng(seed);
  const A = Array.from({ length: n + 4 }, () =>
    Array.from({ length: n }, () => r())
  );
  const l = A.map(() => r());
  const N = new Float64Array(n * n);
  const b = new Float64Array(n);
  A.forEach((row, o) => {
    for (let i = 0; i < n; i++) {
      b[i] += row[i]! * l[o]!;
      for (let j = 0; j < n; j++) N[i * n + j] += row[i]! * row[j]!;
    }
  });
  return {
    params: Array.from({ length: n }, (_, i) => ({
      type: 'TROTOT',
      site: `S${i}`,
      refEpochMs: 0,
      apriori: i * 0.1,
      unit: 'm',
    })),
    N,
    b,
    ltpl: l.reduce((s, v) => s + v * v, 0),
    nObs: n + 4,
    nPreEliminated: 0,
    sigma0Apriori: 1,
    dataStartMs: 0,
    dataEndMs: 0,
  };
}

describe('neq linear algebra', () => {
  it('Cholesky solve and inverse', () => {
    const q = randomNeq(7, 1);
    const L = q.N.slice();
    expect(choleskyInPlace(L, 7)).toBe(-1);
    const x = choleskySolve(L, 7, q.b);
    const inv = choleskyInverse(L, 7);
    for (let i = 0; i < 7; i++) {
      let s = 0;
      for (let j = 0; j < 7; j++) s += q.N[i * 7 + j]! * x[j]!;
      expect(s).toBeCloseTo(q.b[i]!, 10);
      for (let j = 0; j < 7; j++) {
        let e = 0;
        for (let k = 0; k < 7; k++) e += q.N[i * 7 + k]! * inv[k * 7 + j]!;
        expect(e).toBeCloseTo(i === j ? 1 : 0, 10);
      }
    }
  });
  it('flags a singular matrix', () => {
    const a = new Float64Array([1, 1, 1, 1]);
    expect(choleskyInPlace(a, 2)).toBe(1);
  });
  it('Schur complement = solving the full system', () => {
    const q = randomNeq(8, 2);
    const full = solveNeq(q);
    const r = schurComplement(q.N, q.b, 8, [0, 2, 5], [1, 3, 4, 6, 7]);
    const L = r.N.slice();
    choleskyInPlace(L, 3);
    const x = choleskySolve(L, 3, r.b);
    expect(x[0]).toBeCloseTo(full.dx[0]!, 10);
    expect(x[1]).toBeCloseTo(full.dx[2]!, 10);
    expect(x[2]).toBeCloseTo(full.dx[5]!, 10);
  });
});

describe('neq algebra', () => {
  it('pre-elimination keeps the solution, vᵀPv and dof', () => {
    const q = randomNeq(6, 3);
    const full = solveNeq(q);
    const red = solveNeq(preEliminate(q, (_, i) => i % 2 === 1));
    expect(red.params.map((p) => p.site)).toEqual(['S0', 'S2', 'S4']);
    expect(red.dx[1]).toBeCloseTo(full.dx[2]!, 10);
    expect(red.vtpv).toBeCloseTo(full.vtpv, 10);
    expect(red.dof).toBe(full.dof);
    expect(red.cov[4]).toBeCloseTo(full.cov[2 * 6 + 2]!, 10);
  });

  it('a-priori transformation leaves the estimate unchanged', () => {
    const q = randomNeq(5, 4);
    const a = solveNeq(q);
    const q2 = changeApriori(q, [1, -2, 3, 0.5, 7]);
    const b = solveNeq(q2);
    for (let i = 0; i < 5; i++)
      expect(b.estimate[i]).toBeCloseTo(a.estimate[i]!, 10);
    expect(b.vtpv).toBeCloseTo(a.vtpv, 9);
  });

  it('stacking = one system with all observations', () => {
    const q = randomNeq(4, 5);
    const s = stackNeqs([q, changeApriori(q, [0.3, 0.2, 0.1, 0])]);
    const a = solveNeq(q);
    const b = solveNeq(s);
    for (let i = 0; i < 4; i++)
      expect(b.estimate[i]).toBeCloseTo(a.estimate[i]!, 10);
    expect(s.nObs).toBe(16);
    expect(b.vtpv).toBeCloseTo(2 * a.vtpv, 9);
    // Twice the data: half the variance, same σ̂₀ scale aside.
    expect(scaleNeq(q, 2).N[0]).toBe(2 * q.N[0]!);
  });

  it('covariance → NEQ removes the a-priori constraints', () => {
    const q = randomNeq(5, 6);
    const C0 = [4, 4, 4, 4, 4];
    const constrained = solveNeq(
      constrainParameters(q, () => true, 2) // σ = 2 → C0 = 4
    );
    const back = neqFromCovariance({
      params: q.params,
      estimate: constrained.estimate,
      cov: constrained.cov.map(
        (v) => v / (constrained.sigma0 ?? 1) ** 2 // unscaled covariance
      ),
      aprioriCov: C0,
    });
    for (let i = 0; i < 25; i++) expect(back.N[i]).toBeCloseTo(q.N[i]!, 8);
    const free = solveNeq(q);
    const again = solveNeq(back);
    for (let i = 0; i < 5; i++)
      expect(again.estimate[i]).toBeCloseTo(free.estimate[i]!, 8);
  });

  it('moves positions to another epoch with known velocities', () => {
    const q = freeNeq(['WTZR'], [XYZ[0]!], [XYZ[0]!], T0);
    const m = moveToEpoch(q, T0 + MS_PER_YEAR, () => [0.01, -0.02, 0.03]);
    expect(m.params[1]!.apriori - q.params[1]!.apriori).toBeCloseTo(-0.02, 9);
    expect(m.params[0]!.refEpochMs).toBe(T0 + MS_PER_YEAR);
  });

  it('addObservations counts pseudo-observations', () => {
    const q = randomNeq(3, 7);
    const c = addObservations(q, [{ terms: [[0, 1]], value: 0, sigma: 1 }]);
    expect(c.nObs).toBe(q.nObs + 1);
    expect(c.N[0]).toBe(q.N[0]! + 1);
  });
});

describe('minimum-constraint datum', () => {
  const sites = SITES.map((s) => s[0]);
  // Truth = reference; the solution sees it translated by 3 cm plus noise,
  // and one station is 4 cm off.
  const r = rng(11);
  const apr = XYZ.map((x) => x.map((v) => Math.round(v)));
  const obs = XYZ.map((x, i) =>
    x.map(
      (v, k) =>
        v +
        [0.03, -0.02, 0.01][k]! +
        r() * 0.0005 +
        (i === 3 && k === 2 ? 0.04 : 0)
    )
  );
  const neq = freeNeq(sites, obs, apr, T0);
  const reference = XYZ.map((xyz, i) => ({
    site: sites[i]!,
    xyz: xyz as [number, number, number],
    epochMs: T0,
  }));

  it('the free NEQ is singular', () => {
    expect(() => solveNeq(neq)).toThrow(/singular/);
  });

  it('NNT recovers the reference frame and rejects the bad station', () => {
    const sol = solveWithDatum(neq, {
      reference,
      position: 'translation',
      maxResidualHorizontalM: 0.005,
      maxResidualVerticalM: 0.015,
    });
    const bad = sol.datum.find((d) => d.site === 'BRUX')!;
    expect(bad.used).toBe(false);
    expect(sol.datum.filter((d) => d.used)).toHaveLength(7);
    // Good stations back on their reference to the noise level.
    for (let i = 0; i < 8; i++) {
      if (i === 3) continue;
      for (let k = 0; k < 3; k++)
        expect(Math.abs(sol.estimate[3 * i + k]! - XYZ[i]![k]!)).toBeLessThan(
          0.002
        );
    }
    expect(sol.iterations).toBe(2);
    // dof: 24 obs + 3 conditions − 24 unknowns
    expect(sol.dof).toBe(3);
  });

  it('NNT+NNR+NNS (similarity) on a translated network', () => {
    const sol = solveWithDatum(neq, {
      reference,
      position: 'similarity',
      iterate: false,
    });
    expect(sol.helmert).not.toBeNull();
    expect(sol.datum.every((d) => d.used)).toBe(true);
  });
});

describe('multi-year combination', () => {
  // Weekly free NEQs over 3 years with known velocities, a random frame
  // translation per week, an antenna change at WTZR (offset, same
  // velocity) and an earthquake at MATE (offset + new velocity).
  const r = rng(21);
  const vel = XYZ.map(() => [r() * 0.02, r() * 0.02, r() * 0.005]);
  const tEq = T0 + 1.5 * MS_PER_YEAR;
  const segments = segmentsFromEvents([
    { site: 'WTZR', tMs: T0 + MS_PER_YEAR, kind: 'equipment' },
    { site: 'MATE', tMs: tEq, kind: 'earthquake' },
  ]);
  const truth = (i: number, t: number) => {
    const dt = (t - T0) / MS_PER_YEAR;
    return XYZ[i]!.map((x, k) => {
      let v = x + vel[i]![k]! * dt;
      if (i === 0 && t >= T0 + MS_PER_YEAR) v += [0.01, 0, -0.02][k]!;
      if (i === 7 && t >= tEq) v += 0.03 + 0.01 * ((t - tEq) / MS_PER_YEAR);
      // annual signal in height-ish (Z) at JOZE
      if (i === 6 && k === 2) v += 0.003 * Math.sin(2 * Math.PI * dt);
      return v;
    });
  };
  const sites = SITES.map((s) => s[0]);

  function combined(periodic: 'none' | 'annual') {
    const comb = new NeqCombination({
      epochMs: T0,
      segments,
      periodic,
      helmertPerSolution: 'translation',
    });
    for (let w = 0; w < 156; w++) {
      const t = T0 + w * 7 * 86_400_000;
      const shift = [r() * 0.005, r() * 0.005, r() * 0.005];
      const obs = sites.map((_, i) =>
        truth(i, t).map((v, k) => v + shift[k]! + r() * 0.0005)
      );
      comb.add(
        freeNeq(
          sites,
          obs,
          obs.map((x) => x.map((v) => Math.round(v))),
          t
        )
      );
    }
    return comb.result();
  }

  it('recovers velocities across an equipment change and an earthquake', () => {
    const q = tieVelocities(combined('annual'), 1e-3, ['NONE']);
    const sol = solveWithDatum(q, {
      reference: sites.map((site, i) => ({
        site,
        xyz: XYZ[i] as [number, number, number],
        vel: vel[i] as [number, number, number],
        epochMs: T0,
      })),
      sites: ['POTS', 'ONSA', 'BRUX', 'ZIMM', 'GRAZ', 'JOZE'],
      position: 'translation',
      velocity: 'translation',
      iterate: false,
    });
    const v = (site: string, soln: string, ax: string) =>
      sol.estimate[
        sol.params.findIndex(
          (p) => p.site === site && p.solnId === soln && p.type === `VEL${ax}`
        )
      ]!;
    // WTZR: one velocity across its two position segments.
    expect(
      sol.params.filter((p) => p.site === 'WTZR' && p.type === 'VELX')
    ).toHaveLength(1);
    expect(
      sol.params.filter((p) => p.site === 'WTZR' && p.type === 'STAX')
    ).toHaveLength(2);
    expect(v('WTZR', '1', 'X')).toBeCloseTo(vel[0]![0]!, 4);
    // MATE: two velocity segments; the second carries the extra 1 cm/yr.
    expect(v('MATE', '1', 'Y')).toBeCloseTo(vel[7]![1]!, 3);
    expect(v('MATE', '2', 'Y')).toBeCloseTo(vel[7]![1]! + 0.01, 3);
    // Annual amplitude at JOZE Z recovered.
    const s1 =
      sol.estimate[
        sol.params.findIndex((p) => p.site === 'JOZE' && p.type === 'S1Z')
      ]!;
    expect(s1).toBeCloseTo(0.003, 3);
    expect(v('JOZE', '1', 'Z')).toBeCloseTo(vel[6]![2]!, 4);
  });

  it('ties velocity segments on request', () => {
    const q = tieVelocities(combined('none'), 1e-6, ['MATE']);
    const sol = solveWithDatum(q, {
      reference: sites.map((site, i) => ({
        site,
        xyz: XYZ[i] as [number, number, number],
        vel: vel[i] as [number, number, number],
        epochMs: T0,
      })),
      sites: ['POTS', 'ONSA', 'BRUX', 'ZIMM'],
      iterate: false,
    });
    const vs = sol.params.flatMap((p, i) =>
      p.site === 'MATE' && p.type === 'VELY' ? [sol.estimate[i]!] : []
    );
    expect(vs).toHaveLength(2);
    expect(vs[0]).toBeCloseTo(vs[1]!, 5);
  });
});

describe('SINEX normal equations', () => {
  const q = freeNeq(
    ['WTZR', 'POTS', 'ONSA'],
    XYZ.slice(0, 3).map((x) => x.map((v) => v + 0.001)),
    XYZ.slice(0, 3),
    T0
  );

  it('NEQ round trip (writeSinexNeq → parseSinex → sinexToNeq)', () => {
    const text = writeSinexNeq(q, { agency: 'GCC', createdMs: T0 });
    expect(text).toContain('+SOLUTION/NORMAL_EQUATION_MATRIX L');
    const f = parseSinex(text);
    expect(f.neqVector).toHaveLength(9);
    const back = sinexToNeq(f);
    for (let i = 0; i < 81; i++) expect(back.N[i]).toBeCloseTo(q.N[i]!, 6);
    for (let i = 0; i < 9; i++) {
      expect(back.b[i]! / q.b[i]!).toBeCloseTo(1, 12);
      expect(back.params[i]!.apriori).toBeCloseTo(q.params[i]!.apriori, 6);
    }
    expect(back.ltpl).toBeCloseTo(q.ltpl, 6);
    expect(back.nObs).toBe(9);
  });

  it('covariance round trip un-constrains (N = C⁻¹ − C₀⁻¹)', () => {
    const constrained = constrainParameters(q, () => true, 1); // 1 m
    const sol = solveNeq(constrained);
    const text = writeSinexCovariance(
      {
        params: q.params,
        estimate: sol.estimate,
        cov: sol.cov.map((v) => v / (sol.sigma0 ?? 1) ** 2),
        aprioriCov: new Array(9).fill(1),
        dataStartMs: q.dataStartMs,
        dataEndMs: q.dataEndMs,
      },
      { agency: 'GCC', createdMs: T0 }
    );
    expect(text).toContain('+SOLUTION/MATRIX_APRIORI L COVA');
    const back = sinexToNeq(parseSinex(text));
    for (let i = 0; i < 81; i++)
      expect(back.N[i]! / 250000).toBeCloseTo(q.N[i]! / 250000, 4);
  });

  it('reads CORR matrices (std devs on the diagonal) and U triangles', () => {
    const text = [
      '%=SNX 2.02 TST 20:001:00000 TST 20:001:00000 20:002:00000 P 00002 2 S',
      '+SOLUTION/ESTIMATE',
      '     1 STAX   WTZR  A    1 20:001:43200 m    2  4.07558031514000e+06 2.00000e-03',
      '     2 STAY   WTZR  A    1 20:001:43200 m    2  9.31854054010000e+05 3.00000e-03',
      '-SOLUTION/ESTIMATE',
      '+SOLUTION/MATRIX_ESTIMATE U CORR',
      '     1     1  2.0E-03 0.5',
      '     2     2  3.0E-03',
      '-SOLUTION/MATRIX_ESTIMATE U CORR',
      '%ENDSNX',
    ].join('\n');
    const f = parseSinex(text);
    const C = f.matrixEstimate!;
    expect(C.kind).toBe('COVA');
    expect(C.data[0]).toBeCloseTo(4e-6, 15);
    expect(C.data[1]).toBeCloseTo(0.5 * 2e-3 * 3e-3, 15);
    expect(C.data[2]).toBeCloseTo(C.data[1]!, 15);
    expect(C.data[3]).toBeCloseTo(9e-6, 15);
  });

  it('writeSinex with full cross-covariance', () => {
    const cov = new Array(36)
      .fill(0)
      .map((_, i) => (i % 7 === 0 ? 1e-6 : 1e-8));
    const text = writeSinex({
      agency: 'GCC',
      stations: [0, 1].map((i) => ({
        code: SITES[i]![0],
        refEpochMs: T0,
        dataStartMs: T0,
        dataEndMs: T0 + 86_400_000,
        xyz: XYZ[i]!,
        cov: [
          [1e-6, 0, 0],
          [0, 1e-6, 0],
          [0, 0, 1e-6],
        ],
      })),
      covariance: cov,
    });
    const f = parseSinex(text);
    expect(f.matrixEstimate!.data[5 * 6 + 0]).toBeCloseTo(1e-8, 20);
    expect(parseSinexEstimates(text).get('POTS 1')!.xyz![0]).toBeCloseTo(
      XYZ[1]![0],
      6
    );
  });
});

describe('SINEX epochs', () => {
  it('two-digit years: ≤ 50 → 20xx, > 50 → 19xx (SINEX 2.02)', () => {
    expect(parseSinexEpoch('24:017:43200')).toBe(Date.UTC(2024, 0, 17, 12));
    expect(parseSinexEpoch('50:001:00000')).toBe(Date.UTC(2050, 0, 1));
    expect(parseSinexEpoch('51:001:00000')).toBe(Date.UTC(1951, 0, 1));
    expect(parseSinexEpoch('96:366:86399')).toBe(
      Date.UTC(1996, 11, 31, 23, 59, 59)
    );
  });
  it('00:000:00000 is "unspecified", not 2000-01-01', () => {
    expect(parseSinexEpoch('00:000:00000')).toBeNull();
    expect(parseSinexEpoch('00:001:00000')).toBe(Date.UTC(2000, 0, 1));
  });
  it('four-digit years (YYYY:DDD:SSSSS)', () => {
    expect(parseSinexEpoch('2024:017:43200')).toBe(Date.UTC(2024, 0, 17, 12));
    expect(parseSinexEpoch('0000:000:00000')).toBeNull();
  });
  it('parseSinexEstimates: year 50 is 2050', () => {
    const text = [
      '+SOLUTION/ESTIMATE',
      '     1 STAX   WTZR  A    1 50:001:00000 m    2  4.07558031514000e+06 2.00000e-03',
      '-SOLUTION/ESTIMATE',
    ].join('\n');
    expect(parseSinexEstimates(text).get('WTZR 1')!.epochMs).toBe(
      Date.UTC(2050, 0, 1)
    );
  });
});

describe('discontinuity and SSC files', () => {
  it('parses P/V segments with open ends', () => {
    const d = parseSinexDiscontinuities(
      [
        '+SOLUTION/DISCONTINUITY',
        ' ACOR  A    1 P 00:000:00000 99:265:00000 P - Unknown',
        ' ACOR  A    2 P 99:265:00000 00:000:00000 P - antenna change',
        ' ACOR  A    1 P 00:000:00000 00:000:00000 V -',
        '-SOLUTION/DISCONTINUITY',
      ].join('\n')
    );
    expect(d).toHaveLength(3);
    expect(d[0]!.startMs).toBe(-Infinity);
    expect(d[0]!.endMs).toBe(Date.UTC(1999, 0, 265));
    expect(d[1]!.endMs).toBe(Infinity);
    expect(d[2]!.kind).toBe('V');
    expect(d[1]!.comment).toBe('antenna change');
  });
  it('parses an EPN SSC entry', () => {
    const s = parseSsc(
      [
        '14201M010 WTZR              GPS WTZR  4075580.31110   931854.05434  4801568.28074  0.00004  0.00002  0.00004  3 10:182:00000 26:115:86370 20:001:00000',
        '14201M010                                  -0.01598        0.01718        0.01004  0.00001  0.00001  0.00001',
      ].join('\n')
    );
    expect(s).toHaveLength(1);
    expect(s[0]!.site).toBe('WTZR');
    expect(s[0]!.solnId).toBe('3');
    expect(s[0]!.vel[1]).toBeCloseTo(0.01718, 8);
    expect(s[0]!.epochMs).toBe(Date.UTC(2020, 0, 1));
  });
});

describe('EUREF week 2297: daily NEQs → weekly (real data)', () => {
  // The seven EUREF daily combined solutions, reduced to six stations
  // (exact Schur complement of the un-constrained covariance NEQs), and the
  // official EUR0 weekly coordinates. See scripts/neq-oracles.
  const fx = JSON.parse(
    readFileSync(
      new URL('../test-fixtures/eur2297_neq_6sta.json', import.meta.url),
      'utf8'
    )
  ) as {
    sites: string[];
    daily: string[];
    weekly: Record<string, { epochMs: number; xyz: number[]; vel: number[] }>;
  };

  it('stacking + NNT reproduces the EUR0 weekly coordinates (< 0.2 mm)', () => {
    const daily = fx.daily.map((t) => sinexToNeq(parseSinex(t)));
    const moved = daily.map((q) =>
      moveToEpoch(
        q,
        (p) => fx.weekly[p.site]!.epochMs,
        (s) => fx.weekly[s]!.vel
      )
    );
    const sol = solveWithDatum(stackNeqs(moved), {
      reference: fx.sites.map((site) => ({
        site,
        xyz: fx.weekly[site]!.xyz as [number, number, number],
        epochMs: fx.weekly[site]!.epochMs,
      })),
      iterate: false,
    });
    sol.params.forEach((p, i) => {
      const k = ['STAX', 'STAY', 'STAZ'].indexOf(p.type);
      expect(
        Math.abs(sol.estimate[i]! - fx.weekly[p.site]!.xyz[k]!)
      ).toBeLessThan(2e-4);
    });
    expect(sol.sigma0!).toBeGreaterThan(0.5);
  });
});

describe('stationNeq (PPP day → NEQ)', () => {
  it('N = C⁻¹ and the solution is the input', () => {
    const q = stationNeq({
      site: 'WTZR',
      epochMs: T0,
      xyz: XYZ[0]!,
      cov: [4e-6, 1e-6, 0, 1e-6, 4e-6, 0, 0, 0, 9e-6],
    });
    const s = solveNeq(q);
    for (let k = 0; k < 3; k++)
      expect(s.estimate[k]).toBeCloseTo(XYZ[0]![k]!, 9);
    expect(s.cov[8]).toBeCloseTo(9e-6, 12);
  });
});
