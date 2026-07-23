import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { setBitU } from '../src/navbits';
import {
  BdsAssembler,
  bdsSubframeParityOk,
  decodeBdsD1Frame,
  decodeBdsD2Frame,
  isBdsGeoPrn,
} from '../src/navbits/bds';
import {
  GloStringAssembler,
  decodeGloStrings,
  testGloString,
} from '../src/navbits/glo';
import { parseSbfBdsNav, parseSbfGloNav } from '../src/sbf/rawnav-bds';

const SBF_FILE = join(__dirname, '../test-fixtures/dlf5_bdsglo_slice.sbf');

/** RINEX prints ~13 significant digits; require agreement to that. */
function relClose(actual: number | undefined, expected: number) {
  expect(actual).toBeDefined();
  expect(Math.abs(actual! - expected)).toBeLessThanOrEqual(
    Math.abs(expected) * 1e-11 + 1e-19
  );
}

/** Write a possibly negative value split across two bit fields. */
function setSplit(
  b: Uint8Array,
  p1: number,
  l1: number,
  p2: number,
  l2: number,
  value: number
) {
  const u = value < 0 ? value + 2 ** (l1 + l2) : value;
  setBitU(b, p1, l1, Math.floor(u / 2 ** l2));
  setBitU(b, p2, l2, u % 2 ** l2);
}

/* ================================================================== */
/*  BDS BCH(15,11,1) word parity                                       */
/* ================================================================== */

/** Encode the 4 BCH(15,11,1) parity bits of an 11-bit info word. */
function bchParity(info: number): number {
  let r = info << 4;
  for (let i = 14; i >= 4; i--) if (r & (1 << i)) r ^= 0x13 << (i - 4);
  return r & 0xf;
}

/**
 * Build a parity-valid 300-bit subframe from 26+9×22 data bits laid
 * out at the RTKLIB/Septentrio de-interleaved positions: word 1 =
 * [15 unprotected][11 info][4 parity], words 2-10 = [11+11 info]
 * [4+4 parity].
 */
function withParity(sf: Uint8Array): Uint8Array {
  const get = (pos: number, len: number) => {
    let v = 0;
    for (let i = pos; i < pos + len; i++)
      v = v * 2 + ((sf[i >> 3]! >> (7 - (i & 7))) & 1);
    return v;
  };
  setBitU(sf, 26, 4, bchParity(get(15, 11)));
  for (let w = 1; w < 10; w++) {
    const base = 30 * w;
    setBitU(sf, base + 22, 4, bchParity(get(base, 11)));
    setBitU(sf, base + 26, 4, bchParity(get(base + 11, 11)));
  }
  return sf;
}

describe('bdsSubframeParityOk', () => {
  it('accepts a BCH-valid subframe and rejects a corrupted one', () => {
    const sf = new Uint8Array(38);
    setBitU(sf, 0, 11, 0x712); // preamble
    setBitU(sf, 15, 3, 1); // FraID
    setBitU(sf, 30, 12, 0xabc);
    setBitU(sf, 60, 13, 1072);
    withParity(sf);
    expect(bdsSubframeParityOk(sf)).toBe(true);

    for (const bit of [20, 45, 299]) {
      const bad = sf.slice();
      bad[bit >> 3]! ^= 1 << (7 - (bit & 7));
      expect(bdsSubframeParityOk(bad), `flipped bit ${bit}`).toBe(false);
    }
  });

  it('checks all known BCH codewords round-trip', () => {
    // g(x) = x^4+x+1: every 11-bit info word must verify with its
    // parity and fail with any other parity.
    for (const info of [0, 1, 0x555, 0x7ff, 0x123]) {
      const sf = new Uint8Array(38);
      setBitU(sf, 15, 11, info);
      withParity(sf);
      expect(bdsSubframeParityOk(sf)).toBe(true);
    }
  });
});

/* ================================================================== */
/*  BDS D1 / D2 frame decoding (synthetic)                             */
/* ================================================================== */

const D1_WEEK = 1072;
const D1_TOE = 352800; // = toc (D1 consistency rule), s of BDT week

