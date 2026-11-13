/**
 * RINEX navigation files: reader field positions (spec oracle), and
 * 2.11 ↔ 3.04 ↔ 4.02 round trips through our writers.
 */
import { describe, expect, it } from 'vitest';
import {
  parseNavFile,
  type GlonassEphemeris,
  type KeplerEphemeris,
  type NavResult,
} from '../src/rinex/nav';
import { writeRinexNav } from '../src/rinex/nav-writer';
import { writeRinexNav2 } from '../src/rinex/nav-writer-v2';
import { writeRinexNav4 } from '../src/rinex/nav-writer-v4';
import { hasFixture, readText } from './nav-sources';
import {
  expectSameEphemerides,
  expectSamePhysics,
  normaliseRecord,
  recordBlocks,
} from './nav-compare';

const HAS_V2 = hasFixture('brdc_v2.nav');
const HAS_V2G = hasFixture('brdc_v2_glo.nav');
const HAS_V3 = hasFixture('brdc_v3_igs.nav');
const HAS_V4 = hasFixture('brdc_v4_dlr.nav');
/** Fixed creation date: deterministic output. */
const DATE = { date: new Date(Date.UTC(2026, 0, 2)) };

/** Multiset equality of two lists of record texts. */
function expectSameMultiset(a: string[], b: string[]) {
  expect(b.length).toBe(a.length);
  expect([...b].sort()).toEqual([...a].sort());
}

describe('reader: blank (BNK) fields keep their slot', () => {
  it.skipIf(!HAS_V4)(
    'RINEX 4 NavIC LNAV orbit-5 "IDOT, BNK, IRN week" reads week 2399',
    () => {
      // brdc_v4_dlr.nav, > EPH I02 LNAV, BROADCAST ORBIT-5 (RINEX 4.02
      // Table A30): "-1.035400271434e-09" + 19 blanks + "2.399000000000e+03".
      // Collapsing the blank made the week 0.
      const nav = parseNavFile(readText('brdc_v4_dlr.nav'));
      const navic = nav.ephemerides.filter(
        (e) => e.system === 'I'
      ) as KeplerEphemeris[];
      expect(navic.length).toBeGreaterThan(100);
      const i02 = navic.find((e) => e.prn === 'I02')!;
      expect(i02.idot).toBe(-1.035400271434e-9);
      expect(i02.week).toBe(2399);
      // orbit-6 "URA, health, TGD, BNK": TGD stays in slot 3
      expect(i02.tgd).toBe(-1.862645149231e-9);
      for (const e of navic) expect(e.week, e.prn).toBe(2399);
    }
  );

  it('a blank mid-line field is 0 and the next field keeps its column', () => {
    const blank = ' '.repeat(19);
    const text = [
      '     3.05           N: GNSS NAV DATA    G: GPS              RINEX VERSION / TYPE',
      '                                                            END OF HEADER',
      'G05 2026 01 01 02 00 00 1.000000000000E-04 2.000000000000E-12 0.000000000000E+00',
      '     5.000000000000E+01 1.100000000000E+01 4.000000000000E-09 1.000000000000E+00',
      '     1.000000000000E-06 1.000000000000E-02 2.000000000000E-06 5.153000000000E+03',
      '     3.528000000000E+05 1.000000000000E-07 2.000000000000E+00 3.000000000000E-08',
      '     9.600000000000E-01 2.000000000000E+02 1.000000000000E+00-8.000000000000E-09',
      `     2.000000000000E-10${blank} 2.399000000000E+03`,
      `     2.000000000000E+00 0.000000000000E+00-4.000000000000E-09 5.000000000000E+01`,
      `${blank.slice(0, 4)}${blank} 4.000000000000E+00`,
    ].join('\n');
    const [g] = parseNavFile(text).ephemerides as KeplerEphemeris[];
    expect(g!.week).toBe(2399);
    expect(g!.ttm).toBeUndefined(); // blank t_tm = not known
  });
});

