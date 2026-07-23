import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { computeSatPosition } from '../src/orbit/index';
import { parseNavFile, type KeplerEphemeris } from '../src/rinex/nav';
import { parseNovatelNav } from '../src/novatel';

/**
 * BDS GEO propagation regressions.
 *
 * GEO ephemeris elements are broadcast in a frame tilted −5° about the
 * x-axis and must be recovered with the Rz(ΩE·tk)·Rx(−5°) transform.
 * Consequently the broadcast i0 of a GEO is ≈ 5° ± its real drift
 * inclination — it can sit on either side of 0.1 rad (C01 broadcasts
 * 0.111 rad in the 2025 OEM719 fixture, 0.062 rad in the 2026 BRDC
 * fixture). Detection therefore has to be by PRN slot (C01–C05,
 * C59–C63), not by an inclination threshold: records that fell through
 * to the MEO/IGSO branch diverged ~850 km per hour of tk between
 * consecutive records of the same satellite.
 *
 * The cross-record experiment below is decoder-independent ground
 * truth: two consecutive broadcast records describe the same orbit, so
 * propagating the older record to the newer record's toe must agree
 * with the newer record evaluated at its own toe to broadcast-accuracy
 * level (RTKLIB demo5 eph2pos on the same records: < 0.5 m).
 */

/** Naive-BDT toc → GPS-scale Unix ms (BDT = GPS − 14 s). */
const bdtTocToGpsMs = (e: KeplerEphemeris) => e.tocDate.getTime() + 14000;

/** Distance between two records' predictions at the newer record's toe. */
function crossRecordDistance(a: KeplerEphemeris, b: KeplerEphemeris): number {
  const t = bdtTocToGpsMs(b);
  const pa = computeSatPosition(a, t);
  const pb = computeSatPosition(b, t);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
}

function consecutivePair(
  ephs: KeplerEphemeris[],
  prn: string
): [KeplerEphemeris, KeplerEphemeris] {
  const recs = ephs
    .filter((e) => e.prn === prn)
    .sort((x, y) => x.tocDate.getTime() - y.tocDate.getTime());
  const a = recs.find((e, i) => recs[i + 1] && recs[i + 1]!.toe !== e.toe);
  const b = recs[recs.indexOf(a!) + 1];
  expect(a, `${prn}: need two records with distinct toe`).toBeDefined();
  return [a!, b!];
}

const BRDC = join(__dirname, '../test-fixtures/brdc_v3_igs.nav');
const OEM719 = join(__dirname, '../test-fixtures/oem719_rtk_base.gps');

describe.skipIf(!existsSync(BRDC))('BDS GEO — IGS BRDC records', () => {
  const ephs = existsSync(BRDC)
    ? (parseNavFile(readFileSync(BRDC, 'utf-8')).ephemerides.filter(
        (e) => e.system === 'C'
      ) as KeplerEphemeris[])
    : [];

  it('C01 (GEO) consecutive records agree at the shared epoch', () => {
    const [a, b] = consecutivePair(ephs, 'C01');
    expect(crossRecordDistance(a, b)).toBeLessThan(100);
  });

  it('C06 (IGSO control) consecutive records agree at the shared epoch', () => {
    const [a, b] = consecutivePair(ephs, 'C06');
    expect(crossRecordDistance(a, b)).toBeLessThan(100);
  });
});

describe.skipIf(!existsSync(OEM719))(
  'BDS GEO — OEM719 broadcast records',
  () => {
    const ephs = existsSync(OEM719)
      ? (parseNovatelNav(
          new Uint8Array(readFileSync(OEM719))
        ).ephemerides.filter((e) => e.system === 'C') as KeplerEphemeris[])
      : [];

    it('C01 records with broadcast i0 > 0.1 rad still take the GEO branch', () => {
      const [a, b] = consecutivePair(ephs, 'C01');
      // This fixture is the regression trigger: broadcast i0 above the old
      // 0.1 rad "GEO" threshold. If it ever stops being so, the test no
      // longer guards the inclination-heuristic regression.
      expect(a.i0).toBeGreaterThan(0.1);
      expect(b.i0).toBeGreaterThan(0.1);
      // Was 851.7 km when the record fell through to the MEO/IGSO branch.
      expect(crossRecordDistance(a, b)).toBeLessThan(100);
    });

    it('C06 (IGSO control) stays consistent', () => {
      const [a, b] = consecutivePair(ephs, 'C06');
      expect(crossRecordDistance(a, b)).toBeLessThan(100);
    });

    it('C01 absolute position matches RTKLIB demo5 eph2pos', () => {
      // Oracle: RTKLIB demo5 eph2pos (GEO branch, -DENACMP) fed the exact
      // decoded fields of the 04:00 BDT record, evaluated at its own toe
      // (2025-03-26 04:00:14 GPST). Allow 25 m: ~17 m of the difference is
      // RTKLIB's BDS earth-rotation rate (OMGE_CMP 7.292115e-5) vs our
      // shared OMEGA_E (7.2921151467e-5) — a fixed frame offset, not drift.
      const rec = ephs
        .filter((e) => e.prn === 'C01')
        .find((e) => e.toe === 273600);
      expect(rec).toBeDefined();
      const p = computeSatPosition(rec!, bdtTocToGpsMs(rec!));
      const d = Math.hypot(
        p.x - -34363261.482,
        p.y - 24401008.795,
        p.z - -793978.166
      );
      expect(d).toBeLessThan(25);
    });

    it('GEO velocity central-difference stays finite and GEO-sized', () => {
      const rec = ephs.find((e) => e.prn === 'C01')!;
      const t = bdtTocToGpsMs(rec) + 600_000;
      const p = computeSatPosition(rec, t);
      const speed = Math.hypot(p.vx, p.vy, p.vz);
      // ECEF speed of a slightly-inclined GEO: tens of m/s, never km/s.
      expect(Number.isFinite(speed)).toBe(true);
      expect(speed).toBeGreaterThan(0);
      expect(speed).toBeLessThan(300);
      // Velocity must be consistent with position differencing over ±30 s.
      const pm = computeSatPosition(rec, t - 30_000);
      const pp = computeSatPosition(rec, t + 30_000);
      expect(p.vx).toBeCloseTo((pp.x - pm.x) / 60, 1);
      expect(p.vy).toBeCloseTo((pp.y - pm.y) / 60, 1);
      expect(p.vz).toBeCloseTo((pp.z - pm.z) / 60, 1);
    });
  }
);
