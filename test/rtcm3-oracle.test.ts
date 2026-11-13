/**
 * RTCM 3 against independent oracles — the decoder must agree with RTKLIB
 * and with a second receiver, not just with our own encoder.
 *
 * 1. Every frame of the DLF100 capture (Trimble Alloy) re-encodes byte for
 *    byte through our encoders, or is listed as having no encoder.
 * 2. Every observable RTKLIB 2.4.2 convbin writes for the same capture
 *    (test-fixtures/convbin/dlf100_rtcm3.obs, see its README) is matched value
 *    by value: pseudorange, phase (sign!), Doppler (sign!), C/N0, epoch time on
 *    the GPS scale for GPS, GLONASS (UTC+3 h day time) and Galileo/QZSS.
 * 3. Station conventions: 1005/1006 ECEF X/Y/Z order and 0.0001 m unit, against
 *    RTKLIB's APPROX POSITION XYZ and against a Septentrio receiver (DLF500,
 *    PVTGeodetic) on the same antenna; 1006 height, 1007/1008/1033 strings with
 *    asymmetric values so a swap is visible.
 *
 * Reference: RTCM 10403.3 §3.5.3 Table 3.5-6/3.5-7 (1005/1006), 3.5-9/3.5-10
 * (1007/1008), 3.5-73 (1033); §3.5.16 MSM tables 3.5-91 (GPS) … 3.5-108.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  BitReader,
  MsmEncoder,
  Rtcm3Decoder,
  createStationMeta,
  decodeEphemeris,
  decodeGloBiases,
  decodeMsmFull,
  encodeAntennaDescriptor,
  encodeEphemeris,
  encodeGloBiases,
  encodeStationArp,
  encodeStationDescriptors,
  obsEpochToDate,
  resetGloFreqCache,
  updateStationMeta,
} from '../src/rtcm3';
import type { Rtcm3Frame } from '../src/rtcm3';
import { parseSbfPvt } from '../src/sbf';
import { geodeticToEcef } from '../src/coordinates/ecef';
import { compareWithOracle, readRinex3Obs } from './helpers/rinex3-obs-oracle';
import type { RawLike } from './helpers/rinex3-obs-oracle';

const FIX = join(__dirname, '..', 'test-fixtures');
const frames = new Rtcm3Decoder().decode(
  new Uint8Array(readFileSync(join(FIX, 'dlf100_rtcm_rtk_base.rtcm')))
);
const oracleText = readFileSync(
  join(FIX, 'convbin', 'dlf100_rtcm3.obs'),
  'utf8'
);
const REF = new Date('2026-11-06T09:00:00Z');
const reframe = (b: Uint8Array) => new Rtcm3Decoder().decode(b)[0]!;
const bits = (f: Rtcm3Frame, skip: number, n: number) => {
  const r = new BitReader(f.payload);
  r.skip(skip);
  return r.readU(n);
};

/* ------------------------------------------------------------------ */
/*  1. decode → encode, every frame                                    */
/* ------------------------------------------------------------------ */