describe.skipIf(!HAS_V2)('RINEX 2.11 GPS → 3.04 → 2.11 (brdc_v2.nav)', () => {
  const text = HAS_V2 ? readText('brdc_v2.nav') : '';
  const v2 = HAS_V2 ? parseNavFile(text) : null!;
  const v3 = HAS_V2 ? parseNavFile(writeRinexNav(v2, DATE)) : null!;
  const back = HAS_V2 ? writeRinexNav2(v3, DATE) : '';

  it('3.04 keeps every field to the 12 printed digits of RINEX 2', () => {
    expect(v2.ephemerides.length).toBe(413);
    expectSameEphemerides(v2.ephemerides, v3.ephemerides, 1e-11);
    expectSamePhysics(v2.ephemerides, v3.ephemerides, 7);
  });

  it('writes the 413 CDDIS data records back line for line', () => {
    // Only the order differs: CDDIS sorts by epoch, we by PRN.
    expectSameMultiset(recordBlocks(text), recordBlocks(back));
  });

  it('carries ION ALPHA/BETA, DELTA-UTC and LEAP SECONDS through 3.04', () => {
    const hdr = (t: string, label: string) =>
      t.split('\n').find((l) => l.substring(60).trim() === label);
    for (const label of ['ION ALPHA', 'ION BETA', 'LEAP SECONDS'])
      expect(hdr(back, label), label).toBe(hdr(text, label));
    // DELTA-UTC: A0 0.186264514923D-08 A1 0.888178419700D-14 T 589824
    // W 2399. RINEX 3 TIME SYSTEM CORR prints A0 as D17.10 (11 digits):
    // the 12th digit of RINEX 2's D19.12 does not survive 3.04.
    expect(hdr(back, 'DELTA-UTC: A0,A1,T,W')).toBe(
      '    0.186264514920D-08 0.888178419700D-14   589824     2399 DELTA-UTC: A0,A1,T,W'
    );
    const gput = v3.header.timeSystemCorr!.find((c) => c.type === 'GPUT')!;
    expect(gput).toMatchObject({ refTime: 589824, refWeek: 2399 });
    expect(gput.a0).toBe(1.8626451492e-9);
    expect(gput.a1).toBe(8.881784197e-15);
    expect(v3.header.leapSeconds).toBe(18);
  });
});

describe.skipIf(!HAS_V2G)(
  'RINEX 2.11 GLONASS → 3.04 → 2.11 (brdc_v2_glo.nav)',
  () => {
    const text = HAS_V2G ? readText('brdc_v2_glo.nav') : '';
    const v2 = HAS_V2G ? parseNavFile(text) : null!;
    const v3text = HAS_V2G ? writeRinexNav(v2, DATE) : '';
    const v3 = HAS_V2G ? parseNavFile(v3text) : null!;
    const back = HAS_V2G ? writeRinexNav2(v3, { ...DATE, system: 'R' }) : '';

    it('3.04 keeps every field; positions and clocks agree', () => {
      expectSameEphemerides(v2.ephemerides, v3.ephemerides, 1e-11);
      expectSamePhysics(v2.ephemerides, v3.ephemerides, 11);
    });

    it('writes every CDDIS data record back line for line (−0 kept)', () => {
      expectSameMultiset(recordBlocks(text), recordBlocks(back));
    });

    it('frame time: RINEX 2 seconds of day ↔ RINEX 3 seconds of week', () => {
      // R01 2026-01-01 02:45 UTC (Thu): t_k 0.900000000000D+04 = 02:30
      // of the day (Table A11) = 4·86400 + 9000 s of the week (3.05
      // Table A10) — the reader holds the RINEX 3 meaning.
      const r01 = v2.ephemerides.find(
        (e) =>
          e.prn === 'R01' && e.tocDate.getTime() === Date.UTC(2026, 0, 1, 2, 45)
      ) as GlonassEphemeris;
      expect(r01.messageFrameTime).toBe(4 * 86400 + 9000);
      const line = v3text
        .split('\n')
        .find((l) => l.startsWith('R01 2026 01 01 02 45 00'))!;
      expect(line.substring(61, 80)).toBe(' 3.546000000000E+05');
    });

    it('CORR TO SYSTEM TIME (−τc) survives as GLUT, to D17.10', () => {
      // "  2026     1     1   -0.372529029846D-08" → GLUT a0 (= −τc,
      // RINEX 3.05 Table A5) printed with 11 digits → back in RINEX 2.
      const glut = v3.header.timeSystemCorr!.find((c) => c.type === 'GLUT')!;
      expect(glut.a0).toBe(-3.7252902985e-9);
      const hdr = (t: string) =>
        t.split('\n').find((l) => l.includes('CORR TO SYSTEM TIME'));
      expect(hdr(back)!.trimEnd()).toBe(
        '  2026     1     1   -0.372529029850D-08                    CORR TO SYSTEM TIME'
      );
      expect(hdr(text)!.substring(0, 40)).toBe(
        '  2026     1     1   -0.372529029846D-08'
      );
    });
  }
);

