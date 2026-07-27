import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { crc32, parseNovatelNav } from '../src/novatel';
import { parseSbfCnav, scanSbfFrames } from '../src/sbf';
import { getBitU } from '../src/navbits';
import type { GlonassEphemeris, KeplerEphemeris } from '../src/rinex/nav';

const FILE = join(__dirname, '../test-fixtures/oemv_rangecmp.gps');
const OEM7_FILE = join(__dirname, '../test-fixtures/oem7_nav_slice.gps');
const SBF_CNAV_FILE = join(__dirname, '../test-fixtures/dlf5_cnav_slice.sbf');

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

  it('has no IONUTC in the 2009 capture (verified census)', () => {
    expect(res.ionoCorrections).toEqual({});
    expect(res.leapSeconds).toBeNull();
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

/**
 * The OEM7 fixture is a whole-frame slice of the MIT-licensed
 * wwz-research/RTK-GNSS sample capture
 * (sample_data/oem719-202503261140.zip, rover, OEM719, WHU
 * 2025-03-26): 435 GALEPHEMERIS, 780 BDSEPHEMERIS, 144 IONUTC, 3 RANGE
 * and 2 GPSEPHEM frames. Expected values pinned from RTKLIB demo5
 * convbin's RINEX 3.04 conversion of the same slice; the full oracle
 * (oracle-novnav2.tmp.mjs) agreed on every numeric field of all 107
 * convbin-visible records to rel < 5e-12 (the 9 extra BDS prn>50
 * records are dropped by RTKLIB's MAXPRNCMP=50 — deliberate
 * deviation, see decodeBdsEphemeris).
 */
describe.skipIf(!existsSync(OEM7_FILE))('parseNovatelNav (OEM719)', () => {
  // Guarded read: describe bodies execute even under skipIf.
  const res = existsSync(OEM7_FILE)
    ? parseNovatelNav(new Uint8Array(readFileSync(OEM7_FILE)))
    : null!;

  it('decodes and de-duplicates the broadcast ephemerides', () => {
    expect(res.badCrc).toBe(0);
    expect(res.ephemerides.length).toBe(118);
    expect(res.ephemerides.filter((e) => e.system === 'E').length).toBe(44);
    expect(res.ephemerides.filter((e) => e.system === 'C').length).toBe(72);
    expect(res.ephemerides.filter((e) => e.system === 'G').length).toBe(2);
  });

  it('decodes GPSEPHEM (7) — pinned from the IGS BRDC oracle', () => {
    // The full rover capture decodes 42 GPSEPHEM records; every one
    // matches the same-day IGS BRDC file (BRDC00IGS_R_2025085/084/060)
    // by (prn, iode, toc, toe) with worst field rel err 3.75e-12 — an
    // oracle independent of RTKLIB, which never decodes this message.
    const g01 = res.ephemerides.find((e) => e.prn === 'G01')!;
    expect(g01).toBeDefined();
    expect(g01.system).toBe('G');
    const k = g01 as KeplerEphemeris;
    expect(k.iode).toBe(194);
    expect(k.week).toBe(2359);
    expect(k.toe).toBe(273600);
    expect(k.tocDate.getTime()).toBe(Date.UTC(2025, 2, 26, 4));
    expect(k.svHealth).toBe(0);
    close(k.sqrtA, 5153.737897872925);
    close(k.e, 0.0004246990429237485);
    close(k.af0, 0.0001923772506415844);
    const g02 = res.ephemerides.find((e) => e.prn === 'G02') as KeplerEphemeris;
    expect(g02.iode).toBe(16);
    close(g02.e, 0.01615214324556291);
    close(g02.af0, -0.00021053338423371315);
  });

  it('decodes GALEPHEMERIS into a Galileo I/NAV ephemeris (E02)', () => {
    // First E02 record in stream order (GPSEPHEM frames precede it).
    const e02 = res.ephemerides.find((e) => e.prn === 'E02') as KeplerEphemeris;
    expect(e02).toBeDefined();

    // Epoch: 2025-03-25 18:00:00 GPS scale, GAL/GPS week 2359.
    expect(e02.tocDate.getTime()).toBe(Date.UTC(2025, 2, 25, 18));
    expect(e02.toc).toBe((Date.UTC(2025, 2, 25, 18) / 1000) % 604800);
    expect(e02.week).toBe(2359);
    expect(e02.toe).toBe(237600);
    expect(e02.iode).toBe(15); // IODNav
    expect(e02.svHealth).toBe(0);

    // Clock (I/NAV set — convbin data source 517)
    close(e02.af0, 0.207266653888e-3);
    close(e02.af1, 0.282796008833e-11);
    expect(e02.af2).toBe(0);
    close(e02.tgd, -0.209547579288e-8); // BGD E5a/E1

    // Orbit (radians on the wire — no semicircle scaling)
    expect(e02.crs).toBe(38.15625);
    expect(e02.crc).toBe(241.78125);
    close(e02.deltaN, 0.362086510928e-8);
    close(e02.m0, 0.24702198756);
    close(e02.cuc, 0.154972076416e-5);
    close(e02.e, 0.433206907474e-3);
    close(e02.cus, 0.456906855106e-5);
    close(e02.sqrtA, 0.544060152245e4);
    close(e02.cic, 0.186264514923e-7);
    close(e02.omega0, 0.931186941091);
    close(e02.cis, 0.130385160446e-7);
    close(e02.i0, 0.964176742951);
    close(e02.omega, 0.868741238354);
    close(e02.omegaDot, -0.580667044256e-8);
    close(e02.idot, 0.178936024832e-9);
  });

  it('uses the F/NAV clock set when rcv_fnav is flagged (E29)', () => {
    // convbin tags this record with data source 258 (F/NAV).
    const e29 = res.ephemerides.find(
      (e) =>
        e.prn === 'E29' && e.tocDate.getTime() === Date.UTC(2025, 2, 26, 0, 40)
    ) as KeplerEphemeris;
    expect(e29).toBeDefined();
    expect(e29.iode).toBe(55);
    expect(e29.toe).toBe(261600);
    close(e29.af0, -0.817549880594e-4); // F/NAV af0, not the I/NAV one
    close(e29.af1, -0.333955085807e-11);
    close(e29.tgd, -0.442378222942e-8);
    expect(e29.crs).toBe(-186.75);
    expect(e29.crc).toBe(160.5);
  });

  it('decodes BDSEPHEMERIS on the BDT scale (C01)', () => {
    const c01 = res.ephemerides.find((e) => e.prn === 'C01') as KeplerEphemeris;
    expect(c01).toBeDefined();

    // RINEX BDS epochs are BDT calendar dates; week is the BDT week.
    expect(c01.tocDate.getTime()).toBe(Date.UTC(2025, 2, 26, 3));
    expect(c01.week).toBe(1003);
    expect(c01.toe).toBe(270000); // BDT seconds of week
    expect(c01.iode).toBe(1); // AODE
    expect(c01.svHealth).toBe(0); // SatH1

    close(c01.af0, -0.330305658281e-3);
    close(c01.af1, 0.411315426163e-11);
    expect(c01.af2).toBe(0);
    close(c01.tgd, -0.52e-8); // TGD1 (B1)

    expect(c01.crs).toBe(173.703125);
    expect(c01.crc).toBe(797.171875);
    close(c01.deltaN, -0.320620497988e-8);
    close(c01.m0, 0.759389273486);
    close(c01.cuc, 0.589014962316e-5);
    close(c01.e, 0.550547498278e-3);
    close(c01.cus, -0.260048545897e-4);
    close(c01.sqrtA, 0.649343768501e4);
    close(c01.cic, 0.20070001483e-6);
    close(c01.omega0, -0.219760185263e1);
    close(c01.cis, 0.146683305502e-6);
    close(c01.i0, 0.110830533245); // GEO — low inclination
    close(c01.omega, -0.148231237631e1);
    close(c01.omegaDot, 0.413374361559e-8);
    close(c01.idot, 0.105718689322e-9);
  });

  it('keeps BDS-3 GEO/IGSO satellites above PRN 50', () => {
    // RTKLIB demo5 drops these via MAXPRNCMP=50 (deliberate deviation).
    const high = res.ephemerides.filter(
      (e) => e.system === 'C' && parseInt(e.prn.slice(1), 10) > 50
    );
    expect(high.length).toBe(9);
    for (const e of high) {
      for (const v of Object.values(e)) {
        if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('decodes IONUTC into RINEX-header iono corrections and leap seconds', () => {
    // convbin header: GPSA .2980D-07 .7451D-08 -.1788D-06 .0000D+00,
    // GPSB .1331D+06 .0000D+00 -.2621D+06 .2621D+06, LEAP SECONDS 18.
    const a = res.ionoCorrections['GPSA']!;
    const b = res.ionoCorrections['GPSB']!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Klobuchar SIS quantization: α in units of 2^-30 s, β of 2^11 s.
    expect(a[0]).toBe(32 * 2 ** -30);
    expect(a[1]).toBe(8 * 2 ** -30);
    expect(a[2]).toBe(-192 * 2 ** -30);
    expect(a[3]).toBe(0);
    expect(b).toEqual([65 * 2 ** 11, 0, -128 * 2 ** 11, 128 * 2 ** 11]);
    expect(res.leapSeconds).toBe(18);
  });
});

/* ================================================================== */
/*  Synthetic frames — QZSSEPHEMERIS has no public capture or RTKLIB   */
/*  oracle, and the week/timescale edge cases need chosen values.      */
/* ================================================================== */

/** Wrap a payload in an OEM4 binary frame (28-byte header + CRC32). */
function buildFrame(
  id: number,
  week: number,
  towMs: number,
  payload: Uint8Array
): Uint8Array {
  const buf = new Uint8Array(28 + payload.length + 4);
  const view = new DataView(buf.buffer);
  buf[0] = 0xaa;
  buf[1] = 0x44;
  buf[2] = 0x12;
  buf[3] = 28; // header length
  view.setUint16(4, id, true);
  buf[6] = 0; // message type: binary, original message
  view.setUint16(8, payload.length, true);
  view.setUint16(14, week, true);
  view.setUint32(16, towMs, true);
  buf.set(payload, 28);
  view.setUint32(28 + payload.length, crc32(buf, 0, 28 + payload.length), true);
  return buf;
}

function concat(...frames: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of frames) {
    out.set(f, o);
    o += f.length;
  }
  return out;
}

class Payload {
  buf: Uint8Array;
  view: DataView;
  constructor(len: number) {
    this.buf = new Uint8Array(len);
    this.view = new DataView(this.buf.buffer);
  }
  u1(off: number, v: number) {
    this.view.setUint8(off, v);
  }
  u4(off: number, v: number) {
    this.view.setUint32(off, v, true);
  }
  r8(off: number, v: number) {
    this.view.setFloat64(off, v, true);
  }
}

/** GALEPHEMERIS payload (220 B) per RTKLIB decode_galephemerisb. */
function galPayload(opts: {
  prn: number;
  rcvFnav: 0 | 1;
  iodNav: number;
  toe: number;
  tocFnav: number;
  tocInav: number;
}): Payload {
  const p = new Payload(220);
  p.u4(0, opts.prn);
  p.u4(4, opts.rcvFnav);
  p.u4(8, opts.rcvFnav ? 0 : 1); // rcv_inav
  p.u1(12, 3); // svh_e1b
  p.u1(13, 1); // svh_e5a
  p.u1(14, 2); // svh_e5b
  p.u1(15, 1); // dvs_e1b
  p.u1(16, 0); // dvs_e5a
  p.u1(17, 1); // dvs_e5b
  p.u1(18, 107); // SISA index
  p.u4(20, opts.iodNav);
  p.u4(24, opts.toe);
  p.r8(28, 5440.6); // sqrtA
  p.r8(36, 3.62e-9); // deltaN
  p.r8(44, 0.247); // m0
  p.r8(52, 4.33e-4); // e
  p.r8(60, 0.8687); // omega
  p.r8(68, 1.55e-6); // cuc
  p.r8(76, 4.57e-6); // cus
  p.r8(84, 241.78); // crc
  p.r8(92, 38.16); // crs
  p.r8(100, 1.86e-8); // cic
  p.r8(108, 1.3e-8); // cis
  p.r8(116, 0.9642); // i0
  p.r8(124, 1.79e-10); // idot
  p.r8(132, 0.9312); // omega0
  p.r8(140, -5.81e-9); // omegaDot
  p.u4(148, opts.tocFnav);
  p.r8(152, 1.5e-4); // af0 fnav
  p.r8(160, 2.5e-12); // af1 fnav
  p.r8(168, 3.5e-19); // af2 fnav
  p.u4(176, opts.tocInav);
  p.r8(180, 2.07e-4); // af0 inav
  p.r8(188, 2.83e-12); // af1 inav
  p.r8(196, 4.5e-19); // af2 inav
  p.r8(204, -2.1e-9); // BGD E5a/E1
  p.r8(212, -3.03e-9); // BGD E5b/E1
  return p;
}

describe('parseNovatelNav (synthetic frames)', () => {
  const WEEK = 2359;

  it('decodes a synthetic QZSSEPHEMERIS (layout: OEM7 manual §3.150)', () => {
    const p = new Payload(228);
    const A = 42164200.5;
    p.u4(0, 194); // PRN
    p.r8(4, 512010); // tow
    p.u4(12, 0x41); // health: 6-bit code 1 + alert flag (bit 6)
    p.u4(16, 121); // IODE1
    p.u4(20, 121); // IODE2
    p.u4(24, WEEK); // full toe week
    p.u4(28, WEEK % 1024); // z-count week
    p.r8(32, 514800); // toe
    p.r8(40, A); // semi-major axis in METRES (not sqrtA)
    p.r8(48, 2.49e-9); // deltaN
    p.r8(56, -3.13); // m0
    p.r8(64, 7.61e-2); // e
    p.r8(72, -1.586); // omega
    p.r8(80, 3.11e-5); // cuc
    p.r8(88, -7.43e-6); // cus
    p.r8(96, 420.75); // crc
    p.r8(104, 1023.97); // crs
    p.r8(112, 4.3e-7); // cic
    p.r8(120, -8.2e-8); // cis
    p.r8(128, 0.7306); // i0
    p.r8(136, 3.74e-10); // idot
    p.r8(144, 0.6785); // omega0
    p.r8(152, -2.86e-9); // omegaDot
    p.u4(160, 889); // IODC
    p.r8(164, 514800); // toc
    p.r8(172, -5.59e-9); // tgd
    p.r8(180, -1.13e-7); // af0
    p.r8(188, -1.14e-13); // af1
    p.r8(196, 2.5e-20); // af2
    p.u4(204, 0); // AS
    p.r8(208, 1.46e-4); // corrected mean motion (unused)
    p.r8(216, 61.47); // URA variance (unused)
    p.u1(224, 1); // fit interval

    const res = parseNovatelNav(buildFrame(1336, WEEK, 512010000, p.buf));
    expect(res.ephemerides.length).toBe(1);
    const j = res.ephemerides[0] as KeplerEphemeris;
    expect(j.system).toBe('J');
    expect(j.prn).toBe('J02'); // PRN 194 → J02
    expect(j.week).toBe(WEEK);
    expect(j.toe).toBe(514800);
    expect(j.tocDate.getTime()).toBe(
      Date.UTC(1980, 0, 6) + (WEEK * 604800 + 514800) * 1000
    );
    // Same (Unix-week) convention as parseNavFile's toc field.
    expect(j.toc).toBe((j.tocDate.getTime() / 1000) % 604800);
    expect(j.iode).toBe(121);
    expect(j.svHealth).toBe(1); // alert bit masked off
    expect(j.sqrtA).toBe(Math.sqrt(A)); // A (m) → sqrtA
    expect(j.deltaN).toBe(2.49e-9);
    expect(j.m0).toBe(-3.13);
    expect(j.e).toBe(7.61e-2);
    expect(j.omega).toBe(-1.586);
    expect(j.cuc).toBe(3.11e-5);
    expect(j.cus).toBe(-7.43e-6);
    expect(j.crc).toBe(420.75);
    expect(j.crs).toBe(1023.97);
    expect(j.cic).toBe(4.3e-7);
    expect(j.cis).toBe(-8.2e-8);
    expect(j.i0).toBe(0.7306);
    expect(j.idot).toBe(3.74e-10);
    expect(j.omega0).toBe(0.6785);
    expect(j.omegaDot).toBe(-2.86e-9);
    expect(j.tgd).toBe(-5.59e-9);
    expect(j.af0).toBe(-1.13e-7);
    expect(j.af1).toBe(-1.14e-13);
    expect(j.af2).toBe(2.5e-20);
  });

  it('folds a QZSS toc across the week boundary from the toe', () => {
    const p = new Payload(228);
    p.u4(0, 193);
    p.u4(12, 0);
    p.u4(16, 5);
    p.u4(24, WEEK);
    p.r8(32, 604200); // toe near end of week
    p.r8(40, 42164200);
    p.r8(164, 600); // toc just past the rollover → next week
    const res = parseNovatelNav(buildFrame(1336, WEEK, 604200000, p.buf));
    const j = res.ephemerides[0] as KeplerEphemeris;
    expect(j.tocDate.getTime()).toBe(
      Date.UTC(1980, 0, 6) + ((WEEK + 1) * 604800 + 600) * 1000
    );
  });

  it('rejects QZSS PRNs outside 193-202', () => {
    const p = new Payload(228);
    p.u4(0, 32);
    expect(
      parseNovatelNav(buildFrame(1336, WEEK, 1000, p.buf)).ephemerides.length
    ).toBe(0);
  });

  it('selects the Galileo clock set from the data-source flag', () => {
    const inav = galPayload({
      prn: 5,
      rcvFnav: 0,
      iodNav: 77,
      toe: 237600,
      tocFnav: 236400,
      tocInav: 237000,
    });
    const fnav = galPayload({
      prn: 5,
      rcvFnav: 1,
      iodNav: 77,
      toe: 237600,
      tocFnav: 236400,
      tocInav: 237000,
    });
    const res = parseNovatelNav(
      concat(
        buildFrame(1122, WEEK, 238000000, inav.buf),
        buildFrame(1122, WEEK, 238000000, fnav.buf)
      )
    );
    // Distinct data sources are separate records (RTKLIB ephset slots).
    expect(res.ephemerides.length).toBe(2);
    const [i, f] = res.ephemerides as KeplerEphemeris[];
    expect(i!.prn).toBe('E05');
    const sow = (s: number) =>
      (((Date.UTC(1980, 0, 6) / 1000 + WEEK * 604800 + s) % 604800) + 604800) %
      604800;
    expect(i!.af0).toBe(2.07e-4); // I/NAV clock set
    expect(i!.af1).toBe(2.83e-12);
    expect(i!.toc).toBe(sow(237000));
    expect(i!.tocDate.getTime()).toBe(
      Date.UTC(1980, 0, 6) + (WEEK * 604800 + 237000) * 1000
    );
    expect(f!.af0).toBe(1.5e-4); // F/NAV clock set
    expect(f!.af1).toBe(2.5e-12);
    expect(f!.toc).toBe(sow(236400));
    // Both carry the same broadcast orbit, radians as-is, and the
    // RINEX SVH bit packing (E5b HS=2,DVS=1|E5a HS=1,DVS=0|E1B HS=3,DVS=1).
    for (const e of [i!, f!]) {
      expect(e.iode).toBe(77);
      expect(e.week).toBe(WEEK);
      expect(e.toe).toBe(237600);
      expect(e.sqrtA).toBe(5440.6);
      expect(e.m0).toBe(0.247);
      expect(e.tgd).toBe(-2.1e-9); // BGD E5a/E1
      expect(e.svHealth).toBe(
        (2 << 7) | (1 << 6) | (1 << 4) | (0 << 3) | (3 << 1) | 1
      );
    }
  });

  it('adjusts the Galileo toe week against the header time', () => {
    // Header very early in week N ⇒ a large toe belongs to week N−1.
    const p = galPayload({
      prn: 12,
      rcvFnav: 0,
      iodNav: 10,
      toe: 600000,
      tocFnav: 600000,
      tocInav: 600000,
    });
    const res = parseNovatelNav(buildFrame(1122, WEEK, 10000000, p.buf));
    const e = res.ephemerides[0] as KeplerEphemeris;
    expect(e.week).toBe(WEEK - 1);
    expect(e.tocDate.getTime()).toBe(
      Date.UTC(1980, 0, 6) + ((WEEK - 1) * 604800 + 600000) * 1000
    );
  });

  it('de-duplicates repeated Galileo broadcasts per IODNav and set', () => {
    const p = galPayload({
      prn: 3,
      rcvFnav: 0,
      iodNav: 20,
      toe: 237600,
      tocFnav: 237600,
      tocInav: 237600,
    });
    const p2 = galPayload({
      prn: 3,
      rcvFnav: 0,
      iodNav: 21, // new issue of data
      toe: 238200,
      tocFnav: 238200,
      tocInav: 238200,
    });
    const res = parseNovatelNav(
      concat(
        buildFrame(1122, WEEK, 238000000, p.buf),
        buildFrame(1122, WEEK, 238030000, p.buf), // repeat — suppressed
        buildFrame(1122, WEEK, 238630000, p2.buf)
      )
    );
    expect(res.ephemerides.length).toBe(2);
    expect((res.ephemerides[1] as KeplerEphemeris).iode).toBe(21);
  });

  it('keeps synthetic BDSEPHEMERIS on the BDT scale and de-duplicates', () => {
    const mk = (toe: number, toc: number) => {
      const p = new Payload(196);
      p.u4(0, 26); // PRN C26
      p.u4(4, 1003); // BDT week
      p.r8(8, 2.0); // URA (m)
      p.u4(16, 1); // health1
      p.r8(20, -5.2e-9); // TGD1
      p.r8(28, -9.7e-9); // TGD2
      p.u4(36, 1); // AODC
      p.u4(40, toc);
      p.r8(44, -3.3e-4); // af0
      p.r8(52, 4.11e-12); // af1
      p.r8(60, 1.2e-19); // af2
      p.u4(68, 2); // AODE
      p.u4(72, toe);
      p.r8(76, 5282.6); // sqrtA
      p.r8(84, 5.5e-4); // e
      p.r8(92, -1.482); // omega
      p.r8(100, -3.2e-9); // deltaN
      p.r8(108, 0.7594); // m0
      p.r8(116, -2.198); // omega0
      p.r8(124, 4.13e-9); // omegaDot
      p.r8(132, 0.9605); // i0
      p.r8(140, 1.06e-10); // idot
      p.r8(148, 5.89e-6); // cuc
      p.r8(156, -2.6e-5); // cus
      p.r8(164, 797.17); // crc
      p.r8(172, 173.7); // crs
      p.r8(180, 2.01e-7); // cic
      p.r8(188, 1.47e-7); // cis
      return p;
    };
    const res = parseNovatelNav(
      concat(
        buildFrame(1696, 2359, 100000000, mk(270000, 270000).buf),
        buildFrame(1696, 2359, 100030000, mk(270000, 270000).buf), // repeat
        buildFrame(1696, 2359, 103630000, mk(273600, 273600).buf)
      )
    );
    expect(res.ephemerides.length).toBe(2);
    const c = res.ephemerides[0] as KeplerEphemeris;
    expect(c.prn).toBe('C26');
    expect(c.week).toBe(1003); // BDT week, not GPS
    expect(c.toe).toBe(270000); // BDT seconds of week
    // BDT calendar epoch (naive Date, like a parsed RINEX BDS record)
    expect(c.tocDate.getTime()).toBe(
      Date.UTC(2006, 0, 1) + (1003 * 604800 + 270000) * 1000
    );
    expect(c.iode).toBe(2); // AODE
    expect(c.svHealth).toBe(1); // SatH1
    expect(c.tgd).toBe(-5.2e-9); // TGD1
    expect(c.af0).toBe(-3.3e-4);
    expect(c.sqrtA).toBe(5282.6);
    expect(c.i0).toBe(0.9605);
  });

  it('decodes a synthetic IONUTC (last message wins)', () => {
    const mk = (a0: number, dtls: number) => {
      const p = new Payload(108);
      p.r8(0, a0);
      p.r8(8, 7.45e-9);
      p.r8(16, -1.79e-7);
      p.r8(24, 1.19e-7);
      p.r8(32, 133120);
      p.r8(40, 0);
      p.r8(48, -262144);
      p.r8(56, 262144);
      p.u4(64, 2185); // WNt
      p.u4(68, 405504); // tot
      p.r8(72, -9.3e-10); // A0
      p.r8(80, -2.66e-15); // A1
      p.u4(88, 1929); // WN_LSF
      p.u4(92, 7); // DN
      p.view.setInt32(96, dtls, true); // Δt_LS
      p.view.setInt32(100, dtls, true); // Δt_LSF
      return p;
    };
    const res = parseNovatelNav(
      concat(
        buildFrame(8, 2359, 100000000, mk(1.0e-8, 17).buf),
        buildFrame(8, 2359, 200000000, mk(2.98e-8, 18).buf)
      )
    );
    expect(res.ionoCorrections['GPSA']).toEqual([
      2.98e-8, 7.45e-9, -1.79e-7, 1.19e-7,
    ]);
    expect(res.ionoCorrections['GPSB']).toEqual([133120, 0, -262144, 262144]);
    expect(res.leapSeconds).toBe(18);
  });

  it('decodes a RAWSBASFRAME type-9 GEO message to a geostationary orbit', () => {
    // A real SBAS L1 message type 9 (29 bytes, PRN 144) carved from the
    // DLF500 SBF capture, re-wrapped in an OEM4 RAWSBASFRAME (id 973):
    // frame-decoder u4, PRN u4, a u4, then the 29-byte message.
    const mt9 = Uint8Array.from(
      Buffer.from(
        'c624f0401e2b940bb3ddded5a0f9e53081afbcfc9888fc3eefbc1f8011',
        'hex'
      )
    );
    const p = new Payload(41);
    p.u4(0, 3); // frame-decoder number
    p.u4(4, 144); // SBAS PRN → S44
    p.u4(8, 0); // reserved
    p.buf.set(mt9, 12);

    // Non–type-9 messages (here a type-2 fast-correction frame) are ignored.
    const other = new Payload(41);
    other.u4(4, 131);
    other.buf[12] = 0xc6; // preamble
    other.buf[13] = 0x08; // message type 2 in bits 8-13

    const res = parseNovatelNav(
      concat(
        buildFrame(287, WEEK, 512000000, other.buf), // RAWWAASFRAME twin
        buildFrame(973, WEEK, 512000000, p.buf)
      )
    );
    const geo = res.ephemerides.filter(
      (e) => e.prn[0] === 'S'
    ) as GlonassEphemeris[];
    expect(geo).toHaveLength(1);
    expect(geo[0]!.prn).toBe('S44');
    expect(geo[0]!.system).toBe('S');
    const r = Math.hypot(geo[0]!.x, geo[0]!.y, geo[0]!.z); // km
    expect(r).toBeGreaterThan(42000); // geostationary radius ≈ 42 164 km
    expect(r).toBeLessThan(42300);
    expect(geo[0]!.freqNum).toBe(0);
  });
});

/**
 * RAWCNAVFRAME (1066) has no public capture; the container layout is
 * the OEM7 manual §3.165 (signal channel U4, PRN U4, frame ID U4,
 * 38-byte raw CNAV message). Rather than synthesizing field values,
 * these tests wrap the REAL oracle-validated L2C messages from the
 * committed SBF fixture in synthetic NovAtel frames: the payload is
 * genuine broadcast data, only the container is constructed, and the
 * decode must equal parseSbfCnav's output for the same bits.
 */
describe.skipIf(!existsSync(SBF_CNAV_FILE))(
  'parseNovatelNav RAWCNAVFRAME (real payload, synthetic container)',
  () => {
    const buildFrame = (payload: Uint8Array): Uint8Array => {
      const frame = new Uint8Array(28 + payload.length + 4);
      const dv = new DataView(frame.buffer);
      frame.set([0xaa, 0x44, 0x12, 28]);
      dv.setUint16(4, 1066, true);
      frame[6] = 0x00; // binary format
      dv.setUint16(8, payload.length, true);
      dv.setUint16(14, 2428, true);
      dv.setUint32(16, 355_200_000, true);
      frame.set(payload, 28);
      dv.setUint32(
        28 + payload.length,
        crc32(frame, 0, 28 + payload.length),
        true
      );
      return frame;
    };

    const sbfBytes = existsSync(SBF_CNAV_FILE)
      ? new Uint8Array(readFileSync(SBF_CNAV_FILE))
      : new Uint8Array(0);

    // Extract the raw 300-bit L2C messages from the SBF blocks the
    // same way src/sbf/rawnav.ts does, then wrap each in a 1066 frame.
    const messages: Uint8Array[] = [];
    if (sbfBytes.length > 0) {
      const view = new DataView(
        sbfBytes.buffer,
        sbfBytes.byteOffset,
        sbfBytes.byteLength
      );
      scanSbfFrames(sbfBytes, view, (id, b, len) => {
        if (id !== 4018 || len < 60) return; // GPSRawL2C only
        const msg = new Uint8Array(38);
        for (let k = 0; k < 10; k++) {
          const w = view.getUint32(b + 20 + 4 * k, true);
          for (let j = 0; j < 4; j++) {
            const idx = 4 * k + (3 - j);
            if (idx < 38) msg[idx] = (w >>> (8 * j)) & 0xff;
          }
        }
        messages.push(msg);
      });
    }

    it('assembles the same ephemerides as the SBF path from the same bits', () => {
      expect(messages.length).toBeGreaterThan(10);
      const stream = new Uint8Array(
        messages.reduce((a, m) => a + 28 + 50 + 4 - 38 + m.length, 0)
      );
      let o = 0;
      for (const msg of messages) {
        const payload = new Uint8Array(50);
        const pdv = new DataView(payload.buffer);
        pdv.setUint32(0, 0, true); // signal channel
        pdv.setUint32(4, getBitU(msg, 8, 6), true); // PRN
        pdv.setUint32(8, getBitU(msg, 14, 6), true); // frame/message type
        payload.set(msg, 12);
        const f = buildFrame(payload);
        stream.set(f, o);
        o += f.length;
      }

      const nov = parseNovatelNav(stream.subarray(0, o));
      expect(nov.badCrc).toBe(0);
      expect(nov.cnavBadCrc).toBe(0);

      const sbf = parseSbfCnav(sbfBytes).ephemerides.filter(
        (e) => e.signal === 'L2C'
      );
      expect(nov.cnav.length).toBe(sbf.length);
      for (let i = 0; i < sbf.length; i++) {
        const a = nov.cnav[i]! as unknown as Record<string, unknown>;
        const b = sbf[i]! as unknown as Record<string, unknown>;
        for (const k of Object.keys(a)) {
          if (k === 'signal') continue;
          const va = a[k];
          const vb = b[k];
          if (va instanceof Date) {
            expect((vb as Date).getTime(), k).toBe(va.getTime());
          } else {
            expect(vb, `${sbf[i]!.prn} ${k}`).toStrictEqual(va);
          }
        }
      }
    });

    it('counts and drops corrupted messages via CRC-24Q', () => {
      const msg = messages[0]!;
      const bad = new Uint8Array(msg);
      bad[20] ^= 0x40;
      const payload = new Uint8Array(50);
      new DataView(payload.buffer).setUint32(4, getBitU(bad, 8, 6), true);
      payload.set(bad, 12);
      const res = parseNovatelNav(buildFrame(payload));
      expect(res.cnavBadCrc).toBe(1);
      expect(res.cnav.length).toBe(0);
    });
  }
);
