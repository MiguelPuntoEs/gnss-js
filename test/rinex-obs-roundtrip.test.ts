import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  readRinexObs,
  writeCrx,
  writeRinex2ObsBlob,
  writeRinex4ObsBlob,
  writeRinexObsBlob,
  type CompactEpoch,
  type RinexObsData,
} from '../src/rinex';

/**
 * RINEX observation conversions: every reader (2.11, 3.0x, 4.0x, CRINEX
 * 1.0/3.0) into every writer (2.11, 3.04, 4.01, CRINEX) and back, compared
 * value by value — observations, LLI, signal strength, epoch flags, clock
 * offsets, events and the header records a conversion must carry.
 *
 * Fixtures: real IGS/EUREF CRINEX slices and their crx2rnx decompression
 * (see test-fixtures/README.rinex-obs).
 */

const FIX = (name: string) => `${__dirname}/../test-fixtures/${name}`;
const fixture = (name: string) =>
  readRinexObs(new File([readFileSync(FIX(name))], name));

async function text(blob: Blob): Promise<string> {
  return gunzipSync(Buffer.from(await blob.arrayBuffer())).toString('latin1');
}

const reread = (t: string) => readRinexObs(new File([t], 'x.obs'));

type Writer = (d: RinexObsData) => Promise<string>;
const W3: Writer = async (d) =>
  text(await writeRinexObsBlob(d.header, d.epochs, d.obsTypes));
const W4: Writer = async (d) =>
  text(await writeRinex4ObsBlob(d.header, d.epochs, d.obsTypes));
const W2: Writer = async (d) =>
  text(await writeRinex2ObsBlob(d.header, d.epochs, d.obsTypes));
const CRX =
  (w: Writer): Writer =>
  async (d) =>
    writeCrx(await w(d), { date: '01-Jan-24 00:00' });

/** Epochs as plain data for deep equality (NaN → null, LLI/SSI 0 → absent). */
function plain(epochs: CompactEpoch[], codes?: (sys: string) => number[]) {
  return epochs.map((e) => ({
    time: e.time,
    flag: e.flag ?? 0,
    clock: e.clockOffset ?? null,
    records: e.records ?? null,
    // Satellite order within an epoch is free (the writers sort by PRN).
    sats: [...e.sats]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([prn, v]) => {
        const idx = codes?.(prn[0]!) ?? [...v.keys()];
        const lli = e.lli?.get(prn);
        const ssi = e.ssi?.get(prn);
        return [
          prn,
          idx.map((i) => (i < 0 || Number.isNaN(v[i]!) ? null : v[i]!)),
          idx.map((i) => (i >= 0 ? (lli?.[i] ?? 0) : 0)),
          idx.map((i) => (i >= 0 ? (ssi?.[i] ?? 0) : 0)),
        ];
      }),
  }));
}

/** Keep only `keep` (system → codes) of a data set, re-indexing every array. */
function subset(d: RinexObsData, keep: Record<string, string[]>): RinexObsData {
  const idx = new Map(
    Object.entries(keep).map(([sys, codes]) => [
      sys,
      codes.map((c) => d.obsTypes.get(sys)!.indexOf(c)),
    ])
  );
  const pick = <T extends Float64Array | Uint8Array>(a: T, ix: number[]) =>
    ix.map((i) => a[i]!);
  const epochs = d.epochs.map((e) => {
    const out: CompactEpoch = { ...e, sats: new Map() };
    delete out.lli;
    delete out.ssi;
    for (const [prn, v] of e.sats) {
      const ix = idx.get(prn[0]!);
      if (!ix) continue;
      out.sats.set(prn, Float64Array.from(pick(v, ix)));
      const l = e.lli?.get(prn);
      if (l) (out.lli ??= new Map()).set(prn, Uint8Array.from(pick(l, ix)));
      const q = e.ssi?.get(prn);
      if (q) (out.ssi ??= new Map()).set(prn, Uint8Array.from(pick(q, ix)));
    }
    return out;
  });
  return {
    header: d.header,
    epochs,
    obsTypes: new Map(Object.entries(keep)),
  };
}

