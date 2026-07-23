import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { setBitU } from '../src/navbits';
import {
  CnavAssembler,
  assembleCnavEphemeris,
  cnavCrcOk,
  crc24q,
} from '../src/navbits/cnav';
import { parseSbfCnav } from '../src/sbf';
import { parseUbxCnav } from '../src/ubx';

const SBF_FILE = join(__dirname, '../test-fixtures/dlf5_cnav_slice.sbf');
const UBX_FILE = join(__dirname, '../test-fixtures/f9p_cnav_slice.ubx');

/** RINEX prints ~13 significant digits; require agreement to that. */
function relClose(actual: number | null, expected: number) {
  expect(actual).not.toBeNull();
  expect(Math.abs(actual! - expected)).toBeLessThanOrEqual(
    Math.abs(expected) * 1e-11 + 1e-19
  );
}

/* ================================================================== */
/*  CRC-24Q and synthetic message assembly                             */
/* ================================================================== */

/** Frame a synthetic 300-bit CNAV message: header, fields, CRC. */
function buildCnavMsg(
  prn: number,
  type: number,
  towSec: number,
  fields: (b: Uint8Array) => void
): Uint8Array {
  const b = new Uint8Array(38);
  setBitU(b, 0, 8, 0x8b);
  setBitU(b, 8, 6, prn);
  setBitU(b, 14, 6, type);
  setBitU(b, 20, 17, towSec / 6);
  fields(b);
  setBitU(b, 276, 24, crc24q(b, 276));
  return b;
}

const TOE = 345600; // toe/toc used by the synthetic set (s of week)
const mt10 = (toe = TOE) =>
  buildCnavMsg(7, 10, 345000, (b) => {
    setBitU(b, 38, 13, 2137); // WN
    setBitU(b, 70, 11, toe / 300);
  });
const mt11 = (toe = TOE) =>
  buildCnavMsg(7, 11, 345012, (b) => setBitU(b, 38, 11, toe / 300));
const mt33 = (toc = TOE) =>
  buildCnavMsg(7, 33, 345024, (b) => {
    setBitU(b, 60, 11, toc / 300);
    setBitU(b, 71, 26, 1024); // af0 = 1024 * 2^-35
  });

describe('crc24q / cnavCrcOk', () => {
  it('matches the CRC-24/Q check value for "123456789"', () => {
    const data = new TextEncoder().encode('123456789');
    expect(crc24q(data, 72)).toBe(0xcde703);
  });

  it('accepts a well-formed message and rejects a corrupted one', () => {
    const msg = mt10();
    expect(cnavCrcOk(msg)).toBe(true);
    const bad = msg.slice();
    bad[20] ^= 0x10;
    expect(cnavCrcOk(bad)).toBe(false);
  });
});

describe('CnavAssembler (synthetic messages)', () => {
  it('emits only when MT10+MT11+MT3x agree on toe/toc', () => {
    const a = new CnavAssembler();
    expect(a.push(mt10())).toBeNull();
    expect(a.push(mt11())).toBeNull();
    const eph = a.push(mt33());
    expect(eph).not.toBeNull();
    expect(eph!.prn).toBe('G07');
    expect(eph!.week).toBe(2137);
    expect(eph!.toe).toBe(TOE);
    expect(eph!.toc).toBe(TOE);
    expect(eph!.clockMsgType).toBe(33);
    relClose(eph!.af0, 1024 * 2 ** -35);
    expect(eph!.tgd).toBeNull(); // no MT30 seen
  });

  it('holds back a mixed data set until the epochs match', () => {
    const a = new CnavAssembler();
    a.push(mt10());
    a.push(mt33());
    // MT11 from the NEXT data set: toe differs, no emission
    expect(a.push(mt11(TOE + 7200))).toBeNull();
    // consistent MT11 arrives: the set completes
    expect(a.push(mt11())).not.toBeNull();
  });

  it('suppresses unchanged repeats of the same data set', () => {
    const a = new CnavAssembler();
    a.push(mt10());
    a.push(mt11());
    expect(a.push(mt33())).not.toBeNull();
    a.push(mt10());
    a.push(mt11());
    expect(a.push(mt33())).toBeNull(); // same key: week/toe/clock
  });

  it('assembleCnavEphemeris counts messages and CRC failures', () => {
    const bad = mt10();
    bad[30] ^= 0xff;
    const res = assembleCnavEphemeris([mt10(), bad, mt11(), mt33()]);
    expect(res.messages).toBe(4);
    expect(res.badCrc).toBe(1);
    expect(res.ephemerides.length).toBe(1);
  });
});

/* ================================================================== */
/*  Septentrio GPSRawL2C / GPSRawL5                                    */
/* ================================================================== */

