/**
 * Septentrio SBF against the AsteRx-m3 Pro+ v4.15.1 Reference Guide. RTKLIB
 * 2.4.2 has no SBF reader, so the oracle is the guide itself: an independent
 * MeasEpoch decoder written straight from its field tables (§4.2.1 pp.
 * 273–277, §4.1.9 SVID, §4.1.10 signal numbers; a Python script, not this
 * library) agreed with parseSbfMeas on all 28 644 values of the DLF500 slice
 * once the two bugs pinned below were fixed. Values here are hand-decoded
 * from the raw bytes with those tables.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseSbfMeas, parseSbfPvt } from '../src/sbf';
import { svidToPrn } from '../src/sbf/frame';

const FIX = join(__dirname, '..', 'test-fixtures');
const bytes = new Uint8Array(
  readFileSync(join(FIX, 'dlf500_sbf_nav_slice.sbf'))
);
const res = parseSbfMeas(bytes);

describe('SBF SVID numbering (§4.1.9)', () => {
  it('maps every defined range, BeiDou up to C63', () => {
    expect(svidToPrn(1)).toBe('G01');
    expect(svidToPrn(38)).toBe('R01');
    expect(svidToPrn(61)).toBe('R24');
    expect(svidToPrn(62)).toBeNull(); // GLONASS, slot unknown
    expect(svidToPrn(63)).toBe('R25');
    expect(svidToPrn(71)).toBe('E01');
    expect(svidToPrn(106)).toBe('E36');
    expect(svidToPrn(120)).toBe('S20');
    expect(svidToPrn(141)).toBe('C01');
    expect(svidToPrn(180)).toBe('C40');
    expect(svidToPrn(181)).toBe('J01');
    expect(svidToPrn(191)).toBe('I01');
    expect(svidToPrn(198)).toBe('S41');
    expect(svidToPrn(216)).toBe('I08');
    expect(svidToPrn(223)).toBe('C41');
    // SVID 240 is C58, which the DLF500 slice tracks on B3I; it was dropped.
    expect(svidToPrn(240)).toBe('C58');
    expect(svidToPrn(245)).toBe('C63');
  });

  it('keeps C58 B3I from the DLF500 MeasEpoch', () => {
    const c58 = res.epochs[0]!.meas.find((m) => m.prn === 'C58');
    expect(c58?.code).toBe('6I');
    expect(c58!.pr).toBeGreaterThan(2e7);
  });
});

describe('MeasEpoch (4027) field tables, hand-decoded', () => {
  it('labels Galileo E6 as 6B when CommonFlags bit 6 (E6B used) is set', () => {
    // §4.1.10: signal 19 is "6C or 6B (∗) — see the E6B Used bit". The
    // DLF500 MeasEpoch blocks carry CommonFlags 0x4D (bits 0, 2, 3, 6).
    const start = bytes.findIndex(
      (b, i) =>
        b === 0x24 &&
        bytes[i + 1] === 0x40 &&
        ((bytes[i + 4]! | (bytes[i + 5]! << 8)) & 0x1fff) === 4027
    );
    expect(bytes[start + 17]).toBe(0x4d);
    expect(res.obsCodes['E']).toContain('6B');
    expect(res.obsCodes['E']).not.toContain('6C');
  });
});

describe('MeasEpoch values hand-decoded from the first DLF500 block', () => {
  // Block header: TOW 94579000 ms, WNc 2429, N1 55, SB1Length 20,
  // SB2Length 12. Formulas are the guide's, written out here on the raw
  // integers so a misread offset, scale or sign shows.
  const C = 299792458;
  const ep = res.epochs[0]!;
  const at = (prn: string, code: string) =>
    ep.meas.find((m) => m.prn === prn && m.code === code)!;

  it('epoch = WNc weeks + TOW ms on the GPS scale', () => {
    expect(ep.timeMs).toBe(Date.UTC(1980, 0, 6) + 2429 * 604800000 + 94579000);
  });

  it('Type1 S44 L1 (SVID 201, sig 24) and its Type2 L5 (sig 25)', () => {
    // Type1: Misc 9, CodeLSB 2955738321, Doppler 1035135, CarrierLSB 59401,
    // CarrierMSB −1, CN0 117, LockTime 480.
    const pr1 = (9 * 4294967296 + 2955738321) * 0.001;
    const l1 = at('S44', '1C');
    expect(l1.pr).toBeCloseTo(pr1, 6);
    expect(pr1).toBeCloseTo(41610443.985, 6);
    expect(l1.doppler).toBeCloseTo(103.5135, 9); // positive = approaching
    expect(l1.cp).toBeCloseTo(
      pr1 / (C / 1575.42e6) + (-1 * 65536 + 59401) * 0.001,
      6
    );
    expect(l1.cn0).toBe(117 * 0.25 + 10); // signal ≠ 1, 2: +10 dB-Hz
    expect(l1.lockTimeMs).toBe(480_000);
    // Type2: OffsetsMSB 7 (code MSB −1 in 3-bit two's complement, Doppler
    // MSB 0), CarrierMSB 0, CodeOffsetLSB 53509, CarrierLSB 2852,
    // DopplerOffsetLSB 5736, CN0 84.
    const pr2 = pr1 + (-1 * 65536 + 53509) * 0.001;
    const l5 = at('S44', '5I');
    expect(l5.pr).toBeCloseTo(pr2, 6);
    expect(l5.cp).toBeCloseTo(pr2 / (C / 1176.45e6) + 2852 * 0.001, 6);
    expect(l5.doppler).toBeCloseTo(
      (103.5135 * 1176.45) / 1575.42 + 5736 * 1e-4,
      9
    );
    expect(l5.cn0).toBe(84 * 0.25 + 10);
  });

  it('GLONASS R13 (SVID 50): FreqNr from ObsInfo, k = 6 − 8 = −2', () => {
    // Type1 sig 8, ObsInfo 48 (bits 3–7 = 6), Misc 4, CodeLSB 2133095676,
    // Doppler 8351426, CarrierMSB 1, CarrierLSB 19762, CN0 144.
    const f1 = 1602e6 - 2 * 562500;
    const pr1 = (4 * 4294967296 + 2133095676) * 0.001;
    const r1 = at('R13', '1C');
    expect(r1.pr).toBeCloseTo(pr1, 6);
    expect(r1.cp).toBeCloseTo(pr1 / (C / f1) + (65536 + 19762) * 0.001, 6);
    expect(r1.doppler).toBeCloseTo(835.1426, 9);
    expect(r1.cn0).toBe(46);
    // Type2 sig 9 (L1P, same carrier): code −0.570 m, Doppler +0.054 Hz.
    const r1p = at('R13', '1P');
    expect(r1p.pr).toBeCloseTo(pr1 + (-65536 + 64966) * 0.001, 6);
    expect(r1p.doppler).toBeCloseTo(835.1426 + 540e-4, 9);
    expect(r1p.cn0).toBe(143 * 0.25 + 10);
  });
});

describe('PVTGeodetic (4007) conventions', () => {
  it('lat/lon are radians, height is ellipsoidal (undulation not applied)', () => {
    // First block: Lat 0.9073271445588356 rad, Lon 0.0765755713796947 rad,
    // Height 75.80951661244035 m, Undulation 47.11496 m (f4 at +40),
    // NrSV 35, HAccuracy/VAccuracy 2 (0.01 m), Mode 4 (RTK fixed).
    const r = parseSbfPvt(bytes).records[0]!;
    expect(r.latDeg).toBeCloseTo((0.9073271445588356 * 180) / Math.PI, 12);
    expect(r.lonDeg).toBeCloseTo((0.0765755713796947 * 180) / Math.PI, 12);
    expect(r.heightM).toBe(75.80951661244035);
    expect(r.nrSV).toBe(35);
    expect(r.hAccuracyM).toBe(0.02);
    expect(r.mode).toBe('rtk-fixed');
    expect(r.timeMs).toBe(ep0Time);
  });
});
const ep0Time = Date.UTC(1980, 0, 6) + 2429 * 604800000 + 94579000;
