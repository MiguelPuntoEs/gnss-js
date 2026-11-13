import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  readRinexObs,
  writeCrx,
  writeRinex2ObsBlob,
  writeRinex4ObsBlob,
  writeRinexObsBlob,
  v2CodeColumns,
  v2ToV3ObsCode,
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

/**
 * Epochs as plain data for deep equality (NaN → null, LLI/SSI 0 → 0), each
 * satellite's arrays in `order`'s code order for its system. Codes are
 * compared as RINEX 3 signals: a RINEX 2 file's codes are mapped back with
 * v2ToV3ObsCode, so a code a conversion drops shows as null.
 */
function plain(d: RinexObsData, order: Map<string, string[]> = d.obsTypes) {
  const col = (sys: string) => {
    const have = (d.obsTypes.get(sys) ?? []).map((c) =>
      c.length === 2 ? v2ToV3ObsCode(sys, c) : c
    );
    return (order.get(sys) ?? []).map((c) => have.indexOf(c));
  };
  return d.epochs.map((e) => ({
    time: e.time,
    flag: e.flag ?? 0,
    clock: e.clockOffset ?? null,
    records: e.records ?? null,
    // Satellite order within an epoch is free (the writers sort by PRN).
    sats: [...e.sats]
      .filter(([prn]) => order.has(prn[0]!))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([prn, v]) => {
        const idx = col(prn[0]!);
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
      expect(plain(out, src.obsTypes)).toEqual(plain(src));
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
      expect(plain(out, src.obsTypes)).toEqual(plain(src));
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

describe('GLONASS SLOT / FRQ #', () => {
  // 3.04/4.01 Table A2: I3,1X,8(A1,I2.2,1X,I2,1X) — slot zero-padded
  // ("R01", not "R 1"); channel k signed, −7…+6.
  it('writes I2.2 slots and signed channels, 8 per line', async () => {
    const sur4 = await fixture('sur4_obs_slice.rnx');
    const src = subset(sur4, { R: ['C1C'] });
    const t = await W3(src);
    const lines = t.split('\n').filter((l) => l.includes('GLONASS SLOT'));
    expect(lines[0]).toBe(
      ' 24 R01  1 R02 -4 R03  5 R04  6 R05  1 R06 -4 R07  5 R08  6 GLONASS SLOT / FRQ #'
    );
    expect(lines[1]).toBe(
      '    R09 -2 R10 -7 R11  0 R12 -1 R13 -2 R14 -7 R15  0 R16 -1 GLONASS SLOT / FRQ #'
    );
    expect((await reread(t)).header.glonassSlots).toEqual(
      sur4.header.glonassSlots
    );
  });
});

describe('RINEX 2.11 ↔ 3 observation codes', () => {
  // RINEX 2.11 Table A2 "# / TYPES OF OBSERV": "C: Pseudorange GPS: C/A,
  // L2C; Glonass: C/A; Galileo: All. P: Pseudorange GPS and Glonass: P
  // code"; section 10.1.1 gives the band numbers per system.
  it('v3 → v2: one signal per v2 code, C2 is L2C and P2 is P(Y)', async () => {
    const sur4 = await fixture('sur4_obs_slice.rnx');
    const named = (sys: string) => {
      const codes = sur4.obsTypes.get(sys)!;
      return Object.fromEntries(
        [...v2CodeColumns(sys, codes)].map(([v2, i]) => [v2, codes[i]])
      );
    };
    expect(named('G')).toEqual({
      C1: 'C1C', L1: 'L1C', D1: 'D1C', S1: 'S1C', // C/A, not L1C (C1L)
      C2: 'C2S', P2: 'C2W', // L2C is C2, P(Y) is P2
      L2: 'L2W', D2: 'D2W', S2: 'S2W', // the P2 carrier
      C5: 'C5Q', L5: 'L5Q', D5: 'D5Q', S5: 'S5Q',
    }); // prettier-ignore
    expect(named('R')).toEqual({
      C1: 'C1C', L1: 'L1C', D1: 'D1C', S1: 'S1C',
      C2: 'C2C', P2: 'C2P', L2: 'L2P', D2: 'D2P', S2: 'S2P',
    }); // prettier-ignore
    expect(named('E')).toEqual({
      C1: 'C1C', L1: 'L1C', D1: 'D1C', S1: 'S1C',
      C5: 'C5Q', L5: 'L5Q', D5: 'D5Q', S5: 'S5Q',
      C6: 'C6B', L6: 'L6B', D6: 'D6B', S6: 'S6B',
      C7: 'C7Q', L7: 'L7Q', D7: 'D7Q', S7: 'S7Q',
      C8: 'C8Q', L8: 'L8Q', D8: 'D8Q', S8: 'S8Q',
    }); // prettier-ignore
    expect(named('C')).toEqual({}); // BeiDou: no RINEX 2.11 codes
  });

  it('v2 → v3 as RTKLIB convcode (rinex.c) maps RINEX 2.11 codes', () => {
    const m = (sys: string, codes: string[]) =>
      codes.map((c) => v2ToV3ObsCode(sys, c));
    expect(m('G', ['C1', 'P1', 'L1', 'D1', 'S1', 'C2', 'P2', 'L2', 'C5', 'L5'])).toEqual(
      ['C1C', 'C1W', 'L1C', 'D1C', 'S1C', 'C2X', 'C2W', 'L2W', 'C5X', 'L5X']
    ); // prettier-ignore
    expect(m('R', ['C1', 'P1', 'L1', 'C2', 'P2', 'L2', 'S2'])).toEqual(
      ['C1C', 'C1P', 'L1C', 'C2C', 'C2P', 'L2P', 'S2P']
    ); // prettier-ignore
    expect(m('E', ['C1', 'L1', 'C5', 'L7', 'S8', 'C6', 'P1'])).toEqual(
      ['C1X', 'L1X', 'C5X', 'L7X', 'S8X', 'C6X', null]
    ); // prettier-ignore
    expect(m('S', ['C1', 'L1', 'C5', 'L2'])).toEqual([
      'C1C',
      'L1C',
      'C5X',
      null,
    ]);
  });

  it('RINEX 2.11 → 2.11 keeps every observation (G, R and E)', async () => {
    // INAB: 24 types (C1 C2 C5 C7 C8 L1 … S8), GPS + GLONASS + Galileo.
    const src = await fixture('inab_obs_slice.25o');
    for (const w of [W2, CRX(W2)]) {
      const out = await reread(await w(src));
      expect(out.obsTypes.get('G')).toEqual(src.obsTypes.get('G'));
      expect(plain(out)).toEqual(plain(src));
    }
  });

  it('RINEX 2.11 → 3.04 / 4.01 writes RINEX 3 codes, values intact', async () => {
    const src = await fixture('inab_obs_slice.25o');
    for (const w of [W3, W4, CRX(W3)]) {
      const out = await reread(await w(src));
      expect(out.obsTypes.get('G')!.slice(0, 6)).toEqual(
        src.obsTypes
          .get('G')!
          .slice(0, 6)
          .map((c) => v2ToV3ObsCode('G', c))
      );
      for (const c of out.obsTypes.get('E')!)
        expect(c).toMatch(/^[CLDS][15678]X$/);
      // every value of a code RINEX 3 can name comes back
      const v3 = new Map(
        [...src.obsTypes].map(([sys, codes]) => [
          sys,
          codes.map((c) => v2ToV3ObsCode(sys, c) ?? '?'),
        ])
      );
      expect(plain(out, v3)).toEqual(plain(src, v3));
    }
  });

  it('RINEX 3.04 → 2.11 → 3.04: the spec mapping, no value moves', async () => {
    const sur4 = await fixture('sur4_obs_slice.rnx');
    const v2 = await reread(await W2(sur4));
    expect(v2.header.satSystem).toBe('M');
    expect([...v2.obsTypes.keys()].sort()).toEqual(['E', 'G', 'R']); // no C
    const back = await reread(await W3(v2));
    // Each v3 code that comes back carries the source signal it was
    // chosen from (attribute X where RINEX 2 cannot tell, e.g. L2C, L5).
    const expected: Record<string, Record<string, string>> = {
      G: { C1C: 'C1C', L1C: 'L1C', C2X: 'C2S', C2W: 'C2W', L2W: 'L2W', C5X: 'C5Q', L5X: 'L5Q', S1C: 'S1C' },
      R: { C1C: 'C1C', C2P: 'C2P', L2P: 'L2P', C2C: 'C2C' },
      E: { C1X: 'C1C', L1X: 'L1C', C7X: 'C7Q', L8X: 'L8Q', S6X: 'S6B' },
    }; // prettier-ignore
    for (const [sys, pairs] of Object.entries(expected)) {
      const order = new Map([[sys, Object.keys(pairs)]]);
      const srcOrder = new Map([[sys, Object.values(pairs)]]);
      expect(plain(back, order)).toEqual(plain(sur4, srcOrder));
    }
  });
});

/* ------------------------------------------------------------------ */
/*  The full matrix: every source format through every writer          */
/* ------------------------------------------------------------------ */

/**
 * What a writer must give back of a source, in the source's own codes:
 * all of it for RINEX 3/4; for RINEX 2.11 the signal v2CodeColumns picks
 * per v2 code of the systems 2.11 defines.
 */
function expectedCodes(src: RinexObsData, toV2: boolean) {
  const v3 = new Map(
    [...src.obsTypes].map(([sys, codes]) => [
      sys,
      codes.map((c) => (c.length === 2 ? (v2ToV3ObsCode(sys, c) ?? '?') : c)),
    ])
  );
  if (!toV2) return { src: v3, out: v3 };
  const s = new Map<string, string[]>();
  const o = new Map<string, string[]>();
  for (const [sys, codes] of src.obsTypes) {
    const cols = v2CodeColumns(sys, codes);
    if (cols.size === 0) continue;
    s.set(
      sys,
      [...cols.values()].map((i) => v3.get(sys)![i]!)
    );
    o.set(
      sys,
      [...cols.keys()].map((c) => v2ToV3ObsCode(sys, c) ?? '?')
    );
  }
  return { src: s, out: o };
}

const SOURCES = [
  ['RINEX 3.04 (SUR4, Leica GR50)', 'sur4_obs_slice.rnx'],
  ['CRINEX 3.0 (SUR4)', 'sur4_lli_slice.crx'],
  ['RINEX 3.02 (ANMG)', 'anmg_obs_slice.rnx'],
  ['CRINEX 3.0 (ANMG, .Z)', 'anmg_crx_slice.crx.Z'],
  ['RINEX 2.11 (INAB, event)', 'inab_obs_slice.25o'],
  ['CRINEX 1.0 (INAB)', 'inab_lli_slice.25d'],
] as const;

const WRITERS = [
  ['RINEX 2.11', W2, true],
  ['RINEX 3.04', W3, false],
  ['RINEX 4.01', W4, false],
  ['CRINEX 1.0', CRX(W2), true],
  ['CRINEX 3.0', CRX(W3), false],
  ['CRINEX 3.0 (RINEX 4.01)', CRX(W4), false],
] as const;

/** First n observation epochs (+ events among them): keeps CRX cases fast. */
function head(d: RinexObsData, n = 12): RinexObsData {
  return { ...d, epochs: d.epochs.slice(0, n) };
}

describe('conversion matrix: values, LLI, SSI, flags, clock, events', () => {
  for (const [sname, file] of SOURCES) {
    for (const [wname, w, toV2] of WRITERS) {
      it(`${sname} → ${wname}`, async () => {
        const src = head(await fixture(file));
        const out = await reread(await w(src));
        const codes = expectedCodes(src, toV2);
        expect(plain(out, codes.out)).toEqual(plain(src, codes.src));
        // nothing else appears
        expect([...out.obsTypes.keys()].sort()).toEqual(
          [...codes.out.keys()].sort()
        );
        // header records every version has (RINEX 2.11 lacks MARKER TYPE,
        // SIGNAL STRENGTH UNIT, GLONASS SLOT / FRQ #, SYS / PHASE SHIFT)
        const hk = (h: RinexObsData['header'], v2: boolean) => ({
          markerName: h.markerName,
          markerNumber: h.markerNumber ?? '',
          observer: h.observer,
          agency: h.agency,
          receiver: [h.receiverNumber, h.receiverType, h.receiverVersion],
          antenna: [h.antNumber, h.antType],
          approxPosition: h.approxPosition,
          antDelta: h.antDelta,
          timeSystem: h.timeSystem,
          leapSeconds: h.leapSeconds,
          ...(v2
            ? {}
            : {
                markerType: h.markerType,
                signalStrengthUnit: h.signalStrengthUnit,
                glonassSlots: h.glonassSlots,
              }),
        });
        const v2 = toV2 || src.header.version < 3;
        expect(hk(out.header, v2)).toEqual(hk(src.header, v2));
        // INTERVAL is optional: written (30 s) even when the source has none
        expect(out.header.interval).toBe(src.header.interval ?? 30);
      });
    }
  }

  it('RINEX 4.01 source (written from SUR4) → every writer', async () => {
    const v4 = await reread(await W4(await fixture('sur4_obs_slice.rnx')));
    expect(v4.header.version).toBe(4.01);
    for (const [, w, toV2] of WRITERS) {
      const out = await reread(await w(v4));
      const codes = expectedCodes(v4, toV2);
      expect(plain(out, codes.out)).toEqual(plain(v4, codes.src));
    }
  });
});

describe('multi-step chains', () => {
  it('RINEX 2.11 → 3.04 → CRINEX 3 → 3.04 → 2.11 gives the 2.11 file back', async () => {
    const src = await fixture('inab_obs_slice.25o');
    const v3 = await reread(await CRX(W3)(src));
    const v2 = await reread(await W2(v3));
    // Same set of types (C2 → C2X → C2, P1 → C1W → P1, …); allowed
    // difference: the list is in canonical order, not the source's.
    expect([...v2.obsTypes.get('G')!].sort()).toEqual(
      src.obsTypes
        .get('G')!
        .filter((c) => v2ToV3ObsCode('G', c))
        .sort()
    );
    expect(plain(v2)).toEqual(plain(src));
  });

  it('RINEX 3.04 → 2.11 → CRINEX 1 → 2.11 → 3.04 → CRINEX 3 → 3.04', async () => {
    const src = await fixture('sur4_obs_slice.rnx');
    const a = await reread(await W2(src));
    const b = await reread(await CRX(W2)(a));
    const c = await reread(await CRX(W3)(b));
    const d = await reread(await W3(c));
    expect(plain(d)).toEqual(plain(c));
    expect(plain(b)).toEqual(plain(a));
    const codes = expectedCodes(src, true);
    expect(plain(d, codes.out)).toEqual(plain(src, codes.src));
  });

  it('writers are a fixed point: write(read(write(x))) = write(x)', async () => {
    const strip = (t: string) =>
      t
        .replace(/^.*PGM \/ RUN BY \/ DATE.*$/m, '')
        .replace(/^.*CRINEX PROG.*$/m, '');
    for (const file of ['sur4_obs_slice.rnx', 'inab_obs_slice.25o']) {
      const src = await fixture(file);
      for (const [, w] of WRITERS) {
        const once = await w(src);
        const twice = await w(await reread(once));
        expect(strip(twice)).toBe(strip(once));
      }
    }
  });
});

describe('RINEX 3.04 data section is line-identical to the source', () => {
  // Our writer against crx2rnx's decompression of the Leica file: every
  // epoch and observation record, character for character. Allowed
  // differences: satellite order within an epoch (we sort by PRN), and an
  // LLI or SSI digit 0 is written blank (Table A3: "0 or blank: OK or not
  // known" / "not known, don't care").
  it('SUR4', async () => {
    const original = readFileSync(FIX('sur4_obs_slice.rnx'), 'latin1');
    const ours = await W3(await fixture('sur4_obs_slice.rnx'));
    const body = (t: string) => {
      const lines = t.split('\n');
      const out: string[] = [];
      let block: string[] = [];
      for (const l of lines.slice(
        lines.findIndex((x) => x.includes('END OF HEADER')) + 1
      )) {
        if (l.startsWith('>')) {
          out.push(...block.sort());
          block = [];
          out.push(l);
        } else if (l)
          block.push(
            l
              .replace(/(\.\d{3})0/g, '$1 ')
              .replace(/(\.\d{3}[ \d])0/g, '$1 ')
              .trimEnd()
          );
      }
      return [...out, ...block.sort()];
    };
    expect(body(ours)).toEqual(body(original));
  });
});

/* ------------------------------------------------------------------ */
/*  Convention locks                                                   */
/* ------------------------------------------------------------------ */

describe('convention locks', () => {
  it('ANTENNA: DELTA H/E/N is [Up, East, North] in every version', async () => {
    // RINEX 3.04 Table A2: "Antenna height: Height of the antenna reference
    // point (ARP) above the marker" F14.4, then "Horizontal eccentricity of
    // ARP relative to the marker (east/north)" 2F14.4. Positioning takes
    // [E, N, U] (antDeltaEnu = [d[1], d[2], d[0]]); a swap here is the
    // ANTEX N/E bug again.
    const src = subset(await fixture('sur4_obs_slice.rnx'), { G: ['C1C'] });
    src.header = { ...src.header, antDelta: [1.2345, -0.0123, 0.0456] };
    for (const w of [W2, W3, W4, CRX(W2), CRX(W3)]) {
      const t = await w(src);
      const line = t
        .split('\n')
        .find((l) => l.includes('ANTENNA: DELTA H/E/N'))!;
      expect(line.slice(0, 42)).toBe(
        '        1.2345       -0.0123        0.0456'
      );
      const h = (await reread(t)).header;
      expect(h.antDelta).toEqual([1.2345, -0.0123, 0.0456]);
      const [up, east, north] = h.antDelta!;
      expect({ up, east, north }).toEqual({
        up: 1.2345,
        east: -0.0123,
        north: 0.0456,
      });
    }
  });

  it('APPROX POSITION XYZ is ECEF metres (SUR4 ≈ 6.36e6 m from the geocentre)', async () => {
    const { header } = await fixture('sur4_obs_slice.rnx');
    expect(header.approxPosition).toEqual([
      2959057.2428, 1341058.4979, 5470426.8032,
    ]);
    const r = Math.hypot(...header.approxPosition!);
    expect(r).toBeGreaterThan(6.35e6);
    expect(r).toBeLessThan(6.39e6);
    const back = (
      await reread(
        await W2(subset(await fixture('sur4_obs_slice.rnx'), { G: ['C1C'] }))
      )
    ).header;
    expect(back.approxPosition).toEqual(header.approxPosition);
  });

  it('GLONASS-only file in GLO (UTC) time: tags written as given, no 18 s / 3 h shift', async () => {
    // 3.04 section 3.1/Table A2: pure GLONASS files default to GLO = UTC(SU)
    // aligned UTC. A writer must not move tags between time scales.
    const sur4 = await fixture('sur4_obs_slice.rnx');
    const glo = subset(sur4, { R: ['C1C', 'L1C'] });
    glo.header = { ...glo.header, timeSystem: 'GLO', satSystem: 'R' };
    for (const w of [W2, W3, W4]) {
      const t = await w(glo);
      const first = t.split('\n').find((l) => l.includes('TIME OF FIRST OBS'))!;
      expect(first.slice(48, 51)).toBe('GLO');
      const back = await reread(t);
      expect(back.header.timeSystem).toBe('GLO');
      expect(back.epochs.map((e) => e.time)).toEqual(
        glo.epochs.map((e) => e.time)
      );
    }
  });

  it('receiver clock offset is seconds (F15.12 / F12.9), sign kept', async () => {
    const src = subset(await fixture('sur4_obs_slice.rnx'), { G: ['C1C'] });
    src.epochs[0]!.clockOffset = -0.000412345678;
    const v3 = await W3(src);
    expect(v3).toContain(
      '> 2026 11 04 00 00  0.0000000  0 10      -0.000412345678'
    );
    const v2 = await W2(src);
    expect(
      v2
        .split('\n')
        .find((l) => l.startsWith(' 26 11  4  0  0'))!
        .slice(68)
    ).toBe('-0.000412346');
  });
});
