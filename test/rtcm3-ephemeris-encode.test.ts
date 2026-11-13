import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { Rtcm3Decoder } from '../src/rtcm3/decoder';
import { decodeEphemeris } from '../src/rtcm3/ephemeris';
import type { EphemerisInfo } from '../src/rtcm3/ephemeris';
import {
  encodeEphemeris,
  ephemerisToInfo,
} from '../src/rtcm3/ephemeris-encode';
import { ephInfoToEphemeris } from '../src/orbit';

const frames = new Rtcm3Decoder().decode(
  new Uint8Array(
    readFileSync(
      join(__dirname, '..', 'test-fixtures', 'dlf100_rtcm_rtk_base.rtcm')
    )
  )
);
const EPH_TYPES = [1019, 1020, 1042, 1044, 1045, 1046];
const reframe = (bytes: Uint8Array) => new Rtcm3Decoder().decode(bytes)[0]!;

describe('ephemeris encoders (DLF100 bit-exact)', () => {
  it.each(EPH_TYPES)('%d re-encodes every message bit for bit', (type) => {
    const msgs = frames.filter((f) => f.messageType === type);
    expect(msgs.length).toBeGreaterThan(0);
    for (const f of msgs) {
      const out = reframe(encodeEphemeris(decodeEphemeris(f)!)!);
      expect(out.payload).toEqual(f.payload);
    }
  });

  it('decodes 1020 τc / N4 / τGPS after N^A (was misaligned by 11 bits)', () => {
    const glo = decodeEphemeris(frames.find((f) => f.messageType === 1020)!)!;
    expect(glo.n4).toBe(8); // 2024–2027 interval
    expect(Math.abs(glo.tauC!)).toBeLessThan(1e-6);
    expect(Math.abs(glo.tauGPS!)).toBeLessThan(1e-6);
    expect(glo.na).toBeGreaterThan(0);
  });
});

describe('ephemeris types not in the fixture', () => {
  /** Encoding is idempotent and every field survives to within its LSB. */
  function roundTrip(info: EphemerisInfo, rel = 1e-3) {
    const bytes = encodeEphemeris(info)!;
    const back = decodeEphemeris(reframe(bytes))!;
    expect(encodeEphemeris(back)).toEqual(bytes);
    for (const [k, v] of Object.entries(info)) {
      if (k === 'lastReceived') continue;
      const got = back[k as keyof EphemerisInfo];
      if (typeof v === 'number') {
        expect(Math.abs((got as number) - v), k).toBeLessThanOrEqual(
          Math.abs(v) * rel
        );
      } else {
        expect(got, k).toBe(v);
      }
    }
    return back;
  }

  it('1041 NavIC round-trips', () => {
    roundTrip(
      {
        prn: 'I05',
        constellation: 'NavIC',
        health: 2,
        lastReceived: 0,
        messageType: 1041,
        week: 345,
        ura: 3,
        toc: 345600,
        toe: 345600,
        sqrtA: 6493.12345,
        eccentricity: 0.0021,
        inclination: 0.51,
        omega0: -1.2,
        omegaDot: -2.5e-9,
        argPerigee: 2.9,
        meanAnomaly: -0.7,
        deltaN: 3.1e-9,
        idot: 1e-10,
        crs: -120.5,
        crc: 230.25,
        cuc: 1.2e-6,
        cus: -3.4e-6,
        cic: 2.6e-6,
        cis: -2.9e-6,
        af0: 1.5e-4,
        af1: -2.3e-11,
        af2: 0,
        iode: 77,
        tgd: -4.6e-9,
      },
      2e-2
    ); // scale errors (×2, ×π) are what this catches; idempotence covers the bits
  });

  it('1043 SBAS round-trips', () => {
    // af0 LSB is 2^-31 s, af1 2^-40: keep them a few LSB wide.
    roundTrip(
      {
        prn: 'S23',
        constellation: 'SBAS',
        health: 0,
        lastReceived: 0,
        messageType: 1043,
        iode: 201,
        toc: 43200,
        ura: 4,
        x: 40000.12,
        y: -12000.5,
        z: 120.4,
        vx: 0.0012,
        vy: -0.0021,
        vz: 0.012,
        ax: 1.25e-6,
        ay: -2.5e-6,
        az: 6.25e-6,
        af0: 2.5e-7,
        af1: 9.1e-12,
      },
      1e-2
    );
  });
});

describe('ephemerisToInfo (receiver Ephemeris → RTCM)', () => {
  const ref = Date.UTC(2026, 10, 6);
  it.each(EPH_TYPES)(
    '%d: Ephemeris → info → message → Ephemeris keeps the orbit and clock',
    (type) => {
      for (const f of frames.filter((x) => x.messageType === type)) {
        const info = { ...decodeEphemeris(f)!, lastReceived: ref };
        const eph = ephInfoToEphemeris(info)!;
        expect(eph).not.toBeNull();
        const again = ephInfoToEphemeris({
          ...decodeEphemeris(
            reframe(
              encodeEphemeris(
                ephemerisToInfo(eph, {
                  galileoType: type === 1045 ? 1045 : 1046,
                })
              )!
            )
          )!,
          lastReceived: ref,
        })!;
        expect(again).toEqual(eph);
      }
    }
  );

  it('carries the original message content, every field', () => {
    // ephInfoToEphemeris used to drop TGD, IODC, L2 codes/P flag, fit
    // interval and URA; they are now Ephemeris (RINEX) fields.
    for (const type of [1019, 1042, 1044, 1045, 1046]) {
      for (const f of frames.filter((x) => x.messageType === type)) {
        const info = { ...decodeEphemeris(f)!, lastReceived: ref };
        const rebuilt = reframe(
          encodeEphemeris(ephemerisToInfo(ephInfoToEphemeris(info)!))!
        );
        expect(rebuilt.payload, `${type} ${info.prn}`).toEqual(f.payload);
      }
    }
  });
});
