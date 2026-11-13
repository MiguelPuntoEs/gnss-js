import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseRinexMet, writeRinexMet, type RinexMet } from '../src/rinex/met';

// Slices (header + first records) of EUREF met files from the BKG archive
// (igs.bkg.bund.de/root_ftp/EUREF/obs): BORJ 2015/100 (teqc, RINEX 2.11),
// BORJ 2025/299 (gfzrnx, 3.05, 6 types, zero-padded epochs, UTF-8 '°'
// in a comment), TUBO 2025/299 (BALRNX, 3.03, 2-decimal SENSOR POS) and
// TUC2 2025/299 (Leica Spider + gfzrnx, 3.05, blank accuracies).
const fx = (f: string) =>
  readFileSync(join(__dirname, '..', 'test-fixtures', f), 'utf8');
const borj2 = fx('borj_met_v211_slice.15m');
const borj3 = fx('borj_met_v305_slice.rnx');
const tubo = fx('tubo_met_v303_slice.rnx');
const tuc2 = fx('tuc2_met_v305_slice.rnx');

const lines = (t: string) =>
  t
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l !== '');

/** The data a conversion must keep (header bookkeeping left out). */
const data = (m: RinexMet) => {
  const { headerLines: _h, zeroPadEpoch: _z, ...rest } = m;
  return rest;
};

describe('writeRinexMet — round trip', () => {
  for (const [name, t] of [
    ['BORJ 2.11', borj2],
    ['BORJ 3.05', borj3],
    ['TUC2 3.05', tuc2],
  ] as const)
    it(`writes ${name} back line for line`, () => {
      expect(lines(writeRinexMet(parseRinexMet(t)))).toEqual(lines(t));
    });

  it('TUBO: identical but for SENSOR POS printed F14.4 (file has 2 decimals)', () => {
    const a = parseRinexMet(tubo);
    const w = lines(writeRinexMet(a));
    const o = lines(tubo);
    const diff = o.flatMap((l, i) => (l !== w[i] ? [[l, w[i]]] : []));
    expect(diff).toEqual([
      [
        '  4001459.04    1192332.37    4805806.71        323.24   PR SENSOR POS XYZ/H',
        '  4001459.0400  1192332.3700  4805806.7100      323.2400 PR SENSOR POS XYZ/H',
      ],
      [
        '  4001458.96    1192332.40    4805806.71        323.20   TD SENSOR POS XYZ/H',
        '  4001458.9600  1192332.4000  4805806.7100      323.2000 TD SENSOR POS XYZ/H',
      ],
      [
        '  4001458.91    1192332.46    4805806.75        323.21   HR SENSOR POS XYZ/H',
        '  4001458.9100  1192332.4600  4805806.7500      323.2100 HR SENSOR POS XYZ/H',
      ],
    ]);
    expect(data(parseRinexMet(writeRinexMet(a)))).toEqual(data(a));
  });

  it('converts 2.11 → 3.05 → 2.11 and 3.05 → 2.11 → 3.05 losslessly', () => {
    for (const t of [borj2, borj3, tuc2]) {
      const a = parseRinexMet(t);
      for (const v of [2.11, 3.05, 4.02]) {
        const b = parseRinexMet(writeRinexMet({ ...a, version: v }));
        expect(data(b)).toEqual(data({ ...a, version: v }));
      }
    }
    const v3 = lines(writeRinexMet({ ...parseRinexMet(borj2), version: 3.05 }));
    // 4-digit year in 3.xx; the 2-digit 15 of 2.11 is 2015.
    expect(v3).toContain(' 2015  4 10  0  0 10 1023.2    1.1   78.2');
  });

  it('writes a header from scratch and continuation lines past 8 types', () => {
    const types = ['PR', 'TD', 'HR', 'ZW', 'ZD', 'ZT', 'WD', 'WS', 'RI', 'HI'];
    const met: RinexMet = {
      version: 3.05,
      markerName: 'TEST00XXX',
      markerNumber: '12345M001',
      types,
      sensors: [
        { model: 'PAROSCIENTIFIC', type: '740-16B', accuracy: 0.2, obs: 'PR' },
      ],
      positions: [{ x: 0, y: 0, z: 0, h: 1234.5678, obs: 'PR' }],
      comments: ['built from records'],
      records: [
        {
          timeMs: Date.UTC(2024, 0, 2, 3, 4, 5),
          values: Object.fromEntries(
            types.map((t, k) => [t, k === 3 ? NaN : -1.5 + 100.25 * k])
          ),
        },
      ],
    };
    const out = writeRinexMet(met);
    const w = lines(out);
    expect(w).toContain(
      '    10    PR    TD    HR    ZW    ZD    ZT    WD    WS    RI# / TYPES OF OBSERV'
    );
    expect(w).toContain(
      '          HI                                                # / TYPES OF OBSERV'
    );
    // Table A22 layouts: A20,A20,6X,F7.1,4X,A2,1X and 3F14.4,F14.4,1X,A2,1X.
    expect(w).toContain(
      'PAROSCIENTIFIC      740-16B' +
        ' '.repeat(23) +
        '0.2    PR SENSOR MOD/TYPE/ACC'
    );
    expect(w).toContain(
      '        0.0000        0.0000        0.0000     1234.5678 PR SENSOR POS XYZ/H'
    );
    expect(w.slice(-2)).toEqual([
      ' 2024  1  2  3  4  5   -1.5   98.8  199.0         399.5  499.8  600.0  700.3',
      '      800.5  900.8',
    ]);
    const back = parseRinexMet(out);
    // Values come back at the printed 0.1 (F7.1); the blank ZW as NaN.
    expect(back.records[0]!.values.ZW).toBeNaN();
    expect(back.records[0]!.values.HI).toBe(900.8);
    expect(back.types).toEqual(types);
  });
});

