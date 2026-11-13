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

describe('TIME OF FIRST OBS time system (RINEX 3.04 Table A2)', () => {
  // "Defaults: GPS for pure GPS files, GLO … GAL … QZS … BDT for pure BDS
  // files, IRN …"; compulsory in mixed files. BDT is GPST − 14 s, so a
  // BeiDou-only file labelled GPS puts every epoch 14 s off.
  const firstObs = (t: string) =>
    t.split('\n').find((l) => l.slice(60).startsWith('TIME OF FIRST OBS'))!;

  it('single-system data without a stated system get the spec default', async () => {
    const sur4 = await fixture('sur4_obs_slice.rnx');
    const unstated = { ...sur4.header, timeSystem: undefined };
    for (const [sys, code, want] of [
      ['E', 'C1C', 'GAL'],
      ['C', 'C2I', 'BDT'],
      ['R', 'C1C', 'GLO'],
      ['G', 'C1C', 'GPS'],
    ] as const) {
      const d = subset(sur4, { [sys]: [code] });
      const t = await W3({ ...d, header: unstated });
      // 5I6,F13.7,5X,A3: the system sits in columns 49–51
      expect(firstObs(t)).toBe(
        `  2026    11     4     0     0    0.0000000     ${want}         TIME OF FIRST OBS   `
      );
    }
  });

  it("a source file's stated system is kept, tags untouched (no 14 s shift)", async () => {
    // SUR4 states GPS: its BeiDou subset is still tagged in GPS time.
    const sur4 = await fixture('sur4_obs_slice.rnx');
    const bds = subset(sur4, { C: ['C2I', 'L2I'] });
    for (const w of [W3, W4]) {
      const t = await w(bds);
      expect(firstObs(t).slice(48, 51)).toBe('GPS');
      const back = await reread(t);
      expect(back.header.timeSystem).toBe('GPS');
      expect(back.epochs.map((e) => e.time)).toEqual(
        bds.epochs.map((e) => e.time)
      );
    }
  });

  it('a blank source record defaults from the source file system', async () => {
    const sur4 = await fixture('sur4_obs_slice.rnx');
    const d = subset(sur4, { E: ['C1C'] });
    const header = { ...d.header, timeSystem: '', satSystem: 'E' };
    expect(firstObs(await W3({ ...d, header })).slice(48, 51)).toBe('GAL');
    expect(firstObs(await W2({ ...d, header })).slice(48, 51)).toBe('GAL');
  });
});

describe('station header records survive every writer', () => {
  // SUR4's header (RINEX 3.04 Table A2 records) with a marker type set;
  // MARKER TYPE and SIGNAL STRENGTH UNIT do not exist in RINEX 2.11.
  for (const [name, w, v3] of [
    ['RINEX 3.04', W3, true],
    ['RINEX 4.01', W4, true],
    ['RINEX 2.11', W2, false],
    ['CRINEX 3.0', CRX(W3), true],
    ['CRINEX 1.0', CRX(W2), false],
  ] as const) {
    it(name, async () => {
      const sur4 = await fixture('sur4_obs_slice.rnx');
      const src = subset(sur4, { G: ['C1C', 'L1C'] });
      src.header = { ...src.header, markerType: 'GEODETIC' };
      src.epochs[1]!.clockOffset = 0.000000123;
      const h = (await reread(await w(src))).header;
      const pick = (x: typeof h) => ({
        markerName: x.markerName,
        markerNumber: x.markerNumber,
        observer: x.observer,
        agency: x.agency,
        receiverNumber: x.receiverNumber,
        receiverType: x.receiverType,
        receiverVersion: x.receiverVersion,
        antNumber: x.antNumber,
        antType: x.antType,
        approxPosition: x.approxPosition,
        antDelta: x.antDelta,
        interval: x.interval,
        timeOfFirstObs: x.timeOfFirstObs,
        timeSystem: x.timeSystem,
        leapSeconds: x.leapSeconds,
        rcvClockOffsApplied: x.rcvClockOffsApplied,
        ...(v3
          ? {
              markerType: x.markerType,
              signalStrengthUnit: x.signalStrengthUnit,
            }
          : {}),
      });
      expect(pick(h)).toEqual(pick(src.header));
      // The slice ends before the day the source header states.
      expect(h.timeOfLastObs!.getTime()).toBe(src.epochs.at(-1)!.time);
      expect(h.markerNumber).toBe('10601M002');
      expect(h.leapSeconds).toBe(18);
      if (v3) expect(h.markerType).toBe('GEODETIC');
    });
  }
});