describe.skipIf(!HAS_V3)('RINEX 3.04 IGS merged file (brdc_v3_igs.nav)', () => {
  const text = HAS_V3 ? readText('brdc_v3_igs.nav') : '';
  const v3 = HAS_V3 ? parseNavFile(text) : null!;
  const out = HAS_V3 ? writeRinexNav(v3, DATE) : '';
  const again = HAS_V3 ? parseNavFile(out) : null!;

  it(
    'write → parse keeps every field of all 28 745 records',
    { timeout: 60000 },
    () => {
      expect(v3.ephemerides.length).toBe(28745);
      expectSameEphemerides(v3.ephemerides, again.ephemerides);
      expectSamePhysics(v3.ephemerides, again.ephemerides, 97);
    }
  );

  it('reproduces every IGS record field for field', () => {
    // Allowed layout differences (all values identical): IGS writes the
    // trailing spare fields of orbit-5/-7 sometimes as 0.0, sometimes
    // not at all; NavIC orbit-5 slot 2 as 0.0 where 3.05 Table A18 says
    // blank. normaliseRecord reads blank = 0 and drops trailing zeros.
    const norm = (t: string) =>
      recordBlocks(t).map((b) => normaliseRecord(b, 4));
    expectSameMultiset(norm(text), norm(out));
  });

  it('header: IONOSPHERIC CORR (with BDS time mark + SV), TIME SYSTEM CORR, LEAP SECONDS', () => {
    // Text identical but for the exponent letter (IGS D, we E; both
    // allowed, RINEX 3.05 §6.8).
    const hdr = (t: string, label: string) =>
      t
        .split('\n')
        .filter((l) => l.substring(60).trim() === label)
        .map((l) => l.trimEnd().replace(/D([+-])/g, 'E$1'));
    for (const label of [
      'IONOSPHERIC CORR',
      'TIME SYSTEM CORR',
      'LEAP SECONDS',
    ])
      expect(hdr(out, label), label).toEqual(hdr(text, label));
    const bds = again.header.ionoCorrectionLines!.filter(
      (l) => l.type === 'BDSA'
    );
    expect(bds[0]).toMatchObject({ timeMark: 'W', sv: 'C02' });
    expect(again.header).toMatchObject({
      leapSeconds: 18,
      leapSecondsFuture: 18,
      leapSecondsWeek: 1929,
      leapSecondsDay: 7,
    });
  });
});

