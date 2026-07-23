import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseNavFile, writeRinexNav4 } from '../src/rinex';
import type {
  Ephemeris,
  KeplerEphemeris,
  NavResult,
  RinexCnavEphemeris,
} from '../src/rinex/nav';
import { CNAV_A_REF, CNAV_OMEGA_DOT_REF } from '../src/navbits/cnav';
import { GPS_PI } from '../src/navbits';
import { parseSbfCnav } from '../src/sbf';

// Committed slice: header + a classic-record sample + every unique GPS
// CNAV record of the IGS hourly RINEX 4.01 nav files BRUX/CEBR/KIRU
// (igs.bkg.bund.de/root_ftp/IGS/nrt, day 2026/204 hours 02-03) — the
// same files the raw CNAV decoder was oracled against.
const SLICE_FILE = join(__dirname, '../test-fixtures/brux_cnav_slice.rnx');
// Same broadcast decoded from raw bits (TU Delft DLF5, 2026-07-23).
const SBF_FILE = join(__dirname, '../test-fixtures/dlf5_cnav_slice.sbf');
// Full-day RINEX 4.02 merged file (downloaded by fetch-test-data.sh).
const DLR_FILE = join(__dirname, '../test-fixtures/brdc_v4_dlr.nav');

/** RINEX prints ~13 significant digits; require agreement to that. */
function relClose(actual: number | null | undefined, expected: number) {
  expect(actual).not.toBeNull();
  expect(Math.abs(actual! - expected)).toBeLessThanOrEqual(
    Math.abs(expected) * 1e-11 + 1e-19
  );
}

/** Sorted deep field comparison of two record arrays (±0 tolerated). */
function expectSameRecords(
  a: readonly (Ephemeris | RinexCnavEphemeris)[],
  b: readonly (Ephemeris | RinexCnavEphemeris)[]
) {
  expect(b.length).toBe(a.length);
  const keyOf = (e: Ephemeris | RinexCnavEphemeris) =>
    `${e.prn}_${e.tocDate.getTime()}`;
  const sa = [...a].sort((x, y) => keyOf(x).localeCompare(keyOf(y)));
  const sb = [...b].sort((x, y) => keyOf(x).localeCompare(keyOf(y)));
  for (let i = 0; i < sa.length; i++) {
    const ra = sa[i]! as unknown as Record<string, unknown>;
    const rb = sb[i]! as unknown as Record<string, unknown>;
    for (const k of Object.keys(ra)) {
      const va = ra[k];
      const vb = rb[k];
      if (va instanceof Date) {
        expect((vb as Date).getTime(), `${keyOf(sa[i]!)} ${k}`).toBe(
          va.getTime()
        );
      } else if (typeof va === 'number') {
        // == so that a file's -0.000000000000E+00 equals a written +0
        expect(vb === va, `${keyOf(sa[i]!)} ${k}: ${vb} !== ${va}`).toBe(true);
      } else {
        expect(vb, `${keyOf(sa[i]!)} ${k}`).toBe(va);
      }
    }
  }
}

