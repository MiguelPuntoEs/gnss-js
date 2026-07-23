import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseNovatelNav } from '../src/novatel';
import type { GlonassEphemeris, KeplerEphemeris } from '../src/rinex/nav';

const FILE = join(__dirname, '../test-fixtures/oemv_rangecmp.gps');

/** Relative-error assertion at RINEX printing precision. */
const close = (got: number, pin: number) => {
  expect(Math.abs(got - pin)).toBeLessThanOrEqual(Math.abs(pin) * 1e-11);
};

/**
 * The fixture is RTKLIB's OEMV sample log (test/data/rcvraw,
 * BSD-2-Clause): 25 RAWEPHEM and 8 GLOEPHEMERIS messages. Expected
 * values pinned from RTKLIB demo5 convbin's RINEX 3.04 nav conversion
 * of the same file (14 unique records); the full-file oracle agreed on
 * every numeric field of all 14 records to rel < 5e-12.
 */
describe.skipIf(!existsSync(FILE))('parseNovatelNav (OEMV)', () => {
  // Guarded read: describe bodies execute even under skipIf.
  const res = existsSync(FILE)
    ? parseNovatelNav(new Uint8Array(readFileSync(FILE)))
    : null!;

  it('decodes and de-duplicates the broadcast ephemerides', () => {
    expect(res.badCrc).toBe(0);
    expect(res.ephemerides.length).toBe(14);
    expect(res.ephemerides.filter((e) => e.system === 'G').length).toBe(9);
    expect(res.ephemerides.filter((e) => e.system === 'R').length).toBe(5);
  });

  it('decodes RAWEPHEM into a GPS Keplerian ephemeris (G11)', () => {
    const g11 = res.ephemerides.find((e) => e.prn === 'G11') as KeplerEphemeris;
    expect(g11).toBeDefined();

    // Epoch: 2009-12-19 00:00:00 GPS, week 1562 — same conventions
    // as parseNavFile (GPS-scale Date, mirror toc seconds).
    expect(g11.tocDate.getTime()).toBe(Date.UTC(2009, 11, 19));
    expect(g11.toc).toBe((Date.UTC(2009, 11, 19) / 1000) % 604800);
    expect(g11.week).toBe(1562);
    expect(g11.toe).toBe(518400);
    expect(g11.iode).toBe(110);
    expect(g11.svHealth).toBe(0);

    // Clock (convbin: -.349921174347D-04 -.204636307899D-11 0)
    close(g11.af0, -0.349921174347e-4);
    close(g11.af1, -0.204636307899e-11);
    expect(g11.af2).toBe(0);
    close(g11.tgd, -0.116415321827e-7); // -25 × 2^-31

    // Orbit
    expect(g11.crs).toBe(2.5); // exact: 80 × 2^-5
    expect(g11.crc).toBe(254.3125); // exact: 8138 × 2^-5
    close(g11.deltaN, 0.669420741204e-8);
    close(g11.m0, -0.643248850857);
    close(g11.cuc, 0.279396772385e-6);
    close(g11.e, 0.103750801645e-1);
    close(g11.cus, 0.442750751972e-5);
    close(g11.sqrtA, 0.515370238495e4);
    close(g11.cic, 0.763684511185e-7);
    close(g11.omega0, 0.202477519771e1);
    close(g11.cis, 0.165775418282e-6);
    close(g11.i0, 0.888351668373);
    close(g11.omega, 0.775219273029);
    close(g11.omegaDot, -0.91618101976e-8);
    close(g11.idot, 0.303584074067e-10);
  });

  it('decodes GLOEPHEMERIS into a GLONASS ephemeris (R14)', () => {
    const r14 = res.ephemerides.find(
      (e) => e.prn === 'R14'
    ) as GlonassEphemeris;
    expect(r14).toBeDefined();

    // RINEX epoch is the GLONASS toe in UTC: 2009-12-18 23:15:00
    // (toe 515715 s GPS − 15 leap seconds).
    expect(r14.tocDate.getTime()).toBe(Date.UTC(2009, 11, 18, 23, 15, 0));
    // Frame time as seconds of the UTC week (convbin v3 convention).
    expect(r14.messageFrameTime).toBe(515190);
    expect(r14.health).toBe(0);
    expect(r14.freqNum).toBe(-7);

    close(r14.tauN, -0.130841508508e-4); // RINEX stores −τ_n
    close(r14.gammaN, 0.181898940355e-11);

    // State vector in km / km/s / km/s² (PZ-90)
    close(r14.x, -0.145564423828e5);
    close(r14.xDot, -0.964970588684);
    close(r14.xAcc, 0.931322574615e-9);
    close(r14.y, 0.181902060547e5);
    close(r14.yDot, 0.105136585236e1);
    close(r14.yAcc, -0.931322574615e-9);
    close(r14.z, 0.102850830078e5);
    close(r14.zDot, -0.322905063629e1);
    close(r14.zAcc, -0.931322574615e-9);
  });

  it('keeps distinct GLONASS records apart (R15 vs R14)', () => {
    const r15 = res.ephemerides.find(
      (e) => e.prn === 'R15'
    ) as GlonassEphemeris;
    expect(r15).toBeDefined();
    expect(r15.tocDate.getTime()).toBe(Date.UTC(2009, 11, 18, 23, 15, 0));
    expect(r15.freqNum).toBe(0);
    close(r15.tauN, 0.115172937512e-3);
    close(r15.z, 0.221884707031e5);
  });
});
