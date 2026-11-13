/**
 * Convention locks for broadcast ephemerides, across every decoder:
 * the time scales and units of the epoch fields, checked against the
 * specifications (IS-GPS-200 t_oc, RINEX 3.05 Tables A6-A18, RTCM
 * 10403.3 §3.5.7-3.5.12) with values whose physical meaning is known.
 */
import { describe, expect, it } from 'vitest';
import type {
  Ephemeris,
  GlonassEphemeris,
  KeplerEphemeris,
} from '../src/rinex/nav';
import { satClockCorrection } from '../src/positioning';
import { gloFrameTimeOfWeek, parseNavFile } from '../src/rinex/nav';
import { navSecondsOfWeek } from '../src/navbits/index';
import {
  encodeEphemeris,
  ephemerisToInfo,
} from '../src/rtcm3/ephemeris-encode';
import { decodeEphemeris } from '../src/rtcm3/ephemeris';
import { Rtcm3Decoder } from '../src/rtcm3/decoder';
import { computeSatPosition, ephInfoToEphemeris } from '../src/orbit';
import { hasFixture, rawSources, readText, rinexSources } from './nav-sources';
import { gpsInstant } from './nav-compare';

const isKepler = (e: Ephemeris): e is KeplerEphemeris => 'toe' in e;

/** Signed difference of two seconds-of-week values, folded to ±½ week. */
const wrapSow = (d: number) =>
  ((((d + 302400) % 604800) + 604800) % 604800) - 302400;

describe('toc is seconds of the GNSS week (IS-GPS-200 t_oc)', () => {
  it('counts from Sunday 00:00, not from the Unix epoch (a Thursday)', () => {
    // 2026-01-01 is a Thursday: 4 days into GPS week 2399.
    expect(navSecondsOfWeek(Date.UTC(2026, 0, 1))).toBe(4 * 86400);
    expect(navSecondsOfWeek(Date.UTC(2026, 0, 4))).toBe(0); // Sunday
    expect(navSecondsOfWeek(Date.UTC(2026, 0, 3, 23, 59, 59))).toBe(604799);
    // Before the GPS epoch still folds into [0, 604800).
    expect(navSecondsOfWeek(Date.UTC(1980, 0, 5))).toBe(6 * 86400);
  });

  const sources = { ...rawSources(), ...rinexSources() };

  it.each(Object.keys(sources))(
    '%s: toc agrees with tocDate and, as broadcast, with toe',
    (key) => {
      const list = sources[key]!.filter(isKepler);
      if (list.length === 0) return; // state-vector-only source
      for (const e of list) {
        expect(e.toc, e.prn).toBe(navSecondsOfWeek(e.tocDate.getTime()));
      }
      // Broadcast LNAV/INAV/D1D2 sets carry toc = toe; the old
      // Unix-epoch count was 259200 s (3 days) off on every record.
      const equal = list.filter((e) => wrapSow(e.toc - e.toe) === 0);
      expect(equal.length / list.length).toBeGreaterThan(0.99);
    }
  );

  it.skipIf(!hasFixture('brdc_v3_igs.nav'))(
    'RINEX 3 G01/E02/C01 records: toc equals the printed toe',
    () => {
      const nav = parseNavFile(readText('brdc_v3_igs.nav'));
      const first = (prn: string) =>
        nav.ephemerides.find((e) => e.prn === prn) as KeplerEphemeris;
      // G01 2026 01 01 00 00 00 … toe 3.456000000000E+05
      expect(first('G01').toc).toBe(345600);
      expect(first('G01').toe).toBe(345600);
      // E02 2025 12 31 23 30 00 … toe 3.438000000000E+05 (GST week)
      expect(first('E02').toc).toBe(343800);
      expect(first('E02').toe).toBe(343800);
      // C01 2026 01 01 00 00 00 (BDT clock face) … toe 3.456000000000E+05
      expect(first('C01').toc).toBe(345600);
      expect(first('C01').toe).toBe(345600);
    }
  );

  it.skipIf(!hasFixture('brdc_v3_igs.nav'))(
    'RINEX → RTCM 1019/1044/1046 → Ephemeris keeps the clock epoch',
    () => {
      // ephemerisToInfo sends `toc` as the RTCM t_oc field: with the
      // Unix-epoch count the decoded clock epoch moved by +3 or −4 days.
      const nav = parseNavFile(readText('brdc_v3_igs.nav'));
      for (const sys of ['G', 'J', 'E'] as const) {
        const list = nav.ephemerides.filter((e) => e.system === sys);
        for (const e of list.slice(0, 20)) {
          const bytes = encodeEphemeris(ephemerisToInfo(e))!;
          const frame = new Rtcm3Decoder().decode(bytes)[0]!;
          const back = ephInfoToEphemeris({
            ...decodeEphemeris(frame)!,
            lastReceived: e.tocDate.getTime(),
          })!;
          expect(back.tocDate.toISOString(), e.prn).toBe(
            e.tocDate.toISOString()
          );
        }
      }
    }
  );
});

