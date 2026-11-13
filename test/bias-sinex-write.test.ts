import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { gunzipSync } from 'zlib';
import { join } from 'path';
import {
  parseBiasSinex,
  findSatBias,
  biasMetres,
  SatOsbTable,
  type BiasSinex,
} from '../src/rinex/bias-sinex';
import {
  writeBiasSinex,
  biasSolutionLine,
} from '../src/rinex/bias-sinex-writer';

// Slices of two real products (provenance in .gitignore):
// ESA0OPSFIN_DCB.BIA (relative DSBs, Fortran E21.15 layout, every Galileo
// C1C–C5Q record + 4 of each other group) and the CNES PPP-Wizard
// post-processed ABS file for 2024/001 (absolute code + phase OSBs, every
// record of the first 30 s interval).
const FIX = join(__dirname, '..', 'test-fixtures');
const fx = (f: string) => readFileSync(join(FIX, f), 'utf8');
const esaText = fx('esa_dcb_slice.bia');
const cnesText = fx('cnes_osb_slice.bia');

const lines = (t: string) =>
  t
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l !== '');

/** Everything a writer must carry, bySat (derived) left out. */
const content = (b: BiasSinex) => {
  const { bySat: _bySat, header, ...rest } = b;
  return { ...rest, header: header && { ...header, count: 0 } };
};

const T0 = Date.UTC(2024, 0, 1, 0, 0, 10);

describe('writeBiasSinex — round trip', () => {
  it('writes the ESA (Fortran) file back line for line', () => {
    // Only trailing blanks differ (ESA pads the reference block to 80).
    expect(lines(writeBiasSinex(parseBiasSinex(esaText)))).toEqual(
      lines(esaText)
    );
  });

  it.skipIf(!existsSync(join(FIX, 'ESA0OPSFIN_DCB.BIA')))(
    'writes the full ESA rolling file back line for line',
    () => {
      const t = fx('ESA0OPSFIN_DCB.BIA');
      expect(lines(writeBiasSinex(parseBiasSinex(t)))).toEqual(lines(t));
    }
  );

  it('keeps every CNES record and block through write → parse', () => {
    const a = parseBiasSinex(cnesText);
    expect(a.records.length).toBe(261);
    const out = writeBiasSinex(a);
    expect(content(parseBiasSinex(out))).toEqual(content(a));
    // Documented differences from the CNES original (none is data):
    //  - solution values: CNES prints free F (`10.1737`, no STD) where
    //    §4.8 asks E21.15 → `0.101737000000000E+02` (same number);
    //  - header: CNES writes the count as `00000 0` and mode `P`; the
    //    writer recounts (I8.8) and keeps the mode;
    //  - DESCRIPTION: CNES pads with a TAB and puts PARAMETER_SPACING one
    //    column left of 1X,I12; the trailer it lacks (-BIAS/SOLUTION
    //    separator + %=ENDBIA, file trimmed by fetch-test-data.sh) is added.
    const w = lines(out);
    expect(w[0]).toBe(
      '%=BIA 1.00 CNT 2024:012:20587 CNT 2024:001:00000 2024:002:00000 P 00000261'
    );
    expect(w).toContain(
      ' OSB       G01           C1C       2024:001:00000 2024:001:00030 ns   0.101737000000000E+02'
    );
    expect(w).toContain(' PARAMETER_SPACING' + ' '.repeat(33) + '30'); // I12 ends col 53
    expect(w.at(-1)).toBe('%=ENDBIA');
  });

  it.skipIf(!existsSync(join(FIX, 'CNES_ABS_ge.bia.gz')))(
    'round-trips all 743 244 CNES records',
    () => {
      const a = parseBiasSinex(
        gunzipSync(readFileSync(join(FIX, 'CNES_ABS_ge.bia.gz'))).toString()
      );
      const b = parseBiasSinex(writeBiasSinex(a));
      expect(b.records.length).toBe(a.records.length);
      expect(b.records).toEqual(a.records);
    },
    120_000
  );

  it('writes slope, station, receiver-information and open epochs', () => {
    // A built (not parsed) product exercising the optional §4.7/§4.8 parts.
    const src =
      parseBiasSinex(`%=BIA 1.00 TST 2024:010:00000 TST 2024:001:00000 2024:002:00000 A 00000003
+BIAS/RECEIVER_INFORMATION
*STATION__ C GROUP____ DATA_START____ DATA_END______ RECEIVER_TYPE_______ RECEIVER_FIRMWARE___
 WTZR00DEU G @MP1TRI   2024:001:00000 2024:001:86399 TRIMBLE NETR9        5.10
*LEGEND:   G @MP1TRI   TRIMBLE        receivers with Everest MP mitigation enabled.
-BIAS/RECEIVER_INFORMATION
+BIAS/DESCRIPTION
 PARAMETER_SPACING                                 300
 BIAS_MODE                               ABSOLUTE
-BIAS/DESCRIPTION
+BIAS/SOLUTION
*BIAS SVN_ PRN STATION__ OBS1 OBS2 BIAS_START____ BIAS_END______ UNIT __ESTIMATED_VALUE____ _STD_DEV___ __ESTIMATED_SLOPE____ _STD_DEV___
 OSB  G063 G01           L1C       2024:001:00000 2024:001:86400 cyc  -.125000000000000E+00 .100000E-02 0.250000000000000E-05 .300000E-06
 OSB  G    G   WTZR00DEU C1C       2024:001:00000 0000:000:00000 ns   0.731000000000000E+01 .210000E-01
 ISB  C    C   ABMF      C1I  C7I  2024:001:00000 2024:002:00000 ns   0.240909461328850E+02 .835246E+00
-BIAS/SOLUTION
%=ENDBIA
`);
    const out = writeBiasSinex(src);
    const back = parseBiasSinex(out);
    expect(content(back)).toEqual(content(src));
    const [l1, sta] = back.records;
    expect(l1).toMatchObject({ unit: 'cyc', value: -0.125, std: 0.001 });
    expect(l1!.slope).toBe(2.5e-6);
    expect(l1!.slopeStd).toBe(3e-7);
    expect(sta).toMatchObject({ prn: 'G', station: 'WTZR00DEU' });
    expect(sta!.endMs).toBe(Infinity);
    expect(back.receivers![1]).toMatchObject({
      station: 'WTZR00DEU',
      system: 'G',
      group: '@MP1TRI',
      receiverType: 'TRIMBLE NETR9',
      firmware: '5.10',
    });
    // 2024:001:86400 is 2024:002:00000 — same instant, canonical form.
    expect(out).toContain(
      ' OSB  G063 G01           L1C       2024:001:00000 2024:002:00000 cyc  -.125000000000000E+00 .100000E-02 0.250000000000000E-05 .300000E-06'
    );
    expect(out).toContain('2024:001:00000 0000:000:00000 ns   0.731');
  });

  it('writes a minimal file from bare records', () => {
    const recs = parseBiasSinex(cnesText).records.slice(0, 5);
    const out = writeBiasSinex(
      { records: recs, bySat: new Map() },
      { fileAgency: 'GJS', dataAgency: 'CNT', createdMs: Date.UTC(2024, 0, 2) }
    );
    const w = lines(out);
    // Header: all-OSB → absolute mode 'A'; span from the records.
    expect(w[0]).toBe(
      '%=BIA 1.00 GJS 2024:002:00000 CNT 2024:001:00000 2024:001:00030 A 00000005'
    );
    expect(w).toContain(' BIAS_MODE                               ABSOLUTE');
    expect(parseBiasSinex(out).records).toEqual(recs);
  });
});

