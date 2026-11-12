import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseRinexStream } from '../src/rinex';
import { parseNavFile } from '../src/rinex/nav';
import {
  CN0_TEMPLATE,
  ElevationModel,
  QualityAccumulator,
  compareCn0WithTemplate,
} from '../src/analysis';

describe('compareCn0WithTemplate', () => {
  const at = (key: string, offset: number) => {
    const [system, code] = key.split(':') as [string, string];
    const t = CN0_TEMPLATE[key]!;
    return {
      system,
      code,
      label: key,
      mean: t.median.map((m) => (m === null ? null : m + offset)),
      n: t.median.map(() => 100),
    };
  };

  it('a healthy file sits on the reference', () => {
    const c = compareCn0WithTemplate([at('G:S1C', 0), at('E:S5Q', 0)])!;
    expect(c.deficitDb).toBeCloseTo(0, 6);
  });

  it('reads an across-the-board loss as the deficit', () => {
    const c = compareCn0WithTemplate([
      at('G:S1C', -9),
      at('E:S5Q', -9),
      at('R:S1C', -8),
    ])!;
    expect(c.deficitDb).toBeCloseTo(-9, 6);
  });

  it('ignores semi-codeless W, SBAS and unknown signals', () => {
    expect(
      compareCn0WithTemplate([at('G:S1W', -20), at('G:S2W', -20)])
    ).toBeNull();
  });
});

const DIR = join(__dirname, '../test-fixtures');
const HAS_DATA =
  existsSync(join(DIR, 'ABMF.crx')) && existsSync(join(DIR, 'BRDC.nav'));

describe.skipIf(!HAS_DATA)('site diagnostics on a real day (ABMF)', () => {
  const buf = HAS_DATA ? readFileSync(join(DIR, 'ABMF.crx')) : null!;
  const file = () => new File([new Uint8Array(buf)], 'ABMF.crx');
  const nav = HAS_DATA
    ? parseNavFile(readFileSync(join(DIR, 'BRDC.nav'), 'utf-8'))
    : null!;

  const run = async (cn0OffsetDb = 0) => {
    const { header } = await parseRinexStream(file());
    const model = ElevationModel.create(nav.ephemerides, header.approxPosition);
    const qa = new QualityAccumulator(header, {
      elevation: model,
      maskDeg: 10,
    });
    await parseRinexStream(
      file(),
      undefined,
      undefined,
      (time, prn, codes, values) => {
        const v = cn0OffsetDb
          ? values.map((x, i) =>
              x != null && x > 0 && codes[i]![0] === 'S' ? x + cn0OffsetDb : x
            )
          : values;
        qa.onObservation(time, prn, codes, v);
      },
      true
    );
    return qa.finalize();
  };

  it('horizon, obstruction, multipath sky and C/N0 all read healthy', async () => {
    const q = await run();
    const sky = q.tracking!.sky;
    expect(sky.horizon).toHaveLength(36);
    expect(sky.cutoffDeg).toBeLessThanOrEqual(5);
    // ABMF's receiver never tracks C41–C46 (newest BeiDou-3). They're
    // listed, not counted: counting them read as a fake obstruction in the
    // east (80–90°, up to 30°) and 78 % BeiDou tracking.
    expect(sky.obstructions).toHaveLength(0);
    expect(q.tracking!.neverTracked).toEqual(
      expect.arrayContaining(['C41', 'C42', 'C43', 'C44', 'C45', 'C46'])
    );
    expect(q.tracking!.percent).toBeGreaterThan(99);
    // Lost time shows per timeline bin: a healthy day never dips.
    const perBin = q.tracking!.timeline.percent.filter(
      (x): x is number => x !== null
    );
    expect(perBin.length).toBeGreaterThan(90);
    expect(Math.min(...perBin)).toBeGreaterThan(90);
    const mp = q.multipathSky!;
    expect(mp.medianRms!).toBeGreaterThan(0.15);
    expect(mp.medianRms!).toBeLessThan(0.5);
    expect(mp.worst!.rms).toBeGreaterThanOrEqual(mp.medianRms!);
    // The fine grid pools the same samples: 36 × 18 cells, same total.
    const f = mp.fine!;
    expect(f.rms).toHaveLength(36);
    expect(f.rms[0]).toHaveLength(18);
    const total = (g: number[][]) =>
      g.reduce((a, col) => a + col.reduce((b, x) => b + x, 0), 0);
    expect(total(f.n)).toBe(total(mp.n));
    const filled = f.rms.flat().filter((x) => x !== null).length;
    expect(filled).toBeGreaterThan(300); // a 24 h day covers most of the sky
    const c = compareCn0WithTemplate(q.signals!.cn0ByElevation)!;
    expect(Math.abs(c.deficitDb)).toBeLessThan(4);
  }, 120_000);

  it('a 9 dB loss on every signal (failing LNA/cable) shows as −9 dB', async () => {
    const q = await run(-9);
    const c = compareCn0WithTemplate(q.signals!.cn0ByElevation)!;
    expect(c.deficitDb).toBeLessThan(-7);
    expect(c.deficitDb).toBeGreaterThan(-11);
  }, 120_000);
});
