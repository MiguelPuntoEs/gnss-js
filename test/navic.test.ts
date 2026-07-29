import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseSbfNavic, extractSbfNavicSubframe } from '../src/sbf';
import { decodeSbfNavigation } from '../src/sbf/navigation';
import { getBitU, setBitU } from '../src/navbits';
import { decodeEphemeris } from '../src/rtcm3';

const FIX = join(__dirname, '../test-fixtures/dlf500_navic_slice.sbf');

// NavIC gen-1 satellites are GEO/IGSO at a ≈ 42 164 km; IGSO inclination ≈ 29°.
const A_NOMINAL = 42_164_000;

describe.skipIf(!existsSync(FIX))('NavIC ephemeris (SBF NAVICRaw 4093)', () => {
  const data = new Uint8Array(readFileSync(FIX));

  it('decodes physical NavIC ephemerides and drops alert-flagged SVs', () => {
    const r = parseSbfNavic(data);
    expect(r.messages).toBe(500);
    expect(r.badCrc).toBeGreaterThan(0); // weak L5 in NL → real CRC failures
    expect(r.ephemerides.length).toBeGreaterThan(0);

    const byPrn = new Map(r.ephemerides.map((e) => [e.prn, e]));
    // I02 and I09 broadcast healthy (alert=0) data in this capture.
    for (const prn of ['I02', 'I09']) {
      const e = byPrn.get(prn);
      expect(e, prn).toBeDefined();
      expect(e!.system).toBe('I');
      const a = e!.sqrtA ** 2;
      expect(Math.abs(a - A_NOMINAL)).toBeLessThan(2_000_000); // within 2000 km
      expect(e!.e).toBeLessThan(0.02);
      expect((e!.i0 * 180) / Math.PI).toBeGreaterThan(20);
      expect((e!.i0 * 180) / Math.PI).toBeLessThan(35);
      expect(e!.svHealth).toBe(0);
    }
    // I06 is alert-flagged (unhealthy) → must not be emitted as a valid orbit.
    expect(byPrn.has('I06')).toBe(false);
  });

  it('surfaces NavIC through the one-pass decodeSbfNavigation', () => {
    const nav = decodeSbfNavigation(data);
    expect(nav.counts.navicRaw).toBe(500);
    expect(nav.ephemerides.some((e) => e.system === 'I')).toBe(true);
  });

  it('RTCM 1041 decodes the same NavIC ephemeris as the SBF path', () => {
    // Build a 1041 payload from a healthy SV's raw subframe bits (the RTCM
    // message carries the same fields, in order, that subframes 1 & 2 do).
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const svid: Record<string, number> = { I02: 2 };
    let sf1: Uint8Array | null = null;
    let sf2: Uint8Array | null = null;
    for (let i = 0; i + 60 <= data.length && !sf2;) {
      if (data[i] === 0x24 && data[i + 1] === 0x40) {
        if ((view.getUint16(i + 4, true) & 0x1fff) === 4093) {
          const prn = view.getUint8(i + 14);
          const sf = extractSbfNavicSubframe(view, i);
          const id = getBitU(sf, 27, 2) + 1;
          const alert = getBitU(sf, 25, 1);
          if (prn === 190 + svid.I02! && !alert) {
            if (id === 1) sf1 = sf;
            else if (id === 2 && sf1) sf2 = sf; // first consecutive pair
          }
          i += 60;
          continue;
        }
      }
      i++;
    }
    expect(sf1, 'found I02 sf1').not.toBeNull();
    expect(sf2, 'found I02 sf2').not.toBeNull();

    const payload = new Uint8Array(60);
    let pos = 0;
    setBitU(payload, pos, 12, 1041);
    pos += 12;
    setBitU(payload, pos, 6, svid.I02!);
    pos += 6;
    for (let k = 30; k < 260; k++)
      setBitU(payload, pos++, 1, getBitU(sf1!, k, 1));
    for (let k = 30; k < 260; k++)
      setBitU(payload, pos++, 1, getBitU(sf2!, k, 1));

    const eph = decodeEphemeris({ messageType: 1041, length: 60, payload });
    expect(eph).not.toBeNull();
    expect(eph!.prn).toBe('I02');
    expect(eph!.constellation).toBe('NavIC');

    // Same numbers the SBF decoder produced for I02.
    const sbf = parseSbfNavic(data).ephemerides.find((e) => e.prn === 'I02')!;
    expect(eph!.sqrtA).toBeCloseTo(sbf.sqrtA, 3);
    expect(eph!.eccentricity).toBeCloseTo(sbf.e, 9);
    expect(eph!.inclination).toBeCloseTo(sbf.i0, 9);
    expect(eph!.meanAnomaly).toBeCloseTo(sbf.m0, 6);
    expect(eph!.af0).toBeCloseTo(sbf.af0, 12);
  });
});
