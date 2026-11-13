import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseRinexHeaderText,
  parseRinexStream,
  readRinexObs,
  writeCrx,
  type CompactEpoch,
} from '../src/rinex';

/**
 * Observation-reader fixes found by the RINEX obs round-trip program. Each
 * block cites the specification record it pins.
 */

function fileFrom(content: string, name = 'test.obs'): File {
  return new File([content], name, { type: 'text/plain' });
}

interface Obs {
  time: number;
  prn: string;
  codes: string[];
  values: (number | null)[];
}

async function collect(text: string): Promise<Obs[]> {
  const out: Obs[] = [];
  await parseRinexStream(
    fileFrom(text),
    undefined,
    undefined,
    (time, prn, codes, values) =>
      out.push({ time, prn, codes, values: [...values] })
  );
  return out;
}

const V3_HEADER = `     3.04           OBSERVATION DATA    G                   RINEX VERSION / TYPE
TEST                                                        MARKER NAME
G    2 C1C L1C                                              SYS / # / OBS TYPES
  2024     1     1     0     0    0.0000000     GPS         TIME OF FIRST OBS
                                                            END OF HEADER
`;

const V2_HEADER = `     2.11           OBSERVATION DATA    G (GPS)             RINEX VERSION / TYPE
TEST                                                        MARKER NAME
     2    C1    L1                                          # / TYPES OF OBSERV
  2024     1     1     0     0    0.0000000     GPS         TIME OF FIRST OBS
                                                            END OF HEADER
`;

describe('epoch flag 1 (power failure) carries observations', () => {
  // RINEX 3.04 Table A3 / 2.11 Table A2: "Epoch flag = 0 or 1: OBSERVATION
  // records follow". Flag 1 only says the receiver lost power before it.
  const v3 = `${V3_HEADER}> 2024 01 01 00 00  0.0000000  0  1
G01  20000000.000   105000000.000
> 2024 01 01 00 00 30.0000000  1  1
G01  20000100.000   105000500.000
`;
  const v2 = `${V2_HEADER} 24  1  1  0  0  0.0000000  0  1G01
  20000000.000   105000000.000
 24  1  1  0  0 30.0000000  1  1G01
  20000100.000   105000500.000
`;

  it('RINEX 3', async () => {
    const obs = await collect(v3);
    expect(obs.map((o) => o.values[0])).toEqual([20000000, 20000100]);
  });

  it('RINEX 2', async () => {
    const obs = await collect(v2);
    expect(obs.map((o) => o.values[1])).toEqual([105000000, 105000500]);
  });

  it('Compact RINEX 3 and 1', async () => {
    for (const text of [v3, v2]) {
      const obs = await collect(writeCrx(text, { date: '01-Jan-24 00:00' }));
      expect(obs).toHaveLength(2);
      expect(obs[1]!.values[0]).toBe(20000100);
    }
  });
});

describe('RINEX 2 epoch with a receiver clock offset', () => {
  // RINEX 2.11 Table A2: satellite list 12(A1,I2) in columns 33–68, then the
  // optional receiver clock offset F12.9 in columns 69–80. Read as more
  // satellites ("  -", "0.0", …) it threw the whole epoch out of step.
  const sats = 'G01G02G03G04G05G06G07G08G09G10G11G12';
  const lines = Array.from(
    { length: 12 },
    (_, i) => `  ${20000000 + i}.000   ${105000000 + i}.000`
  ).join('\n');
  const text = `${V2_HEADER} 24  1  1  0  0  0.0000000  0 12${sats}  -0.000123456
${lines}
 24  1  1  0  0 30.0000000  0  1G05
  20000100.000   105000500.000
`;

  it('reads every satellite of both epochs', async () => {
    const obs = await collect(text);
    expect(obs).toHaveLength(13);
    expect(obs[11]).toMatchObject({
      prn: 'G12',
      values: [20000011, 105000011],
    });
    expect(obs[12]).toMatchObject({
      prn: 'G05',
      values: [20000100, 105000500],
    });
  });
});

