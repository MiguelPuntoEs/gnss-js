/**
 * QC regression against G-Nut/Anubis 3.11 (the EUREF/IGS QC tool) on the
 * ABMF 2024/001 fixture with the day's BRDC — run once, numbers pinned here
 * so the QC statistics can't drift silently. Reproduce with:
 *   CRX2RNX ABMF.crx | gzip > ABMF.rnx.gz
 *   anubis :inp:rinexo ABMF.rnx.gz :inp:rinexn BRDC.rnx.gz \
 *          :out:xtr ABMF.xtr :qc:ele_cut=10
 *
 * Definitions differ, so bounds are deliberate, not tight:
 * - Tracking ≥10° ≈ Anubis "%Rt>10" (Hav>10 / Exp>10 of the best-tracked
 *   phase signal per system).
 * - Multipath: Anubis mpX averages every code on a band with a 20-epoch
 *   moving RMS; ours sigma-edits each arc and picks one code per band, so it
 *   reads lower (ABMF: 15–30 %; seven 2026 IGS/EUREF stations: ±20 %).
 * - Slips: Anubis nSlp counts per satellite AND signal and has no mask; ours
 *   counts distinct satellite-epochs. Only the ranking across constellations
 *   is comparable.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseRinexStream } from '../src/rinex';
import { parseNavFile } from '../src/rinex/nav';
import { analyzeQuality, ElevationModel } from '../src/analysis';

const DIR = join(__dirname, '../test-fixtures');
const HAS_DATA =
  existsSync(join(DIR, 'ABMF.crx')) && existsSync(join(DIR, 'BRDC.nav'));

/** Anubis 3.11, ABMF00GLP 2024-01-01, :qc:ele_cut=10. */
const ANUBIS = {
  // %Rt>10 of the best-tracked phase signal (Hav>10 / Exp>10)
  trackingAbove10: { G: 99.48, R: 97.88, E: 99.92 },
  // =GNSSUM mp1/mp2 (cm)
  mp: { G: [37.7, 42.0], R: [56.2, 44.1], E: [26.7] },
  // =GNSSUM nSlp
  nSlp: { G: 1718, R: 1148, E: 2563, C: 187 },
};

describe.skipIf(!HAS_DATA)('QC vs Anubis (ABMF 2024/001)', () => {
  const buf = HAS_DATA ? readFileSync(join(DIR, 'ABMF.crx')) : null!;
  const file = () => new File([new Uint8Array(buf)], 'ABMF.crx');
  // describe.skipIf bodies still execute: only start the run with data.
  const run = HAS_DATA
    ? (async () => {
        const nav = parseNavFile(readFileSync(join(DIR, 'BRDC.nav'), 'utf-8'));
        const { header } = await parseRinexStream(file());
        const model = ElevationModel.create(
          nav.ephemerides,
          header.approxPosition
        );
        const all = await analyzeQuality(file(), header, undefined, undefined, {
          elevation: model,
        });
        const masked = await analyzeQuality(
          file(),
          header,
          undefined,
          undefined,
          {
            elevation: model,
            maskDeg: 10,
          }
        );
        return { all, masked };
      })()
    : null!;

  it('tracking above 10° within 1.5 points of Anubis', async () => {
    const { masked } = await run;
    for (const [sys, ref] of Object.entries(ANUBIS.trackingAbove10)) {
      const ours = masked.tracking!.perSystem.find((s) => s.system === sys)!;
      expect(Math.abs(ours.percent - ref)).toBeLessThan(1.5);
    }
  }, 120_000);

  it('code multipath within 0.6–1.2× of Anubis per band', async () => {
    const { all } = await run;
    const rms = (label: string) =>
      all.multipath.signalStats.find((s) => s.label === label)!.rms * 100;
    const pairs: [string, number][] = [
      ['MP L1-L2 (GPS)', ANUBIS.mp.G[0]!],
      ['MP L2-L1 (GPS)', ANUBIS.mp.G[1]!],
      ['MP G1-G2 (GLONASS)', ANUBIS.mp.R[0]!],
      ['MP G2-G1 (GLONASS)', ANUBIS.mp.R[1]!],
      ['MP E1-E5a (Galileo)', ANUBIS.mp.E[0]!],
    ];
    for (const [label, ref] of pairs) {
      const ratio = rms(label) / ref;
      expect(ratio, label).toBeGreaterThan(0.6);
      expect(ratio, label).toBeLessThan(1.2);
    }
  }, 120_000);

  it('ranks constellations by slips the way Anubis does', async () => {
    const { all } = await run;
    const ps = all.cycleSlips.perSystem;
    const ours = (['G', 'R', 'E', 'C'] as const)
      .slice()
      .sort((a, b) => ps[b]!.slipEpochs - ps[a]!.slipEpochs);
    const theirs = (['G', 'R', 'E', 'C'] as const)
      .slice()
      .sort((a, b) => ANUBIS.nSlp[b] - ANUBIS.nSlp[a]);
    expect(ours).toEqual(theirs);
  }, 120_000);

  it('the mask removes horizon slips, never adds any', async () => {
    const { all, masked } = await run;
    expect(masked.cycleSlips.slipEpochs).toBeLessThan(
      all.cycleSlips.slipEpochs
    );
  }, 120_000);
});
