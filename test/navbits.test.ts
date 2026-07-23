import { describe, it, expect } from 'vitest';
import {
  GPS_PI,
  decodeGpsLnavFrame,
  getBitS,
  getBitU,
  setBitS,
  setBitU,
} from '../src/navbits';

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);

describe('bit helpers', () => {
  it('round-trips unsigned values across byte boundaries', () => {
    const buf = new Uint8Array(8);
    setBitU(buf, 3, 32, 0xdeadbeef);
    expect(getBitU(buf, 3, 32)).toBe(0xdeadbeef);
    setBitU(buf, 37, 17, 100799); // max TOW count
    expect(getBitU(buf, 37, 17)).toBe(100799);
    expect(getBitU(buf, 3, 32)).toBe(0xdeadbeef); // neighbours intact
  });

  it("round-trips two's-complement signed values", () => {
    const buf = new Uint8Array(10);
    for (const [pos, len, v] of [
      [0, 8, -128],
      [11, 22, -75149],
      [40, 14, -1],
      [54, 24, 8388607],
      [78, 1, 0],
    ] as const) {
      setBitS(buf, pos, len, v);
      expect(getBitS(buf, pos, len)).toBe(v);
    }
  });
});

/** Raw (unscaled) LNAV field values, per IS-GPS-200 subframes 1–3. */
interface LnavRaw {
  tow: number; // 17-bit TOW count (×6 s)
  week: number; // 10-bit week
  svh: number;
  iodc: number; // 10 bits
  tgd: number; // signed 8 bits
  toc: number; // 16-bit count (×16 s)
  af2: number;
  af1: number;
  af0: number;
  iode: number;
  crs: number;
  deltaN: number;
  m0: number;
  cuc: number;
  e: number; // unsigned 32
  cus: number;
  sqrtA: number; // unsigned 32
  toes: number; // 16-bit count (×16 s)
  cic: number;
  omega0: number;
  cis: number;
  i0: number;
  crc: number;
  omega: number;
  omegaDot: number; // signed 24
  iode3: number;
  idot: number; // signed 14
}

/**
 * Encode subframes 1–3 in the parity-stripped format RAWEPHEM
 * delivers: ten 24-bit data words per subframe packed MSB-first into
 * 30 bytes (TLM word first, HOW second), 90 bytes total.
 */
function encodeLnavFrame(f: LnavRaw): Uint8Array {
  const buf = new Uint8Array(90);
  for (const [n, id] of [1, 2, 3].entries()) {
    let i = 240 * n + 24; // skip the TLM word
    setBitU(buf, i, 17, f.tow);
    i += 17 + 2; // alert + anti-spoof flags
    setBitU(buf, i, 3, id);
    i += 3 + 2; // HOW trailing bits
    if (id === 1) {
      setBitU(buf, i, 10, f.week);
      i += 10;
      setBitU(buf, i, 2, 1); // codes on L2
      i += 2;
      setBitU(buf, i, 4, 2); // URA index
      i += 4;
      setBitU(buf, i, 6, f.svh);
      i += 6;
      setBitU(buf, i, 2, f.iodc >> 8);
      i += 2;
      i += 1 + 87; // L2 P flag + reserved
      setBitS(buf, i, 8, f.tgd);
      i += 8;
      setBitU(buf, i, 8, f.iodc & 0xff);
      i += 8;
      setBitU(buf, i, 16, f.toc);
      i += 16;
      setBitS(buf, i, 8, f.af2);
      i += 8;
      setBitS(buf, i, 16, f.af1);
      i += 16;
      setBitS(buf, i, 22, f.af0);
    } else if (id === 2) {
      setBitU(buf, i, 8, f.iode);
      i += 8;
      setBitS(buf, i, 16, f.crs);
      i += 16;
      setBitS(buf, i, 16, f.deltaN);
      i += 16;
      setBitS(buf, i, 32, f.m0);
      i += 32;
      setBitS(buf, i, 16, f.cuc);
      i += 16;
      setBitU(buf, i, 32, f.e);
      i += 32;
      setBitS(buf, i, 16, f.cus);
      i += 16;
      setBitU(buf, i, 32, f.sqrtA);
      i += 32;
      setBitU(buf, i, 16, f.toes);
      i += 16;
      setBitU(buf, i, 1, 0); // fit interval flag
    } else {
      setBitS(buf, i, 16, f.cic);
      i += 16;
      setBitS(buf, i, 32, f.omega0);
      i += 32;
      setBitS(buf, i, 16, f.cis);
      i += 16;
      setBitS(buf, i, 32, f.i0);
      i += 32;
      setBitS(buf, i, 16, f.crc);
      i += 16;
      setBitS(buf, i, 32, f.omega);
      i += 32;
      setBitS(buf, i, 24, f.omegaDot);
      i += 24;
      setBitU(buf, i, 8, f.iode3);
      i += 8;
      setBitS(buf, i, 14, f.idot);
    }
  }
  return buf;
}

