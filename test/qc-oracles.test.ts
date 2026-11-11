/**
 * QC regression against two independent tools on the ABMF 2024/001 fixture
 * with the day's BRDC — run once, numbers pinned here so the QC statistics
 * can't drift silently.
 *
 * teqc 2019Feb25 (UNAVCO; GPS + GLONASS L1/L2, RINEX 2 only). Input made
 * with RTKLIB demo5 convbin (`-v 2.11 -f 2 -x R25 -x R26 -x R27`; teqc
 * rejects GLONASS slots > 24), then `teqc +qc -nav n,g -set_mask 10`.
 *
 * Anubis 3.11 (G-Nut, the EUREF/IGS QC tool). Reproduce with:
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

/** teqc 2019Feb25, ABMF 2024-01-01, GPS + GLONASS, 10° mask. */
const TEQC = {
  // "Complete obs > 10" / "Possible obs > 10": 40473 / 43698
  completeAbove10: 92.62,
  mp1: 0.556, // Moving average MP12 (m), GPS + GLONASS
  mp2: 0.549,
  // "IOD or MP slips > 10": 169, of which "IOD slips > 10": 159 are
  // ionospheric-rate events (> 4 m/min), not cycle slips in our sense.
  slipsAbove10: 169,
  iodSlipsAbove10: 159,
};

describe.skipIf(!HAS_DATA)('QC vs teqc / Anubis (ABMF 2024/001)', () => {
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

  it('dual-frequency tracking ≥10° within 1 point of teqc complete obs', async () => {
    const { masked } = await run;
    const gr = masked.tracking!.perSystem.filter((s) =>
      'GR'.includes(s.system)
    );
    const pct =
      (gr.reduce((a, s) => a + s.dualFreq, 0) /
        gr.reduce((a, s) => a + s.expected, 0)) *
      100;
    expect(Math.abs(pct - TEQC.completeAbove10)).toBeLessThan(1);
  }, 120_000);

  it('multipath below teqc by its definition (C/A code, moving average)', async () => {
    const { masked } = await run;
    const mp = (l: string) =>
      masked.multipath.signalStats.find((s) => s.label === l)!;
    const w = (a: string, b: string) => {
      const x = mp(a);
      const y = mp(b);
      return Math.sqrt(
        (x.rms ** 2 * x.count + y.rms ** 2 * y.count) / (x.count + y.count)
      );
    };
    const mp1 = w('MP L1-L2 (GPS)', 'MP G1-G2 (GLONASS)');
    const mp2 = w('MP L2-L1 (GPS)', 'MP G2-G1 (GLONASS)');
    for (const [ours, ref] of [
      [mp1, TEQC.mp1],
      [mp2, TEQC.mp2],
    ] as const) {
      expect(ours / ref).toBeGreaterThan(0.4);
      expect(ours / ref).toBeLessThan(1.0);
    }
  }, 120_000);

  it('GPS+GLONASS slips ≥10° between teqc MP-only and teqc total', async () => {
    const { masked } = await run;
    const ps = masked.cycleSlips.perSystem;
    const ours = ps.G!.slipEpochs + ps.R!.slipEpochs;
    expect(ours).toBeGreaterThanOrEqual(
      TEQC.slipsAbove10 - TEQC.iodSlipsAbove10
    );
    expect(ours).toBeLessThanOrEqual(TEQC.slipsAbove10);
  }, 120_000);

  it('iono events + confirmed slips ≈ teqc IOD slips (it counts both)', async () => {
    // teqc flags any geometry-free jump > 400 cm/min of L1 delay; we split
    // that into ionospheric events (iono.activity) and cycle slips.
    const { masked } = await run;
    const a = masked.iono.activity!.perSystem;
    const ps = masked.cycleSlips.perSystem;
    const ours =
      a.G!.events + a.R!.events + ps.G!.slipEpochs + ps.R!.slipEpochs;
    expect(
      Math.abs(ours - TEQC.iodSlipsAbove10) / TEQC.iodSlipsAbove10
    ).toBeLessThan(0.15);
  }, 120_000);
});
