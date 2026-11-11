import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseRinexStream } from '../src/rinex';
import { parseNavFile } from '../src/rinex/nav';
import {
  ContinuityAccumulator,
  ElevationModel,
  LossOfLockAccumulator,
  QualityAccumulator,
} from '../src/analysis';
import type { RinexHeader } from '../src/rinex/parser';

const DIR = join(__dirname, '../test-fixtures');

/**
 * LLI through the parser. Slices cut from plain RINEX and re-compressed
 * with Hatanaka's RNX2CRX 4.2.0; the expected flags are what the plain
 * RINEX carries (identical to CRX2RNX's output on the full days: SUR4
 * 2026/308 35 460 flags, INAB 2025/178 6 614, zero differences).
 */
describe('LLI from Hatanaka-compressed RINEX', () => {
  const flags = async (name: string) => {
    const out: string[] = [];
    const file = new File(
      [new Uint8Array(readFileSync(join(DIR, name)))],
      name
    );
    await parseRinexStream(
      file,
      undefined,
      undefined,
      (t, prn, codes, v, lli) =>
        codes.forEach((c, i) => {
          if (v[i] != null && lli?.[i])
            out.push(
              `${new Date(t).toISOString().slice(11, 19)} ${prn} ${c}=${lli[i]}`
            );
        }),
      true
    );
    return out;
  };

  it('CRINEX 3 (SUR4, 40 epochs)', async () => {
    const f = await flags('sur4_lli_slice.crx');
    expect(f).toHaveLength(494);
    expect(f.slice(0, 2)).toEqual(['00:00:00 E07 L1C=4', '00:00:00 E08 L1C=4']);
  });

  it('CRINEX 1 (INAB, 240 epochs) — blank data clears its flags', async () => {
    const f = await flags('inab_lli_slice.25d');
    expect(f).toHaveLength(289);
    expect(f.slice(0, 2)).toEqual(['00:00:00 G02 L2=4', '00:00:30 G02 L2=4']);
  });
});

describe('LossOfLockAccumulator', () => {
  it('counts bit 0 as lost lock and bit 1 as half-cycle; ignores bit 2', () => {
    const acc = new LossOfLockAccumulator();
    const codes = ['C1C', 'L1C', 'L2W'];
    acc.onObservation('G01', codes, [2e7, 1e8, 8e7], [null, 1, 4]);
    acc.onObservation('G01', codes, [2e7, 1e8, 8e7], [null, 2, 5]);
    acc.onObservation('E05', ['L1C'], [1e8], [null]);
    const r = acc.finalize();
    expect(r.available).toBe(true);
    const l1 = r.bands.find((b) => b.system === 'G' && b.band === '1')!;
    const l2 = r.bands.find((b) => b.system === 'G' && b.band === '2')!;
    expect(l1).toMatchObject({ phaseObs: 2, lossOfLock: 1, halfCycle: 1 });
    // 4 = anti-spoofing / BOC: routine; 5 = 4 | 1: lost lock.
    expect(l2).toMatchObject({ phaseObs: 2, lossOfLock: 1, halfCycle: 0 });
    expect(r.perSatellite).toEqual({ G01: 2 });
  });

  it('reports a source without LLI as unavailable', () => {
    const acc = new LossOfLockAccumulator();
    acc.onObservation('G01', ['L1C'], [1e8], undefined);
    expect(acc.finalize().available).toBe(false);
  });
});

describe('ContinuityAccumulator short gaps', () => {
  it('lists gaps from two epochs up to the long-gap limit', () => {
    const c = new ContinuityAccumulator({
      interval: 1,
      obsTypes: {},
      glonassSlots: {},
    } as unknown as RinexHeader);
    const T0 = Date.UTC(2026, 0, 1);
    const at = (s: number) => c.onEpoch(T0 + s * 1000, []);
    for (let s = 0; s < 100; s++) at(s);
    // 1 s interval: a 30 s dropout (a short gap) …
    for (let s = 130; s < 200; s++) at(s);
    // … a single missing epoch (not a gap) …
    for (let s = 201; s < 300; s++) at(s);
    // … and a 15-min outage (a long gap).
    for (let s = 1200; s < 1300; s++) at(s);
    const r = c.finalize();
    expect(r.shortGapCount).toBe(1);
    expect(r.shortGaps[0]).toEqual({ from: T0 + 99_000, to: T0 + 130_000 });
    expect(r.shortGapSec).toBe(30);
    expect(r.gaps).toHaveLength(1);
  });
});