const RAW: LnavRaw = {
  tow: 85870, // 515220 s
  week: 538, // 1562 mod 1024
  svh: 5,
  iodc: 110,
  tgd: -25,
  toc: 32400, // 518400 s
  af2: 3,
  af1: -18,
  af0: -75149,
  iode: 110,
  crs: 80, // 2.5 m
  deltaN: 1234,
  m0: -987654321,
  cuc: 600,
  e: 89123456,
  cus: 9500,
  sqrtA: 2701234567,
  toes: 32400,
  cic: 164,
  omega0: 1387654321,
  cis: 356,
  i0: 607000000,
  crc: 8138, // 254.3125 m
  omega: 529000000,
  omegaDot: -19678,
  iode3: 110,
  idot: 65,
};

describe('decodeGpsLnavFrame', () => {
  const eph = decodeGpsLnavFrame(encodeLnavFrame(RAW), {
    prn: 'G11',
    refWeek: 1562,
  })!;

  it('decodes the synthetic frame', () => {
    expect(eph).not.toBeNull();
    expect(eph.system).toBe('G');
    expect(eph.prn).toBe('G11');
  });

  it('resolves the 10-bit week and epochs', () => {
    expect(eph.week).toBe(1562);
    expect(eph.toe).toBe(518400);
    expect(eph.tocDate.getTime()).toBe(
      GPS_EPOCH_MS + (1562 * 604800 + 518400) * 1000
    );
    expect(eph.tocDate.toISOString()).toBe('2009-12-19T00:00:00.000Z');
    // Mirrors parseNavFile's seconds-of-week convention.
    expect(eph.toc).toBe((eph.tocDate.getTime() / 1000) % 604800);
  });

  it('applies the IS-GPS-200 scale factors exactly', () => {
    expect(eph.svHealth).toBe(5);
    expect(eph.iode).toBe(110);
    expect(eph.tgd).toBe(-25 * 2 ** -31);
    expect(eph.af2).toBe(3 * 2 ** -55);
    expect(eph.af1).toBe(-18 * 2 ** -43);
    expect(eph.af0).toBe(-75149 * 2 ** -31);
    expect(eph.crs).toBe(2.5);
    expect(eph.crc).toBe(254.3125);
    expect(eph.deltaN).toBe(1234 * 2 ** -43 * GPS_PI);
    expect(eph.m0).toBe(-987654321 * 2 ** -31 * GPS_PI);
    expect(eph.cuc).toBe(600 * 2 ** -29);
    expect(eph.e).toBe(89123456 * 2 ** -33);
    expect(eph.cus).toBe(9500 * 2 ** -29);
    expect(eph.sqrtA).toBe(2701234567 * 2 ** -19);
    expect(eph.cic).toBe(164 * 2 ** -29);
    expect(eph.omega0).toBe(1387654321 * 2 ** -31 * GPS_PI);
    expect(eph.cis).toBe(356 * 2 ** -29);
    expect(eph.i0).toBe(607000000 * 2 ** -31 * GPS_PI);
    expect(eph.omega).toBe(529000000 * 2 ** -31 * GPS_PI);
    expect(eph.omegaDot).toBe(-19678 * 2 ** -43 * GPS_PI);
    expect(eph.idot).toBe(65 * 2 ** -43 * GPS_PI);
  });

  it('maps the reserved TGD value -128 to 0', () => {
    const e2 = decodeGpsLnavFrame(encodeLnavFrame({ ...RAW, tgd: -128 }), {
      refWeek: 1562,
    })!;
    expect(e2.tgd).toBe(0);
    expect(e2.prn).toBe('G00'); // default when the caller has no PRN
  });

  it('increments the week when toe rolls over past the frame time', () => {
    // Frame sent at end-of-week, ephemeris referenced to the next week.
    const e2 = decodeGpsLnavFrame(
      encodeLnavFrame({ ...RAW, tow: 100700, toes: 0, toc: 0 }),
      { refWeek: 1562 }
    )!;
    expect(e2.week).toBe(1563);
    expect(e2.toe).toBe(0);
  });

  it('rejects inconsistent frames', () => {
    // IODE (subframe 2/3) vs IODC LSBs mismatch
    expect(
      decodeGpsLnavFrame(encodeLnavFrame({ ...RAW, iode: 111, iode3: 111 }))
    ).toBeNull();
    // Mixed issues of data between subframes 2 and 3
    expect(
      decodeGpsLnavFrame(encodeLnavFrame({ ...RAW, iode3: 109 }))
    ).toBeNull();
    // Wrong subframe IDs (shift subframe order by one)
    const shuffled = encodeLnavFrame(RAW);
    shuffled.copyWithin(0, 30, 60);
    expect(decodeGpsLnavFrame(shuffled)).toBeNull();
    // Truncated input
    expect(decodeGpsLnavFrame(encodeLnavFrame(RAW).subarray(0, 89))).toBeNull();
  });
});
