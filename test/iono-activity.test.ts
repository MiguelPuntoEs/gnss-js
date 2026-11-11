import { describe, expect, it } from 'vitest';
import { IonoAccumulator } from '../src/analysis/ionosphere';
import { C_LIGHT, FREQ } from '../src/constants/gnss';
import type { RinexHeader } from '../src/rinex/parser';

const T0 = Date.UTC(2026, 0, 1);
const codes = ['C1C', 'L1C', 'C2W', 'L2W'];
const header = {
  interval: 30,
  obsTypes: { G: codes },
  glonassSlots: {},
} as unknown as RinexHeader;
const f1 = FREQ['G']!['1']!;
const f2 = FREQ['G']!['2']!;
const gm1 = (f1 * f1) / (f2 * f2) - 1;

/** One epoch with an L1 ionospheric delay of `i1` metres. */
function obs(i: number, i1: number) {
  const range = 2.0e7 + 800 * i * 30;
  const i2 = i1 * (gm1 + 1);
  return [
    range + i1,
    (range - i1) / (C_LIGHT / f1) + 1e6,
    range + i2,
    (range - i2) / (C_LIGHT / f2) + 2e6,
  ];
}

describe('IonoAccumulator activity', () => {
  it('counts an L1 iono-delay change faster than 400 cm/min', () => {
    const acc = new IonoAccumulator(header);
    for (let i = 0; i < 20; i++)
      acc.onObservation(T0 + i * 30_000, 'G01', codes, obs(i, 5 + 0.01 * i));
    // 3 m in 30 s = 600 cm/min on L1: a teqc IOD event.
    acc.onObservation(T0 + 20 * 30_000, 'G01', codes, obs(20, 8.2));
    const a = acc.finalize().activity!;
    expect(a.events).toBe(1);
    expect(a.perSystem.G).toEqual({ events: 1, tested: 20 });
  });

  it('does not count a quiet ionosphere', () => {
    const acc = new IonoAccumulator(header);
    for (let i = 0; i < 40; i++)
      acc.onObservation(T0 + i * 30_000, 'G01', codes, obs(i, 5 + 0.01 * i));
    expect(acc.finalize().activity!.events).toBe(0);
  });

  it('leaves out an epoch the slip detector confirmed as a cycle slip', () => {
    const acc = new IonoAccumulator(header);
    for (let i = 0; i < 20; i++)
      acc.onObservation(T0 + i * 30_000, 'G01', codes, obs(i, 5));
    acc.onObservation(T0 + 20 * 30_000, 'G01', codes, obs(20, 8.2));
    acc.notifySlip(T0 + 20 * 30_000, 'G01', new Set(['1']));
    expect(acc.finalize().activity!.events).toBe(0);
  });
});