describe('BeiDou epochs are on the BDT clock face (RINEX 3.05 Table A14)', () => {
  const rtcm = rawSources()['rtcm3'] ?? [];

  it('RTCM 1042 → Ephemeris: tocDate is BDT, as in RINEX and RTKLIB', () => {
    // RTKLIB 2.4.2p13 convbin, same capture (test-fixtures/convbin/):
    //   C10 2026 11  6  9  0  0 -.875937752426E-03 …
    const c10 = rtcm.find((e) => e.prn === 'C10') as KeplerEphemeris;
    expect(c10.tocDate.toISOString()).toBe('2026-11-06T09:00:00.000Z');
    expect(c10.toc).toBe(c10.toe); // 464400 s of BDT week 1087
    expect(c10.week).toBe(1087);
    for (const e of rtcm.filter((x) => x.system === 'C'))
      expect(e.tocDate.getUTCSeconds(), e.prn).toBe(0);
  });

  it('round-trips a BDT week-start epoch through RTCM 1042', () => {
    // toc = 0: on the GPS-scale axis the epoch is 14 s before the BDT
    // week boundary, so the week went one low and the clock epoch moved
    // back seven days.
    const c = rtcm.find((e) => e.system === 'C') as KeplerEphemeris;
    const start: KeplerEphemeris = {
      ...c,
      tocDate: new Date(Date.UTC(2026, 10, 8)), // Sunday 00:00 BDT
      toc: 0,
      toe: 0,
      week: 1088,
    };
    const back = ephInfoToEphemeris({
      ...decodeEphemeris(
        new Rtcm3Decoder().decode(encodeEphemeris(ephemerisToInfo(start))!)[0]!
      )!,
      lastReceived: start.tocDate.getTime(),
    }) as KeplerEphemeris;
    expect(back.week).toBe(1088);
    expect(back.tocDate.toISOString()).toBe('2026-11-08T00:00:00.000Z');
  });
});

describe('GLONASS message frame time (RINEX 3.05 Table A10)', () => {
  it.skipIf(!hasFixture('brdc_v2_glo.nav'))(
    'RINEX 2 t_k (seconds of day) is read as seconds of the UTC week',
    () => {
      // brdc_v2_glo.nav: " 1 26  1  1  2 45  0.0 … 0.900000000000D+04":
      // R01 at 02:45 UTC Thursday, frame 02:30 of the day (2.11 Table
      // A11). RINEX 3/4 and every decoder hold tk + nd·86400 in seconds
      // of the week: 4·86400 + 9000. Kept raw, a 2.11 → 3.04 conversion
      // wrote 9000 into the 3.04 field ("Sunday 02:30").
      const nav = parseNavFile(readText('brdc_v2_glo.nav'));
      const r01 = nav.ephemerides.find(
        (e) =>
          e.prn === 'R01' && e.tocDate.getTime() === Date.UTC(2026, 0, 1, 2, 45)
      ) as GlonassEphemeris;
      expect(r01.messageFrameTime).toBe(354600);
      // Same record in the RINEX 3.04 IGS file of the same day
      if (hasFixture('brdc_v3_igs.nav')) {
        const v3 = parseNavFile(readText('brdc_v3_igs.nav'));
        const same = v3.ephemerides.find(
          (e) =>
            e.prn === 'R01' && e.tocDate.getTime() === r01.tocDate.getTime()
        ) as GlonassEphemeris;
        expect(same.messageFrameTime).toBe(354600);
      }
      // A frame of the previous UTC day: epoch 00:15, t_k 23:45 → Wed
      expect(gloFrameTimeOfWeek(Date.UTC(2026, 0, 1, 0, 15), 85500)).toBe(
        3 * 86400 + 85500
      );
      // … and across the week boundary: Sun 00:15, t_k Sat 23:45
      expect(gloFrameTimeOfWeek(Date.UTC(2026, 0, 4, 0, 15), 85500)).toBe(
        6 * 86400 + 85500
      );
    }
  );

  it('RTCM 1020 tk becomes the UTC seconds-of-week frame time', () => {
    // RTKLIB 2.4.2p13 convbin: R 3 2026 11  6  9 15  0 … .465240000000E+06
    // = Friday 09:14:00 UTC (tk), 60 s before tb.
    const r03 = (rawSources()['rtcm3'] ?? []).find((e) => e.prn === 'R03');
    expect(r03).toBeDefined();
    expect((r03 as { messageFrameTime: number }).messageFrameTime).toBe(465240);
  });
});