describe('SYS / SCALE FACTOR', () => {
  // RINEX 3.04 Table A2: "Factor to divide stored observations with before
  // use (1,10,100,1000)". A phase stored ×10 keeps a fourth decimal.
  const text = `     3.04           OBSERVATION DATA    G                   RINEX VERSION / TYPE
TEST                                                        MARKER NAME
G    3 C1C L1C S1C                                          SYS / # / OBS TYPES
G   10  1 L1C                                               SYS / SCALE FACTOR
G  100  1 S1C                                               SYS / SCALE FACTOR
  2024     1     1     0     0    0.0000000     GPS         TIME OF FIRST OBS
                                                            END OF HEADER
> 2024 01 01 00 00  0.0000000  0  1
G01  20000000.123  1050000001.234        4525.000
`;

  it('divides stored values by the factor (RINEX 3 and Compact RINEX 3)', async () => {
    for (const t of [text, writeCrx(text, { date: '01-Jan-24 00:00' })]) {
      const [o] = await collect(t);
      expect(o!.values[0]).toBeCloseTo(20000000.123, 6);
      expect(o!.values[1]).toBeCloseTo(105000000.1234, 6);
      expect(o!.values[2]).toBeCloseTo(45.25, 9);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Header records a conversion must carry (RINEX 3.04 Table A2)       */
/* ------------------------------------------------------------------ */

const FIX = (name: string) => `${__dirname}/../test-fixtures/${name}`;
const fixtureFile = (name: string) => new File([readFileSync(FIX(name))], name);

describe('header records (SUR4, Leica GR50, RINEX 3.04)', () => {
  it('reads every conversion-relevant record as the file states it', async () => {
    const { header: h } = await readRinexObs(fixtureFile('sur4_obs_slice.rnx'));
    expect(h.markerNumber).toBe('10601M002');
    expect(h.markerType).toBe('');
    expect(h.signalStrengthUnit).toBe('DBHZ');
    expect(h.timeSystem).toBe('GPS');
    expect(h.leapSeconds).toBe(18);
    expect(h.rcvClockOffsApplied).toBe(false);
    expect(h.interval).toBe(30);
    // SYS / PHASE SHIFT: A1,1X,A3,1X,F8.5 — blank correction = reference
    expect(h.phaseShifts).toHaveLength(19);
    expect(h.phaseShifts![0]).toEqual({
      sys: 'G',
      code: 'L1C',
      correction: null,
      sats: [],
    });
    expect(h.phaseShifts![2]).toEqual({
      sys: 'G',
      code: 'L2S',
      correction: -0.25,
      sats: [],
    });
    expect(h.phaseShifts![8]).toMatchObject({ code: 'L1C', correction: 0.5 });
    // GLONASS COD/PHS/BIS: 4(1X,A3,1X,F8.3), metres
    expect(h.glonassCodPhsBis).toEqual({
      C1C: -71.94,
      C1P: -71.94,
      C2C: -71.94,
      C2P: -71.94,
    });
  });

  it('GLONASS channel sign: R02 -4, R04 +6 (8(A1,I2.2,1X,I2,1X))', async () => {
    const { header: h } = await readRinexObs(fixtureFile('sur4_obs_slice.rnx'));
    expect(h.glonassSlots[2]).toBe(-4);
    expect(h.glonassSlots[4]).toBe(6);
    expect(h.glonassSlots[10]).toBe(-7);
    expect(Object.keys(h.glonassSlots)).toHaveLength(24);
  });

  it('phase-shift satellite lists and their continuation lines', () => {
    const h =
      parseRinexHeaderText(`     3.04           OBSERVATION DATA    G                   RINEX VERSION / TYPE
G    1 L2S                                                  SYS / # / OBS TYPES
G L2S -0.25000  12 G01 G02 G03 G04 G05 G06 G07 G08 G09 G10  SYS / PHASE SHIFT
                  G11 G12                                   SYS / PHASE SHIFT
G L2X                                                       SYS / PHASE SHIFT
                                                            END OF HEADER
`)!;
    expect(h.phaseShifts![0]!.sats).toHaveLength(12);
    expect(h.phaseShifts![0]!.sats[11]).toBe('G12');
    expect(h.phaseShifts![1]).toEqual({
      sys: 'G',
      code: 'L2X',
      correction: null,
      sats: [],
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Compact RINEX reader vs RNXCMP crx2rnx (independent oracle)        */
/* ------------------------------------------------------------------ */

describe('CRINEX reader equals crx2rnx', () => {
  // *_obs_slice.* are crx2rnx 4.2.0 output of the committed CRINEX slices,
  // cut to a few epochs: decoding the CRINEX ourselves must give the same
  // values, LLI and SSI, epoch flags and events.
  for (const [crx, rnx] of [
    ['sur4_lli_slice.crx', 'sur4_obs_slice.rnx'],
    ['anmg_crx_slice.crx', 'anmg_obs_slice.rnx'],
    ['inab_lli_slice.25d', 'inab_obs_slice.25o'],
  ] as const) {
    it(`${crx} ≡ ${rnx}`, async () => {
      const a = await readRinexObs(fixtureFile(crx));
      const b = await readRinexObs(fixtureFile(rnx));
      expect(b.epochs.length).toBeGreaterThan(2);
      const t0 = b.epochs[0]!.time;
      const i0 = a.epochs.findIndex((e) => e.time === t0);
      const slice = a.epochs.slice(i0, i0 + b.epochs.length);
      expect(plain(slice)).toEqual(plain(b.epochs));
      expect([...a.obsTypes]).toEqual([...b.obsTypes]);
    });
  }
});

/** Epochs as plain data for deep equality (NaN → null). */
function plain(epochs: CompactEpoch[]) {
  return epochs.map((e) => ({
    time: e.time,
    flag: e.flag ?? 0,
    clock: e.clockOffset ?? null,
    records: e.records ?? null,
    sats: [...e.sats].map(([prn, v]) => [
      prn,
      [...v].map((x) => (Number.isNaN(x) ? null : x)),
      [...(e.lli?.get(prn) ?? [])],
      [...(e.ssi?.get(prn) ?? [])],
    ]),
  }));
}

/* ------------------------------------------------------------------ */
/*  Epoch records: clock offset, events, SSI                           */
/* ------------------------------------------------------------------ */

describe('epoch records', () => {
  // RINEX 3.04 Table A3: clock F15.12 from column 42; RINEX 2.11: F12.9 in
  // columns 69–80. Asymmetric values so a unit slip (ns vs s) shows.
  /** F14.3 + LLI + SSI */
  const f = (v: number, lli = ' ', ssi = ' ') =>
    v.toFixed(3).padStart(14) + lli + ssi;
  const ev3 = (t: string, flag: number, n: number, clk?: number) =>
    `> 2024 01 01 ${t}  ${flag}${String(n).padStart(3)}` +
    (clk === undefined ? '' : `      ${clk.toFixed(12).padStart(15)}`);
  const ev2 = (t: string, flag: number, n: number, sats = '', clk?: number) =>
    ` 24  1  1 ${t}  ${flag}${String(n).padStart(3)}${sats}`.padEnd(
      clk === undefined ? 0 : 68
    ) + (clk === undefined ? '' : clk.toFixed(9).padStart(12));
  const COMMENT = `${''.padEnd(60)}COMMENT`;
  const MOVED = `${'MOVED'.padEnd(60)}MARKER NAME`;
  const v3 = [
    V3_HEADER.trimEnd(),
    ev3('00 00  0.0000000', 0, 1, -0.000123456789),
    'G01' + f(20000000, '1', '8') + f(105000000, ' ', '5'),
    ev3('00 00 30.0000000', 0, 1, 0.00012345679),
    'G01' + f(20000100) + f(105000500, ' ', '3'),
    ev3('00 00 45.0000000', 5, 2),
    COMMENT,
    MOVED,
    '>'.padEnd(31) + '4  1',
    COMMENT,
    ev3('00 01  0.0000000', 0, 1),
    'G01' + f(20000200) + f(105001000),
    '',
  ].join('\n');
  const v2 = [
    V2_HEADER.trimEnd(),
    ev2(' 0  0  0.0000000', 0, 1, 'G01', -0.000123456),
    f(20000000, '1', '8') + f(105000000, ' ', '5'),
    ev2(' 0  0 30.0000000', 0, 1, 'G01', 0.000123457),
    f(20000100) + f(105000500, ' ', '3'),
    ev2(' 0  0 45.0000000', 5, 2),
    COMMENT,
    MOVED,
    ''.padEnd(28) + '4  1',
    COMMENT,
    ev2(' 0  1  0.0000000', 0, 1, 'G01'),
    f(20000200) + f(105001000),
    '',
  ].join('\n');

  for (const [name, text, clk] of [
    ['RINEX 3', v3, [-0.000123456789, 0.00012345679]],
    ['RINEX 2', v2, [-0.000123456, 0.000123457]],
  ] as const) {
    for (const crx of [false, true]) {
      it(`${name}${crx ? ' (Compact)' : ''}`, async () => {
        const t = crx ? writeCrx(text, { date: '01-Jan-24 00:00' }) : text;
        const d = await readRinexObs(new File([t], 'x.obs'));
        expect(d.epochs.map((e) => e.flag ?? 0)).toEqual([0, 0, 5, 4, 0]);
        expect(d.epochs[0]!.clockOffset).toBeCloseTo(clk[0], 15);
        expect(d.epochs[1]!.clockOffset).toBeCloseTo(clk[1], 15);
        expect(d.epochs[4]!.clockOffset).toBeUndefined();
        expect(d.epochs[2]!.time).toBe(Date.UTC(2024, 0, 1, 0, 0, 45));
        expect(d.epochs[2]!.records![1]!.startsWith('MOVED')).toBe(true);
        expect(Number.isNaN(d.epochs[3]!.time)).toBe(true); // blank epoch
        expect(d.epochs[3]!.records).toHaveLength(1);
        // LLI col 15, SSI col 16 of each field
        expect([...d.epochs[0]!.lli!.get('G01')!]).toEqual([1, 0]);
        expect([...d.epochs[0]!.ssi!.get('G01')!]).toEqual([8, 5]);
        expect([...d.epochs[1]!.ssi!.get('G01')!]).toEqual([0, 3]);
        expect(d.epochs[1]!.lli).toBeUndefined();
      });
    }
  }
});