describe('RINEX 4 CNAV parsing (brux_cnav_slice.rnx)', () => {
  const result = parseNavFile(readFileSync(SLICE_FILE, 'utf-8'));

  it('parses the 4.01 header and the classic-record sample', () => {
    expect(result.header.version).toBe(4.01);
    expect(result.header.leapSeconds).toBe(18);
    expect(result.ephemerides.length).toBe(6);
    const systems = result.ephemerides.map((e) => e.system).sort();
    expect(systems).toEqual(['C', 'E', 'G', 'G', 'R', 'S']);
  });

  it('returns CNAV records on the cnav array', () => {
    expect(result.cnav).toBeDefined();
    expect(result.cnav!.length).toBe(33);
    for (const c of result.cnav!) {
      expect(c.system).toBe('G');
      expect(c.prn).toMatch(/^G\d{2}$/);
      expect(c.week).toBe(2428);
      expect(c.toe).toBe(c.toc); // Toe == Toc (Table A10 note 2)
      expect(c.toeDate.getTime()).toBe(c.tocDate.getTime());
    }
  });

  it('reads every G04 CNAV field pinned from the raw BRUX text', () => {
    // > EPH G04 CNAV, toc 2026-07-23 01:30:00 — first record in the slice
    const e = result.cnav![0]!;
    expect(e.prn).toBe('G04');
    expect(e.tocDate.getTime()).toBe(Date.UTC(2026, 6, 23, 1, 30, 0));
    // 2026-07-23 is Thursday: sow = 4*86400 + 1.5*3600
    expect(e.toc).toBe(351000);
    relClose(e.af0, 6.285309791565e-5);
    relClose(e.af1, 6.785683126509e-13);
    expect(e.af2).toBe(0);
    relClose(e.aDot, 6.146430969238e-4);
    relClose(e.crs, -3.851171875e1);
    relClose(e.deltaN0, 4.21410410578e-9);
    relClose(e.m0, -1.510318025048);
    relClose(e.cuc, -2.031214535236e-6);
    relClose(e.e, 3.831180627458e-3);
    relClose(e.cus, 8.182600140572e-6);
    relClose(Math.sqrt(e.a), 5.153676388784e3);
    relClose(e.deltaA, 5.153676388784e3 ** 2 - CNAV_A_REF);
    expect(e.top).toBe(297900);
    relClose(e.cic, 4.936009645462e-8);
    relClose(e.omega0, 2.688795239709);
    relClose(e.cis, -2.235174179077e-8);
    relClose(e.i0, 9.724859845162e-1);
    relClose(e.crc, 2.2780859375e2);
    relClose(e.omega, -2.901340507426);
    relClose(e.omegaDot, -7.762766871021e-9);
    relClose(e.deltaOmegaDot, -7.762766871021e-9 - CNAV_OMEGA_DOT_REF * GPS_PI);
    relClose(e.i0Dot, 4.664480008601e-10);
    relClose(e.deltaN0Dot, -1.842030550511e-14);
    expect(e.uraNed0).toBe(-2);
    expect(e.uraNed1).toBe(3);
    expect(e.uraEd).toBe(-2);
    expect(e.health).toBe(1); // L5 flagged unhealthy on the IIR-M
    relClose(e.tgd, -4.656612873077e-9);
    expect(e.uraNed2).toBe(7);
    relClose(e.iscL1ca, -2.037268131971e-10);
    relClose(e.iscL2c, 3.317836672068e-9);
    relClose(e.iscL5i5, -1.42608769238e-9);
    relClose(e.iscL5q5, -1.396983861923e-9);
    expect(e.tow).toBe(347130); // t_tm
    expect(e.wnOp).toBe(2428); // ambiguity-resolved in the file
    // Not carried by the RINEX record: defaulted
    expect(e.clockMsgType).toBe(0);
    expect(e.integrityFlag).toBe(false);
    expect(e.l2cPhasing).toBe(false);
  });

  it('does not disturb classic parsing (LNAV G04 alongside CNAV G04)', () => {
    const g04 = result.ephemerides.find(
      (e) => e.prn === 'G04'
    ) as KeplerEphemeris;
    expect(g04).toBeDefined();
    relClose(g04.af0, 6.285449489951e-5);
    relClose(g04.sqrtA, 5.153676298141e3);
    expect(g04.week).toBe(2428);
  });
});

describe.skipIf(!existsSync(SBF_FILE))(
  'RINEX 4 CNAV vs raw-bits decode (same broadcast)',
  () => {
    const rnx = parseNavFile(readFileSync(SLICE_FILE, 'utf-8'));
    const sbf = parseSbfCnav(new Uint8Array(readFileSync(SBF_FILE)));

    it('finds every SBF-decoded data set in the RINEX slice', () => {
      expect(sbf.ephemerides.length).toBe(15);
      for (const e of sbf.ephemerides) {
        const match = rnx.cnav!.find(
          (c) => c.prn === e.prn && c.week === e.week && c.toe === e.toe
        );
        expect(match, `${e.prn} toe=${e.toe}`).toBeDefined();
      }
    });

    it('agrees field for field at RINEX print precision', () => {
      const NUM_FIELDS = [
        'af0',
        'af1',
        'af2',
        'aDot',
        'crs',
        'deltaN0',
        'deltaN0Dot',
        'm0',
        'e',
        'cuc',
        'cus',
        'cic',
        'cis',
        'crc',
        'top',
        'omega',
        'omega0',
        'i0',
        'omegaDot',
        'i0Dot',
        'uraEd',
        'uraNed0',
        'uraNed1',
        'uraNed2',
        'health',
        'toc',
      ] as const;
      const NULLABLE = [
        'tgd',
        'iscL1ca',
        'iscL2c',
        'iscL5i5',
        'iscL5q5',
      ] as const;

      for (const e of sbf.ephemerides) {
        const c = rnx.cnav!.find(
          (x) => x.prn === e.prn && x.week === e.week && x.toe === e.toe
        )!;
        for (const f of NUM_FIELDS) relClose(c[f], e[f]);
        relClose(Math.sqrt(c.a), Math.sqrt(e.a));
        for (const f of NULLABLE) {
          if (e[f] == null) expect(c[f], `${e.prn} ${f}`).toBeNull();
          else relClose(c[f], e[f]!);
        }
        expect(c.tocDate.getTime()).toBe(e.tocDate.getTime());
        // File wn_op is ambiguity-resolved; broadcast WN_OP is 8-bit
        expect(((c.wnOp! % 256) + 256) % 256).toBe(e.wnOp! % 256);
      }
    });
  }
);

