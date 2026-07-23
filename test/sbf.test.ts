import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseSbfMeas } from '../src/sbf';

const FILE = join(__dirname, '../test-fixtures/tudb_meas3_slice.sbf');

/**
 * The slice is cut from TU Delft's TUDB mosaic station log (2026-07-21,
 * 1 Hz, Meas3 with a 10 s reference-epoch interval). It starts at the
 * reference epoch 00:00:10 and spans 13 epochs (11 delta epochs plus a
 * second reference epoch at 00:00:20). Expected values are pinned from
 * RTKLIB demo5 convbin's RINEX conversion of the same log — the
 * full-file comparison (328k observables over 899 epochs) agreed to
 * the 0.0005 RINEX printing quantum.
 */
describe.skipIf(!existsSync(FILE))('parseSbfMeas (TUDB Meas3 slice)', () => {
  const res = parseSbfMeas(new Uint8Array(readFileSync(FILE)));

  it('frames the stream: 13 epochs, clean CRCs', () => {
    expect(res.epochs.length).toBe(13);
    expect(res.badCrc).toBe(0);
    expect(res.messageCounts['4109']).toBe(13);
    expect(res.messageCounts['4110']).toBe(13);
  });

  it('decodes receiver time in the RINEX parser convention', () => {
    // > 2026 07 21 00 00 10.0000000 in the reference RINEX
    expect(res.epochs[0]!.timeMs).toBe(Date.UTC(2026, 6, 21, 0, 0, 10));
    expect(res.epochs[1]!.timeMs - res.epochs[0]!.timeMs).toBe(1000);
    expect(res.epochs[12]!.timeMs).toBe(Date.UTC(2026, 6, 21, 0, 0, 22));
  });

  it('maps signals to the RTKLIB obs-code convention', () => {
    // Same code sets as convbin's RINEX header (order here is first-seen)
    expect(res.obsCodes['G']!.sort()).toEqual(['1C', '2L', '2W', '5Q']);
    expect(res.obsCodes['R']!.sort()).toEqual(['1C', '2C', '3Q']);
    expect(res.obsCodes['E']!.sort()).toEqual(['1C', '5Q', '7Q', '8Q']);
    expect(res.obsCodes['C']!.sort()).toEqual(['1P', '2I', '5P', '6I']);
    expect(res.obsCodes['S']!.sort()).toEqual(['1C', '5I']);
  });

  const at = (epoch: number, prn: string, code: string) =>
    res.epochs[epoch]!.meas.find((m) => m.prn === prn && m.code === code);

  const close = (v: number | null, ref: number, tol: number) => {
    expect(v).not.toBeNull();
    expect(Math.abs(v! - ref)).toBeLessThan(tol);
  };

  it('matches convbin at the reference epoch (GPS L1 + L2)', () => {
    const g12 = at(0, 'G12', '1C')!;
    close(g12.pr, 21923628.377, 6e-4);
    close(g12.cp, 115209549.532, 6e-4);
    close(g12.cn0, 48.875, 0.26);
    const g12l2 = at(0, 'G12', '2W')!;
    close(g12l2.pr, 21923625.659, 6e-4);
    close(g12l2.cp, 89773719.836, 6e-4);
    close(g12l2.cn0, 47.5, 0.26);
  });

  it('matches convbin at the reference epoch (GLONASS FCN + BeiDou + SBAS)', () => {
    const r04 = at(0, 'R04', '1C')!; // FCN +6
    close(r04.pr, 22025178.653, 6e-4);
    close(r04.cp, 117943864.187, 6e-4);
    close(r04.cn0, 46.812, 0.26);
    close(at(0, 'R04', '2C')!.pr, 22025184.18, 6e-4);
    close(at(0, 'R04', '3Q')!.cp, 88310486.853, 6e-4);
    const c24 = at(0, 'C24', '2I')!;
    close(c24.pr, 22492547.505, 6e-4);
    close(c24.cp, 117124666.123, 6e-4);
    close(c24.cn0, 52.75, 0.26);
    close(at(0, 'C24', '1P')!.pr, 22492549.24, 6e-4);
    const s23 = at(0, 'S23', '1C')!;
    close(s23.pr, 38779137.032, 6e-4);
    close(s23.cp, 203786471.605, 6e-4);
    close(at(0, 'S23', '5I')!.pr, 38779002.874, 6e-4);
  });

  it('matches convbin at a delta epoch (00:00:15)', () => {
    const g12 = at(5, 'G12', '1C')!;
    close(g12.pr, 21926973.383, 6e-4);
    close(g12.cp, 115227128.717, 6e-4);
    close(g12.cn0, 48.625, 0.26);
    const c24 = at(5, 'C24', '1P')!;
    close(c24.pr, 22495003.85, 6e-4);
    close(c24.cp, 118212118.505, 6e-4);
    close(c24.cn0, 50.312, 0.26);
  });

  it('only emits valid observables (no Doppler in this log)', () => {
    for (const e of res.epochs) {
      for (const m of e.meas) {
        expect(m.doppler).toBeNull(); // no Meas3Doppler blocks logged
        if (m.pr !== null) expect(m.pr).toBeGreaterThan(1e6);
        if (m.cp !== null) expect(m.cp).not.toBe(0);
        if (m.cn0 !== null) {
          expect(m.cn0).toBeGreaterThan(10);
          expect(m.cn0).toBeLessThan(65);
        }
      }
    }
  });
});

/* ── classic MeasEpoch (4027): synthetic block pinning the field layout ── */

