import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseRinexStream } from '../src/rinex';
import { parseNavFile } from '../src/rinex/nav';
import {
  analyzeQuality,
  ElevationModel,
  QualityAccumulator,
} from '../src/analysis';
import type { RinexHeader } from '../src/rinex/parser';

const DIR = join(__dirname, '../test-fixtures');
const HAS_DATA =
  existsSync(join(DIR, 'ABMF.crx')) && existsSync(join(DIR, 'BRDC.nav'));

const fileFrom = (buf: Buffer, name: string) =>
  new File([new Uint8Array(buf)], name);

describe('ElevationModel.create', () => {
  it('needs both ephemerides and a real receiver position', () => {
    expect(ElevationModel.create([], [4e6, 1e6, 4.8e6])).toBeNull();
    // The all-zero APPROX POSITION XYZ many files carry is not a position.
    const nav = HAS_DATA
      ? parseNavFile(readFileSync(join(DIR, 'BRDC.nav'), 'utf-8'))
      : null;
    if (nav) {
      expect(ElevationModel.create(nav.ephemerides, [0, 0, 0])).toBeNull();
      expect(ElevationModel.create(nav.ephemerides, null)).toBeNull();
    }
  });
});

describe('QualityAccumulator without orbits', () => {
  it('ignores the mask (nothing to compute elevation from)', () => {
    const qa = new QualityAccumulator(
      {
        interval: 30,
        obsTypes: { G: ['C1C', 'L1C'] },
        glonassSlots: {},
      } as unknown as RinexHeader,
      { maskDeg: 10 }
    );
    qa.onObservation(0, 'G01', ['C1C', 'L1C'], [2e7, 1e8]);
    const r = qa.finalize();
    expect(r.maskDeg).toBeNull();
    expect(r.belowMask).toBe(0);
    expect(r.tracking).toBeNull();
  });
});

describe.skipIf(!HAS_DATA)('elevation-masked QC (ABMF + BRDC)', () => {
  const buf = HAS_DATA ? readFileSync(join(DIR, 'ABMF.crx')) : null!;
  const nav = HAS_DATA
    ? parseNavFile(readFileSync(join(DIR, 'BRDC.nav'), 'utf-8'))
    : null!;

  it('drops low satellites, keeps the rest, and reports tracking', async () => {
    const file = fileFrom(buf, 'ABMF.crx');
    const { header } = await parseRinexStream(file);
    const model = ElevationModel.create(nav.ephemerides, header.approxPosition);
    expect(model).not.toBeNull();

    const all = await analyzeQuality(file, header, undefined, undefined, {
      elevation: model,
    });
    const masked = await analyzeQuality(file, header, undefined, undefined, {
      elevation: model,
      maskDeg: 10,
    });

    expect(all.maskDeg).toBeNull();
    expect(masked.maskDeg).toBe(10);
    // An IGS receiver records down to a few degrees: a 10° mask drops a
    // real share of satellite-epochs, but nowhere near all of them.
    expect(masked.belowMask).toBeGreaterThan(1000);
    expect(masked.cycleSlips.testedEpochs).toBeLessThan(
      all.cycleSlips.testedEpochs
    );
    expect(masked.cycleSlips.testedEpochs).toBeGreaterThan(
      all.cycleSlips.testedEpochs * 0.6
    );
    // Horizon arcs carry most of the slips: masking can only remove them.
    expect(masked.cycleSlips.slipEpochs).toBeLessThanOrEqual(
      all.cycleSlips.slipEpochs
    );

    // A healthy IGS station tracks nearly everything above 10°.
    const t = masked.tracking!;
    expect(t.maskDeg).toBe(10);
    expect(t.expected).toBeGreaterThan(10_000);
    expect(t.percent).toBeGreaterThan(90);
    expect(t.percent).toBeLessThanOrEqual(100);
    expect(t.dualPercent).toBeLessThanOrEqual(t.percent);
    for (const s of t.perSystem)
      expect(s.tracked).toBeLessThanOrEqual(s.expected);
  }, 120_000);

  it('elevations are physical (−90…90°) and null without an ephemeris', async () => {
    const { header } = await parseRinexStream(fileFrom(buf, 'ABMF.crx'));
    const model = ElevationModel.create(
      nav.ephemerides,
      header.approxPosition
    )!;
    const t0 = header.timeOfFirstObs!.getTime();
    let seen = 0;
    for (const prn of model.prns) {
      const el = model.elevationDeg(prn, t0 + 3600_000);
      if (el === null) continue;
      expect(el).toBeGreaterThanOrEqual(-90);
      expect(el).toBeLessThanOrEqual(90);
      seen++;
    }
    expect(seen).toBeGreaterThan(30);
    expect(model.elevationDeg('G99', t0)).toBeNull();
  });
});