describe.skipIf(!HAS_V3)('RINEX 3.04 → 4.01 → 3.04 (brdc_v3_igs.nav)', () => {
  const text = HAS_V3 ? readText('brdc_v3_igs.nav') : '';
  const v3 = HAS_V3 ? parseNavFile(text) : null!;
  const v4 = HAS_V3 ? parseNavFile(writeRinexNav4(v3, DATE)) : null!;
  const back = HAS_V3 ? parseNavFile(writeRinexNav(v4, DATE)) : null!;

  it(
    '4.01 keeps every field of every ephemeris; 3.04 again too',
    { timeout: 60000 },
    () => {
      expectSameEphemerides(v3.ephemerides, v4.ephemerides);
      expectSameEphemerides(v3.ephemerides, back.ephemerides);
      expectSamePhysics(v3.ephemerides, back.ephemerides, 101);
    }
  );

  it('IONOSPHERIC CORR lines become ION records and come back', () => {
    // Every line returns, BDS ones keyed by SV; the time mark is the
    // ION epoch's hour (A = 00h).
    expect(v4.ion!.length).toBe(
      2 + v3.header.ionoCorrectionLines!.filter((l) => l.type === 'BDSA').length
    );
    const c02 = v4.ion!.find((r) => r.sv === 'C02')!;
    expect(c02.epoch.getUTCHours()).toBe('W'.charCodeAt(0) - 65);
    const strip = (l: {
      type: string;
      values: number[];
      timeMark?: string;
      sv?: string;
    }) => ({ ...l, values: l.values.slice(0, 4) });
    const want = v3.header.ionoCorrectionLines!.map(strip);
    const got = back.header.ionoCorrectionLines!.map(strip);
    expect(got.map((l) => `${l.type}${l.sv ?? ''}`).sort()).toEqual(
      want.map((l) => `${l.type}${l.sv ?? ''}`).sort()
    );
    for (const l of want) {
      const g = got.find((x) => x.type === l.type && x.sv === l.sv)!;
      expect(g.timeMark).toBe(l.timeMark);
      // GAL has a 4th (disturbance-flag) slot in RINEX 4: 0 here
      expect(g.values.slice(0, l.values.length)).toEqual(l.values);
    }
  });

  it('TIME SYSTEM CORR lines become STO records and come back', () => {
    // What RINEX 3 lacks is invented as documented: t_tm = t_ref,
    // A2 = 0; GLUT (no reference time) is dated by the first ephemeris.
    expect(v4.sto!.map((r) => r.type)).toEqual(
      v3.header.timeSystemCorr!.map((c) => c.type)
    );
    const gput = v4.sto!.find((r) => r.type === 'GPUT')!;
    expect(gput.epoch.toISOString()).toBe('2026-01-03T19:50:24.000Z'); // W2399 + 589824 s
    expect(gput).toMatchObject({
      system: 'G',
      message: 'LNAV',
      ttm: 589824,
      a2: 0,
    });
    const bdut = v4.sto!.find((r) => r.type === 'BDUT')!;
    // BDT week 1043 starts Sun 2025-12-28; + 345185 s = Wed 23:53:05 BDT
    expect(bdut.epoch.toISOString()).toBe('2025-12-31T23:53:05.000Z');
    expect(back.header.timeSystemCorr).toEqual(v3.header.timeSystemCorr);
  });
});

describe.skipIf(!HAS_V4)('RINEX 4.02 DLR merged file (brdc_v4_dlr.nav)', () => {
  const v4 = HAS_V4 ? parseNavFile(readText('brdc_v4_dlr.nav')) : null!;
  const again = HAS_V4 ? parseNavFile(writeRinexNav4(v4, DATE)) : null!;
  const v3 = HAS_V4
    ? parseNavFile(writeRinexNav(v4, { ...DATE, version: '3.05' }))
    : null!;
  /** RINEX 3.05 GLONASS orbit-4 (Table A10): not in 3.04. */
  const GLO_STATUS = ['statusFlags', 'l1l2GroupDelay', 'urai', 'healthFlags'];

  it('reads every STO, EOP and ION record', () => {
    // grep '^> STO' / '^> EOP' / '^> ION' brdc_v4_dlr.nav | wc -l
    expect(v4.sto!.length).toBe(151);
    expect(v4.eop!.length).toBe(29);
    expect(v4.ion!.length).toBe(131);
  });

  it('4.01 rewrite: STO, EOP and ION records identical', () => {
    expect(again.sto).toEqual(v4.sto);
    expect(again.eop).toEqual(v4.eop);
    expect(again.ion).toEqual(v4.ion);
    expectSameEphemerides(v4.ephemerides, again.ephemerides);
  }, 60000);

  it(
    '→ 3.05: classic ephemerides equal (3.04: but GLONASS status)',
    { timeout: 60000 },
    () => {
      expectSameEphemerides(v4.ephemerides, v3.ephemerides);
      const v304 = parseNavFile(writeRinexNav(v4, DATE));
      expectSameEphemerides(
        v4.ephemerides,
        v304.ephemerides,
        1e-12,
        GLO_STATUS
      );
      expect(
        (v304.ephemerides.find((e) => e.system === 'R') as GlonassEphemeris)
          .statusFlags
      ).toBeUndefined();
    }
  );

  it('→ 3.05: iono + time offsets move to the header; CNAV/EOP are dropped', () => {
    expectSamePhysics(v4.ephemerides, v3.ephemerides, 89);
    // What 3.04 cannot express is gone (module header of nav-writer.ts).
    expect(v3.cnav).toBeUndefined();
    expect(v3.bdsCnav).toBeUndefined();
    expect(v3.eop).toBeUndefined();
    // ION G24 LNAV 2026-01-01 00:11:24, first GPS Klobuchar record
    const gpsa = v3.header.ionoCorrections['GPSA']!;
    expect(gpsa[0]).toBeCloseTo(2.4214e-8, 12);
    expect(v3.header.ionoCorrections['GAL']![0]).toBeCloseTo(154.5, 3);
    const bdga = v3.header.timeSystemCorr!.find((c) => c.type === 'BDGA')!;
    // > STO C37 CNVX 2025 12 31 23 20 00 BDGA, A0 −3.899913281202e-09
    // (D17.10: 11 digits printed)
    expect(bdga.a0).toBeCloseTo(-3.899913281202e-9, 18);
    expect(bdga.refWeek).toBe(1043); // BDT week of 2025-12-31
  });
});

