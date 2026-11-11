import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseRinexStream } from '../src/rinex';
import { QualityAccumulator } from '../src/analysis/quality-analysis';
import { ContinuityAccumulator } from '../src/analysis/continuity';
import { C_LIGHT, FREQ } from '../src/constants/gnss';
import type { RinexHeader } from '../src/rinex/parser';

const T0 = Date.UTC(2026, 0, 1);
const codes = ['C1C', 'L1C', 'S1C', 'C2W', 'L2W'];
const header = {
  interval: 30,
  obsTypes: { G: codes },
  glonassSlots: {},
} as unknown as RinexHeader;
const lam1 = C_LIGHT / FREQ['G']!['1']!;
const lam2 = C_LIGHT / FREQ['G']!['2']!;
const MS_M = C_LIGHT * 1e-3;

/** Six satellites, smooth geometry; `codeShift` added to every pseudorange. */
function feed(
  acc: { onObservation: QualityAccumulator['onObservation'] },
  i: number,
  codeShift = 0,
  sats = 6
) {
  for (let s = 1; s <= sats; s++) {
    const range = 2.0e7 + s * 1e6 + (100 + s * 50) * i * 30;
    acc.onObservation(
      T0 + i * 30_000,
      `G${String(s).padStart(2, '0')}`,
      codes,
      [
        range + codeShift,
        range / lam1 + 1e6,
        45,
        range + codeShift,
        range / lam2 + 2e6,
      ]
    );
  }
}

describe('receiver clock jumps', () => {
  it('detects a 1 ms code jump on every satellite and keeps it out of the slips', () => {
    const qa = new QualityAccumulator(header);
    for (let i = 0; i < 20; i++) feed(qa, i);
    for (let i = 20; i < 40; i++) feed(qa, i, MS_M); // receiver clock reset
    const r = qa.finalize();
    expect(r.clockJumps!.jumps).toHaveLength(1);
    expect(r.clockJumps!.jumps[0]).toMatchObject({
      time: T0 + 20 * 30_000,
      ms: 1,
      integerMs: true,
      agree: 6,
      of: 6,
    });
    // Without the correction every satellite would "slip" at epoch 20.
    expect(r.cycleSlips.slipEpochs).toBe(0);
  });

  it('a quiet clock reports nothing', () => {
    const qa = new QualityAccumulator(header);
    for (let i = 0; i < 40; i++) feed(qa, i);
    const r = qa.finalize();
    expect(r.clockJumps!.jumps).toHaveLength(0);
    expect(r.clockJumps!.epochsChecked).toBe(39);
  });
});

describe('continuity', () => {
  it('finds gaps, short pieces, repeated epochs and duplicate satellites', () => {
    const c = new ContinuityAccumulator(header);
    const ep = (t: number, sats: string[]) =>
      c.onEpoch(
        t,
        sats.map((prn) => ({ prn, values: [2e7, 1e8, 45, 2e7, 8e7] }))
      );
    const six = ['G01', 'G02', 'G03', 'G04', 'G05', 'G06'];
    for (let i = 0; i < 100; i++) ep(T0 + i * 30_000, six); // 49.5 min
    // 20-min gap, then a 10-min piece (short), another gap, then 60 min.
    for (let i = 140; i < 160; i++) ep(T0 + i * 30_000, six);
    for (let i = 200; i < 320; i++) ep(T0 + i * 30_000, ['G01', 'G02', 'G03']);
    ep(T0 + 319 * 30_000, six); // repeated epoch
    ep(T0 + 320 * 30_000, ['G01', 'G01', 'G02', 'G03', 'G04']); // duplicate
    const r = c.finalize();
    expect(r.gaps).toHaveLength(2);
    expect(r.gaps[0]).toEqual({
      from: T0 + 99 * 30_000,
      to: T0 + 140 * 30_000,
    });
    expect(r.shortPieces).toBe(1);
    expect(r.repeatedEpochs).toBe(1);
    expect(r.duplicateSats).toBe(1);
    expect(r.epochs).toBe(100 + 20 + 120 + 1);
    expect(r.expectedEpochs).toBe(321);
    // ≥ 4 dual-frequency satellites: the six-satellite epochs and the last.
    expect(r.usableEpochs).toBe(100 + 20 + 1);
    expect(r.maxSatellites).toBe(6);
  });
});

describe('signal profile', () => {
  it('reports C/N0 per signal over graded observations', () => {
    const qa = new QualityAccumulator(header);
    for (let i = 0; i < 10; i++) feed(qa, i);
    const cn0 = qa.finalize().signals!.cn0;
    expect(cn0).toHaveLength(1);
    expect(cn0[0]).toMatchObject({
      system: 'G',
      code: 'S1C',
      n: 60,
      mean: 45,
      sd: 0,
    });
  });
});

const DIR = join(__dirname, '../test-fixtures');
const HAS_ABMF = existsSync(join(DIR, 'ABMF.crx'));

describe.skipIf(!HAS_ABMF)('clock jump injected into a real day (ABMF)', () => {
  it('finds the 1 ms reset and leaves slips and multipath as they were', async () => {
    const buf = readFileSync(join(DIR, 'ABMF.crx'));
    const file = () => new File([new Uint8Array(buf)], 'ABMF.crx');
    const { header } = await parseRinexStream(file());
    const run = async (jumpAt: number | null) => {
      const qa = new QualityAccumulator(header);
      await parseRinexStream(
        file(),
        undefined,
        undefined,
        (time, prn, codes, values) => {
          const v =
            jumpAt !== null && time >= jumpAt
              ? values.map((x, i) =>
                  x != null && x !== 0 && codes[i]![0] === 'C' ? x + MS_M : x
                )
              : values;
          qa.onObservation(time, prn, codes, v);
        },
        true
      );
      return qa.finalize();
    };
    const t0 = header.timeOfFirstObs!.getTime();
    const clean = await run(null);
    const jumped = await run(t0 + 12 * 3600_000);
    expect(clean.clockJumps!.jumps).toHaveLength(0);
    expect(jumped.clockJumps!.jumps).toHaveLength(1);
    expect(jumped.clockJumps!.jumps[0]).toMatchObject({
      ms: 1,
      integerMs: true,
    });
    expect(jumped.cycleSlips.slipEpochs).toBe(clean.cycleSlips.slipEpochs);
    const mp = (q: typeof clean) =>
      q.multipath.signalStats.find((s) => s.label === 'MP L1-L2 (GPS)')!.rms;
    expect(mp(jumped)).toBeCloseTo(mp(clean), 6);
  }, 120_000);
});