/** Build D1 subframes 1-3 with a known field set. */
function buildD1(sow = 352806, toe = D1_TOE): Uint8Array {
  const b = new Uint8Array(3 * 38);
  for (let s = 0; s < 3; s++) {
    const i = s * 304;
    setBitU(b, i + 0, 11, 0x712);
    setBitU(b, i + 15, 3, s + 1); // FraID
    setSplit(b, i + 18, 8, i + 30, 12, sow + 6 * s);
  }
  /* subframe 1 */
  setBitU(b, 42, 1, 1); // SatH1
  setBitU(b, 60, 13, D1_WEEK);
  setSplit(b, 73, 9, 90, 8, D1_TOE / 8); // toc
  setSplit(b, 98, 10, 0, 0, -47); // tgd1 = -4.7 ns
  setSplit(b, 214, 11, 0, 0, -100); // af2
  setSplit(b, 225, 7, 240, 17, -654321); // af0
  setSplit(b, 257, 5, 270, 17, 98765); // af1
  /* subframe 2 */
  const i2 = 304;
  setSplit(b, i2 + 42, 10, i2 + 60, 6, 1234); // deltaN
  setSplit(b, i2 + 66, 16, i2 + 90, 2, -5678); // cuc
  setSplit(b, i2 + 92, 20, i2 + 120, 12, -87654321); // m0
  setSplit(b, i2 + 132, 10, i2 + 150, 22, 1867776); // e
  setSplit(b, i2 + 180, 18, 0, 0, 34567); // cus
  setSplit(b, i2 + 198, 4, i2 + 210, 14, -23456); // crc
  setSplit(b, i2 + 224, 8, i2 + 240, 10, 12345); // crs
  setSplit(b, i2 + 250, 12, i2 + 270, 20, 2770679808); // sqrtA
  setBitU(b, i2 + 290, 2, (toe / 8) >> 15); // toe MSB
  /* subframe 3 */
  const i3 = 608;
  setBitU(b, i3 + 42, 10, ((toe / 8) >> 5) & 0x3ff); // toe mid
  setBitU(b, i3 + 60, 5, (toe / 8) & 0x1f); // toe LSB
  setSplit(b, i3 + 65, 17, i3 + 90, 15, 649912345); // i0
  setSplit(b, i3 + 105, 7, i3 + 120, 11, -4321); // cic
  setSplit(b, i3 + 131, 11, i3 + 150, 13, -333222); // omegaDot
  setSplit(b, i3 + 163, 9, i3 + 180, 9, 7890); // cis
  setSplit(b, i3 + 189, 13, i3 + 210, 1, -1024); // idot
  setSplit(b, i3 + 211, 21, i3 + 240, 11, -1234567890); // omega0
  setSplit(b, i3 + 251, 11, i3 + 270, 21, 987654321); // omega
  return b;
}

describe('decodeBdsD1Frame (synthetic)', () => {
  const PI = 3.1415926535898;

  it('decodes all fields with BDS ICD scale factors', () => {
    const eph = decodeBdsD1Frame(buildD1(), { prn: 'C29' })!;
    expect(eph).not.toBeNull();
    expect(eph.system).toBe('C');
    expect(eph.prn).toBe('C29');
    expect(eph.week).toBe(D1_WEEK);
    expect(eph.toe).toBe(D1_TOE);
    // naive-BDT calendar Date (repo convention for BDS records)
    expect(eph.tocDate.getTime()).toBe(
      Date.UTC(2006, 0, 1) + (D1_WEEK * 7 * 86400 + D1_TOE) * 1000
    );
    expect(eph.svHealth).toBe(1);
    expect(eph.iode).toBe(Math.floor(D1_TOE / 720) % 240);
    relClose(eph.tgd, -47 * 0.1e-9);
    relClose(eph.af0, -654321 * 2 ** -33);
    relClose(eph.af1, 98765 * 2 ** -50);
    relClose(eph.af2, -100 * 2 ** -66);
    relClose(eph.deltaN, 1234 * 2 ** -43 * PI);
    relClose(eph.cuc, -5678 * 2 ** -31);
    relClose(eph.m0, -87654321 * 2 ** -31 * PI);
    relClose(eph.e, 1867776 * 2 ** -33);
    relClose(eph.cus, 34567 * 2 ** -31);
    relClose(eph.crc, -23456 * 2 ** -6);
    relClose(eph.crs, 12345 * 2 ** -6);
    relClose(eph.sqrtA, 2770679808 * 2 ** -19);
    relClose(eph.i0, 649912345 * 2 ** -31 * PI);
    relClose(eph.cic, -4321 * 2 ** -31);
    relClose(eph.omegaDot, -333222 * 2 ** -43 * PI);
    relClose(eph.cis, 7890 * 2 ** -31);
    relClose(eph.idot, -1024 * 2 ** -43 * PI);
    relClose(eph.omega0, -1234567890 * 2 ** -31 * PI);
    relClose(eph.omega, 987654321 * 2 ** -31 * PI);
  });

  it('rejects a broken SOW chain (mixed-issue frame)', () => {
    const b = buildD1();
    setSplit(b, 304 + 18, 8, 304 + 30, 12, 999); // subframe-2 SOW
    expect(decodeBdsD1Frame(b)).toBeNull();
  });

  it('resolves the toe week across a week boundary', () => {
    // sow near week end, toe just after rollover: week increments
    const b = buildD1(604794, 0);
    setSplit(b, 73, 9, 90, 8, 0); // toc = 0 to keep toc == toe
    const eph = decodeBdsD1Frame(b)!;
    expect(eph.week).toBe(D1_WEEK + 1);
    expect(eph.toe).toBe(0);
  });
});