/* ------------------------------------------------------------------ */
/*  Spec slot tables: writer columns and reader fields                 */
/* ------------------------------------------------------------------ */

/**
 * Field in each 19-char slot of a record, per system: row 0 the three
 * epoch-line values, rows 1-7 BROADCAST ORBIT-1…7. RINEX 3.05 Tables
 * A6 (GPS), A8 (Galileo), A10 (GLONASS), A12 (QZSS), A14 (BDS), A16
 * (SBAS), A18 (NavIC); RINEX 2.11 Tables A4, A11, A16 are the same
 * slots; RINEX 4.02 Tables A9-A15, A19, A30 too. '' = spare / blank.
 */
const SLOTS: Record<string, string[][]> = {
  G: [
    ['af0', 'af1', 'af2'],
    ['iode', 'crs', 'deltaN', 'm0'],
    ['cuc', 'e', 'cus', 'sqrtA'],
    ['toe', 'cic', 'omega0', 'cis'],
    ['i0', 'crc', 'omega', 'omegaDot'],
    ['idot', 'l2Codes', 'week', 'l2pFlag'],
    ['svAccuracy', 'svHealth', 'tgd', 'iodc'],
    ['ttm', 'fitInterval'],
  ],
  E: [
    ['af0', 'af1', 'af2'],
    ['iode', 'crs', 'deltaN', 'm0'],
    ['cuc', 'e', 'cus', 'sqrtA'],
    ['toe', 'cic', 'omega0', 'cis'],
    ['i0', 'crc', 'omega', 'omegaDot'],
    ['idot', 'dataSources', 'week', ''],
    ['svAccuracy', 'svHealth', 'tgd', 'tgd2'], // BGD E5a/E1, BGD E5b/E1
    ['ttm'],
  ],
  C: [
    ['af0', 'af1', 'af2'],
    ['iode', 'crs', 'deltaN', 'm0'], // AODE
    ['cuc', 'e', 'cus', 'sqrtA'],
    ['toe', 'cic', 'omega0', 'cis'],
    ['i0', 'crc', 'omega', 'omegaDot'],
    ['idot', '', 'week', ''],
    ['svAccuracy', 'svHealth', 'tgd', 'tgd2'], // SatH1, TGD1 B1/B3, TGD2 B2/B3
    ['ttm', 'aodc'],
  ],
  I: [
    ['af0', 'af1', 'af2'],
    ['iode', 'crs', 'deltaN', 'm0'], // IODEC
    ['cuc', 'e', 'cus', 'sqrtA'],
    ['toe', 'cic', 'omega0', 'cis'],
    ['i0', 'crc', 'omega', 'omegaDot'],
    ['idot', '', 'week', ''],
    ['svAccuracy', 'svHealth', 'tgd', ''],
    ['ttm'],
  ],
  R: [
    ['tauN', 'gammaN', 'messageFrameTime'], // −τn, +γn, tk+nd·86400
    ['x', 'xDot', 'xAcc', 'health'], // km, km/s, km/s²
    ['y', 'yDot', 'yAcc', 'freqNum'],
    ['z', 'zDot', 'zAcc', 'ageOfOperation'],
    ['statusFlags', 'l1l2GroupDelay', 'urai', 'healthFlags'], // 3.05 / 4
  ],
  S: [
    ['tauN', 'gammaN', 'messageFrameTime'], // aGf0, aGf1, t_tm
    ['x', 'xDot', 'xAcc', 'health'],
    ['y', 'yDot', 'yAcc', 'freqNum'], // URA
    ['z', 'zDot', 'zAcc', 'iodn'],
  ],
};
SLOTS['J'] = SLOTS['G']!;

