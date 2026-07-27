import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getBitU, setBitU } from '../src/navbits';
import { crc24q } from '../src/navbits/cnav';
import { parseUbxRawNav } from '../src/ubx/rawnav';
import type { GlonassEphemeris, KeplerEphemeris } from '../src/rinex/nav';

const UBX_FILE = join(__dirname, '../test-fixtures/f9p_rawnav_slice.ubx');

/** RINEX prints ~13 significant digits; require agreement to that. */
function relClose(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
    Math.abs(expected) * 1e-11 + 1e-19
  );
}

/* ================================================================== */
/*  Synthetic UBX frames                                               */
/* ================================================================== */

/** Wrap a payload in a checksummed UBX frame. */
function ubxFrame(cls: number, id: number, payload: Uint8Array): Uint8Array {
  const f = new Uint8Array(8 + payload.length);
  f[0] = 0xb5;
  f[1] = 0x62;
  f[2] = cls;
  f[3] = id;
  f[4] = payload.length & 0xff;
  f[5] = payload.length >> 8;
  f.set(payload, 6);
  fixChecksum(f, 0, payload.length);
  return f;
}

/** Recompute the Fletcher checksum of the frame at `start`. */
function fixChecksum(data: Uint8Array, start: number, payloadLen: number) {
  let a = 0;
  let b = 0;
  for (let j = start + 2; j < start + 6 + payloadLen; j++) {
    a = (a + data[j]!) & 0xff;
    b = (b + a) & 0xff;
  }
  data[start + 6 + payloadLen] = a;
  data[start + 7 + payloadLen] = b;
}

/** Build one RXM-SFRBX frame from 32-bit dwrd values. */
function sfrbx(
  gnssId: number,
  svId: number,
  sigId: number,
  freqId: number,
  dwrds: number[]
): Uint8Array {
  const p = new Uint8Array(8 + 4 * dwrds.length);
  p[0] = gnssId;
  p[1] = svId;
  p[2] = sigId;
  p[3] = freqId;
  p[4] = dwrds.length;
  p[6] = 2; // version
  const v = new DataView(p.buffer);
  dwrds.forEach((w, k) => v.setUint32(8 + 4 * k, w, true));
  return ubxFrame(0x02, 0x13, p);
}

function concat(frames: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(frames.reduce((s, f) => s + f.length, 0));
  let o = 0;
  for (const f of frames) {
    out.set(f, o);
    o += f.length;
  }
  return out;
}

/* ── Galileo: a 234-bit page pair packed the u-blox way ──────────── */

/** Assemble a 16-byte I/NAV word: type + IODNav + caller fields. */
function inavWord(
  type: number,
  iodNav: number | null,
  fields: (b: Uint8Array) => void
): Uint8Array {
  const w = new Uint8Array(16);
  setBitU(w, 0, 6, type);
  if (iodNav !== null) setBitU(w, 6, 10, iodNav);
  fields(w);
  return w;
}

/** Wrap a 128-bit word into a CRC'd 234-bit even+odd page pair. */
function inavPage(word: Uint8Array): Uint8Array {
  const p = new Uint8Array(30);
  for (let k = 0; k < 14; k++) setBitU(p, 2 + 8 * k, 8, word[k]!);
  setBitU(p, 114, 1, 1); // odd part: Even/Odd=1
  setBitU(p, 116, 8, word[14]!);
  setBitU(p, 124, 8, word[15]!);
  setBitU(p, 196, 24, crc24q(p, 196));
  return p;
}

/**
 * Pack a 234-bit page pair into u-blox SFRBX dwrds: the 114-bit even
 * part left-justified in dwrd 0-3 (pad below), the 120-bit odd part
 * left-justified in dwrd 4-7. E1B carries a 9th reserved word.
 */
function inavDwrds(page: Uint8Array, e1b: boolean): number[] {
  const d = [
    getBitU(page, 0, 32),
    getBitU(page, 32, 32),
    getBitU(page, 64, 32),
    getBitU(page, 96, 18) * 2 ** 14,
    getBitU(page, 114, 32),
    getBitU(page, 146, 32),
    getBitU(page, 178, 32),
    getBitU(page, 210, 24) * 2 ** 8,
  ];
  if (e1b) d.push(0);
  return d;
}

const IOD = 100;
const TOE = 345600; // = toc of the synthetic data set (s of week)
const GST_WEEK = 1404; // GPS week 2428

