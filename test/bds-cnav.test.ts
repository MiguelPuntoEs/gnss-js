import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseSbfBdsCnav } from '../src/sbf/rawnav-bds-cnav';
import { decodeSbfNavigation } from '../src/sbf/navigation';
import { parseNavFile, type BdsCnavEphemeris } from '../src/rinex/nav';
import { writeRinexNav4 } from '../src/rinex/nav-writer-v4';
import {
  BdsCnav2Assembler,
  bdsCnav2CrcOk,
  bdsCnav3CrcOk,
} from '../src/navbits/bds-cnav';

// TU Delft DLF500NLD1 (Septentrio) 2026-07-27 ~02:16 GPST: BDSRawB1C (20),
// BDSRawB2a (100) and BDSRawB2b (319) blocks. Oracle: the matching CNV1/
// CNV2/CNV3 records of DLR's merged RINEX 4 broadcast file BRD400DLR
// (doi:10.57677/BRD400DLR), decoded independently of this library.
const fixture = (f: string) => join(__dirname, '../test-fixtures', f);
const sbf = new Uint8Array(readFileSync(fixture('dlf500_sbf_nav_slice.sbf')));
const dlr = parseNavFile(
  readFileSync(fixture('brd400dlr_2026208_bdscnav.rnx'), 'utf8')
);

/** Fields broadcast in the ephemeris/clock data proper. */
const ORBIT_FIELDS = [
  'week',
  'toe',
  'toc',
  'satType',
  'aDot',
  'deltaN0',
  'deltaN0Dot',
  'm0',
  'e',
  'omega',
  'omega0',
  'i0',
  'omegaDot',
  'i0Dot',
  'cis',
  'cic',
  'crs',
  'crc',
  'cus',
  'cuc',
  'af0',
  'af1',
  'af2',
  'iode',
  'iodc',
  'tgdB1Cp',
  'tgdB2ap',
  'iscB1Cd',
  'iscB2ad',
  'tgdB2bI',
] as const satisfies readonly (keyof BdsCnavEphemeris)[];

const close = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-12;

function expectSameOrbit(a: BdsCnavEphemeris, b: BdsCnavEphemeris) {
  for (const k of ORBIT_FIELDS) {
    const x = a[k];
    const y = b[k];
    if (x === null || y === null) expect([k, x]).toEqual([k, y]);
    else expect([k, close(x, y)]).toEqual([k, true]);
  }
  // RINEX stores √A, rounding A at the µm level.
  expect(Math.abs(a.a - b.a)).toBeLessThan(1e-4);
  expect(a.toeDate.getTime()).toBe(b.toeDate.getTime());
}

describe('BeiDou-3 B-CNAV from SBF BDSRawB1C/B2a/B2b', () => {
  const r = parseSbfBdsCnav(sbf);

  it('assembles CNV1, CNV2 and CNV3 ephemerides', () => {
    expect(r.messages).toBe(439);
    const by = (m: string) => r.ephemerides.filter((e) => e.message === m);
    expect(by('CNV1')).toHaveLength(10);
    expect(by('CNV2')).toHaveLength(10);
    expect(by('CNV3')).toHaveLength(10);
    // A handful of B2b messages fail CRC-24Q; none of the B1C/B2a do.
    expect(r.badCrc).toBe(9);
  });

  it('matches DLR BRD400DLR field for field', () => {
    let matched = 0;
    for (const e of r.ephemerides) {
      const ref = dlr.bdsCnav!.find(
        (x) =>
          x.prn === e.prn &&
          x.message === e.message &&
          x.tocDate.getTime() === e.tocDate.getTime()
      );
      if (!ref) continue; // C14 B2b is absent from DLR's merged file
      expectSameOrbit(e, ref);
      matched++;
    }
    expect(matched).toBe(29);
  });

  it('decodes the B1C/B2a/B2b triple of one satellite identically', () => {
    const c28 = r.ephemerides.filter((e) => e.prn === 'C28');
    expect(c28.map((e) => e.message).sort()).toEqual(['CNV1', 'CNV2', 'CNV3']);
    const [a, b, c] = c28;
    for (const k of ['m0', 'e', 'omega0', 'i0', 'af0', 'toe'] as const) {
      expect(a![k]).toBe(b![k]);
      expect(a![k]).toBe(c![k]);
    }
    expect(a!.satType).toBe(3); // MEO
    expect(a!.tocDate.toISOString()).toBe('2026-07-27T02:00:00.000Z'); // BDT
  });

  it('is part of the one-pass decodeSbfNavigation', () => {
    const nav = decodeSbfNavigation(sbf);
    expect(nav.counts.bdsCnavRaw).toBe(439);
    expect(nav.bdsCnav).toHaveLength(30);
  });
});

