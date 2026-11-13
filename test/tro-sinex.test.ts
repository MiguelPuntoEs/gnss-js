import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseTroSinex,
  troSeries,
  writeTroSinex,
  type TroEstimate,
} from '../src/rinex/tro-sinex';

// Excerpts of EUREF products for 2024-01-14 (GPS week 2297), BKG mirror
// igs.bkg.bund.de/root_ftp/EUREF/products/2297/: CODE's daily
// troposphere (COD0EPNFIN_20240140000_01D_01H_TRO.TRO, 3 stations) and the
// EUREF weekly combination (EUR0OPSFIN_20240140000_07D_01H_TRO.TRO, 2
// stations, first 48 hours).
const read = (f: string) =>
  readFileSync(join(__dirname, '../test-fixtures', f), 'latin1');
const COD = read('cod0epnfin_2024014_tro_slice.tro');
const EUR = read('eur0opsfin_2024014_07d_tro_slice.tro');

describe('parseTroSinex', () => {
  it('reads a CODE SINEX_TRO 2.00 file', () => {
    const t = parseTroSinex(COD);
    expect(t.version).toBe('2.00');
    expect(t.agency).toBe('COE');
    expect(t.startMs).toBe(Date.UTC(2024, 0, 14));
    expect(t.fields).toEqual([
      'TROTOT',
      'TROTOT_STDDEV',
      'TGNTOT',
      'TGNTOT_STDDEV',
      'TGETOT',
      'TGETOT_STDDEV',
    ]);
    expect(t.units).toEqual([1000, 1000, 1000, 1000, 1000, 1000]);
    expect(t.description['TROPO MAPPING FUNCTION']).toBe('WET_VMF3');
    expect(t.description['ELEVATION CUTOFF ANGLE']).toBe('3');
    const z = t.sites.get('ZIMM00CHE')!;
    expect(z.domes).toBe('14001M004');
    expect(z.xyz).toEqual([4331296.802, 567556.222, 4633134.155]);
    expect(z.system).toBe('IGS20');
    expect(z.antenna).toBe('TRM29659.00     NONE');
    expect(z.pcvModel).toBe('IGS20_2290');
    expect(z.receiver).toBe('TRIMBLE NETR9');
    expect(z.eccUne).toEqual([0, 0, 0]);
    expect(z.latDeg).toBeCloseTo(46.8771, 4);
    const ztd = troSeries(t, 'ZIMM', 'TROTOT');
    expect(ztd).toHaveLength(24);
    expect(ztd[0]).toEqual({
      tMs: Date.UTC(2024, 0, 14, 0, 30),
      value: 2.0905,
    });
    expect(troSeries(t, 'ZIMM00CHE', 'TGNTOT')[0]!.value).toBeCloseTo(
      -0.000529,
      9
    );
  });

  it('reads the EUREF combined weekly product (TROPO PARAMETERS NAMES)', () => {
    const t = parseTroSinex(EUR);
    expect(t.fields.slice(0, 3)).toEqual(['TROTOT', 'TROTOT_STDDEV', 'IWV']);
    const w = troSeries(t, 'WTZR', 'TROTOT');
    expect(w).toHaveLength(48);
    expect(w[0]!.tMs).toBe(Date.UTC(2024, 0, 14, 0, 30));
    expect(w[0]!.value).toBeGreaterThan(2.0);
    expect(w[0]!.value).toBeLessThan(2.5);
    expect(t.sites.get('WTZR00DEU')!.xyz![0]).toBeCloseTo(4075580, -1);
  });

  it('reads the 0.01 format the old IGS product (and gnsscalc) wrote', () => {
    const old = [
      '%=TRO 0.01 GCC 24:020:00000 GCC 24:014:00000 24:014:00600 P  MIX',
      '+TROP/DESCRIPTION',
      ' SAMPLING TROP                                    300',
      ' SOLUTION_FIELDS_1             TROTOT',
      '-TROP/DESCRIPTION',
      '+TROP/STA_COORDINATES',
      '*SITE PT SOLN T __STA_X_____ __STA_Y_____ __STA_Z_____ SYSTEM REMRK',
      ' WTZR  A    1 P  4075580.300   931853.900  4801568.200 IGS20  GCC',
      '-TROP/STA_COORDINATES',
      '+TROP/SOLUTION',
      '*SITE ____EPOCH___ TROTOT',
      ' WTZR 24:014:00000 2345.6',
      ' WTZR 24:014:00300 2346.1',
      '-TROP/SOLUTION',
      '%=ENDTRO',
    ].join('\n');
    const t = parseTroSinex(old);
    expect(t.fields).toEqual(['TROTOT']);
    expect(t.sites.get('WTZR')!.xyz![2]).toBeCloseTo(4801568.2, 3);
    expect(troSeries(t, 'WTZR', 'TROTOT')).toEqual([
      { tMs: Date.UTC(2024, 0, 14), value: 2.3456 },
      { tMs: Date.UTC(2024, 0, 14, 0, 5), value: 2.3461 },
    ]);
  });
});

