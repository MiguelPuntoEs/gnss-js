import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseNavFile } from '../src/rinex';
import {
  computeSatPosition,
  computeTlePositions,
  elementAgeDays,
  formatCatalogNumber,
  matchElementsToPrns,
  parseElementSets,
  parseOmmJson,
  parseTle,
  parseTleLines,
  prnFromObjectName,
  selectEphemeris,
  tleChecksum,
  tlePositionEcef,
  tleSatellite,
} from '../src/orbit';

/**
 * Real-world fixtures, all from 2026-11-14:
 * - celestrak_gnss_2026-11-14.{json,tle}: CelesTrak GROUP=gnss, fetched
 *   together at ~21:27 UTC (OMM JSON and the same sets as TLE)
 * - brdc_2026318_19h.rnx: IGS BRDC00WRD_R_20263180000_01D_MN, header plus
 *   the record nearest 19:00 for every PRN (igs.bkg.bund.de)
 */
const DIR = join(__dirname, '../test-fixtures/sgp4');
const read = (f: string) => readFileSync(join(DIR, f), 'utf-8');
const T = Date.UTC(2026, 10, 14, 19, 0, 0); // GPS-scale

describe('TLE parsing', () => {
  const ISS = [
    'ISS (ZARYA)',
    '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927',
    '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
  ];

  it('reads the classic ISS example', () => {
    const { sets, issues } = parseTle(ISS.join('\n'));
    expect(issues).toEqual([]);
    const el = sets[0]!;
    expect(el.name).toBe('ISS (ZARYA)');
    expect(el.norad).toBe(25544);
    expect(el.intlDesignator).toBe('98067A');
    expect(el.inclination).toBe(51.6416);
    expect(el.eccentricity).toBeCloseTo(0.0006703, 10);
    expect(el.meanMotion).toBe(15.72125391);
    expect(el.bstar).toBeCloseTo(-0.11606e-4, 12);
    expect(el.meanMotionDot).toBeCloseTo(-0.00002182, 12);
    expect(el.revAtEpoch).toBe(56353);
    // 2008 day 264.51782528 = 2008-09-20 12:25:40.104 UTC
    const jd = el.epochJd + el.epochJdFrac;
    expect((jd - 2440587.5) * 86400000).toBeCloseTo(
      Date.UTC(2008, 8, 20, 12, 25, 40, 104),
      -1
    );
  });

  it('computes checksums and flags mismatches without dropping the set', () => {
    expect(tleChecksum(ISS[1]!)).toBe(7);
    expect(tleChecksum(ISS[2]!)).toBe(7);
    const bad = ISS[2]!.slice(0, 68) + '0';
    const { sets, issues } = parseTle([ISS[1], bad].join('\n'));
    expect(sets).toHaveLength(1);
    expect(issues).toEqual([{ line: 2, message: 'line 2 checksum mismatch' }]);
  });

  it('handles Alpha-5 catalogue numbers', () => {
    expect(formatCatalogNumber(25544)).toBe('25544');
    expect(formatCatalogNumber(100000)).toBe('A0000');
    expect(formatCatalogNumber(182345)).toBe('J2345'); // I is skipped
    expect(formatCatalogNumber(339999)).toBe('Z9999');
    const l1 = ISS[1]!.replace('25544', 'J2345');
    const l2 = ISS[2]!.replace('25544', 'J2345');
    expect(parseTleLines(l1, l2).norad).toBe(182345);
  });

  it('rejects mismatched catalogue numbers', () => {
    expect(() =>
      parseTleLines(ISS[1]!, ISS[2]!.replace('25544', '25545'))
    ).toThrow(/differ/);
  });

  it('TLE and OMM forms of the same CelesTrak sets agree', () => {
    const omm = parseOmmJson(read('celestrak_gnss_2026-11-14.json'));
    const { sets, issues } = parseElementSets(
      read('celestrak_gnss_2026-11-14.tle')
    );
    expect(issues).toEqual([]);
    // CelesTrak leaves catalogue numbers ≥ 100 000 out of its TLE output
    // (no Alpha-5 there) — one reason the site reads OMM JSON
    expect(sets.length).toBe(omm.filter((e) => e.norad < 100000).length);
    expect(omm.some((e) => e.norad >= 100000)).toBe(true);
    const byNorad = new Map(omm.map((e) => [e.norad, e]));
    for (const t of sets) {
      const o = byNorad.get(t.norad)!;
      // TLE name lines stop at 24 characters ("…(SOUTHPA*)")
      expect(o.name!.startsWith(t.name!.slice(0, 20))).toBe(true);
      expect(t.epochJd + t.epochJdFrac).toBeCloseTo(
        o.epochJd + o.epochJdFrac,
        7
      );
      expect(t.meanMotion).toBeCloseTo(o.meanMotion, 8);
      expect(t.eccentricity).toBeCloseTo(o.eccentricity, 6); // TLE: 7 digits
      expect(t.inclination).toBeCloseTo(o.inclination, 4);
      // same position to metres (TLE rounds eccentricity to 7 digits)
      const a = tlePositionEcef(tleSatellite(t), T)!;
      const b = tlePositionEcef(tleSatellite(o), T)!;
      expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(20);
    }
  });
});