describe('decodeBdsD2Frame (synthetic)', () => {
  const D2_TOE = 352800;

  function buildD2(sow = 352806): Uint8Array {
    const b = new Uint8Array(10 * 38);
    const sows = [0, 6, 9, 12, 15, 18, 21, 24, 27]; // pages 1,3..10
    for (let p = 0; p < 10; p++) {
      const i = p * 304;
      setBitU(b, i + 0, 11, 0x712);
      setBitU(b, i + 15, 3, 1); // subframe 1
      setBitU(b, i + 42, 4, p + 1); // Pnum
      if (p !== 1)
        setSplit(b, i + 18, 8, i + 30, 12, sow + sows[p > 1 ? p - 1 : 0]!);
    }
    /* page 1 */
    setBitU(b, 46, 1, 1); // SatH1
    setBitU(b, 64, 13, D1_WEEK);
    setSplit(b, 77, 5, 90, 12, D2_TOE / 8); // toc
    setSplit(b, 102, 10, 0, 0, 473); // tgd1
    /* page 3: af0, af1 MSBs */
    const p3 = 2 * 304;
    setSplit(b, p3 + 100, 12, p3 + 120, 12, -654321); // af0
    setSplit(b, p3 + 132, 4, 0, 0, -3); // af1 4-MSB (signed)
    /* page 4: af1 LSBs, af2, deltaN, cuc MSBs */
    const p4 = 3 * 304;
    setSplit(b, p4 + 46, 6, p4 + 60, 12, 98765 & 0x3ffff); // af1 18-LSB
    setSplit(b, p4 + 72, 10, p4 + 90, 1, -100); // af2
    setSplit(b, p4 + 96, 16, 0, 0, 1234); // deltaN
    setSplit(b, p4 + 120, 14, 0, 0, -355); // cuc 14-MSB
    /* page 5: cuc LSBs, m0, cus, e MSBs */
    const p5 = 4 * 304;
    setBitU(b, p5 + 46, 4, 2); // cuc 4-LSB
    setSplit(b, p5 + 50, 2, p5 + 90, 8, 0); // (m0 via 3 parts below)
    // m0 = -87654321: 32 bits split 2/22/8
    {
      const u = -87654321 + 2 ** 32;
      setBitU(b, p5 + 50, 2, Math.floor(u / 2 ** 30));
      setBitU(b, p5 + 60, 22, Math.floor(u / 2 ** 8) % 2 ** 22);
      setBitU(b, p5 + 90, 8, u % 2 ** 8);
    }
    setSplit(b, p5 + 98, 14, p5 + 120, 4, 34567); // cus
    setSplit(b, p5 + 124, 10, 0, 0, 0); // e 10-MSB (0 for small e)
    /* page 6: e LSBs, sqrtA, cic MSBs */
    const p6 = 5 * 304;
    setSplit(b, p6 + 46, 6, p6 + 60, 16, 1867776); // e 22-LSB
    {
      const u = 2770679808; // sqrtA, 32 bits split 6/22/4
      setBitU(b, p6 + 76, 6, Math.floor(u / 2 ** 26));
      setBitU(b, p6 + 90, 22, Math.floor(u / 2 ** 4) % 2 ** 22);
      setBitU(b, p6 + 120, 4, u % 2 ** 4);
    }
    setSplit(b, p6 + 124, 10, 0, 0, -17); // cic 10-MSB
    /* page 7: cic LSBs, cis, toe, i0 MSBs */
    const p7 = 6 * 304;
    setSplit(b, p7 + 46, 6, p7 + 60, 2, (-4321 + 2 ** 18) % 2 ** 8); // cic 8-LSB
    setSplit(b, p7 + 62, 18, 0, 0, 7890); // cis
    setSplit(b, p7 + 80, 2, p7 + 90, 15, D2_TOE / 8); // toe
    setSplit(b, p7 + 105, 7, p7 + 120, 14, 317339); // i0 21-MSB
    /* page 8: i0 LSBs, crc, crs, omegaDot MSBs */
    const p8 = 7 * 304;
    setSplit(b, p8 + 46, 6, p8 + 60, 5, 649912345 % 2 ** 11); // i0 11-LSB
    setSplit(b, p8 + 65, 17, p8 + 90, 1, -23456); // crc
    setSplit(b, p8 + 91, 18, 0, 0, 12345); // crs
    setSplit(b, p8 + 109, 3, p8 + 120, 16, -10414); // omegaDot 19-MSB
    /* page 9: omegaDot LSBs, omega0, omega MSBs */
    const p9 = 8 * 304;
    setBitU(b, p9 + 46, 5, (-333222 + 2 ** 24) % 2 ** 5); // omegaDot 5-LSB
    {
      const u = -1234567890 + 2 ** 32; // omega0, split 1/22/9
      setBitU(b, p9 + 51, 1, Math.floor(u / 2 ** 31));
      setBitU(b, p9 + 60, 22, Math.floor(u / 2 ** 9) % 2 ** 22);
      setBitU(b, p9 + 90, 9, u % 2 ** 9);
    }
    setSplit(b, p9 + 99, 13, p9 + 120, 14, Math.floor(987654321 / 2 ** 5)); // omega 27-MSB
    /* page 10: omega LSBs, idot */
    const p10 = 9 * 304;
    setBitU(b, p10 + 46, 5, 987654321 % 2 ** 5); // omega 5-LSB
    setSplit(b, p10 + 51, 1, p10 + 60, 13, -1024); // idot
    return b;
  }

  const PI = 3.1415926535898;

  it('reassembles the ephemeris split over pages 1-10', () => {
    const eph = decodeBdsD2Frame(buildD2(), { prn: 'C02' })!;
    expect(eph).not.toBeNull();
    expect(eph.prn).toBe('C02');
    expect(eph.week).toBe(D1_WEEK);
    expect(eph.toe).toBe(D2_TOE);
    expect(eph.svHealth).toBe(1);
    relClose(eph.tgd, 473 * 0.1e-9);
    relClose(eph.af0, -654321 * 2 ** -33);
    relClose(eph.af1, (-3 * 2 ** 18 + (98765 & 0x3ffff)) * 2 ** -50);
    relClose(eph.af2, -100 * 2 ** -66);
    relClose(eph.deltaN, 1234 * 2 ** -43 * PI);
    relClose(eph.cuc, (-355 * 16 + 2) * 2 ** -31);
    relClose(eph.m0, -87654321 * 2 ** -31 * PI);
    relClose(eph.e, 1867776 * 2 ** -33);
    relClose(eph.cus, 34567 * 2 ** -31);
    relClose(eph.sqrtA, 2770679808 * 2 ** -19);
    relClose(eph.cic, -4321 * 2 ** -31);
    relClose(eph.cis, 7890 * 2 ** -31);
    relClose(
      eph.i0,
      (317339 * 2 ** 11 + (649912345 % 2 ** 11)) * 2 ** -31 * PI
    );
    relClose(eph.crc, -23456 * 2 ** -6);
    relClose(eph.crs, 12345 * 2 ** -6);
    relClose(
      eph.omegaDot,
      (-10414 * 32 + ((-333222 + 2 ** 24) % 32)) * 2 ** -43 * PI
    );
    relClose(eph.omega0, -1234567890 * 2 ** -31 * PI);
    relClose(eph.omega, 987654321 * 2 ** -31 * PI);
    relClose(eph.idot, -1024 * 2 ** -43 * PI);
  });

  it('rejects a broken page-SOW chain', () => {
    const b = buildD2();
    setSplit(b, 3 * 304 + 18, 8, 3 * 304 + 30, 12, 1); // page-4 SOW
    expect(decodeBdsD2Frame(b)).toBeNull();
  });
});