describe('writeRinexNav4', () => {
  const parsed = parseNavFile(readFileSync(SLICE_FILE, 'utf-8'));

  it('round-trips the slice: write → parse → identical records', () => {
    const out = writeRinexNav4(parsed);
    const again = parseNavFile(out);
    expect(again.header.version).toBe(4.01);
    expect(again.header.leapSeconds).toBe(18);
    expectSameRecords(parsed.ephemerides, again.ephemerides);
    expectSameRecords(parsed.cnav!, again.cnav!);
  });

  it('labels records by constellation message type', () => {
    const out = writeRinexNav4(parsed);
    expect(out).toContain('> EPH G04 CNAV');
    expect(out).toContain('> EPH G04 LNAV');
    expect(out).toContain('> EPH R01 FDMA');
    expect(out).toContain('> EPH E03 INAV');
    expect(out).toContain('> EPH C06 D1');
    expect(out).toContain('> EPH S36 SBAS');
  });

  it('writes BDS GEO satellites as D2', () => {
    const geo: NavResult = {
      header: parsed.header,
      ephemerides: parsed.ephemerides
        .filter((e) => e.prn === 'C06')
        .map((e) => ({ ...e, prn: 'C01' }) as Ephemeris),
    };
    expect(writeRinexNav4(geo)).toContain('> EPH C01 D2');
  });

  it('reproduces the BRUX CNAV record text field for field', () => {
    const out = writeRinexNav4({
      header: parsed.header,
      ephemerides: [],
      cnav: parsed.cnav!.slice(0, 1), // G04 2026-07-23 01:30
    });
    const lines = out.split('\n');
    const i = lines.findIndex((l) => l === '> EPH G04 CNAV');
    expect(i).toBeGreaterThan(0);
    expect(lines[i + 1]).toBe(
      'G04 2026 07 23 01 30 00 6.285309791565E-05 6.785683126509E-13' +
        ' 0.000000000000E+00'
    );
    expect(lines[i + 2]).toBe(
      '     6.146430969238E-04-3.851171875000E+01 4.214104105780E-09' +
        '-1.510318025048E+00'
    );
    // orbit-8: t_tm + ambiguity-resolved wn_op
    expect(lines[i + 9]).toBe('     3.471300000000E+05 2.428000000000E+03');
  });

  it('writes blank fields for unavailable TGD/ISC and reads them back', () => {
    const eph: RinexCnavEphemeris = {
      ...parsed.cnav![0]!,
      tgd: null,
      iscL1ca: null,
      iscL2c: null,
      iscL5i5: null,
      iscL5q5: null,
    };
    const out = writeRinexNav4({
      header: parsed.header,
      ephemerides: [],
      cnav: [eph],
    });
    const again = parseNavFile(out).cnav![0]!;
    expect(again.tgd).toBeNull();
    expect(again.iscL1ca).toBeNull();
    expect(again.iscL2c).toBeNull();
    expect(again.iscL5i5).toBeNull();
    expect(again.iscL5q5).toBeNull();
    expectSameRecords([eph], [again]);
  });

  it('emits ION data records instead of v3 iono header lines', () => {
    const nav: NavResult = {
      header: {
        version: 3.04,
        type: 'N',
        leapSeconds: 18,
        ionoCorrections: {
          GPSA: [
            1.1175870895e-8, -7.4505805969e-9, -5.9604644775e-8,
            1.1920928955e-7,
          ],
          GPSB: [90112, -32768, -196608, 196608],
          GAL: [45.25, -0.1484375, 0.0135498046875, 0],
        },
      },
      ephemerides: parsed.ephemerides,
    };
    const out = writeRinexNav4(nav);
    expect(out).not.toContain('IONOSPHERIC CORR');
    expect(out).toContain('> ION G   LNAV');
    expect(out).toContain('> ION E   IFNV');
    // reparse must skip the ION records cleanly
    const again = parseNavFile(out);
    expectSameRecords(nav.ephemerides, again.ephemerides);
  });

  it('omits ION records when there is nothing to date them', () => {
    const out = writeRinexNav4({
      header: {
        version: 3.04,
        type: 'N',
        leapSeconds: null,
        ionoCorrections: { GPSA: [1e-8, 2e-8, 3e-8, 4e-8] },
      },
      ephemerides: [],
    });
    expect(out).not.toContain('> ION');
  });
});

// ── Classic-records regression against the full-day DLR file ────────
describe.skipIf(!existsSync(DLR_FILE))(
  'writeRinexNav4 round trip (brdc_v4_dlr.nav)',
  () => {
    it('re-parses to identical classic and CNAV records', () => {
      const r1 = parseNavFile(readFileSync(DLR_FILE, 'utf-8'));
      expect(r1.ephemerides.length).toBeGreaterThan(10000);
      // The DLR merged file also carries QZSS CNAV records
      expect(r1.cnav!.some((c) => c.system === 'J')).toBe(true);
      expect(r1.cnav!.some((c) => c.system === 'G')).toBe(true);

      const r2 = parseNavFile(writeRinexNav4(r1));
      expectSameRecords(r1.ephemerides, r2.ephemerides);
      expectSameRecords(r1.cnav!, r2.cnav!);
    });
  }
);
