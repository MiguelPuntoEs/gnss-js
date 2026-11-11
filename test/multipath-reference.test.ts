import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseRinexStream } from '../src/rinex';
import { parseNavFile } from '../src/rinex/nav';
import {
  ElevationModel,
  QualityAccumulator,
  ReferenceMultipathAccumulator,
} from '../src/analysis';
import type { RinexHeader } from '../src/rinex/parser';

const header = {
  interval: 30,
  obsTypes: { G: ['C1C', 'L1C', 'C2W', 'L2W'] },
  glonassSlots: {},
} as unknown as RinexHeader;

const F1 = 1575.42e6;
const F2 = 1227.6e6;
const C = 299_792_458;

/** A GPS satellite whose code carries `noise(k)` on top of a clean range. */
function feed(
  acc: ReferenceMultipathAccumulator,
  n: number,
  noise: (k: number) => number,
  el = 45
) {
  const codes = header.obsTypes.G!;
  for (let k = 0; k < n; k++) {
    const range = 2.2e7 + 100 * k;
    const values = [
      range + noise(k),
      (range / C) * F1 + 1234,
      range + noise(k),
      (range / C) * F2 + 987,
    ];
    acc.onObservation(
      Date.UTC(2026, 0, 1) + k * 30_000,
      'G05',
      codes,
      values,
      el
    );
  }
}

describe('ReferenceMultipathAccumulator', () => {
  it('reads zero multipath from clean code, whatever the ambiguities', () => {
    const acc = new ReferenceMultipathAccumulator(header);
    feed(acc, 200, () => 0);
    const r = acc.finalize();
    for (const s of r.anubis.signals) expect(s.mean).toBeLessThan(1e-6);
    for (const s of r.teqc.summary) expect(s.mean).toBeLessThan(1e-6);
  });

  it('Anubis: the 20-epoch sample SD; teqc: residual to the 50-point mean', () => {
    // Alternating ±0.3 m: a 20-epoch window's sample SD is
    // 0.3·sqrt(20/19); the residual to a 50-point mean is ±0.3.
    const acc = new ReferenceMultipathAccumulator(header);
    feed(acc, 400, (k) => (k % 2 ? 0.3 : -0.3));
    const r = acc.finalize();
    const m1c = r.anubis.signals.find((s) => s.label === 'GPS M1C')!;
    expect(m1c.mean).toBeCloseTo(0.3 * Math.sqrt(20 / 19), 3);
    const mp12 = r.teqc.summary.find((s) => s.name === 'MP12')!;
    expect(mp12.mean).toBeGreaterThan(0.29);
    expect(mp12.mean).toBeLessThan(0.31);
  });

  it('teqc counts only above its mask; Anubis every elevation', () => {
    const acc = new ReferenceMultipathAccumulator(header, 10);
    feed(acc, 200, (k) => (k % 2 ? 0.3 : -0.3), 5);
    const r = acc.finalize();
    expect(r.anubis.signals.length).toBeGreaterThan(0);
    expect(r.teqc.summary).toHaveLength(0);
  });
});

const DIR = join(__dirname, '../test-fixtures');
const HAS_DATA =
  existsSync(join(DIR, 'ABMF.crx')) && existsSync(join(DIR, 'BRDC.nav'));

/**
 * ABMF 2024/001 — a station the methods were not fitted on. Anubis 3.11
 * `:qc:sec_mpx=1` per-signal means (cm) and teqc 2019Feb25 "Moving average
 * MP12/MP21" (see qc-oracles.test.ts for how both were run). Clean
 * satellites agree to the centimetre; the means differ where a few
 * satellites' slips and outliers are handled differently (GPS reads ~20 %
 * low here, Galileo ~20 % high; GLONASS, BeiDou and SBAS within 10 %).
 */
const ANUBIS_ABMF: Record<string, number> = {
  'GPS M1C': 37.37,
  'GPS M2W': 46.4,
  'GLO M1C': 58.75,
  'GLO M2P': 43.26,
  'GAL M1C': 26.7,
  'GAL M5Q': 25.52,
  'BDS M2I': 40.81,
  'BDS M6I': 24.16,
  'SBS M1C': 177.97,
};
const TEQC_ABMF = { MP12: 0.556, MP21: 0.549 };

describe.skipIf(!HAS_DATA)(
  'reference multipath vs Anubis / teqc (ABMF)',
  () => {
    it('per-signal means within 0.7–1.4× of Anubis; teqc within 0.8–1.05×', async () => {
      const buf = readFileSync(join(DIR, 'ABMF.crx'));
      const { header: h } = await parseRinexStream(
        new File([new Uint8Array(buf)], 'ABMF.crx')
      );
      const nav = parseNavFile(readFileSync(join(DIR, 'BRDC.nav'), 'utf-8'));
      const qa = new QualityAccumulator(h, {
        elevation: ElevationModel.create(nav.ephemerides, h.approxPosition),
        maskDeg: 10,
      });
      await parseRinexStream(
        new File([new Uint8Array(buf)], 'ABMF.crx'),
        undefined,
        undefined,
        (t, p, c, v) => qa.onObservation(t, p, c, v),
        true
      );
      const ref = qa.finalize().referenceMultipath!;
      for (const [label, cm] of Object.entries(ANUBIS_ABMF)) {
        const s = ref.anubis.signals.find((x) => x.label === label)!;
        const ratio = (s.mean * 100) / cm;
        expect(ratio, label).toBeGreaterThan(0.7);
        expect(ratio, label).toBeLessThan(1.4);
      }
      for (const [name, m] of Object.entries(TEQC_ABMF)) {
        const s = ref.teqc.summary.find((x) => x.name === name)!;
        expect(s.mean / m, name).toBeGreaterThan(0.8);
        expect(s.mean / m, name).toBeLessThan(1.05);
      }
    }, 120_000);
  }
);