describe('BdsAssembler', () => {
  it('emits on subframe 3 and suppresses unchanged repeats', () => {
    const a = new BdsAssembler();
    const frame = buildD1();
    const sf = (n: number) => frame.subarray(n * 38, (n + 1) * 38);
    expect(a.push('C29', sf(0))).toBeNull();
    expect(a.push('C29', sf(1))).toBeNull();
    const eph = a.push('C29', sf(2));
    expect(eph).not.toBeNull();
    expect(eph!.prn).toBe('C29');
    // unchanged rebroadcast: same toe suppressed
    a.push('C29', sf(0));
    a.push('C29', sf(1));
    expect(a.push('C29', sf(2))).toBeNull();
  });

  it('routes GEO PRNs to D2 (subframe-1 pages), not D1', () => {
    expect(isBdsGeoPrn(2)).toBe(true);
    expect(isBdsGeoPrn(29)).toBe(false);
    expect(isBdsGeoPrn(59)).toBe(true);
    const a = new BdsAssembler();
    // a D1-style subframe 3 for a GEO PRN must not decode anything
    expect(a.push('C02', buildD1().subarray(76, 114))).toBeNull();
  });
});

/* ================================================================== */
/*  GLONASS strings                                                    */
/* ================================================================== */

describe('testGloString', () => {
  // String 1 of R10 (L1 C/A) from the DLF5 capture — receiver
  // CRCPassed, so its KX Hamming code is known-good.
  const REAL = new Uint8Array([
    0x08, 0x15, 0xf9, 0x4f, 0x15, 0xd4, 0x21, 0x89, 0x49, 0xb9, 0x08,
  ]);

  it('accepts a real string and rejects double-bit corruption', () => {
    expect(testGloString(REAL)).toBe(true);
    // two flipped data bits: uncorrectable, must be rejected
    const bad = REAL.slice();
    bad[3] ^= 0x18;
    expect(testGloString(bad)).toBe(false);
  });

  it('flags every single corrupted checksum-region string', () => {
    let rejected = 0;
    for (let bit = 8; bit < 40; bit++) {
      const bad = REAL.slice();
      bad[bit >> 3]! ^= 1 << (7 - (bit & 7));
      bad[10] ^= 0x08; // also break the overall parity Σ
      if (!testGloString(bad)) rejected++;
    }
    expect(rejected).toBe(32);
  });
});