/** Count of non-zero flags in a flag map. */
const flagCount = (epochs: CompactEpoch[], k: 'lli' | 'ssi') =>
  epochs.reduce(
    (n, e) =>
      n +
      [...(e[k]?.values() ?? [])].reduce(
        (m, a) => m + a.filter(Boolean).length,
        0
      ),
    0
  );

describe('LLI survives every writer', () => {
  // The loss-of-lock indicator is column 15 of each F14.3 field (RINEX 2.11
  // Table A2, 3.04 Table A3). Bit 0 = cycle slip: dropping it hides every
  // slip from the next processor.
  for (const [name, w] of [
    ['RINEX 3.04', W3],
    ['RINEX 4.01', W4],
    ['RINEX 2.11', W2],
    ['CRINEX 3.0', CRX(W3)],
    ['CRINEX 1.0', CRX(W2)],
  ] as const) {
    it(name, async () => {
      // ANMG (RINEX 3.02): L1C, L2W slips on G
      const src = subset(await fixture('anmg_obs_slice.rnx'), {
        G: ['C1C', 'L1C', 'C2W', 'L2W'],
      });
      const out = await reread(await w(src));
      expect(flagCount(src.epochs, 'lli')).toBe(4);
      expect(plain(out.epochs).map((e) => e.sats.map((s) => s[2]))).toEqual(
        plain(src.epochs).map((e) => e.sats.map((s) => s[2]))
      );
    });
  }
});

describe('signal strength indicator survives every writer', () => {
  // SSI is column 16 of each field (1–9, RINEX 3.04 Table A3). SUR4's Leica
  // GR50 maps its C/N0 into it (header COMMENT: "< 12dBHz -> 1 …").
  for (const [name, w] of [
    ['RINEX 3.04', W3],
    ['RINEX 4.01', W4],
    ['RINEX 2.11', W2],
    ['CRINEX 3.0', CRX(W3)],
    ['CRINEX 1.0', CRX(W2)],
  ] as const) {
    it(name, async () => {
      const src = subset(await fixture('sur4_obs_slice.rnx'), {
        G: ['C1C', 'L1C', 'C2W', 'L2W', 'S1C'],
      });
      const out = await reread(await w(src));
      expect(flagCount(src.epochs, 'ssi')).toBeGreaterThan(50);
      expect(plain(out.epochs).map((e) => e.sats.map((s) => s[3]))).toEqual(
        plain(src.epochs).map((e) => e.sats.map((s) => s[3]))
      );
    });
  }
});

describe('epoch flag, receiver clock offset and events survive every writer', () => {
  // INAB (RINEX 2.11) carries a flag-3 event (new site occupation) at
  // 01:00:00; the clock offsets are synthetic, asymmetric values written to
  // the precision of the narrower format (RINEX 2 F12.9).
  const COMMENT = `${'re-occupied'.padEnd(60)}COMMENT`;
  for (const [name, w] of [
    ['RINEX 3.04', W3],
    ['RINEX 4.01', W4],
    ['RINEX 2.11', W2],
    ['CRINEX 3.0', CRX(W3)],
    ['CRINEX 1.0', CRX(W2)],
  ] as const) {
    it(name, async () => {
      const src = subset(await fixture('inab_obs_slice.25o'), {
        G: ['C1', 'L1'],
      });
      const ev = src.epochs.findIndex((e) => e.flag === 3);
      expect(ev).toBe(3);
      src.epochs[ev]!.records = [COMMENT];
      src.epochs[0]!.clockOffset = -0.000123456;
      src.epochs[1]!.clockOffset = 0.000987654;
      src.epochs[2]!.flag = 1; // power failure before this epoch
      // An event without a significant epoch (blank date fields)
      src.epochs.push({
        time: NaN,
        sats: new Map(),
        flag: 4,
        records: [COMMENT],
      });
      // W2's v2 code passthrough is not this test's subject: use v3 codes.
      const v3 = { ...src, obsTypes: new Map([['G', ['C1C', 'L1C']]]) };
      const out = await reread(await w(v3));
      const meta = (d: RinexObsData) =>
        d.epochs.map((e) => [
          e.time,
          e.flag ?? 0,
          e.clockOffset ?? null,
          e.records ?? null,
        ]);
      expect(meta(out)).toEqual(meta(src));
    });
  }
});
