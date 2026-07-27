import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseSbfGpsNav } from '../src/sbf/rawnav-gps';
import { parseSbfCnav } from '../src/sbf/rawnav';
import { parseSbfNav } from '../src/sbf/nav';
import { parseSbfGalNav } from '../src/sbf/rawnav-gal';
import { parseSbfBdsNav, parseSbfGloNav } from '../src/sbf/rawnav-bds';
import { parseSbfGeoNav } from '../src/sbf/rawnav-sbas';
import { parseSbfIonoUtc } from '../src/sbf/iono';
import { decodeSbfNavigation } from '../src/sbf/navigation';

// A 256 KB slice of the TU Delft DLF500NLD1 Septentrio stream. This
// receiver broadcasts navigation as raw frames (GPSRawCA, GALRawINAV/FNAV,
// GLORawCA, BDSRaw, GPSRawL2C/L5), so it exercises every raw assembler and
// the one-pass decoder together.
const SBF_FILE = join(__dirname, '../test-fixtures/dlf500_sbf_nav_slice.sbf');
const bytes = existsSync(SBF_FILE)
  ? new Uint8Array(readFileSync(SBF_FILE))
  : new Uint8Array();

const bySystem = (eph: { prn: string }[]) => {
  const m = new Map<string, number>();
  for (const e of eph) m.set(e.prn[0]!, (m.get(e.prn[0]!) ?? 0) + 1);
  return m;
};

describe.skipIf(!existsSync(SBF_FILE))('SBF GPS LNAV (GPSRawCA)', () => {
  it('assembles GPS ephemerides from raw C/A subframes', () => {
    const r = parseSbfGpsNav(bytes);
    expect(r.messages).toBeGreaterThan(30); // dozens of GPSRawCA blocks
    expect(r.ephemerides.length).toBeGreaterThanOrEqual(8);
    expect(r.ephemerides.every((e) => e.prn[0] === 'G')).toBe(true);
  });

  it('produces physically plausible GPS orbits', () => {
    for (const e of parseSbfGpsNav(bytes).ephemerides) {
      expect(e.sqrtA).toBeGreaterThan(5153); // GPS MEO √a ≈ 5153.6 m^½
      expect(e.sqrtA).toBeLessThan(5154);
      expect(e.e).toBeGreaterThanOrEqual(0);
      expect(e.e).toBeLessThan(0.03);
      expect(e.i0).toBeGreaterThan(0.9); // ≈ 55°
      expect(e.i0).toBeLessThan(1.1);
      expect(e.week).toBeGreaterThan(2000);
    }
  });

  it('agrees with the same satellites decoded from L2C/L5 CNAV', () => {
    const lnav = new Set(parseSbfGpsNav(bytes).ephemerides.map((e) => e.prn));
    const cnav = new Set(parseSbfCnav(bytes).ephemerides.map((e) => e.prn));
    // Every CNAV satellite also has an LNAV ephemeris (LNAV is broadcast
    // by every GPS SV; L2C/L5 only by the modernised ones).
    for (const prn of cnav) expect(lnav.has(prn)).toBe(true);
  });
});

describe.skipIf(!existsSync(SBF_FILE))('decodeSbfNavigation (one pass)', () => {
  it('covers every constellation the receiver broadcasts', () => {
    const nav = decodeSbfNavigation(bytes);
    const bySys = bySystem(nav.ephemerides);
    expect(bySys.get('G') ?? 0).toBeGreaterThanOrEqual(8); // GPS LNAV
    expect(bySys.get('E') ?? 0).toBeGreaterThanOrEqual(8); // Galileo
    expect(bySys.get('R') ?? 0).toBeGreaterThanOrEqual(8); // GLONASS
    expect(bySys.get('C') ?? 0).toBeGreaterThanOrEqual(8); // BeiDou
    expect(nav.cnav.length).toBeGreaterThan(0); // GPS CNAV
    expect(nav.ionoCorrections['GPSA']).toBeDefined();
  });

  it('reports per-source block counts', () => {
    const { counts } = decodeSbfNavigation(bytes);
    expect(counts.gpsLnavRaw).toBeGreaterThan(0);
    expect(counts.galRaw).toBeGreaterThan(0);
    expect(counts.gloRaw).toBeGreaterThan(0);
    expect(counts.bdsRaw).toBeGreaterThan(0);
    expect(counts.sbasRaw).toBeGreaterThan(0);
  });

  it('decodes SBAS GEO (type-9) into geostationary state vectors', () => {
    const geo = parseSbfGeoNav(bytes);
    expect(geo.messages).toBeGreaterThan(0);
    expect(geo.badCrc).toBe(0); // GEORawL1 CRC-24Q clean in this slice
    expect(geo.ephemerides.length).toBeGreaterThanOrEqual(3);
    for (const e of geo.ephemerides) {
      expect(e.system).toBe('S');
      const r = Math.hypot(e.x, e.y, e.z); // km
      expect(r).toBeGreaterThan(42000); // geostationary radius ≈ 42 164 km
      expect(r).toBeLessThan(42300);
    }
    // the one-pass decoder surfaces the same GEO records
    const oneP = decodeSbfNavigation(bytes).ephemerides.filter(
      (e) => e.prn[0] === 'S'
    );
    expect(oneP.length).toBe(geo.ephemerides.length);
  });

  it('matches the sum of the per-class parsers (no divergence)', () => {
    const nav = decodeSbfNavigation(bytes);

    // Legacy ephemerides: union of decoded-nav + raw GAL/GLO/BDS/GPS-LNAV,
    // de-duped by (prn, toc, source) — exactly what the one-pass produces.
    const key = (e: { prn: string; tocDate: Date } & { source?: string }) =>
      `${e.prn}|${e.tocDate.getTime()}|${e.source ?? ''}`;
    const union = new Map<string, unknown>();
    for (const e of parseSbfNav(bytes).ephemerides) union.set(key(e), e);
    for (const e of parseSbfGpsNav(bytes).ephemerides) union.set(key(e), e);
    for (const e of parseSbfGalNav(bytes).ephemerides) union.set(key(e), e);
    for (const e of parseSbfGloNav(bytes).ephemerides) union.set(key(e), e);
    for (const e of parseSbfBdsNav(bytes).ephemerides) union.set(key(e), e);
    for (const e of parseSbfGeoNav(bytes).ephemerides) union.set(key(e), e);
    expect(nav.ephemerides.length).toBe(union.size);

    expect(nav.cnav.length).toBe(parseSbfCnav(bytes).ephemerides.length);
    const iono = parseSbfIonoUtc(bytes);
    expect(Object.keys(nav.ionoCorrections).sort()).toEqual(
      Object.keys(iono.ionoCorrections).sort()
    );
    expect(nav.leapSeconds).toBe(iono.leapSeconds);
  });
});