describe('decodeGloStrings (synthetic)', () => {
  // 2026-07-23 ~02:32 GPS scale; UTC day = Thursday (tod ≈ 9 100 s)
  const REF = new Date(Date.UTC(2026, 6, 23, 2, 32, 8));

  function buildStrings(): Uint8Array {
    const b = new Uint8Array(40);
    for (let s = 0; s < 4; s++) setBitU(b, s * 80 + 1, 4, s + 1);
    /* string 1: tk = 05:31:30 MT, x fields */
    setBitU(b, 9, 5, 5); // tk hours
    setBitU(b, 14, 6, 31); // tk minutes
    setBitU(b, 20, 1, 1); // tk 30-s bit
    setBitU(b, 21, 24, 2 ** 23 + 1933276); // xDot: sign-magnitude, negative
    setBitU(b, 45, 5, 9); // xAcc
    setBitU(b, 50, 27, 41946163); // x
    /* string 2: Bn, tb, y fields */
    setBitU(b, 85, 1, 1); // Bn MSB (unhealthy)
    setBitU(b, 89, 7, 23); // tb → toe 02:45 UTC
    setBitU(b, 101, 24, 928895); // yDot
    setBitU(b, 125, 5, 2 ** 4 + 1); // yAcc negative
    setBitU(b, 130, 27, 2 ** 26 + 6252826); // y negative
    /* string 3: gamma, z fields */
    setBitU(b, 166, 11, 2 ** 10 + 2); // gammaN negative
    setBitU(b, 181, 24, 2834879); // zDot
    setBitU(b, 205, 5, 1); // zAcc
    setBitU(b, 210, 27, 30583172); // z
    /* string 4: tau, slot */
    setBitU(b, 245, 22, 2 ** 21 + 61590); // tauN negative
    setBitU(b, 310, 5, 19); // slot
    return b;
  }

  it('decodes with parseNavFile conventions (km, UTC, RINEX signs)', () => {
    const eph = decodeGloStrings(buildStrings(), REF, { freqNum: 3 })!;
    expect(eph).not.toBeNull();
    expect(eph.system).toBe('R');
    expect(eph.prn).toBe('R19');
    expect(eph.freqNum).toBe(3);
    expect(eph.health).toBe(1);
    // tb = 23 → 23·900 − 10800 s UTC = 02:45:00 of the UTC day
    expect(eph.tocDate.getTime()).toBe(Date.UTC(2026, 6, 23, 2, 45, 0));
    // tk 05:31:30 MT → 02:31:30 UTC, seconds of the UTC week
    expect(eph.messageFrameTime).toBe(4 * 86400 + 2 * 3600 + 31 * 60 + 30);
    relClose(eph.tauN, 61590 * 2 ** -30); // RINEX sign: −τn
    relClose(eph.gammaN, -2 * 2 ** -40);
    relClose(eph.x, 41946163 * 2 ** -11); // km
    relClose(eph.xDot, -1933276 * 2 ** -20);
    relClose(eph.xAcc, 9 * 2 ** -30);
    relClose(eph.y, -6252826 * 2 ** -11);
    relClose(eph.yDot, 928895 * 2 ** -20);
    relClose(eph.yAcc, -1 * 2 ** -30);
    relClose(eph.z, 30583172 * 2 ** -11);
    relClose(eph.zDot, 2834879 * 2 ** -20);
    relClose(eph.zAcc, 1 * 2 ** -30);
  });

  it('rejects wrong string numbers and slot 0', () => {
    const b = buildStrings();
    setBitU(b, 81, 4, 5); // string 2 slot carries a string-5
    expect(decodeGloStrings(b, REF)).toBeNull();
    const b2 = buildStrings();
    setBitU(b2, 310, 5, 0); // slot 0: unknown
    expect(decodeGloStrings(b2, REF)).toBeNull();
  });
});

