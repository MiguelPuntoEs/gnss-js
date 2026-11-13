/**
 * Raw receiver data → RINEX 3.05 / 4.01 → parse → RTCM3 → decode, for
 * every ephemeris decoder (u-blox, Septentrio, NovAtel, Trimble, BINEX,
 * RTCM3): each hop keeps every field to the printed precision, and the
 * satellite position and clock to < 1 mm / < 1e-12 s.
 */
import { describe, expect, it } from 'vitest';
import { parseNavFile, type Ephemeris } from '../src/rinex/nav';
import { writeRinexNav } from '../src/rinex/nav-writer';
import { writeRinexNav4 } from '../src/rinex/nav-writer-v4';
import {
  encodeEphemeris,
  ephemerisToInfo,
} from '../src/rtcm3/ephemeris-encode';
import { decodeEphemeris } from '../src/rtcm3/ephemeris';
import { Rtcm3Decoder } from '../src/rtcm3/decoder';
import { ephInfoToEphemeris } from '../src/orbit';
import { RTCM_RECEIVED, rawSources, readBin, hasFixture } from './nav-sources';
import { expectSameEphemerides, expectSamePhysics } from './nav-compare';

const header = {
  version: 3.05,
  type: 'N',
  leapSeconds: 18,
  ionoCorrections: {},
};

/** Unique by PRN + epoch + Galileo source (RINEX holds one record each). */
function unique(list: Ephemeris[]): Ephemeris[] {
  const seen = new Map<string, Ephemeris>();
  for (const e of list)
    seen.set(
      `${e.prn}_${e.tocDate.getTime()}_${'dataSources' in e ? e.dataSources : ''}`,
      e
    );
  return [...seen.values()];
}

/** Ephemeris → RTCM3 message → Ephemeris. */
function viaRtcm(e: Ephemeris): Ephemeris | null {
  const bytes = encodeEphemeris(ephemerisToInfo(e));
  if (!bytes) return null;
  const info = decodeEphemeris(new Rtcm3Decoder().decode(bytes)[0]!);
  return (
    info && ephInfoToEphemeris({ ...info, lastReceived: e.tocDate.getTime() })
  );
}

const sources = rawSources();

describe.each(Object.keys(sources))('%s', (key) => {
  const raw = unique(sources[key]!);
  // Fields a decoder adds that are not RINEX record fields.
  const NOT_RINEX = ['source'];

  it('→ RINEX 3.05 → parse: every field', () => {
    expect(raw.length).toBeGreaterThan(0);
    const back = parseNavFile(
      writeRinexNav({ header, ephemerides: raw }, { version: '3.05' })
    );
    expectSameEphemerides(raw, back.ephemerides, 1e-12, NOT_RINEX);
    expectSamePhysics(raw, back.ephemerides);
  });

  it('→ RINEX 4.01 → parse: every field', () => {
    const back = parseNavFile(writeRinexNav4({ header, ephemerides: raw }));
    expectSameEphemerides(raw, back.ephemerides, 1e-12, NOT_RINEX);
  });

  it('→ RINEX 3.05 → RTCM3 → decode: same orbit and clock', () => {
    const rinex = parseNavFile(
      writeRinexNav({ header, ephemerides: raw }, { version: '3.05' })
    ).ephemerides;
    const rtcm = rinex.map(viaRtcm);
    const pairs = rinex
      .map((e, i) => [e, rtcm[i]] as const)
      .filter((p): p is readonly [Ephemeris, Ephemeris] => p[1] != null);
    expect(pairs.length).toBe(rinex.length);
    expectSamePhysics(
      pairs.map((p) => p[0]),
      pairs.map((p) => p[1])
    );
  });
});

describe.skipIf(!hasFixture('dlf100_rtcm_rtk_base.rtcm'))(
  'RTCM3 → RINEX 3.05 → RTCM3 is bit-exact',
  () => {
    const frames = new Rtcm3Decoder().decode(
      readBin('dlf100_rtcm_rtk_base.rtcm')
    );
    it.each([1019, 1042, 1044, 1045, 1046])('%d', (type) => {
      const msgs = frames.filter((f) => f.messageType === type);
      expect(msgs.length).toBeGreaterThan(0);
      for (const f of msgs) {
        const eph = ephInfoToEphemeris({
          ...decodeEphemeris(f)!,
          lastReceived: RTCM_RECEIVED,
        })!;
        const [rinex] = parseNavFile(
          writeRinexNav({ header, ephemerides: [eph] }, { version: '3.05' })
        ).ephemerides;
        const out = new Rtcm3Decoder().decode(
          encodeEphemeris(ephemerisToInfo(rinex!))!
        )[0]!;
        expect(out.payload, `${type} ${eph.prn}`).toEqual(f.payload);
      }
    });

    it('TGD survives RTCM → Ephemeris (single-frequency SPP needs it)', () => {
      // DF097 GPS TGD; ephInfoToEphemeris set every TGD to 0, so SPP with
      // RTCM-streamed ephemerides lost metres of L1 group delay.
      const f = frames.find((x) => x.messageType === 1019)!;
      const info = decodeEphemeris(f)!;
      const eph = ephInfoToEphemeris({ ...info, lastReceived: RTCM_RECEIVED })!;
      expect(info.tgd).not.toBe(0);
      expect((eph as { tgd: number }).tgd).toBe(info.tgd);
      const c = frames.find((x) => x.messageType === 1042)!;
      const ci = decodeEphemeris(c)!;
      const ce = ephInfoToEphemeris({ ...ci, lastReceived: RTCM_RECEIVED }) as {
        tgd: number;
        tgd2: number;
      };
      expect([ce.tgd, ce.tgd2]).toEqual([ci.tgd1, ci.tgd2]);
    });
  }
);