describe('SYS / PHASE SHIFT and GLONASS COD/PHS/BIS', () => {
  // Mandatory in RINEX 3.01+/3.02+ (3.04 sections 9.1, 9.9, Table A2);
  // deprecated in RINEX 4 ("should be ignored by RINEX decoders and
  // encoders", 4.01 Table A2), so not written there.
  const keep = {
    G: ['C1C', 'L1C', 'L1L', 'C2W', 'L2W', 'L2S'],
    R: ['C1C', 'L1C', 'L2P'],
  };

  it('RINEX 3.04 keeps the records of the codes it writes', async () => {
    const src = subset(await fixture('sur4_obs_slice.rnx'), keep);
    const h = (await reread(await W3(src))).header;
    expect(h.phaseShifts).toEqual([
      { sys: 'G', code: 'L1C', correction: null, sats: [] },
      { sys: 'G', code: 'L1L', correction: 0.25, sats: [] },
      { sys: 'G', code: 'L2S', correction: -0.25, sats: [] },
      { sys: 'G', code: 'L2W', correction: null, sats: [] },
      { sys: 'R', code: 'L1C', correction: null, sats: [] },
      { sys: 'R', code: 'L2P', correction: 0.25, sats: [] },
    ]);
    expect(h.glonassCodPhsBis).toEqual({
      C1C: -71.94,
      C1P: -71.94,
      C2C: -71.94,
      C2P: -71.94,
    });
  });

  it('RINEX 3.04 from a source without them: the blank "unknown" records', async () => {
    // Section 9.1: alignment unknown → code and correction left blank;
    // 9.9: unknown GLONASS bias → all fields blank.
    const src = subset(await fixture('inab_obs_slice.25o'), {
      G: ['C1', 'L1'],
      R: ['C1', 'L1'],
    });
    src.obsTypes = new Map([
      ['G', ['C1C', 'L1C']],
      ['R', ['C1C', 'L1C']],
    ]);
    const t = await W3(src);
    const lines = t.split('\n').filter((l) => /PHASE SHIFT|COD\/PHS/.test(l));
    expect(lines).toEqual([
      `G${' '.repeat(59)}SYS / PHASE SHIFT   `,
      `R${' '.repeat(59)}SYS / PHASE SHIFT   `,
      `${' '.repeat(60)}GLONASS COD/PHS/BIS `,
    ]);
    const h = (await reread(t)).header;
    expect(h.phaseShifts).toEqual([
      { sys: 'G', code: '', correction: null, sats: [] },
      { sys: 'R', code: '', correction: null, sats: [] },
    ]);
    expect(h.glonassCodPhsBis).toEqual({});
  });

  it('satellite lists with continuation lines (I2.2 count, 10 per line)', async () => {
    const src = subset(await fixture('sur4_obs_slice.rnx'), { G: ['L2S'] });
    const sats = Array.from(
      { length: 12 },
      (_, i) => `G${String(i + 1).padStart(2, '0')}`
    );
    src.header = {
      ...src.header,
      phaseShifts: [{ sys: 'G', code: 'L2S', correction: -0.25, sats }],
    };
    const t = await W3(src);
    expect(t).toContain(
      'G L2S -0.25000  12 G01 G02 G03 G04 G05 G06 G07 G08 G09 G10  SYS / PHASE SHIFT'
    );
    expect(t).toContain(
      `${' '.repeat(18)} G11 G12${' '.repeat(34)}SYS / PHASE SHIFT`
    );
    expect((await reread(t)).header.phaseShifts![0]!.sats).toEqual(sats);
  });

  it('RINEX 4.01 omits both', async () => {
    const src = subset(await fixture('sur4_obs_slice.rnx'), keep);
    const t = await W4(src);
    expect(t).not.toMatch(/PHASE SHIFT|COD\/PHS\/BIS/);
  });
});