describe('writeTroSinex', () => {
  const t = parseTroSinex(COD);
  const est: TroEstimate[] = t.records.map((r) => ({
    site: r.site,
    epochMs: r.epochMs,
    ztd: r.values[0]! / 1000,
    ztdSigma: r.values[1]! / 1000,
    gradN: r.values[2]! / 1000,
    gradNSigma: r.values[3]! / 1000,
    gradE: r.values[4]! / 1000,
    gradESigma: r.values[5]! / 1000,
  }));
  const text = writeTroSinex({
    agency: 'GCC',
    createdMs: Date.UTC(2024, 1, 1),
    reference: { DESCRIPTION: 'round trip', SOFTWARE: 'gnss-js' },
    description: {
      'TROPO SAMPLING INTERVAL': '3600',
      'TROPO MAPPING FUNCTION': 'WET_VMF3',
    },
    sites: [...t.sites.values()].map((s) => ({
      id: s.id,
      domes: s.domes,
      xyz: s.xyz!,
      receiver: s.receiver,
      antenna: s.antenna,
      pcvModel: s.pcvModel,
      eccUne: s.eccUne,
    })),
    estimates: est,
  });

  it('round-trips CODE values exactly', () => {
    const back = parseTroSinex(text);
    expect(back.version).toBe('2.00');
    expect(back.fields).toEqual(t.fields);
    expect(back.records).toEqual(t.records);
    for (const [id, s] of t.sites) {
      const b = back.sites.get(id)!;
      expect(b.xyz).toEqual(s.xyz);
      expect(b.domes).toBe(s.domes);
      expect(b.antenna).toBe(s.antenna);
      expect(b.receiver).toBe(s.receiver);
      expect(b.eccUne).toEqual(s.eccUne);
    }
    expect(back.description['TROPO MAPPING FUNCTION']).toBe('WET_VMF3');
  });

  it('writes solution rows byte-identical to the CODE file', () => {
    const rows = (s: string) =>
      s
        .split('\n')
        .filter((l) => /^ \w{9} \d{4}:\d{3}:\d{5} /.test(l))
        .map((l) => l.trimEnd());
    expect(rows(text)).toEqual(rows(COD));
    expect(text.split('\n')[0]).toBe(
      '%=TRO 2.00 GCC 2024:032:00000 GCC 2024:014:01800 2024:014:84600 P  MIX'
    );
  });

  it('writes TROTOT + STDDEV only without gradients', () => {
    const s = writeTroSinex({
      agency: 'GCC',
      createdMs: 0,
      sites: [{ id: 'WTZR', xyz: [4075580.3, 931853.9, 4801568.2] }],
      estimates: [
        { site: 'WTZR', epochMs: Date.UTC(2024, 0, 14), ztd: 2.34567 },
      ],
    });
    const back = parseTroSinex(s);
    expect(back.fields).toEqual(['TROTOT', 'TROTOT_STDDEV']);
    expect(troSeries(back, 'WTZR', 'TROTOT')[0]!.value).toBeCloseTo(2.3457, 6);
    expect(back.sites.get('WTZR00XXX')!.latDeg).toBeCloseTo(49.144, 2);
  });
});