const HAS_DATA =
  existsSync(join(DIR, 'ABMF.crx')) && existsSync(join(DIR, 'BRDC.nav'));

describe.skipIf(!HAS_DATA)(
  'per-satellite table and untracked stretches (ABMF)',
  () => {
    const buf = HAS_DATA ? readFileSync(join(DIR, 'ABMF.crx')) : null!;
    const nav = HAS_DATA
      ? parseNavFile(readFileSync(join(DIR, 'BRDC.nav'), 'utf-8'))
      : null!;
    const run = async (dropGpsHour: number | null) => {
      const file = new File([new Uint8Array(buf)], 'ABMF.crx');
      const { header } = await parseRinexStream(file);
      const t0 = header.timeOfFirstObs!.getTime();
      const qa = new QualityAccumulator(header, {
        elevation: ElevationModel.create(
          nav.ephemerides,
          header.approxPosition
        ),
        maskDeg: 10,
      });
      await parseRinexStream(
        new File([new Uint8Array(buf)], 'ABMF.crx'),
        undefined,
        undefined,
        (t, prn, codes, v, lli) => {
          const h = (t - t0) / 3_600_000;
          if (
            dropGpsHour !== null &&
            prn[0] === 'G' &&
            h >= dropGpsHour &&
            h < dropGpsHour + 1
          )
            return;
          qa.onObservation(t, prn, codes, v, lli);
        },
        true
      );
      return qa.finalize();
    };

    it('one row per satellite with sane fields', async () => {
      const q = await run(null);
      const rows = q.satellites!;
      expect(rows.length).toBeGreaterThan(40);
      const g = rows
        .filter((r) => r.prn.startsWith('G'))
        .sort((a, b) => (b.tracked ?? 0) - (a.tracked ?? 0))[0]!;
      expect(g.minEl!).toBeGreaterThanOrEqual(-5);
      expect(g.maxEl!).toBeLessThanOrEqual(90);
      expect(g.tracked!).toBeLessThanOrEqual(g.expected!);
      expect(Object.keys(g.multipath)).toContain('1');
      expect(g.cn0['1']!).toBeGreaterThan(30);
      expect(q.lossOfLock!.available).toBe(true);
      // GPS IIR satellites (no L2C) fall back to P(Y) on L2: every GPS
      // satellite gets MP, not only those carrying the preferred C2L/L2L.
      const gps = rows.filter((r) => r.prn[0] === 'G' && (r.tracked ?? 0) > 0);
      for (const r of gps) expect(Object.keys(r.multipath)).toContain('2');
      // Longest first. ABMF loses GLONASS low in the north-west (R24, R06,
      // R13, R20 all at 10–23°, azimuth 313–340°): a low obstruction there
      // that only this list shows — the sky grid needs a wall ≥ 10° high.
      const u = q.tracking!.untracked;
      expect(u[0]).toMatchObject({ prn: 'R24' });
      expect(u[0]!.minutes).toBeGreaterThan(45);
      for (const x of u.filter((x) => x.minutes > 15)) {
        expect(x.azFrom).toBeGreaterThan(230);
        expect(x.elMax).toBeLessThan(25);
      }
    }, 120_000);

    it('an hour without GPS lists each GPS satellite above the mask', async () => {
      const q = await run(12);
      const gps = q.tracking!.untracked.filter((u) => u.prn[0] === 'G');
      expect(gps.length).toBeGreaterThan(5);
      for (const u of gps.slice(0, 5)) {
        expect(u.minutes).toBeGreaterThan(30);
        expect(u.minutes).toBeLessThanOrEqual(61);
        expect(u.elMin).toBeGreaterThanOrEqual(10);
      }
    }, 120_000);
  }
);