describe('GloStringAssembler', () => {
  const REF = new Date(Date.UTC(2026, 6, 23, 2, 32, 8));

  function stringsOf(buf: Uint8Array): Uint8Array[] {
    return [0, 1, 2, 3].map((s) => buf.subarray(s * 10, s * 10 + 10));
  }

  it('emits on string 4 and suppresses unchanged repeats', () => {
    const a = new GloStringAssembler();
    const b = new Uint8Array(40);
    for (let s = 0; s < 4; s++) setBitU(b, s * 80 + 1, 4, s + 1);
    setBitU(b, 9, 5, 5);
    setBitU(b, 14, 6, 31);
    setBitU(b, 89, 7, 23);
    setBitU(b, 310, 5, 19);
    const strs = stringsOf(b);
    expect(a.push('R19', strs[0]!, REF, 3)).toBeNull();
    expect(a.push('R19', strs[1]!, REF, 3)).toBeNull();
    expect(a.push('R19', strs[2]!, REF, 3)).toBeNull();
    const eph = a.push('R19', strs[3]!, REF, 3);
    expect(eph).not.toBeNull();
    expect(eph!.prn).toBe('R19');
    // repeat of the same frame content: suppressed
    for (const s of strs.slice(0, 3)) a.push('R19', s, REF, 3);
    expect(a.push('R19', strs[3]!, REF, 3)).toBeNull();
  });

  it('drops a frame whose string-4 slot mismatches the SVID', () => {
    const a = new GloStringAssembler();
    const b = new Uint8Array(40);
    for (let s = 0; s < 4; s++) setBitU(b, s * 80 + 1, 4, s + 1);
    setBitU(b, 89, 7, 23);
    setBitU(b, 310, 5, 7); // slot 7, pushed as R19
    let eph = null;
    for (const s of stringsOf(b)) eph = a.push('R19', s, REF, 0);
    expect(eph).toBeNull();
  });

  it('resets the string buffer after a > 30 s gap', () => {
    const a = new GloStringAssembler();
    const b = new Uint8Array(40);
    for (let s = 0; s < 4; s++) setBitU(b, s * 80 + 1, 4, s + 1);
    setBitU(b, 89, 7, 23);
    setBitU(b, 310, 5, 19);
    const strs = stringsOf(b);
    for (const s of strs.slice(0, 3)) a.push('R19', s, REF, 0);
    // string 4 arrives 40 s later: strings 1-3 must have been wiped
    const late = new Date(REF.getTime() + 40000);
    expect(a.push('R19', strs[3]!, late, 0)).toBeNull();
  });
});