/** Read the values of a record's text by slot: [row][slot]. */
function slotsOf(lines: string[], epochCol: number, indent: number) {
  return lines.map((l, r) => {
    const from = r === 0 ? epochCol : indent;
    const out: (number | null)[] = [];
    for (let c = from; c < from + 4 * 19; c += 19) {
      const f = l.substring(c, c + 19).trim();
      out.push(f ? Number(f.replace(/[dD]/, 'E')) : null);
    }
    return out;
  });
}

/** Every named slot of `text` holds `eph[field]` (exact: binary-exact values). */
function expectSlots(
  eph: Record<string, unknown>,
  lines: string[],
  epochCol: number,
  indent: number
) {
  const table = SLOTS[eph.system as string]!;
  const got = slotsOf(lines, epochCol, indent);
  table.forEach((row, r) =>
    row.forEach((field, k) => {
      if (!field || r >= got.length || eph[field] === undefined) return;
      expect(got[r]![k], `${eph.prn} row ${r} slot ${k} = ${field}`).toBe(
        eph[field]
      );
    })
  );
}

/** Asymmetric test values: every field different, signs mixed, no ±1/0. */
const KEPLER = {
  prn: 'G05',
  tocDate: new Date(Date.UTC(2026, 0, 1, 2)),
  toc: 352800,
  af0: 3.25e-4,
  af1: -5.5e-12,
  af2: 1.25e-18,
  iode: 77,
  crs: -12.5,
  deltaN: 4.5e-9,
  m0: 1.25,
  cuc: -1.125e-6,
  e: 0.0123,
  cus: 2.25e-6,
  sqrtA: 5153.75,
  toe: 352800,
  cic: -3.5e-8,
  omega0: 2.125,
  cis: 4.75e-8,
  i0: 0.9625,
  crc: 210.5,
  omega: -1.75,
  omegaDot: -8.125e-9,
  idot: 3.375e-10,
  week: 2399,
  svHealth: 39,
  tgd: -9.25e-9,
  svAccuracy: 2.8,
  ttm: 345678,
};
const VARIANTS: Record<string, Record<string, unknown>> = {
  G: {
    ...KEPLER,
    system: 'G',
    l2Codes: 2,
    l2pFlag: 3,
    iodc: 333,
    fitInterval: 4,
  },
  J: {
    ...KEPLER,
    system: 'J',
    prn: 'J03',
    l2Codes: 2,
    l2pFlag: 3,
    iodc: 333,
    fitInterval: 6,
  },
  E: { ...KEPLER, system: 'E', prn: 'E11', dataSources: 513, tgd2: -5.5e-9 },
  C: { ...KEPLER, system: 'C', prn: 'C23', tgd2: 7.5e-9, aodc: 9 },
  I: { ...KEPLER, system: 'I', prn: 'I05' },
  R: {
    system: 'R',
    prn: 'R07',
    tocDate: new Date(Date.UTC(2026, 0, 1, 2, 15)),
    tauN: -1.5e-5,
    gammaN: 2.75e-12,
    messageFrameTime: 4 * 86400 + 7200 + 1530,
    x: -12345.625,
    xDot: 1.5,
    xAcc: -2.5e-9,
    health: 3,
    y: 23456.375,
    yDot: -2.25,
    yAcc: 3.75e-9,
    freqNum: -6,
    z: -4567.125,
    zDot: 0.875,
    zAcc: -1.25e-9,
    ageOfOperation: 5,
    statusFlags: 181,
    l1l2GroupDelay: -2.5e-9,
    urai: 4,
    healthFlags: 6,
  },
  S: {
    system: 'S',
    prn: 'S27',
    tocDate: new Date(Date.UTC(2026, 0, 1, 2, 0, 32)),
    tauN: 2.5e-8,
    gammaN: -4.5e-12,
    messageFrameTime: 352832,
    x: 40123.5,
    xDot: -0.00125,
    xAcc: 3.5e-8,
    health: 9,
    y: -12345.25,
    yDot: 0.0025,
    yAcc: -1.5e-8,
    freqNum: 4,
    z: 123.75,
    zDot: -0.0375,
    zAcc: 6.25e-8,
    iodn: 133,
  },
};