describe('satellite clock: tocDate time scale (BDT, UTC) vs GPS-scale t', () => {
  // satClockCorrection takes GPS-scale time, like computeSatPosition.
  // Asymmetric, exaggerated drifts so a 14 s / 18 s slip is visible.
  const bds: KeplerEphemeris = {
    system: 'C',
    prn: 'C24',
    tocDate: new Date(Date.UTC(2026, 10, 6, 9)), // 09:00:00 BDT
    toc: 464400,
    toe: 464400,
    week: 1087,
    af0: -8.7e-4,
    af1: 2.5e-9,
    af2: 0,
    iode: 1,
    crs: 0,
    deltaN: 0,
    m0: 0,
    cuc: 0,
    e: 0, // no relativistic term: the polynomial alone
    cus: 0,
    sqrtA: 5282.6,
    cic: 0,
    omega0: 0,
    cis: 0,
    i0: 0.96,
    crc: 0,
    omega: 0,
    omegaDot: 0,
    idot: 0,
    svHealth: 0,
    tgd: 0,
  };

  it('BeiDou: at toc (= GPST 09:00:14) the correction is af0', () => {
    const tocGps = Date.UTC(2026, 10, 6, 9, 0, 14);
    expect(satClockCorrection(bds, tocGps)).toBe(bds.af0);
    // 100 s later on either axis: af0 + af1·100
    expect(satClockCorrection(bds, tocGps + 100_000)).toBeCloseTo(
      bds.af0 + bds.af1 * 100,
      15
    );
  });

  it('GLONASS: at toc (UTC 09:15, = GPST 09:15:18) the correction is −τn', () => {
    const glo: GlonassEphemeris = {
      system: 'R',
      prn: 'R03',
      tocDate: new Date(Date.UTC(2026, 10, 6, 9, 15)),
      tauN: 2.766e-5,
      gammaN: 3.1e-9,
      messageFrameTime: 465240,
      x: 12128.4,
      xDot: 0.31,
      xAcc: 0,
      y: 22295.5,
      yDot: 0.17,
      yAcc: 0,
      z: 2178.2,
      zDot: -3.58,
      zAcc: 0,
      health: 0,
      freqNum: 5,
    };
    const tocGps = Date.UTC(2026, 10, 6, 9, 15, 18);
    expect(satClockCorrection(glo, tocGps)).toBe(glo.tauN);
  });
});

describe('broadcast clock sign and unit vs ESA MGEX SP3 clocks', () => {
  // SP3 clock column: satellite clock − GPST in µs (sp3d §5). The
  // broadcast correction must match it to tens of ns — an af0 / −τn sign
  // flip is off by 2|af0| (tens to hundreds of µs), a unit slip by 10^6.
  const has = hasFixture('ESA_MGEX.sp3') && hasFixture('BRDC.nav');
  const T = Date.UTC(2024, 0, 1, 12); // GPST
  const sp3 = new Map<string, { pos: number[]; clk: number }>();
  if (has) {
    let on = false;
    for (const l of readText('ESA_MGEX.sp3').split('\n')) {
      if (l.startsWith('*')) on = l.startsWith('*  2024  1  1 12  0 ');
      else if (on && l.startsWith('P')) {
        const clk = Number(l.substring(46, 60));
        const pos = [4, 18, 32].map(
          (c) => Number(l.substring(c, c + 14)) * 1e3
        );
        if (Math.abs(clk) < 999999)
          sp3.set(l.slice(1, 4), { pos, clk: clk * 1e-6 });
      }
    }
  }
  const nav = has ? parseNavFile(readText('BRDC.nav')) : null!;

  it.skipIf(!has).each([
    ['G', 100e-9],
    ['E', 100e-9],
    ['C', 100e-9],
    // GLONASS: −τn is relative to GLONASS time; SP3 to GPST, so the
    // GLONASS−GPS time offset (≲ 1 µs) remains — still 100× smaller
    // than a sign flip of τn.
    ['R', 1e-6],
  ] as const)('%s', (sys, tol) => {
    let big = 0;
    for (const [prn, truth] of sp3) {
      if (prn[0] !== sys) continue;
      if (sys === 'C' && Number(prn.slice(1)) < 19) continue; // BDS-3 only
      // The ephemeris of this satellite nearest in time whose orbit
      // matches the SP3 position (the merged BRDC.nav has GLONASS
      // records filed under the wrong slot, e.g. R16/R18 at 11:15).
      let best: { e: Ephemeris; dt: number } | null = null;
      for (const e of nav.ephemerides) {
        if (e.prn !== prn) continue;
        const dt = Math.abs(gpsInstant(e) - T);
        if (dt > 3600_000 || ('svHealth' in e ? e.svHealth : e.health) !== 0)
          continue;
        const p = computeSatPosition(e, T);
        const d = Math.hypot(
          p.x - truth.pos[0]!,
          p.y - truth.pos[1]!,
          p.z - truth.pos[2]!
        );
        if (d < 100 && (!best || dt < best.dt)) best = { e, dt };
      }
      if (!best) continue;
      const bc = satClockCorrection(best.e, T);
      expect(
        Math.abs(bc - truth.clk),
        `${prn} ${bc} vs ${truth.clk}`
      ).toBeLessThan(tol);
      if (Math.abs(truth.clk) > 20 * tol) big++;
    }
    expect(big).toBeGreaterThan(3); // a sign flip would show
  });
});