/* ================================================================== */
/*  Septentrio BDSRaw / GLORawCA (DLF5 slice)                          */
/* ================================================================== */

/**
 * The SBF slice holds the first 3 minutes of BDSRaw/GLORawCA blocks of
 * the TU Delft DLF5 mosaic-X5 capture dlf5_long.sbf (caster,
 * 2026-07-23 02:31 UTC, GPS week 2428). Expected values are pinned
 * from RTKLIB demo5 convbin -r sbf output for the same capture parsed
 * back through parseNavFile — the full-file oracle
 * (oracle-bdsglo.tmp.mjs) matched all 15 BDS records (D1 + the C02
 * GEO D2, worst relative difference 4.4e-12) and all 11 GLONASS
 * records (worst 3.9e-12) field for field, and the raw decode agrees
 * with the captures' decoded BDSNav/GLONav blocks on every broadcast
 * field (BDS `iode` excepted: the raw path derives AODE from toc per
 * RTKLIB/RINEX convention while the decoded block carries the
 * broadcast AODE).
 *
 * Known convbin delta, asserted here as documented: RTKLIB's
 * decode_glorawcanav decodes ephemeris and UTC together and its UTC
 * part needs string 5, so convbin's FIRST GLONASS emission per
 * satellite waits one extra frame — its RINEX tof is this decoder's
 * messageFrameTime + 30 s. This decoder's value is the tk of the
 * frame that carried the record, consistent with the receiver's own
 * GLONav blocks (block time = tk + 8 s, the string-4 offset).
 */