describe('Bias-SINEX — spec oracle (Bias-SINEX 1.00 §4.1, §4.8)', () => {
  it('reads header and solution fields at their specified columns', () => {
    const b = parseBiasSinex(esaText);
    // §4.1: %=BIA 1.00 ESA <created> IGS <start> <end> R <count I8.8>
    expect(b.header).toEqual({
      version: '1.00',
      fileAgency: 'ESA',
      createdMs: Date.UTC(2026, 0, 1) + 151 * 86400e3 + 40369e3,
      dataAgency: 'IGS',
      startMs: Date.UTC(2017, 0, 1),
      endMs: Date.UTC(2026, 0, 1) + 151 * 86400e3,
      mode: 'R',
      count: 93, // the slice's count (the full file says 684)
    });
    // §4.8 line " DSB  E210 E01           C1C  C5Q  2017:001:00000
    // 2023:120:00000 ns   -.358699447332617E+00 .123477E-01":
    // BIAS cols 2-5, SVN 7-10, PRN 12-14, OBS1 26-29, OBS2 31-34, times
    // 36-49/51-64 (YYYY:DDD:SSSSS), UNIT 66-69, VALUE E21.15 71-91, STD
    // E11.6 93-103.
    expect(b.records[0]).toEqual({
      type: 'DSB',
      svn: 'E210',
      prn: 'E01',
      station: '',
      obs1: 'C1C',
      obs2: 'C5Q',
      startMs: Date.UTC(2017, 0, 1),
      endMs: Date.UTC(2023, 0, 1) + 119 * 86400e3,
      unit: 'ns',
      value: -0.358699447332617,
      std: 0.0123477,
    });
    expect(b.description).toContainEqual({
      key: 'OBSERVATION_SAMPLING',
      value: '300',
    });
    expect(b.description).toContainEqual({ key: 'TIME_SYSTEM', value: 'G' });
    expect(b.acknowledgments).toContainEqual({
      agency: 'ESOC',
      description: 'European Space Operations Centre',
    });
    // Odd seconds-of-day survive (GPS-scale ms, no leap-second meddling).
    const e14 = b.records.find((r) => r.endMs % 1000 === 0 && r.prn === 'E14')!;
    expect(e14.endMs).toBe(Date.UTC(2019, 0, 1) + 76 * 86400e3 + 18e3);
  });

  it('formats numbers as Fortran E21.15 / E11.6', () => {
    const r = {
      type: 'OSB',
      svn: 'G063',
      prn: 'G01',
      station: '',
      obs1: 'C1W',
      obs2: '',
      startMs: Date.UTC(2024, 0, 1),
      endMs: Date.UTC(2024, 0, 2),
      unit: 'ns',
      value: 0,
      std: 0,
    };
    expect(biasSolutionLine(r)).toBe(
      ' OSB  G063 G01           C1W       2024:001:00000 2024:002:00000 ns   0.000000000000000E+00 .000000E+00'
    );
    expect(biasSolutionLine({ ...r, value: -1234.5, std: 9.99999949 })).toMatch(
      / -\.123450000000000E\+04 \.100000E\+02$/
    );
    expect(biasSolutionLine({ ...r, value: 1e-12 })).toContain(
      ' 0.100000000000000E-11 '
    );
  });
});