describe('BeiDou D1/D2 IODE slot = broadcast AODE (RINEX 3.05 Table A14)', () => {
  it('every decoder gives 0-31, and RTCM 1042 can carry it', () => {
    // u-blox / SBF raw D1/D2 used demo5's toc/720 mod 240 (105, 130):
    // out of the AODE range RINEX documents, unlike every other source,
    // and RTCM 1042's 5-bit AODE field threw a RangeError on encode.
    // RTKLIB 2.4.2p13 convbin, f9p_sfrbx_slice.ubx: "C 8 … .100000000000E+01".
    const all = { ...rawSources(), ...rinexSources() };
    for (const [key, list] of Object.entries(all))
      for (const e of list.filter(
        (x) => x.system === 'C'
      ) as KeplerEphemeris[]) {
        expect(e.iode, `${key} ${e.prn}`).toBeGreaterThanOrEqual(0);
        expect(e.iode, `${key} ${e.prn}`).toBeLessThanOrEqual(31);
      }
    const c08 = (all['ubx:f9p_sfrbx_slice.ubx'] ?? []).find(
      (e) => e.prn === 'C08'
    ) as KeplerEphemeris;
    expect(c08.iode).toBe(1);
    expect(() => encodeEphemeris(ephemerisToInfo(c08))).not.toThrow();
  });
});

describe('cross-decoder: the same satellite, two receivers, one orbit', () => {
  it('every Keplerian ephemeris agrees with another decoder within 1 km', () => {
    // Independent decoders of the same broadcast (u-blox, Septentrio,
    // NovAtel, Trimble, RTCM) must put a satellite at the same place:
    // a mis-read toe/time scale shows as hundreds of km. Pairs within
    // 2 h of each other, compared at the later epoch.
    const src = rawSources();
    const keys = Object.keys(src);
    let pairs = 0;
    for (let a = 0; a < keys.length; a++)
      for (let b = a + 1; b < keys.length; b++)
        for (const ea of src[keys[a]!]!.filter(isKepler))
          for (const eb of src[keys[b]!]!.filter(isKepler)) {
            if (ea.prn !== eb.prn) continue;
            const ta = gpsInstant(ea);
            const tb = gpsInstant(eb);
            if (Math.abs(ta - tb) > 2 * 3600_000) continue;
            const t = Math.max(ta, tb);
            const p = computeSatPosition(ea, t);
            const q = computeSatPosition(eb, t);
            const d = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
            expect(d, `${ea.prn} ${keys[a]} vs ${keys[b]}`).toBeLessThan(1000);
            pairs++;
          }
    expect(pairs).toBeGreaterThan(50);
  });

  it('Trimble RT27 Galileo toe is the broadcast toe, not the transmit time', () => {
    // RETSVDATA subtype 11: +9 = 126685 s (transmit, …:25), +15 = toe
    // 126000 = Mon 11:00 GST. With +9 as toe E04 sat 2500 km off.
    const e04 = (rawSources()['trimble'] ?? []).find(
      (e) => e.prn === 'E04'
    ) as KeplerEphemeris;
    expect(e04.toe).toBe(126000);
    expect(e04.toc).toBe(126000);
    expect(e04.ttm).toBe(126685);
    expect(e04.svAccuracy).toBeCloseTo(3.12, 10); // SISA index 107
  });
});