describe('RINEX met — spec oracle (2.11 Table A5/A6, 3.05 A19–A21)', () => {
  it('reads 3.05 header and record fields at their columns', () => {
    const m = parseRinexMet(borj3);
    expect(m.version).toBe(3.05);
    expect(m.markerName).toBe('BORJ00DEU');
    expect(m.markerNumber).toBe('14268M002');
    expect(m.types).toEqual(['HR', 'PR', 'RI', 'TD', 'WD', 'WS']);
    expect(m.sensors[0]).toEqual({
      model: 'P2410010',
      type: 'WXTPTU',
      accuracy: 1.0,
      obs: 'PR',
    });
    expect(m.sensors.find((s) => s.obs === 'RI')!.accuracy).toBeUndefined();
    expect(m.positions).toEqual([
      { x: 3769401.4, y: 440564.8, z: 5109099.1, h: 52.1, obs: 'PR' },
    ]);
    // " 2025 10 26 00 00 05   78.2  992.4    0.0   10.1  249.0    7.3"
    expect(m.records[0]).toEqual({
      timeMs: Date.UTC(2025, 9, 26, 0, 0, 5),
      values: { HR: 78.2, PR: 992.4, RI: 0, TD: 10.1, WD: 249, WS: 7.3 },
    });
    expect(m.zeroPadEpoch).toBe(true);
    expect(m.records).toHaveLength(30);
  });

  it('reads 2.11 two-digit years (00–79 → 20xx)', () => {
    const m = parseRinexMet(borj2);
    expect(m.version).toBe(2.11);
    expect(m.records[1]).toEqual({
      timeMs: Date.UTC(2015, 3, 10, 0, 0, 10),
      values: { PR: 1023.2, TD: 1.1, HR: 78.2 },
    });
    const y99 = borj2.replace(/^ 15 {2}4 10/m, ' 99  4 10');
    expect(
      new Date(parseRinexMet(y99).records[0]!.timeMs).getUTCFullYear()
    ).toBe(1999);
  });

  it('keeps comments with multi-byte characters and their label', () => {
    const m = parseRinexMet(borj3);
    expect(m.comments).toContain('PR accuracy 0.5 mbar at 0 ... 30°C');
    expect(m.headerLines!.filter((l) => l.label === 'COMMENT')).toHaveLength(9);
  });
});

describe('RINEX met — convention locks', () => {
  it('values follow the header type order, not a fixed PR/TD/HR order', () => {
    // BORJ lists HR first, TUBO PR first, TUC2 HR PR TD: pressure must
    // come out as hPa-sized, humidity as %, temperature as °C in each.
    for (const t of [borj2, borj3, tubo, tuc2]) {
      const m = parseRinexMet(t);
      for (const r of m.records) {
        expect(r.values.PR).toBeGreaterThan(900);
        expect(r.values.PR).toBeLessThan(1060);
        expect(r.values.HR).toBeGreaterThanOrEqual(0);
        expect(r.values.HR).toBeLessThanOrEqual(100);
        expect(r.values.TD).toBeGreaterThan(-40);
        expect(r.values.TD).toBeLessThan(45);
      }
    }
  });

  it('pressure is in mbar = hPa, consistent with the sensor height', () => {
    // Standard atmosphere p(h) = 1013.25 (1 − 2.25577e-5 h)^5.25588 hPa,
    // weather ± 45 hPa: TUBO 323 m, TUC2 161 m, BORJ 52 m. A Pa or inHg
    // reading would be off by 100× / 30×.
    for (const t of [borj3, tubo, tuc2]) {
      const m = parseRinexMet(t);
      const h = m.positions.find((p) => p.obs === 'PR')!.h;
      const std = 1013.25 * Math.pow(1 - 2.25577e-5 * h, 5.25588);
      expect(Math.abs(m.records[0]!.values.PR! - std)).toBeLessThan(45);
    }
    // TUBO (323 m) reads lower than TUC2 (161 m) on the same day.
    expect(parseRinexMet(tubo).records[0]!.values.PR).toBeLessThan(
      parseRinexMet(tuc2).records[0]!.values.PR!
    );
  });

  it('epochs are GPS time taken as written (no leap-second shift)', () => {
    // TUBO: "EPOCHS AFTER RECOMPUTING FROM UTC TO GPS TIME SCALE" → hh:mm:15.
    const m = parseRinexMet(tubo);
    expect(m.records[0]!.timeMs).toBe(Date.UTC(2025, 9, 26, 0, 0, 15));
    expect(m.records[1]!.timeMs - m.records[0]!.timeMs).toBe(60_000);
  });

  it('SENSOR POS is X, Y, Z then H (geocentric, not lat/lon)', () => {
    const p = parseRinexMet(tuc2).positions[0]!;
    // TUC2 (Chania, Crete): |XYZ| ≈ Earth radius, H a station height.
    expect(Math.hypot(p.x, p.y, p.z)).toBeGreaterThan(6.36e6);
    expect([p.x, p.y, p.z, p.h]).toEqual([
      4744543.7806, 2119411.9664, 3686258.7452, 160.8652,
    ]);
  });
});
