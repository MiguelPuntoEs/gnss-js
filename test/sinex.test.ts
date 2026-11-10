import { describe, it, expect } from 'vitest';
import { writeSinex, parseSinexEstimates } from '../src/rinex/sinex';

const WTZR = {
  code: 'WTZR',
  domes: '14201M010',
  description: 'Wettzell, GERMANY',
  refEpochMs: Date.UTC(2025, 0, 1),
  dataStartMs: Date.UTC(2024, 0, 15),
  dataEndMs: Date.UTC(2025, 11, 15, 23, 59, 30),
  xyz: [4075580.2266, 931854.145, 4801568.3391] as [number, number, number],
  vel: [-0.01593, 0.01721, 0.01006] as [number, number, number],
  cov: [
    [1e-6, 2e-7, 3e-7, 0, 0, 0],
    [2e-7, 4e-7, 1e-7, 0, 0, 0],
    [3e-7, 1e-7, 9e-7, 0, 0, 0],
    [0, 0, 0, 4e-7, 0, 0],
    [0, 0, 0, 0, 2.5e-7, 0],
    [0, 0, 0, 0, 0, 1.6e-6],
  ],
};

describe('SINEX', () => {
  const text = writeSinex({
    agency: 'GCC',
    stations: [
      WTZR,
      {
        ...WTZR,
        code: 'ZIM2',
        domes: undefined,
        vel: undefined,
        cov: WTZR.cov.slice(0, 3).map((r) => r.slice(0, 3)),
      },
    ],
    description: 'gnsscalc campaign',
    software: 'gnss-js',
    createdMs: Date.UTC(2026, 10, 10),
  });

  it('writes a 2.02 header with the parameter count and solution types', () => {
    const h = text.split('\n')[0]!;
    expect(h).toMatch(
      /^%=SNX 2\.02 GCC 26:314:00000 GCC 24:015:00000 25:349:86370 P 00009 2 S V$/
    );
    expect(text.trimEnd().endsWith('%ENDSNX')).toBe(true);
  });

  it('puts the fields in the standard columns', () => {
    const est = text.split('\n').find((l) => l.includes('STAX   WTZR'))!;
    expect(est.slice(7, 13).trim()).toBe('STAX');
    expect(est.slice(14, 18)).toBe('WTZR');
    expect(est.slice(27, 39)).toBe('25:001:00000');
    expect(Number(est.slice(47, 68))).toBeCloseTo(4075580.2266, 4);
    expect(Number(est.slice(69, 80))).toBeCloseTo(0.001, 6);
    const site = text
      .split('\n')
      .find((l) => l.startsWith(' WTZR  A 14201M010'))!;
    expect(site).toContain('Wettzell, GERMANY');
    expect(site).toMatch(/ 12 52 4\d\.\d {2}49 08 3\d\.\d /);
  });

  it('round-trips the estimates', () => {
    const m = parseSinexEstimates(text);
    const w = m.get('WTZR 1')!;
    expect(w.epochMs).toBe(WTZR.refEpochMs);
    for (let k = 0; k < 3; k++) {
      expect(w.xyz![k]).toBeCloseTo(WTZR.xyz[k]!, 6);
      expect(w.vel![k]).toBeCloseTo(WTZR.vel[k]!, 9);
    }
    expect(m.get('ZIM2 1')!.vel).toBeUndefined();
  });

  it('writes the lower triangle of each station covariance', () => {
    const rows = text
      .slice(
        text.indexOf('+SOLUTION/MATRIX_ESTIMATE'),
        text.indexOf('-SOLUTION/MATRIX_ESTIMATE')
      )
      .split('\n')
      .filter((l) => /^\s+\d/.test(l));
    // WTZR: 6 rows (rows 4–6 split in two lines) + ZIM2: 3 rows
    expect(rows.length).toBe(9 + 3);
    const r3 = rows.find((l) => /^\s+3\s+1 /.test(l))!;
    expect(r3.trim().split(/\s+/).slice(2).map(Number)).toEqual([
      3e-7, 1e-7, 9e-7,
    ]);
  });
});