describe('every DLF100 frame re-encodes byte for byte', () => {
  /** Payload with MSM DF393 (multiple-message bit) cleared. */
  const sansMulti = (p: Uint8Array) => {
    const q = p.slice();
    q[6]! &= ~0x02;
    return q;
  };

  /** Re-encode one frame from its decoded fields; null = no encoder. */
  function reencode(f: Rtcm3Frame, msm: MsmEncoder): Uint8Array | null {
    const t = f.messageType;
    const ep = decodeMsmFull(f);
    if (ep) {
      const timeMs = obsEpochToDate(ep.system, ep.epochMs, REF).getTime();
      const out = msm.encode({ timeMs, observations: ep.observations });
      expect(out).toHaveLength(1);
      return out[0]!;
    }
    if (t === 1005 || t === 1006) {
      const meta = createStationMeta();
      updateStationMeta(meta, f);
      return encodeStationArp({
        stationId: meta.stationId!,
        position: meta.position!,
        antennaHeight: t === 1006 ? meta.antennaHeight! : undefined,
        itrf: meta.itrf!,
        gps: bits(f, 30, 1) === 1,
        glonass: bits(f, 31, 1) === 1,
        galileo: bits(f, 32, 1) === 1,
        nonPhysical: bits(f, 33, 1) === 1,
        singleOscillator: bits(f, 72, 1) === 1,
        quarterCycle: bits(f, 112, 2),
      });
    }
    if (t === 1033) {
      const meta = createStationMeta();
      updateStationMeta(meta, f);
      return encodeStationDescriptors({
        stationId: meta.stationId!,
        antennaType: meta.antennaType ?? '',
        antennaSetupId: meta.antennaSetupId!,
        antennaSerial: meta.antennaSerial ?? '',
        receiverType: meta.receiverType ?? '',
        receiverFirmware: meta.receiverFirmware ?? '',
        receiverSerial: meta.receiverSerial ?? '',
      });
    }
    if (t === 1230) return encodeGloBiases(decodeGloBiases(f)!);
    const eph = decodeEphemeris(f);
    if (eph) return encodeEphemeris(eph);
    return null;
  }

  it('covers every message type in the capture', () => {
    resetGloFreqCache();
    const stationId = bits(
      frames.find((f) => f.messageType === 1077)!,
      12,
      12
    );
    const msm = new MsmEncoder({ msm: 7, stationId, clockSteering: 1 });
    const identical: Record<number, number> = {};
    const noEncoder: Record<number, number> = {};
    for (const f of frames) {
      const out = reencode(f, msm);
      if (!out) {
        noEncoder[f.messageType] = (noEncoder[f.messageType] ?? 0) + 1;
        continue;
      }
      const isMsm = f.messageType >= 1071 && f.messageType <= 1137;
      const got = reframe(out).payload;
      // DF393 depends on how the encoder batches an epoch, nothing else.
      expect(isMsm ? sansMulti(got) : got).toEqual(
        isMsm ? sansMulti(f.payload) : f.payload
      );
      identical[f.messageType] = (identical[f.messageType] ?? 0) + 1;
    }
    expect(identical).toEqual({
      1006: 6,
      1019: 20,
      1020: 12,
      1033: 6,
      1042: 21,
      1044: 1,
      1045: 16,
      1046: 17,
      1077: 123,
      1087: 62,
      1097: 62,
      1117: 61,
      1127: 122,
      1230: 6,
    });
    // No encoder: 1013 system parameters (announces the stream's own
    // schedule) and 4094 (Trimble proprietary).
    expect(noEncoder).toEqual({ 1013: 6, 4094: 6 });
  });
});

/* ------------------------------------------------------------------ */
/*  2. observables vs RTKLIB convbin                                   */
/* ------------------------------------------------------------------ */