describe('Bias-SINEX — convention locks', () => {
  it('DSB = OBS1 − OBS2 (§6.3.1 eq. 7): ESA DSBs match CNES OSB differences', () => {
    // Independent products (ESA DSB 2017–2026 vs CNES OSB of 2024/001):
    // per satellite, DSB(C1C,C5Q) = OSB(C1) − OSB(C5) within the products'
    // ≈0.3 ns disagreement. A swapped OBS order or flipped sign would give
    // DSB ≈ −(OSB1 − OSB2): residuals of 2×|DSB| (up to 20 ns).
    const esa = parseBiasSinex(esaText);
    const cnes = parseBiasSinex(cnesText);
    const res: number[] = [];
    for (const prn of esa.bySat.keys()) {
      const d = findSatBias(esa, prn, 'C1C', 'C5Q', T0);
      const a = findSatBias(cnes, prn, 'C1X', undefined, T0);
      const c = findSatBias(cnes, prn, 'C5X', undefined, T0);
      if (d && a && c) res.push(d.value - (a.value - c.value));
    }
    expect(res.length).toBeGreaterThanOrEqual(25);
    const rms = Math.sqrt(res.reduce((s, r) => s + r * r, 0) / res.length);
    expect(rms).toBeLessThan(0.35);
    // E11 values are large and asymmetric: 10.469 ns vs 10.322 ns.
    expect(findSatBias(esa, 'E11', 'C1C', 'C5Q', T0)!.value).toBeCloseTo(
      10.469,
      3
    );
  });

  it('OSB sign: observed = true + bias, corrected = observed − OSB (§6.1)', () => {
    // §6.1 example: truth 11, observed 7 → bias −4. SatOsbTable hands PPP
    // the OSB in metres to subtract (ppp.ts applySatBiases: c1 − b1).
    const b = parseBiasSinex(cnesText);
    const t = new SatOsbTable(b);
    const g01 = findSatBias(b, 'G01', 'C1C', undefined, T0)!;
    expect(g01.value).toBe(10.1737); // ns, as published
    const m = t.get('G01', 'C1C', T0)!;
    expect(m).toBeCloseTo(10.1737e-9 * 299792458, 9); // +3.0500 m, not −
    const observed = 22_000_000 + m;
    expect(observed - m).toBe(22_000_000);
  });

  it('units: ns → metres via c; cycles are left in cycles', () => {
    const b = parseBiasSinex(cnesText);
    const l1 = findSatBias(b, 'G01', 'L1C', undefined, T0)!;
    expect(l1.unit).toBe('ns');
    expect(l1.value).toBe(-0.6104);
    expect(biasMetres(l1)).toBeCloseTo(-0.6104 * 0.299792458, 12);
    const cyc = { ...l1, unit: 'cyc', value: -0.125 };
    expect(biasMetres(cyc)).toBe(-0.125);
    // The table never mixes cycle-unit OSBs into its metre values.
    expect(new SatOsbTable([cyc]).get('G01', 'L1C', T0)).toBeNull();
  });

  it('epochs are YYYY:DDD:SSSSS, day-of-year 1-based, 0000:000:00000 open', () => {
    const b = parseBiasSinex(cnesText);
    const r = b.records[0]!;
    expect(r.startMs).toBe(Date.UTC(2024, 0, 1));
    expect(r.endMs).toBe(Date.UTC(2024, 0, 1, 0, 0, 30));
    const late = b.records.at(-1)!;
    // 2024:001:06720 = 01:52:00.
    expect(late.endMs).toBe(Date.UTC(2024, 0, 1, 1, 52));
  });
});