/**
 * The SBF slice holds the first 105 GPSRawL2C/GPSRawL5 blocks of the
 * TU Delft DLF5 mosaic-X5 capture dlf5_long.sbf (caster, 2026-07-23
 * 02:31 UTC, GPS week 2428). Expected values are pinned from the
 * RINEX 4.01 CNAV records of the IGS hourly nav files of BRUX/CEBR/
 * KIRU (igs.bkg.bund.de/root_ftp/IGS/nrt, day 204 hours 02-03) — an
 * independent decode of the same broadcast. The full-file oracle
 * (oracle-cnav.tmp.mjs) matched all 21 assembled records field for
 * field (672 fields, worst relative difference 4.1e-13) with a 100%
 * CRC-24Q pass rate over 2400 raw messages.
 */
describe.skipIf(!existsSync(SBF_FILE))('parseSbfCnav (DLF5 slice)', () => {
  const res = existsSync(SBF_FILE)
    ? parseSbfCnav(new Uint8Array(readFileSync(SBF_FILE)))
    : null!;

  it('decodes every raw message with clean CRC-24Q', () => {
    expect(res.messages).toBe(105);
    expect(res.badCrc).toBe(0);
    const bySignal: Record<string, number> = {};
    for (const e of res.ephemerides)
      bySignal[e.signal] = (bySignal[e.signal] ?? 0) + 1;
    expect(bySignal).toEqual({ L5: 9, L2C: 6 });
  });

  it('decodes an L5 data set — G26 vs KIRU RINEX 4.01', () => {
    const e = res.ephemerides.find(
      (x) => x.prn === 'G26' && x.signal === 'L5'
    )!;
    expect(e.system).toBe('G');
    expect(e.week).toBe(2428);
    expect(e.toe).toBe(358200);
    expect(e.toc).toBe(358200);
    expect(e.tocDate.getTime()).toBe(Date.UTC(2026, 6, 23, 3, 30, 0));
    expect(e.toeDate.getTime()).toBe(Date.UTC(2026, 6, 23, 3, 30, 0));
    relClose(e.af0, -3.845495812129e-4);
    relClose(e.af1, -2.462030579409e-12);
    expect(e.af2).toBe(0);
    relClose(e.aDot, 5.232334136963e-3);
    relClose(e.crs, 2.10703125e1);
    relClose(e.deltaN0, 5.501657737556e-9);
    relClose(e.m0, 1.620937715956);
    relClose(e.cuc, 1.192092895508e-6);
    relClose(e.e, 1.116985239787e-2);
    relClose(e.cus, 7.981434464455e-6);
    relClose(Math.sqrt(e.a), 5.153579372592e3);
    expect(e.top).toBe(288900);
    relClose(e.cic, -2.142041921616e-7);
    relClose(e.omega0, -1.641248798155);
    relClose(e.cis, 1.247972249985e-7);
    relClose(e.i0, 9.274569388642e-1);
    relClose(e.crc, 2.07625e2);
    relClose(e.omega, 7.152085418437e-1);
    relClose(e.omegaDot, -8.425473046822e-9);
    relClose(e.i0Dot, -2.762615074007e-10);
    relClose(e.deltaN0Dot, -3.812676251886e-14);
    expect(e.uraNed0).toBe(-2);
    expect(e.uraNed1).toBe(3);
    expect(e.uraNed2).toBe(7);
    expect(e.uraEd).toBe(-1);
    expect(e.health).toBe(1); // L5 signal flagged unhealthy (pre-op)
    relClose(e.tgd, 6.519258022308e-9);
    relClose(e.iscL1ca, -8.440110832453e-10);
    relClose(e.iscL2c, -4.19095158577e-9);
    relClose(e.iscL5i5, 5.820766091347e-9);
    relClose(e.iscL5q5, 5.87897375226e-9);
  });

  it('decodes an L2C data set — G29 (IIR-M) vs KIRU RINEX 4.01', () => {
    const e = res.ephemerides.find(
      (x) => x.prn === 'G29' && x.signal === 'L2C'
    )!;
    expect(e.toe).toBe(357900);
    expect(e.tocDate.getTime()).toBe(Date.UTC(2026, 6, 23, 3, 25, 0));
    relClose(e.af0, -2.767141559161e-4);
    relClose(e.af1, 7.37543359719e-12);
    relClose(e.aDot, -3.899574279785e-3);
    relClose(e.crs, 7.06640625e1);
    relClose(e.deltaN0, 4.455542734096e-9);
    relClose(e.m0, -4.072418428002e-1);
    relClose(e.e, 3.657415800262e-3);
    relClose(Math.sqrt(e.a), 5.153690619731e3);
    expect(e.top).toBe(348300);
    relClose(e.omega0, -4.191483041007e-1);
    relClose(e.i0, 9.601404422519e-1);
    relClose(e.omega, 2.870707012356);
    relClose(e.omegaDot, -8.067600997157e-9);
    relClose(e.tgd, -9.778887033463e-9);
    // No L5 on a IIR-M: the broadcast ISC_L5 fields are zero
    expect(e.iscL5i5).toBe(0);
    expect(e.iscL5q5).toBe(0);
  });

  it('yields identical fields on L2C and L5 for the same data set', () => {
    // Data-set fields must agree bit for bit across signals; transmit-
    // side properties (tow, which MT3x carried the clock) may differ.
    const FIELDS = [
      'week',
      'health',
      'uraEd',
      'uraNed0',
      'uraNed1',
      'uraNed2',
      'top',
      'toe',
      'a',
      'deltaA',
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
      'toc',
      'af0',
      'af1',
      'af2',
      'tgd',
      'iscL1ca',
      'iscL2c',
      'iscL5i5',
      'iscL5q5',
    ] as const;
    const l2c = res.ephemerides.filter((e) => e.signal === 'L2C');
    const l5 = res.ephemerides.filter((e) => e.signal === 'L5');
    let pairs = 0;
    for (const a of l2c) {
      const b = l5.find((x) => x.prn === a.prn && x.toe === a.toe);
      if (!b) continue;
      pairs++;
      for (const k of FIELDS) expect(b[k], `${a.prn} ${k}`).toBe(a[k]);
      expect(b.tocDate.getTime()).toBe(a.tocDate.getTime());
      expect(b.toeDate.getTime()).toBe(a.toeDate.getTime());
    }
    expect(pairs).toBeGreaterThanOrEqual(2);
  });
});