describe('MSM7 observables match RTKLIB convbin value by value', () => {
  resetGloFreqCache();
  const epochs = new Map<number, RawLike[]>();
  for (const f of frames) {
    const ep = decodeMsmFull(f);
    if (!ep) continue;
    const t = obsEpochToDate(ep.system, ep.epochMs, REF).getTime();
    const list = epochs.get(t) ?? [];
    epochs.set(t, list);
    for (const o of ep.observations) {
      for (const s of o.signals) {
        list.push({
          prn: o.prn,
          code: s.rinexCode,
          pr: s.pseudorange ?? null,
          cp: s.phase ?? null,
          doppler: s.doppler ?? null,
          cn0: s.cn0 ?? null,
        });
      }
    }
  }
  const ours = [...epochs].map(([timeMs, meas]) => ({ timeMs, meas }));
  const oracle = readRinex3Obs(oracleText);

  it('reads the oracle: ten GPS-time epochs, RINEX 3.04 codes', () => {
    expect(oracle.epochs).toHaveLength(10);
    expect(oracle.epochs[0]!.timeMs).toBe(Date.UTC(2026, 10, 6, 9, 13, 51));
    expect(oracle.types['G']!.slice(0, 8)).toEqual([
      'C1C',
      'L1C',
      'D1C',
      'S1C',
      'C1W',
      'L1W',
      'D1W',
      'S1W',
    ]);
  });

  it('agrees on every pseudorange, phase, Doppler and C/N0', () => {
    const r = compareWithOracle(oracle, ours);
    // F14.3 printing: half a millimetre / milli-cycle / milli-Hz.
    expect(r.C.missing).toEqual([]);
    expect(r.L.missing).toEqual([]);
    expect(r.D.missing).toEqual([]);
    expect(r.S.missing).toEqual([]);
    expect(r.C.n).toBe(1129);
    expect(r.L.n).toBe(1129);
    expect(r.C.maxDiff).toBeLessThanOrEqual(5e-4 + 1e-6);
    expect(r.L.maxDiff).toBeLessThanOrEqual(5e-4 + 1e-6);
    // Doppler: RTKLIB sums rough + fine range rate in single precision.
    expect(r.D.maxDiff).toBeLessThan(1e-3);
    // C/N0: RTKLIB keeps 0.25 dB-Hz steps (SNR·4 truncated); MSM7 is 1/16.
    expect(r.S.maxDiff).toBeLessThan(0.25);
  });

  it('every cell we decode is in the oracle, except what RTKLIB 2.4.2 drops', () => {
    const inOracle = new Set<string>();
    for (const ep of oracle.epochs) {
      for (const [prn, obs] of ep.sats) {
        for (const t of obs.keys()) inOracle.add(`${ep.timeMs}|${prn}|${t}`);
      }
    }
    // The slice is cut mid-stream: the first and last epochs are partial.
    const inner = oracle.epochs.slice(1, -1).map((e) => e.timeMs);
    let n = 0;
    for (const { timeMs, meas } of ours) {
      if (!inner.includes(timeMs)) continue;
      for (const m of meas) {
        if (m.pr === null) continue;
        // RTKLIB 2.4.2 has no slot for GPS/QZSS L1C (1X) or Galileo E6 (6B),
        // and names BeiDou B1I "1I" (RINEX 3.02), writing only B2I (7I).
        if ('GJ'.includes(m.prn[0]!) && m.code === '1X') continue;
        if (m.prn[0] === 'E' && m.code === '6B') continue;
        // 2.4.2 also stops at Galileo PRN 30 (MAXPRNGAL).
        if (m.prn[0] === 'E' && +m.prn.slice(1) > 30) continue;
        if (m.prn[0] === 'C' && m.code !== '7I') continue;
        expect(
          inOracle.has(`${timeMs}|${m.prn}|C${m.code}`),
          m.prn + m.code
        ).toBe(true);
        n++;
      }
    }
    expect(n).toBeGreaterThan(900);
  });

  it('Doppler sign: positive when the range shortens (RINEX convention)', () => {
    // Independent of RTKLIB: −dΦ/dt over 1 s equals the Doppler to a few Hz.
    const byKey = new Map<string, { t: number; cp: number; d: number }[]>();
    for (const { timeMs, meas } of ours) {
      for (const m of meas) {
        if (m.cp === null || m.doppler === null) continue;
        const k = m.prn + m.code;
        (byKey.get(k) ?? byKey.set(k, []).get(k)!).push({
          t: timeMs,
          cp: m.cp,
          d: m.doppler,
        });
      }
    }
    let checked = 0;
    let approaching = 0;
    for (const series of byKey.values()) {
      for (let i = 1; i < series.length; i++) {
        const a = series[i - 1]!;
        const b = series[i]!;
        if (b.t - a.t !== 1000) continue;
        const rate = -(b.cp - a.cp); // cycles/s
        expect(Math.abs(rate - (a.d + b.d) / 2)).toBeLessThan(5);
        checked++;
        if (a.d > 0) approaching++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
    // Both signs occur, so the check above is not vacuous.
    expect(approaching).toBeGreaterThan(100);
    expect(approaching).toBeLessThan(checked - 100);
  });
});

/* ------------------------------------------------------------------ */
/*  3. station messages: axis order, units, strings                    */
/* ------------------------------------------------------------------ */

describe('station-message conventions', () => {
  const meta = createStationMeta();
  for (const f of frames) updateStationMeta(meta, f);
  const oracle = oracleText.split('\n');
  const header = (label: string) =>
    oracle.find((l) => l.slice(60).trim() === label)!;

  it('1006 X/Y/Z equal RTKLIB APPROX POSITION XYZ, in that order', () => {
    const xyz = header('APPROX POSITION XYZ')
      .slice(0, 42)
      .trim()
      .split(/\s+/)
      .map(Number);
    expect(xyz).toEqual([3924698.1145, 301124.804, 5001904.9911]);
    meta.position!.forEach((v, i) => expect(v).toBeCloseTo(xyz[i]!, 4));
  });

  it('1033 strings land in the right RINEX header fields', () => {
    // RTKLIB REC # / TYPE / VERS = serial, type, firmware; ANT # / TYPE.
    const rec = header('REC # / TYPE / VERS');
    expect(rec.slice(0, 20).trim()).toBe(meta.receiverSerial);
    expect(rec.slice(20, 40).trim()).toBe(meta.receiverType);
    expect(rec.slice(40, 60).trim()).toBe(meta.receiverFirmware);
    const ant = header('ANT # / TYPE');
    expect(ant.slice(0, 20).trim()).toBe(meta.antennaSerial);
    expect(ant.slice(20, 40).trimEnd()).toBe(meta.antennaType);
    expect(meta).toMatchObject({
      receiverSerial: '6235R40294',
      receiverType: 'Trimble Alloy',
      receiverFirmware: '6.60,30/JUN/2026',
      antennaSerial: '10030006',
      antennaType: 'LEIAR25.R3      LEIT',
    });
  });

  it('1006 ARP = a Septentrio receiver’s PVTGeodetic on the same antenna (DLF1)', () => {
    // DLF100 (Trimble, this RTCM stream) and DLF500 (Septentrio, SBF) share
    // the DLF1 antenna. PVTGeodetic: lat/lon in radians, ellipsoidal height.
    // Agreement to 2 cm locks the 1006 axis order and 0.1 mm unit (a swapped
    // or rescaled axis is kilometres off) and the SBF angle unit/height.
    const pvt = parseSbfPvt(
      new Uint8Array(readFileSync(join(FIX, 'dlf500_sbf_nav_slice.sbf')))
    ).records.filter((r) => r.mode === 'rtk-fixed');
    expect(pvt.length).toBeGreaterThan(20);
    const p = pvt[0]!;
    const ecef = geodeticToEcef(
      (p.latDeg! * Math.PI) / 180,
      (p.lonDeg! * Math.PI) / 180,
      p.heightM!
    );
    const d = ecef.map((v, i) => v - meta.position![i]!);
    expect(Math.hypot(...d)).toBeLessThan(0.02);
  });

  it('1005/1006 lock X/Y/Z order, sign and the 0.0001 m unit (asymmetric)', () => {
    // Negative X, small Y, large Z: any swap or sign flip shows.
    const pos: [number, number, number] = [
      -2267335.6693, 5008.1234, 3222374.9735,
    ];
    const f = reframe(
      encodeStationArp({
        stationId: 2731,
        position: pos,
        antennaHeight: 1.2345,
      })
    );
    expect(f.messageType).toBe(1006);
    // DF025 starts at bit 34, DF026 at 74, DF027 at 114 (Table 3.5-6),
    // two's complement in units of 0.0001 m; DF028 at 152.
    const r = new BitReader(f.payload);
    r.skip(34);
    expect(r.readS(38)).toBe(-22673356693);
    r.skip(2);
    expect(r.readS(38)).toBe(50081234);
    r.skip(2);
    expect(r.readS(38)).toBe(32223749735);
    expect(r.readU(16)).toBe(12345);
    const m = createStationMeta();
    updateStationMeta(m, f);
    m.position!.forEach((v, i) => expect(v).toBeCloseTo(pos[i]!, 4));
    expect(m.antennaHeight).toBeCloseTo(1.2345, 4);
    expect(m.stationId).toBe(2731);

    const f5 = reframe(encodeStationArp({ stationId: 7, position: pos }));
    expect(f5.messageType).toBe(1005);
    const m5 = createStationMeta();
    updateStationMeta(m5, f5);
    m5.position!.forEach((v, i) => expect(v).toBeCloseTo(pos[i]!, 4));
    expect(m5.antennaHeight).toBeNull();
  });

  it('1007/1008/1033 keep every descriptor in its own field', () => {
    const d = {
      stationId: 4001,
      antennaType: 'TRM59800.00     SCIS',
      antennaSetupId: 3,
      antennaSerial: 'ANT-5550',
      receiverType: 'SEPT POLARX5',
      receiverFirmware: '5.5.0',
      receiverSerial: 'RX-3001',
    };
    const m = createStationMeta();
    updateStationMeta(m, reframe(encodeStationDescriptors(d)));
    expect(m).toMatchObject(d);

    const m7 = createStationMeta();
    const f7 = reframe(
      encodeAntennaDescriptor({
        stationId: 12,
        antennaType: 'LEIAR25.R3      LEIT',
        antennaSetupId: 9,
      })
    );
    expect(f7.messageType).toBe(1007);
    updateStationMeta(m7, f7);
    expect(m7).toMatchObject({
      stationId: 12,
      antennaType: 'LEIAR25.R3      LEIT',
      antennaSetupId: 9,
      antennaSerial: null,
    });
    const m8 = createStationMeta();
    const f8 = reframe(
      encodeAntennaDescriptor({
        stationId: 12,
        antennaType: 'LEIAR25.R3      LEIT',
        antennaSetupId: 9,
        antennaSerial: '10030006',
      })
    );
    expect(f8.messageType).toBe(1008);
    updateStationMeta(m8, f8);
    expect(m8.antennaSerial).toBe('10030006');
  });
});
