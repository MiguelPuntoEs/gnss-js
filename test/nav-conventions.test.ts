/**
 * Convention locks for broadcast ephemerides, across every decoder:
 * the time scales and units of the epoch fields, checked against the
 * specifications (IS-GPS-200 t_oc, RINEX 3.05 Tables A6-A18, RTCM
 * 10403.3 §3.5.7-3.5.12) with values whose physical meaning is known.
 */
import { describe, expect, it } from 'vitest';
import type { Ephemeris, KeplerEphemeris } from '../src/rinex/nav';
import { parseNavFile } from '../src/rinex/nav';
import { navSecondsOfWeek } from '../src/navbits/index';
import {
  encodeEphemeris,
  ephemerisToInfo,
} from '../src/rtcm3/ephemeris-encode';
import { decodeEphemeris } from '../src/rtcm3/ephemeris';
import { Rtcm3Decoder } from '../src/rtcm3/decoder';
import { ephInfoToEphemeris } from '../src/orbit';
import { hasFixture, rawSources, readText, rinexSources } from './nav-sources';

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
      // RTCM 1042 BeiDou epochs: see the BDT clock-face lock below.
      const list = sources[key]!.filter(
        (e) => isKepler(e) && !(key === 'rtcm3' && e.system === 'C')
      ) as KeplerEphemeris[];
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