/* ================================================================== */
/*  u-blox RXM-SFRBX (GPS L2C)                                         */
/* ================================================================== */

/**
 * The UBX slice holds the first 20 GPS L2C RXM-SFRBX frames (gnssId 0,
 * sigId 3/4) of the rtklibexplorer ZED-F9P capture rover.ubx
 * (2020-12-24, GPS week 2137). No RINEX 4 CNAV product exists that
 * far back (BRD400DLR_S starts later; 404 for 2020/359), so the pinned
 * values are regression values from this decoder, validated two ways:
 * the identical bit layout passes the RINEX 4.01 field oracle on the
 * SBF path above, and positions propagated from all 18 full-capture
 * CNAV records agree with the same capture's LNAV ephemerides to
 * < 6 m (oracle-cnav.tmp.mjs, ADOT folded in; 100% CRC pass on 2629
 * messages — confirming the left-justified 32-bit word packing).
 */
describe.skipIf(!existsSync(UBX_FILE))('parseUbxCnav (F9P slice)', () => {
  const res = existsSync(UBX_FILE)
    ? parseUbxCnav(new Uint8Array(readFileSync(UBX_FILE)))
    : null!;

  it('decodes every raw message with clean CRC-24Q', () => {
    expect(res.messages).toBe(20);
    expect(res.badCrc).toBe(0);
    expect(res.ephemerides.map((e) => e.prn)).toEqual([
      'G04',
      'G09',
      'G27',
      'G07',
      'G08',
      'G26',
    ]);
  });

  it('decodes G04 (week 2137 — 13-bit CNAV week needs no rollover)', () => {
    const e = res.ephemerides[0]!;
    expect(e.prn).toBe('G04');
    expect(e.week).toBe(2137);
    expect(e.toe).toBe(423000);
    expect(e.toc).toBe(423000);
    expect(e.tocDate.getTime()).toBe(Date.UTC(2020, 11, 24, 21, 30, 0));
    expect(e.top).toBe(386100);
    relClose(e.deltaA, -129.365234375);
    relClose(e.aDot, -0.0008487701416015625);
    relClose(e.deltaN0, 4.715910722325102e-9);
    relClose(e.deltaN0Dot, 2.6812989078441416e-15);
    relClose(e.m0, -0.8473468280137019);
    relClose(e.e, 0.0010048351832665503);
    relClose(e.omega, -3.0744627785953393);
    relClose(e.omega0, 1.4349707439027526);
    relClose(e.i0, 0.9597891627054178);
    relClose(e.omegaDot, -8.089030461209048e-9);
    relClose(e.i0Dot, -2.137589039163567e-10);
    relClose(e.crs, -33.1796875);
    relClose(e.crc, 236.9140625);
    relClose(e.cus, 7.3444098234176636e-6);
    relClose(e.cuc, -1.7648562788963318e-6);
    relClose(e.af0, -0.00016715464880689979);
    relClose(e.af1, -3.204547738278052e-12);
    expect(e.af2).toBe(0);
    expect(e.uraEd).toBe(-3);
    expect(e.uraNed0).toBe(-6);
    // The slice ends before any MT30: clock from MT33, no TGD/ISCs
    expect(e.clockMsgType).toBe(33);
    expect(e.tgd).toBeNull();
    expect(e.iscL2c).toBeNull();
  });
});