describe('writer slot locks (spec tables, asymmetric values)', () => {
  const header = {
    version: 3.05,
    type: 'N',
    leapSeconds: 18,
    ionoCorrections: {},
  };
  const nav: NavResult = {
    header,
    ephemerides: Object.values(VARIANTS) as never,
  };
  const recordLines = (text: string, start: string, n: number) => {
    const lines = text.split('\n');
    const i = lines.findIndex((l) => l.startsWith(start));
    expect(i, start).toBeGreaterThan(0);
    return lines.slice(i, i + n);
  };

  it.each(Object.keys(VARIANTS))('RINEX 3.05 %s record', (sys) => {
    const e = VARIANTS[sys]!;
    const text = writeRinexNav(nav, { version: '3.05' });
    expectSlots(
      e,
      recordLines(text, e.prn as string, SLOTS[sys]!.length),
      23,
      4
    );
    // and the reader puts every slot back in its field
    const back = parseNavFile(text).ephemerides.find((x) => x.prn === e.prn)!;
    expect(back).toMatchObject(e);
  });

  it.each(Object.keys(VARIANTS))('RINEX 4.01 %s record', (sys) => {
    const e = VARIANTS[sys]!;
    const text = writeRinexNav4(nav);
    expectSlots(
      e,
      recordLines(text, e.prn as string, SLOTS[sys]!.length),
      23,
      4
    );
    const back = parseNavFile(text).ephemerides.find((x) => x.prn === e.prn)!;
    expect(back).toMatchObject(e);
  });

  it.each(['G', 'R', 'S'] as const)('RINEX 2.11 %s record', (sys) => {
    const e = VARIANTS[sys]!;
    const text = writeRinexNav2(nav, { system: sys });
    const prn2 = String(Number((e.prn as string).slice(1))).padStart(2);
    // RINEX 2.11: I2 PRN + 20-char epoch → values from column 22; 3X indent.
    // GLONASS t_k is seconds of the UTC day there (Table A11).
    const want = sys === 'R' ? { ...e, messageFrameTime: 7200 + 1530 } : e;
    const n = sys === 'G' ? 8 : 4;
    const lines = recordLines(text, prn2 + ' 26', n).slice(
      0,
      sys === 'R' ? 4 : n
    );
    expectSlots(want, lines, 22, 3);
    // RINEX 2 has no GLONASS orbit-4: the 3.05 status fields drop out.
    const dropped = ['statusFlags', 'l1l2GroupDelay', 'urai', 'healthFlags'];
    const back = parseNavFile(text).ephemerides[0]!;
    expect(back).toMatchObject(
      Object.fromEntries(
        Object.entries(e).filter(([k]) => !dropped.includes(k))
      )
    );
  });
});

describe('writeRinexNav header', () => {
  it('IONOSPHERIC CORR is A4,1X,4D12.4 and reads back', () => {
    // RINEX 3.04 Table A5. The D19.12 fields used before ran past
    // column 60 and were cut: GPSA read back as [2.5146, 0, 6e8, 9].
    const iono = {
      GPSA: [2.5146e-8, 7.4506e-9, -1.1921e-7, 5.9605e-8],
      GPSB: [149500, -212990, 0, 327680],
      GAL: [155, -0.70703, 0.002655],
    };
    const out = writeRinexNav({
      header: {
        version: 3.04,
        type: 'N',
        leapSeconds: 18,
        ionoCorrections: iono,
      },
      ephemerides: [],
    });
    const line = out.split('\n').find((l) => l.startsWith('GPSA'))!;
    // IGS brdc_v3_igs.nav prints the same line with D exponents
    expect(line).toBe(
      'GPSA   2.5146E-08  7.4506E-09 -1.1921E-07  5.9605E-08       IONOSPHERIC CORR    '
    );
    expect(parseNavFile(out).header.ionoCorrections).toEqual(iono);
  });
});