/** I/NAV words 1-5 of a consistent synthetic data set for E11. */
function inavWords(): Uint8Array[] {
  return [
    inavWord(1, IOD, (b) => {
      setBitU(b, 16, 14, TOE / 60);
      setBitU(b, 30, 32, 2 ** 32 - 1234567); // M0 = −1234567·2⁻³¹·π
      setBitU(b, 62, 32, 8388608); // e = 2⁻¹⁰
      setBitU(b, 94, 32, 2852126720); // sqrtA = 5440
    }),
    inavWord(2, IOD, (b) => {
      setBitU(b, 16, 32, 2 ** 30); // Ω0 = 0.5π
      setBitU(b, 48, 32, 2 ** 29); // i0 = 0.25π
      setBitU(b, 80, 32, 2 ** 32 - 2 ** 28); // ω = −0.125π
      setBitU(b, 112, 14, 2 ** 14 - 100); // idot
    }),
    inavWord(3, IOD, (b) => {
      setBitU(b, 16, 24, 2 ** 24 - 50000); // Ω̇
      setBitU(b, 40, 16, 3000); // Δn
      setBitU(b, 56, 16, 2 ** 16 - 200); // cuc
      setBitU(b, 72, 16, 300); // cus
      setBitU(b, 88, 16, 8000); // crc = 250
      setBitU(b, 104, 16, 2 ** 16 - 4000); // crs = −125
    }),
    inavWord(4, IOD, (b) => {
      setBitU(b, 16, 6, 11); // SVID
      setBitU(b, 22, 16, 2 ** 16 - 700); // cic
      setBitU(b, 38, 16, 800); // cis
      setBitU(b, 54, 14, TOE / 60); // toc
      setBitU(b, 68, 31, 2 ** 31 - 100000); // af0
      setBitU(b, 99, 21, 1000); // af1
      setBitU(b, 120, 6, 2 ** 6 - 3); // af2
    }),
    inavWord(5, null, (b) => {
      setBitU(b, 47, 10, 2 ** 10 - 10); // BGD E5a/E1 = −10·2⁻³²
      setBitU(b, 57, 10, 20); // BGD E5b/E1
      setBitU(b, 67, 2, 1); // E5b HS
      setBitU(b, 71, 1, 1); // E5b DVS
      setBitU(b, 73, 12, GST_WEEK);
      setBitU(b, 85, 20, 345000); // TOW
    }),
  ];
}

/* ── BeiDou: a parity-valid D1 frame packed the u-blox way ───────── */

/** Encode the 4 BCH(15,11,1) parity bits of an 11-bit info word. */
function bchParity(info: number): number {
  let r = info << 4;
  for (let i = 14; i >= 4; i--) if (r & (1 << i)) r ^= 0x13 << (i - 4);
  return r & 0xf;
}

/** Fill the BCH parity bits of one 300-bit de-interleaved subframe. */
function withParity(sf: Uint8Array): Uint8Array {
  setBitU(sf, 26, 4, bchParity(getBitU(sf, 15, 11)));
  for (let w = 1; w < 10; w++) {
    const base = 30 * w;
    setBitU(sf, base + 22, 4, bchParity(getBitU(sf, base, 11)));
    setBitU(sf, base + 26, 4, bchParity(getBitU(sf, base + 11, 11)));
  }
  return sf;
}

const D1_WEEK = 781;
const D1_TOE = 421200; // = toc (D1 consistency rule), s of BDT week

/** Split a value across two D1 bit fields. */
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

/** Build parity-valid D1 subframes 1-3 with a small known field set. */
function buildD1(sow = 421206): Uint8Array[] {
  const subframes: Uint8Array[] = [];
  for (let s = 0; s < 3; s++) {
    const b = new Uint8Array(38);
    setBitU(b, 0, 11, 0x712); // preamble
    setBitU(b, 15, 3, s + 1); // FraID
    setSplit(b, 18, 8, 30, 12, sow + 6 * s);
    if (s === 0) {
      setBitU(b, 42, 1, 1); // SatH1
      setBitU(b, 60, 13, D1_WEEK);
      setSplit(b, 73, 9, 90, 8, D1_TOE / 8); // toc
      setSplit(b, 98, 10, 0, 0, -47); // tgd1 = −4.7 ns
      setSplit(b, 225, 7, 240, 17, -654321); // af0
    } else if (s === 1) {
      setSplit(b, 250, 12, 270, 20, 2770679808); // sqrtA
      setBitU(b, 290, 2, (D1_TOE / 8) >> 15); // toe MSB
    } else {
      setBitU(b, 42, 10, ((D1_TOE / 8) >> 5) & 0x3ff); // toe mid
      setBitU(b, 60, 5, (D1_TOE / 8) & 0x1f); // toe LSB
    }
    subframes.push(withParity(b));
  }
  return subframes;
}