describe('PRN from CelesTrak object names', () => {
  it.each([
    ['GPS BIIR-5  (PRN 22)', 'G22'],
    ['GPS BIII-7  (PRN 01)', 'G01'],
    ['BEIDOU-3 M1 (C19)', 'C19'],
    ['QZS-2 (QZSS/PRN 194)', 'J02'],
    ['QZS-3 (QZSS/PRN 199)', 'J07'],
    ['SES-5 (EGNOS/PRN 136)', 'S36'],
    ['GSAT-8 (GAGAN/PRN 127)', 'S27'],
    ['GSAT0226 (GALILEO 31)', null],
    ['COSMOS 2557 (706K)', null],
    ['IRNSS-1B', null],
  ])('%s → %s', (name, prn) => {
    expect(prnFromObjectName(name)).toBe(prn);
  });
});

describe('TLE vs broadcast ephemeris (GNSS, 2026-11-14 19:00)', () => {
  const nav = parseNavFile(read('brdc_2026318_19h.rnx'));
  const omm = parseOmmJson(read('celestrak_gnss_2026-11-14.json'));
  const sats = omm.map((e) => tleSatellite(e));
  const ref = new Map<string, [number, number, number]>();
  for (const prn of new Set(nav.ephemerides.map((e) => e.prn))) {
    const eph = selectEphemeris(nav.ephemerides, prn, T);
    if (!eph) continue;
    const p = computeSatPosition(eph, T);
    ref.set(prn, [p.x, p.y, p.z]);
  }
  const matches = matchElementsToPrns(sats, ref, T);
  const byNorad = new Map(matches.map((m) => [m.norad, m]));

  it('every GNSS set propagates (deep-space branch)', () => {
    for (const s of sats) {
      expect(s.satrec.method).toBe('d');
      expect(tlePositionEcef(s, T), s.id).not.toBeNull();
    }
  });

  it('matches most satellites to a broadcast PRN within a few km', () => {
    expect(matches.length).toBeGreaterThan(120);
    for (const m of matches) {
      const sys = m.prn[0]!;
      // GLONASS and SBAS sets are looser (one GLONASS ~60 km today)
      const limit = sys === 'R' || sys === 'S' ? 100 : 5;
      expect(m.distanceKm, m.prn).toBeLessThan(limit);
    }
  });

  it('agrees with the name for GPS and QZSS', () => {
    let checked = 0;
    for (const el of omm) {
      const nm = prnFromObjectName(el.name);
      const m = byNorad.get(el.norad);
      if (!nm || !m || !/^[GJ]/.test(nm)) continue;
      expect(m.prn, el.name).toBe(nm);
      checked++;
    }
    expect(checked).toBeGreaterThan(25);
  });

  it('finds the Galileo and GLONASS PRNs the names do not carry', () => {
    const gal = matches.filter((m) => m.prn.startsWith('E'));
    const glo = matches.filter((m) => m.prn.startsWith('R'));
    expect(gal.length).toBeGreaterThanOrEqual(25);
    expect(glo.length).toBeGreaterThanOrEqual(20);
    // GSAT0211 "GALILEO 14" broadcasts as E02
    const gsat0211 = omm.find((e) => e.name?.startsWith('GSAT0211'))!;
    expect(byNorad.get(gsat0211.norad)?.prn).toBe('E02');
  });

  it('feeds the shared track shape (ground track + az/el)', () => {
    const delft: [number, number, number] = [3924687.7, 301132.7, 5001910.9];
    const times = [T, T + 600_000];
    const all = computeTlePositions(sats.slice(0, 5), times, delft);
    expect(all.prns).toHaveLength(5);
    for (const id of all.prns) {
      const p = all.positions[id]![0]!;
      expect(Math.abs(p.lat)).toBeLessThan(Math.PI / 2);
      expect(p.el).toBeGreaterThan(-Math.PI / 2);
    }
  });

  it('keeps a GEO in its box: SES-5 stays near 5° E all day', () => {
    const ses5 = omm.find((e) => e.name?.startsWith('SES-5'))!;
    const sat = tleSatellite(ses5);
    const times = Array.from(
      { length: 25 },
      (_, h) => T - 19 * 3600_000 + h * 3600_000
    );
    const lons = computeTlePositions([sat], times).positions[sat.id]!.map(
      (p) => (p!.lon * 180) / Math.PI
    );
    for (const lon of lons) expect(Math.abs(lon - 5)).toBeLessThan(1);
    expect(elementAgeDays(ses5, T)).toBeLessThan(2);
  });
});