describe.skipIf(!existsSync(SBF_FILE))('parseSbf{Bds,Glo}Nav (DLF5)', () => {
  const data = existsSync(SBF_FILE)
    ? new Uint8Array(readFileSync(SBF_FILE))
    : null!;
  const bds = data ? parseSbfBdsNav(data) : null!;
  const glo = data ? parseSbfGloNav(data) : null!;

  it('decodes and dedups the raw BDS blocks', () => {
    expect(bds.messages).toBe(1408);
    // The 98 parity rejects are exactly the blocks the receiver
    // itself flags CRCPassed=0 (low-elevation GEO C02); over the full
    // capture the BCH verdict agrees with CRCPassed on all 7456
    // blocks, both ways.
    expect(bds.badCrc).toBe(98);
    expect(bds.ephemerides.map((e) => e.prn).sort()).toEqual([
      'C02',
      'C06',
      'C09',
      'C11',
      'C12',
      'C20',
      'C24',
      'C25',
      'C26',
      'C29',
      'C31',
      'C32',
      'C34',
      'C35',
      'C39',
    ]);
  });

  it('decodes a D1 record — C29 vs convbin RINEX', () => {
    const e = bds.ephemerides.find((x) => x.prn === 'C29')!;
    expect(e.system).toBe('C');
    expect(e.week).toBe(1072); // BDT week
    expect(e.toe).toBe(352800); // BDT s of week
    // naive-BDT calendar epoch, like parseNavFile
    expect(e.tocDate.getTime()).toBe(Date.UTC(2026, 6, 23, 2, 0, 0));
    expect(e.iode).toBe(10);
    expect(e.svHealth).toBe(0);
    relClose(e.af0, 6.34600059129e-4);
    relClose(e.af1, 5.24735810359e-12);
    expect(e.af2).toBe(0);
    relClose(e.crs, 6.74375e1);
    relClose(e.deltaN, 4.01088135502e-9);
    relClose(e.m0, -2.7855792973e-1);
    relClose(e.cuc, 3.33040952682e-6);
    relClose(e.e, 2.17377208173e-4);
    relClose(e.cus, 4.03495505452e-6);
    relClose(e.sqrtA, 5.28265986824e3);
    relClose(e.cic, -1.16415321827e-8);
    relClose(e.omega0, 3.31721297295e-2);
    relClose(e.cis, -2.09547579288e-8);
    relClose(e.i0, 9.4555819626e-1);
    relClose(e.crc, 2.74234375e2);
    relClose(e.omega, 2.13119529919);
    relClose(e.omegaDot, -7.02064958109e-9);
    relClose(e.idot, -1.20362156424e-10);
    relClose(e.tgd, 2.0e-10);
  });

  it('decodes the GEO D2 record — C02 vs convbin RINEX', () => {
    const e = bds.ephemerides.find((x) => x.prn === 'C02')!;
    expect(e.week).toBe(1072);
    expect(e.toe).toBe(352800);
    expect(e.tocDate.getTime()).toBe(Date.UTC(2026, 6, 23, 2, 0, 0));
    expect(e.iode).toBe(10);
    expect(e.svHealth).toBe(0);
    relClose(e.af0, 7.64848664403e-8);
    relClose(e.af1, 1.50990331349e-14);
    expect(e.af2).toBe(0);
    relClose(e.crs, 1.968125e2);
    relClose(e.deltaN, 6.56348768132e-9);
    relClose(e.m0, -1.00646927891);
    relClose(e.cuc, 6.53229653835e-6);
    relClose(e.e, 2.32205726206e-4);
    relClose(e.cus, -2.42097303271e-6);
    relClose(e.sqrtA, 6.49341443825e3);
    relClose(e.cic, -3.67872416973e-8);
    relClose(e.omega0, -3.13415558477);
    relClose(e.cis, 1.51805579662e-7);
    relClose(e.i0, 9.08827060409e-2); // GEO: near-zero inclination
    relClose(e.crc, 6.7765625e1);
    relClose(e.omega, -1.54029251868e-1);
    relClose(e.omegaDot, -5.56380318331e-9);
    relClose(e.idot, 3.09655755548e-10);
    relClose(e.tgd, 4.73e-8);
  });

  it('decodes and dedups the raw GLONASS strings', () => {
    expect(glo.messages).toBe(1666);
    expect(glo.badCrc).toBe(0);
    expect(glo.ephemerides.map((e) => e.prn).sort()).toEqual([
      'R01',
      'R02',
      'R08',
      'R09',
      'R10',
      'R16',
      'R17',
      'R18',
      'R19',
      'R20',
      'R26',
    ]);
  });

  it('decodes R19 vs convbin RINEX (UTC epoch, km, RINEX signs)', () => {
    const e = glo.ephemerides.find((x) => x.prn === 'R19')!;
    expect(e.system).toBe('R');
    expect(e.tocDate.getTime()).toBe(Date.UTC(2026, 6, 23, 2, 45, 0));
    relClose(e.tauN, 5.73685392737e-5);
    relClose(e.gammaN, 1.81898940355e-12);
    // convbin prints 354720 (tk of the frame AFTER its delayed first
    // emission — see the block comment); the broadcast tk here is the
    // frame the record actually came from, 30 s earlier.
    expect(e.messageFrameTime).toBe(354690);
    relClose(e.x, 2.04815253906e4);
    relClose(e.xDot, -1.84407424927);
    expect(e.xAcc).toBe(0);
    relClose(e.y, -3.0528125e3);
    relClose(e.yDot, 8.85911941528e-1);
    relClose(e.yAcc, 9.31322574615e-10);
    relClose(e.z, 1.49322167969e4);
    relClose(e.zDot, 2.7034330368);
    relClose(e.zAcc, -9.31322574615e-10);
    expect(e.health).toBe(0);
    expect(e.freqNum).toBe(3);
  });

  it('all GLONASS records share the joint toe; only R26 unhealthy', () => {
    for (const e of glo.ephemerides) {
      expect(e.tocDate.getTime()).toBe(Date.UTC(2026, 6, 23, 2, 45, 0));
      // R26 broadcasts Bn = 1 (convbin prints health 1 for it too)
      expect(e.health, e.prn).toBe(e.prn === 'R26' ? 1 : 0);
      expect(e.freqNum).toBeGreaterThanOrEqual(-7);
      expect(e.freqNum).toBeLessThanOrEqual(6);
    }
  });
});