/** Pack one 300-bit subframe into 10 dwrds (30 LSBs each). */
const bdsDwrds = (sf: Uint8Array) =>
  Array.from({ length: 10 }, (_, k) => getBitU(sf, 30 * k, 30));

/* ── GLONASS: a Hamming-valid string packed the u-blox way ───────── */

// String 1 of R10 (L1 C/A) from the DLF5 capture — receiver CRCPassed,
// so its KX Hamming code is known-good (see test/bdsglo-raw.test.ts).
const GLO_REAL = new Uint8Array([
  0x08, 0x15, 0xf9, 0x4f, 0x15, 0xd4, 0x21, 0x89, 0x49, 0xb9, 0x08,
]);

/** Pack an 85-bit string into 4 dwrds, big-endian per word. */
function gloDwrds(str: Uint8Array): number[] {
  const b = new Uint8Array(16);
  b.set(str.subarray(0, 11));
  return Array.from(
    { length: 4 },
    (_, k) =>
      b[4 * k]! * 2 ** 24 +
      b[4 * k + 1]! * 2 ** 16 +
      b[4 * k + 2]! * 256 +
      b[4 * k + 3]!
  );
}

/** A minimal RXM-RAWX frame carrying only the epoch (week + tow). */
function rawx(week: number, tow: number): Uint8Array {
  const p = new Uint8Array(16);
  new DataView(p.buffer).setFloat64(0, tow, true);
  new DataView(p.buffer).setUint16(8, week, true);
  return ubxFrame(0x02, 0x15, p);
}

/* ================================================================== */
/*  parseUbxRawNav (synthetic frames)                                  */
/* ================================================================== */