describe('SBAS records in metres (merged BRDC files)', () => {
  it('are rescaled to km, so the GEO lands at its slot', () => {
    // two S36 records of BRDC00WRD_R_20263180000: one in m, one in km
    const text =
      read('brdc_2026318_19h.rnx').split('END OF HEADER')[0] +
      'END OF HEADER\n' +
      [
        'S36 2026 11 14 18 01 02 0.000000000000e+00 0.000000000000e+00 5.832850000000e+05',
        '     4.200368800000e+07 0.000000000000e+00 0.000000000000e+00 0.000000000000e+00',
        '     3.674846960000e+06 0.000000000000e+00 0.000000000000e+00 1.500000000000e+01',
        '     0.000000000000e+00 0.000000000000e+00 0.000000000000e+00 1.500000000000e+01',
        'S36 2026 11 14 18 01 20 0.000000000000e+00 0.000000000000e+00 5.832800000000e+05',
        '     4.200368800000e+04 0.000000000000e+00 0.000000000000e+00 0.000000000000e+00',
        '     3.674846960000e+03 0.000000000000e+00 0.000000000000e+00 1.500000000000e+01',
        '     0.000000000000e+00 0.000000000000e+00 0.000000000000e+00 0.000000000000e+00',
      ].join('\n') +
      '\n';
    const ephs = parseNavFile(text).ephemerides.filter((e) => e.prn === 'S36');
    expect(ephs).toHaveLength(2);
    for (const e of ephs) {
      const p = computeSatPosition(e, Date.UTC(2026, 10, 14, 18, 1, 20));
      const r = Math.hypot(p.x, p.y, p.z);
      expect(r / 1000).toBeCloseTo(42164, -1);
      expect((Math.atan2(p.y, p.x) * 180) / Math.PI).toBeCloseTo(5, 0);
    }
  });
});