/** CRC16-CCITT (poly 0x1021, init 0), bitwise. */
function sbfCrc(data: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= data[i]! << 8;
    for (let k = 0; k < 8; k++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function buildMeasEpoch(): Uint8Array {
  const buf = new Uint8Array(72);
  const v = new DataView(buf.buffer);
  buf[0] = 0x24;
  buf[1] = 0x40;
  v.setUint16(4, 4027, true); // block ID, revision 0
  v.setUint16(6, 72, true); // total length
  v.setUint32(8, 302400000, true); // TOW (ms): mid-week
  v.setUint16(12, 2400, true); // WNc
  buf[14] = 2; // N1
  buf[15] = 20; // SB1Length
  buf[16] = 12; // SB2Length
  buf[17] = 0; // CommonFlags (not scrambled)

  // Type1 #1: G05, signal 0 (GPS L1C/A), one Type2 sub-block
  let p = 20;
  buf[p] = 7; // RxChannel
  buf[p + 1] = 0; // Type: antenna 0, sig 0
  buf[p + 2] = 5; // SVID: G05
  buf[p + 3] = 4; // Misc: CodeMSB=4
  v.setUint32(p + 4, 4054698706, true); // CodeLSB → PR 21234567.890 m
  v.setInt32(p + 8, -12345678, true); // Doppler → -1234.5678 Hz
  v.setUint16(p + 12, 234, true); // CarrierLSB
  v.setInt8(p + 14, 1); // CarrierMSB → +65.770 cycles vs PR
  buf[p + 15] = 142; // CN0 → 45.5 dB-Hz
  v.setUint16(p + 16, 120, true); // LockTime (s)
  buf[p + 18] = 0; // ObsInfo
  buf[p + 19] = 1; // N2

  // Type2: signal 3 (GPS L2C)
  p = 40;
  buf[p] = 3; // Type: antenna 0, sig 3
  buf[p + 1] = 200; // LockTime (s)
  buf[p + 2] = 113; // CN0 → 38.25 dB-Hz
  buf[p + 3] = 0x07; // OffsetsMSB: CodeOffsetMSB=-1, DopplerOffsetMSB=0
  v.setInt8(p + 4, 0); // CarrierMSB
  buf[p + 5] = 0; // ObsInfo
  v.setUint16(p + 6, 60000, true); // CodeOffsetLSB → offset -5.536 m
  v.setUint16(p + 8, 500, true); // CarrierLSB → +0.5 cycles vs PR
  v.setUint16(p + 10, 1000, true); // DopplerOffsetLSB → +0.1 Hz

  // Type1 #2: R05 with FCN +1, signal 8 (GLONASS L1C/A), all-invalid fields
  p = 52;
  buf[p] = 9;
  buf[p + 1] = 8; // sig 8
  buf[p + 2] = 42; // SVID: 37 + 5 → R05
  buf[p + 3] = 4; // CodeMSB=4
  v.setUint32(p + 4, 2694600914, true); // → PR 19874470.098 m
  v.setInt32(p + 8, -2147483648, true); // Doppler do-not-use
  v.setUint16(p + 12, 0, true);
  v.setInt8(p + 14, -128); // carrier do-not-use
  buf[p + 15] = 255; // CN0 do-not-use
  v.setUint16(p + 16, 65535, true); // lock-time do-not-use
  buf[p + 18] = (1 + 8) << 3; // ObsInfo: FCN +1
  buf[p + 19] = 0; // N2

  v.setUint16(2, sbfCrc(buf, 4, 72), true);
  return buf;
}

describe('parseSbfMeas (synthetic MeasEpoch)', () => {
  const C = 299792458;

  it('decodes Type1 + Type2 sub-blocks per the reference guide', () => {
    const res = parseSbfMeas(buildMeasEpoch());
    expect(res.badCrc).toBe(0);
    expect(res.messageCounts['4027']).toBe(1);
    expect(res.epochs.length).toBe(1);
    expect(res.epochs[0]!.timeMs).toBe(
      Date.UTC(1980, 0, 6) + 2400 * 7 * 86400_000 + 302400000
    );
    const meas = res.epochs[0]!.meas;
    expect(meas.length).toBe(3);

    const g05 = meas[0]!;
    expect(g05.prn).toBe('G05');
    expect(g05.code).toBe('1C');
    expect(g05.pr).toBeCloseTo(21234567.89, 6);
    expect(g05.cp).toBeCloseTo((21234567.89 * 1575.42e6) / C + 65.77, 6);
    expect(g05.doppler).toBeCloseTo(-1234.5678, 9);
    expect(g05.cn0).toBeCloseTo(45.5, 9);
    expect(g05.lockTimeMs).toBe(120000);

    const g05l2 = meas[1]!;
    expect(g05l2.code).toBe('2L');
    const p2 = 21234567.89 - 5.536;
    expect(g05l2.pr).toBeCloseTo(p2, 6);
    expect(g05l2.cp).toBeCloseTo((p2 * 1227.6e6) / C + 0.5, 6);
    expect(g05l2.doppler).toBeCloseTo(
      (-1234.5678 * 1227.6e6) / 1575.42e6 + 0.1,
      6
    );
    expect(g05l2.cn0).toBeCloseTo(38.25, 9);
    expect(g05l2.lockTimeMs).toBe(200000);

    const r05 = meas[2]!;
    expect(r05.prn).toBe('R05');
    expect(r05.code).toBe('1C');
    expect(r05.pr).toBeCloseTo(4 * 4294967.296 + 2694600914 * 0.001, 6);
    expect(r05.cp).toBeNull();
    expect(r05.doppler).toBeNull();
    expect(r05.cn0).toBeNull();
    expect(r05.lockTimeMs).toBeNull();
  });

  it('rejects a corrupted frame and counts it', () => {
    const bad = buildMeasEpoch();
    bad[30]! ^= 0xff;
    const res = parseSbfMeas(bad);
    expect(res.badCrc).toBe(1);
    expect(res.epochs.length).toBe(0);
  });
});