describe('parseUbxRawNav (synthetic)', () => {
  it('returns nothing on an empty or garbage stream', () => {
    expect(parseUbxRawNav(new Uint8Array(0))).toEqual({
      ephemerides: [],
      counts: { gal: 0, bds: 0, glo: 0, sbas: 0 },
      badParity: 0,
    });
    expect(
      parseUbxRawNav(new Uint8Array([1, 2, 3, 0xb5, 0x62, 9])).ephemerides
    ).toEqual([]);
  });

  it('assembles a Galileo I/NAV set across E1B and E5b frames', () => {
    const words = inavWords();
    const frames = words.map((w, k) =>
      // words 1-4 via E1B (9 dwrds), word 5 via E5b (8 dwrds): the two
      // carriers broadcast the same words and share one assembler
      k < 4
        ? sfrbx(2, 11, 1, 0, inavDwrds(inavPage(w), true))
        : sfrbx(2, 11, 5, 0, inavDwrds(inavPage(w), false))
    );
    const res = parseUbxRawNav(concat(frames));
    expect(res.counts).toEqual({ gal: 5, bds: 0, glo: 0, sbas: 0 });
    expect(res.badParity).toBe(0);
    expect(res.ephemerides).toHaveLength(1);
    const e = res.ephemerides[0] as KeplerEphemeris;
    expect(e.system).toBe('E');
    expect(e.prn).toBe('E11');
    expect(e.iode).toBe(IOD);
    expect(e.toe).toBe(TOE);
    expect(e.week).toBe(GST_WEEK + 1024);
    expect(e.sqrtA).toBe(5440);
    expect(e.crc).toBe(250);
    expect(e.crs).toBe(-125);
    expect(e.af1).toBe(1000 * 2 ** -46);
    expect(e.tgd).toBe(-10 * 2 ** -32); // BGD E5a/E1
    expect(e.svHealth).toBe((1 << 7) | (1 << 6)); // E5b HS=1, DVS=1
  });

  it('counts a corrupted I/NAV page in badParity', () => {
    const page = inavPage(inavWords()[0]!);
    page[5]! ^= 0x40;
    const res = parseUbxRawNav(
      concat([sfrbx(2, 11, 1, 0, inavDwrds(page, true))])
    );
    expect(res.counts.gal).toBe(1);
    expect(res.badParity).toBe(1);
  });

  it('assembles a BeiDou D1 frame from 30-LSB dwrd words', () => {
    const frames = buildD1().map((sf) => sfrbx(3, 29, 0, 0, bdsDwrds(sf)));
    const res = parseUbxRawNav(concat(frames));
    expect(res.counts).toEqual({ gal: 0, bds: 3, glo: 0, sbas: 0 });
    expect(res.badParity).toBe(0);
    expect(res.ephemerides).toHaveLength(1);
    const e = res.ephemerides[0] as KeplerEphemeris;
    expect(e.system).toBe('C');
    expect(e.prn).toBe('C29');
    expect(e.week).toBe(D1_WEEK);
    expect(e.toe).toBe(D1_TOE);
    expect(e.svHealth).toBe(1);
    relClose(e.tgd, -4.7e-9);
    relClose(e.af0, -654321 * 2 ** -33);
    relClose(e.sqrtA, 2770679808 * 2 ** -19);
  });

  it('counts a BCH parity failure in badParity', () => {
    const sf = buildD1()[0]!;
    sf[3]! ^= 0x08; // flip a protected data bit, keep old parity
    const res = parseUbxRawNav(concat([sfrbx(3, 29, 0, 0, bdsDwrds(sf))]));
    expect(res.counts.bds).toBe(1);
    expect(res.badParity).toBe(1);
  });

  it('checks the GLONASS Hamming code and needs a time reference', () => {
    const t = rawx(2137, 422922);
    const str = sfrbx(6, 10, 0, 5, gloDwrds(GLO_REAL));
    // valid string after a RAWX epoch: accepted (buffered, no eph yet)
    const ok = parseUbxRawNav(concat([t, str]));
    expect(ok.counts.glo).toBe(1);
    expect(ok.badParity).toBe(0);
    // corrupted string: badParity
    const bad = GLO_REAL.slice();
    bad[3]! ^= 0x18;
    const rej = parseUbxRawNav(concat([t, sfrbx(6, 10, 0, 5, gloDwrds(bad))]));
    expect(rej.badParity).toBe(1);
    // no RXM-RAWX first: the string is skipped, not counted as bad
    const skipped = parseUbxRawNav(concat([str]));
    expect(skipped.counts.glo).toBe(1);
    expect(skipped.badParity).toBe(0);
  });
});

/* ================================================================== */
/*  parseUbxRawNav (ZED-F9P slice vs convbin)                          */
/* ================================================================== */

/**
 * The fixture holds the first 4 minutes of RXM-SFRBX (all) and
 * RXM-RAWX (thinned to one epoch per 5 s) frames of rtklibexplorer's
 * ZED-F9P PPP capture f9p_ppp_1224/rover.ubx (2020-12-24 21:28:42
 * GPS, week 2137). Expected values are pinned from RTKLIB demo5
 * convbin -r ubx output for the same slice parsed back through
 * parseNavFile — the full-capture oracle (oracle-ubxrawnav.tmp.mjs)
 * matched every convbin record: 62/62 Galileo (worst relative
 * difference 4.7e-12), 17/17 BeiDou (4.5e-12) and 37/37 GLONASS
 * (4.7e-12), with convbin's printed GLONASS message-frame time equal
 * to this decoder's broadcast-tk value on every matched record
 * (RTKLIB's decode_glostr also derives tof from tk).
 *
 * Known convbin delta, asserted below as documented: RTKLIB dedups
 * GLONASS rebroadcasts by iode (tb) alone, so when R09 flips its Bn
 * health flag (and updates τn) within the same tb, convbin keeps only
 * the pre-flip record; this decoder's tb+health dedup key emits the
 * health-flagged update as well — the one "extra" record per run.
 * The capture tracks no BeiDou GEO, so the D2 path is exercised by
 * the SBF suite (test/bdsglo-raw.test.ts), not here.
 */