describe('BeiDou-3 B-CNAV RINEX 4 records', () => {
  it('reads every CNV1/CNV2/CNV3 record of the DLR extract', () => {
    expect(dlr.bdsCnav).toHaveLength(29);
    const c28 = dlr.bdsCnav!.find(
      (e) => e.prn === 'C28' && e.message === 'CNV1'
    )!;
    expect(c28.iode).toBe(26);
    expect(c28.iodc).toBe(26);
    expect(c28.tgdB1Cp).toBeCloseTo(-2.561137080193e-9, 20);
    expect(c28.iscB2ad).toBeNull(); // blank on CNV1
    expect(c28.deltaA).toBeCloseTo(171.119140625, 3);
  });

  it('round-trips through writeRinexNav4', () => {
    const ephs = parseSbfBdsCnav(sbf).ephemerides;
    const text = writeRinexNav4({
      header: { version: 4, type: 'N', leapSeconds: 18, ionoCorrections: {} },
      ephemerides: [],
      bdsCnav: ephs,
    });
    expect(text).toContain('> EPH C28 CNV3');
    const back = parseNavFile(text).bdsCnav!;
    expect(back).toHaveLength(ephs.length);
    for (const e of ephs) {
      const x = back.find((y) => y.prn === e.prn && y.message === e.message)!;
      expectSameOrbit(e, x);
      for (const k of ['health', 'sismai', 'sisaiOcb', 'top', 'tow'] as const)
        expect(x[k]).toBe(e[k]);
    }
  });
});

describe('BdsCnav2Assembler pairing', () => {
  // Pull C28's B2a messages out of the fixture in stream order.
  const msgs: Uint8Array[] = [];
  const view = new DataView(sbf.buffer, sbf.byteOffset, sbf.byteLength);
  for (let i = 0; i + 8 <= sbf.length; i++) {
    if (sbf[i] !== 0x24 || sbf[i + 1] !== 0x40) continue;
    const id = view.getUint16(i + 4, true) & 0x1fff;
    const len = view.getUint16(i + 6, true);
    if (len < 8 || len % 4 || i + len > sbf.length) continue;
    if (id === 4219 && sbf[i + 14] === 168) {
      const m = new Uint8Array(36);
      for (let k = 0; k < 9; k++) {
        const w = view.getUint32(i + 20 + 4 * k, true);
        m[4 * k] = w >>> 24;
        m[4 * k + 1] = (w >>> 16) & 0xff;
        m[4 * k + 2] = (w >>> 8) & 0xff;
        m[4 * k + 3] = w & 0xff;
      }
      msgs.push(m);
    }
    i += len - 1;
  }
  /** Message type: bits 6-11. */
  const mt = (m: Uint8Array) => ((m[0]! & 0x03) << 4) | (m[1]! >> 4);
  /** SOW (s): bits 12-29, × 3. */
  const sow = (m: Uint8Array) =>
    (((m[1]! & 0x0f) << 14) | (m[2]! << 6) | (m[3]! >> 2)) * 3;

  it('extracts CRC-valid messages', () => {
    expect(msgs.length).toBeGreaterThan(8);
    expect(msgs.every(bdsCnav2CrcOk)).toBe(true);
  });

  it('emits once MT10, a later MT11 and a matching clock are in', () => {
    const asm = new BdsCnav2Assembler();
    const out = msgs.map((m) => asm.push(m)).filter(Boolean);
    expect(out).toHaveLength(1);
    // Repeats of the same set are suppressed.
    expect(msgs.map((m) => asm.push(m)).filter(Boolean)).toHaveLength(0);
  });

  it('drops an MT11 heard before the latest MT10', () => {
    const t10s = msgs.filter((m) => mt(m) === 10);
    const clk = msgs.find((m) => mt(m) >= 30 && mt(m) <= 34)!;
    const t11After = (m: Uint8Array) =>
      msgs.find((x) => mt(x) === 11 && sow(x) > sow(m))!;
    expect(t10s.length).toBeGreaterThanOrEqual(2);
    const [first, second] = t10s;
    const asm = new BdsCnav2Assembler();
    asm.push(first!);
    asm.push(t11After(first!));
    // A new MT10 may start a new set: the earlier MT11 no longer counts.
    asm.push(second!);
    expect(asm.push(clk)).toBeNull();
    expect(asm.push(t11After(second!))).not.toBeNull();
  });

  it('rejects a corrupted message by CRC', () => {
    const bad = msgs[0]!.slice();
    bad[10]! ^= 0x10;
    expect(bdsCnav2CrcOk(bad)).toBe(false);
    expect(bdsCnav3CrcOk(new Uint8Array(10))).toBe(false); // too short
  });
});
