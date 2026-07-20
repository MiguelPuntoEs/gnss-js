import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseRinexStream } from '../src/rinex';
import { analyzeQuality } from '../src/analysis/quality-analysis';

const DIR = join(__dirname, '../test-fixtures');
const HAS_DATA = existsSync(join(DIR, 'ABMF.crx'));

function fileFrom(buf: Buffer, name: string): File {
  return new File([new Uint8Array(buf)], name);
}

describe.skipIf(!HAS_DATA)('analyzeQuality (ABMF daily file)', () => {
  it('runs all three analyses in one pass and returns populated results', async () => {
    const file = fileFrom(readFileSync(join(DIR, 'ABMF.crx')), 'ABMF.crx');
    const { header } = await parseRinexStream(file, undefined, undefined);

    const progress: number[] = [];
    const q = await analyzeQuality(file, header, (p) => progress.push(p));

    // Completeness: a healthy IGS station tracks dozens of satellites
    // across multiple systems.
    const prns = new Set(q.completeness.cells.map((c) => c.prn));
    expect(prns.size).toBeGreaterThan(30);
    expect(q.completeness.systems.length).toBeGreaterThan(2);
    expect(q.completeness.signalStats.length).toBeGreaterThan(3);

    // Multipath: dual-frequency GPS is present, so MP series exist.
    expect(q.multipath.series.length).toBeGreaterThan(10);
    expect(q.multipath.signalStats.length).toBeGreaterThan(0);

    // Cycle slips: structure is present (counts may legitimately be 0).
    expect(q.cycleSlips.signalStats.length).toBeGreaterThan(0);
    expect(q.cycleSlips.events.length).toBeGreaterThanOrEqual(0);

    // Ionosphere: one STEC series per dual-frequency satellite, with
    // physically plausible values (ABMF is low-latitude at solar max:
    // tens of TECU mean slant TEC; DCB bias of a few TECU tolerated).
    expect(q.iono.series.length).toBeGreaterThan(50);
    expect(q.iono.meanStec).toBeGreaterThan(5);
    expect(q.iono.meanStec).toBeLessThan(200);
    // Series are smooth: median epoch-to-epoch change well under 1 TECU.
    const g = q.iono.series.find((s) => s.system === 'G')!;
    const deltas = g.points
      .slice(1)
      .map((p, i) => Math.abs(p.stec - g.points[i]!.stec))
      .sort((a, b) => a - b);
    expect(deltas[deltas.length >> 1]!).toBeLessThan(1);

    // Progress callback fired and is monotonic.
    expect(progress.length).toBeGreaterThan(0);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  }, 30000);
});