describe.skipIf(!existsSync(UBX_FILE))('parseUbxRawNav (F9P slice)', () => {
  const data = existsSync(UBX_FILE)
    ? new Uint8Array(readFileSync(UBX_FILE))
    : null!;
  const res = data ? parseUbxRawNav(data) : null!;
  const sys = (s: string) => res.ephemerides.filter((e) => e.prn[0] === s);

  it('routes and checks every SFRBX message', () => {
    expect(res.counts).toEqual({ gal: 1789, bds: 400, glo: 2162, sbas: 726 });
    // the F9P forwards only parity-clean messages in SFRBX
    expect(res.badParity).toBe(0);
  });

  it('decodes the SBAS GEO (type-9) records to geostationary orbits', () => {
    const geo = sys('S') as GlonassEphemeris[];
    // three GEO PRNs (S31, S33, S38), two epochs each in this slice
    expect([...new Set(geo.map((e) => e.prn))].sort()).toEqual([
      'S31',
      'S33',
      'S38',
    ]);
    for (const e of geo) {
      const r = Math.hypot(e.x, e.y, e.z); // km
      // geostationary radius ≈ 42 164 km; station-kept, near-zero velocity
      expect(r).toBeGreaterThan(42000);
      expect(r).toBeLessThan(42300);
      expect(Math.hypot(e.xDot, e.yDot, e.zDot)).toBeLessThan(0.01);
      expect(e.health).toBe(0);
      expect(e.freqNum).toBe(0);
    }
  });

  it('decodes the Galileo I/NAV records convbin emits', () => {
    const gal = sys('E') as KeplerEphemeris[];
    expect(gal).toHaveLength(15);
    expect([...new Set(gal.map((e) => e.prn))].sort()).toEqual([
      'E01',
      'E04',
      'E09',
      'E14',
      'E19',
      'E21',
      'E27',
      'E31',
    ]);
    // E19, data set of 21:20 GPS — convbin RINEX record, field for field
    const e = gal.find(
      (x) =>
        x.prn === 'E19' &&
        x.tocDate.getTime() === Date.UTC(2020, 11, 24, 21, 20, 0)
    )!;
    expect(e.week).toBe(2137);
    expect(e.iode).toBe(64);
    expect(e.toe).toBe(422400);
    expect(e.svHealth).toBe(0);
    relClose(e.af0, 1.61248608492e-4);
    relClose(e.af1, 9.52127265919e-12);
    expect(e.af2).toBe(0);
    relClose(e.crs, -4.128125e1);
    relClose(e.deltaN, 3.48121643521e-9);
    relClose(e.m0, 3.87024425395e-1);
    relClose(e.cuc, -1.86450779438e-6);
    relClose(e.e, 1.37205701321e-4);
    relClose(e.cus, 5.75743615627e-6);
    relClose(e.sqrtA, 5.44060747528e3);
    relClose(e.cic, 3.53902578354e-8);
    relClose(e.omega0, 1.17922042971);
    relClose(e.cis, 1.86264514923e-9);
    relClose(e.i0, 9.59673020908e-1);
    relClose(e.crc, 2.1596875e2);
    relClose(e.omega, 2.34216479567);
    relClose(e.omegaDot, -5.74381068134e-9);
    relClose(e.idot, -1.15361948145e-10);
    relClose(e.tgd, -3.95812094212e-9); // BGD E5a/E1, the RINEX slot
  });

  it('decodes the BeiDou D1 records convbin emits', () => {
    const bds = sys('C') as KeplerEphemeris[];
    expect(bds.map((e) => e.prn).sort()).toEqual([
      'C08',
      'C14',
      'C21',
      'C24',
      'C25',
      'C26',
      'C29',
      'C33',
    ]);
    // C29 — convbin RINEX record, field for field (BDT epochs/week)
    const e = bds.find((x) => x.prn === 'C29')!;
    expect(e.week).toBe(781); // BDT week
    expect(e.toe).toBe(421200); // BDT s of week
    expect(e.tocDate.getTime()).toBe(Date.UTC(2020, 11, 24, 21, 0, 0));
    expect(e.iode).toBe(105); // derived from toc, RTKLIB convention
    expect(e.svHealth).toBe(0);
    relClose(e.af0, 3.29195871018e-4);
    relClose(e.af1, 5.12301312483e-12);
    expect(e.af2).toBe(0);
    relClose(e.crs, -8.44375e1);
    relClose(e.deltaN, 3.66622414152e-9);
    relClose(e.m0, -3.65778429557e-1);
    relClose(e.cuc, -4.20119613409e-6);
    relClose(e.e, 3.85869061574e-5);
    relClose(e.cus, 6.6040083766e-6);
    relClose(e.sqrtA, 5.28262361717e3);
    relClose(e.cic, 2.32830643654e-8);
    relClose(e.omega0, -1.39850187854);
    relClose(e.cis, 1.95577740669e-8);
    relClose(e.i0, 9.65273321474e-1);
    relClose(e.crc, 2.2775e2);
    relClose(e.omega, 1.14716232673);
    relClose(e.omegaDot, -6.89421574319e-9);
    relClose(e.idot, -2.87869133762e-10);
    relClose(e.tgd, 2.0e-10);
  });

  it('decodes the GLONASS records convbin emits, plus the R09 health flip', () => {
    const glo = sys('R') as GlonassEphemeris[];
    expect(glo).toHaveLength(20); // convbin: 19 (see the block comment)
    expect([...new Set(glo.map((e) => e.prn))].sort()).toEqual([
      'R05',
      'R06',
      'R07',
      'R08',
      'R09',
      'R10',
      'R15',
      'R16',
      'R17',
      'R18',
    ]);
    // R09, tb of 21:15 UTC — convbin RINEX record, field for field
    const r9 = glo.filter((x) => x.prn === 'R09');
    expect(r9).toHaveLength(2);
    const e = r9[0]!;
    expect(e.tocDate.getTime()).toBe(Date.UTC(2020, 11, 24, 21, 15, 0));
    relClose(e.tauN, 1.48760154843e-5);
    relClose(e.gammaN, 2.72848410532e-12);
    // seconds of the UTC week, from the broadcast tk — equal to
    // convbin's printed tof (RTKLIB derives it from tk as well)
    expect(e.messageFrameTime).toBe(422910);
    relClose(e.x, -1.73907675781e4);
    relClose(e.xDot, 1.28048324585);
    relClose(e.xAcc, -9.31322574615e-10);
    relClose(e.y, -1.51404604492e4);
    relClose(e.yDot, 7.88305282593e-1);
    relClose(e.yAcc, 9.31322574615e-10);
    relClose(e.z, 1.09964853516e4);
    relClose(e.zDot, 3.10873985291);
    relClose(e.zAcc, -1.86264514923e-9);
    expect(e.health).toBe(0);
    expect(e.freqNum).toBe(-2);
    // 90 s later R09 rebroadcasts the same tb with Bn=1 and an updated
    // τn: emitted here (tb+health dedup), suppressed by convbin (iode).
    const flip = r9[1]!;
    expect(flip.tocDate.getTime()).toBe(e.tocDate.getTime());
    expect(flip.health).toBe(1);
    expect(flip.messageFrameTime).toBe(423000);
    relClose(flip.tauN, 1.48806720972e-5);
    expect(flip.x).toBe(e.x); // same tb: same state vector
  });

  it('skips GLONASS without a RAWX time reference; refWeek fixes week 0', () => {
    // strip every RXM-RAWX frame: no time reference, no GLONASS
    const noRawx: Uint8Array[] = [];
    const zeroWeek = data.slice();
    let i = 0;
    while (i + 8 <= data.length) {
      const len = data[i + 4]! | (data[i + 5]! << 8);
      const end = i + 6 + len + 2;
      if (data[i + 3] === 0x15) {
        // blank the week field of the zero-week copy and re-checksum
        zeroWeek[i + 6 + 8] = 0;
        zeroWeek[i + 6 + 9] = 0;
        fixChecksum(zeroWeek, i, len);
      } else {
        noRawx.push(data.subarray(i, end));
      }
      i = end;
    }

    const stripped = parseUbxRawNav(concat(noRawx));
    expect(stripped.counts).toEqual(res.counts);
    expect(stripped.ephemerides.filter((e) => e.prn[0] === 'R')).toHaveLength(
      0
    );
    // Galileo/BeiDou carry their own week: unaffected
    expect(stripped.ephemerides.filter((e) => e.prn[0] === 'E')).toHaveLength(
      15
    );
    expect(stripped.ephemerides.filter((e) => e.prn[0] === 'C')).toHaveLength(
      8
    );

    // week 0 in every RAWX: unusable alone, resolved by refWeek
    expect(
      parseUbxRawNav(zeroWeek).ephemerides.filter((e) => e.prn[0] === 'R')
    ).toHaveLength(0);
    const withRef = parseUbxRawNav(zeroWeek, { refWeek: 2137 });
    expect(withRef.ephemerides).toEqual(res.ephemerides);
  });
});
