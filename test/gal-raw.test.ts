import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { GPS_PI, setBitU } from '../src/navbits';
import { crc24q } from '../src/navbits/cnav';
import {
  GalFnavAssembler,
  GalInavAssembler,
  galFnavPageCrcOk,
  galInavPageCrcOk,
} from '../src/navbits/gal';
import { crc16 } from '../src/sbf/frame';
import { parseSbfGalNav } from '../src/sbf/rawnav-gal';
import type { KeplerEphemeris } from '../src/rinex/nav';

const SBF_FILE = join(__dirname, '../test-fixtures/dlf5_galraw_slice.sbf');

/** RINEX prints ~13 significant digits; require agreement to that. */
function relClose(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
    Math.abs(expected) * 1e-11 + 1e-19
  );
}

/* ================================================================== */
/*  Synthetic pages                                                    */
/* ================================================================== */

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
function inavPage(word: Uint8Array, alert = false): Uint8Array {
  const p = new Uint8Array(32);
  setBitU(p, 1, 1, alert ? 1 : 0); // even part: Even/Odd=0, Page Type
  for (let k = 0; k < 14; k++) setBitU(p, 2 + 8 * k, 8, word[k]!);
  setBitU(p, 114, 1, 1); // odd part: Even/Odd=1
  setBitU(p, 115, 1, alert ? 1 : 0);
  setBitU(p, 116, 8, word[14]!);
  setBitU(p, 124, 8, word[15]!);
  setBitU(p, 196, 24, crc24q(p, 196));
  return p;
}

/** Assemble a CRC'd 244-bit F/NAV page. */
function fnavPage(type: number, fields: (b: Uint8Array) => void): Uint8Array {
  const p = new Uint8Array(31);
  setBitU(p, 0, 6, type);
  fields(p);
  setBitU(p, 214, 24, crc24q(p, 214));
  return p;
}

const IOD = 100;
const TOE = 345600; // = toc of the synthetic data set (s of week)
const GST_WEEK = 1404; // GPS week 2428
const TOW = 345000;

/** I/NAV words 1-5 of a consistent synthetic data set for E11. */
function inavWords(iod = IOD): Uint8Array[] {
  return [
    inavWord(1, iod, (b) => {
      setBitU(b, 16, 14, TOE / 60);
      setBitU(b, 30, 32, 2 ** 32 - 1234567); // M0 = −1234567·2⁻³¹·π
      setBitU(b, 62, 32, 8388608); // e = 2⁻¹⁰
      setBitU(b, 94, 32, 2852126720); // sqrtA = 5440
    }),
    inavWord(2, iod, (b) => {
      setBitU(b, 16, 32, 2 ** 30); // Ω0 = 0.5π
      setBitU(b, 48, 32, 2 ** 29); // i0 = 0.25π
      setBitU(b, 80, 32, 2 ** 32 - 2 ** 28); // ω = −0.125π
      setBitU(b, 112, 14, 2 ** 14 - 100); // idot = −100·2⁻⁴³·π
    }),
    inavWord(3, iod, (b) => {
      setBitU(b, 16, 24, 2 ** 24 - 50000); // Ω̇ = −50000·2⁻⁴³·π
      setBitU(b, 40, 16, 3000); // Δn
      setBitU(b, 56, 16, 2 ** 16 - 200); // cuc = −200·2⁻²⁹
      setBitU(b, 72, 16, 300); // cus
      setBitU(b, 88, 16, 8000); // crc = 250
      setBitU(b, 104, 16, 2 ** 16 - 4000); // crs = −125
    }),
    inavWord(4, iod, (b) => {
      setBitU(b, 16, 6, 11); // SVID
      setBitU(b, 22, 16, 2 ** 16 - 700); // cic = −700·2⁻²⁹
      setBitU(b, 38, 16, 800); // cis
      setBitU(b, 54, 14, TOE / 60); // toc
      setBitU(b, 68, 31, 2 ** 31 - 100000); // af0 = −100000·2⁻³⁴
      setBitU(b, 99, 21, 1000); // af1 = 1000·2⁻⁴⁶
      setBitU(b, 120, 6, 2 ** 6 - 3); // af2 = −3·2⁻⁵⁹
    }),
    inavWord(5, null, (b) => {
      setBitU(b, 47, 10, 2 ** 10 - 10); // BGD E5a/E1 = −10·2⁻³²
      setBitU(b, 57, 10, 20); // BGD E5b/E1
      setBitU(b, 67, 2, 1); // E5b HS
      setBitU(b, 69, 2, 0); // E1B HS
      setBitU(b, 71, 1, 1); // E5b DVS
      setBitU(b, 72, 1, 0); // E1B DVS
      setBitU(b, 73, 12, GST_WEEK);
      setBitU(b, 85, 20, TOW);
    }),
  ];
}

/** F/NAV pages 1-4: same orbit/clock numbers as the I/NAV set. */
function fnavPages(iod = IOD): Uint8Array[] {
  return [
    fnavPage(1, (b) => {
      setBitU(b, 6, 6, 11); // SVID
      setBitU(b, 12, 10, iod);
      setBitU(b, 22, 14, TOE / 60); // toc
      setBitU(b, 36, 31, 2 ** 31 - 100000); // af0
      setBitU(b, 67, 21, 1000); // af1
      setBitU(b, 88, 6, 2 ** 6 - 3); // af2
      setBitU(b, 143, 10, 2 ** 10 - 10); // BGD E5a/E1
      setBitU(b, 153, 2, 2); // E5a HS
      setBitU(b, 155, 12, GST_WEEK);
      setBitU(b, 167, 20, TOW);
      setBitU(b, 187, 1, 1); // E5a DVS
    }),
    fnavPage(2, (b) => {
      setBitU(b, 6, 10, iod);
      setBitU(b, 16, 32, 2 ** 32 - 1234567); // M0
      setBitU(b, 48, 24, 2 ** 24 - 50000); // Ω̇
      setBitU(b, 72, 32, 8388608); // e
      setBitU(b, 104, 32, 2852126720); // sqrtA
      setBitU(b, 136, 32, 2 ** 30); // Ω0
      setBitU(b, 168, 14, 2 ** 14 - 100); // idot
    }),
    fnavPage(3, (b) => {
      setBitU(b, 6, 10, iod);
      setBitU(b, 16, 32, 2 ** 29); // i0
      setBitU(b, 48, 32, 2 ** 32 - 2 ** 28); // ω
      setBitU(b, 80, 16, 3000); // Δn
      setBitU(b, 96, 16, 2 ** 16 - 200); // cuc
      setBitU(b, 112, 16, 300); // cus
      setBitU(b, 128, 16, 8000); // crc
      setBitU(b, 144, 16, 2 ** 16 - 4000); // crs
      setBitU(b, 160, 14, TOE / 60); // toe
    }),
    fnavPage(4, (b) => {
      setBitU(b, 6, 10, iod);
      setBitU(b, 16, 16, 2 ** 16 - 700); // cic
      setBitU(b, 32, 16, 800); // cis
    }),
  ];
}

/** Field values shared by both synthetic message types. */
function expectSyntheticOrbit(e: KeplerEphemeris) {
  expect(e.system).toBe('E');
  expect(e.prn).toBe('E11');
  expect(e.iode).toBe(IOD);
  expect(e.toe).toBe(TOE);
  expect(e.week).toBe(2428); // GST 1404 + 1024
  expect(e.tocDate.getTime()).toBe(
    Date.UTC(1980, 0, 6) + (2428 * 604800 + TOE) * 1000
  );
  expect(e.m0).toBe(-1234567 * 2 ** -31 * GPS_PI);
  expect(e.e).toBe(2 ** -10);
  expect(e.sqrtA).toBe(5440);
  expect(e.omega0).toBe(0.5 * GPS_PI);
  expect(e.i0).toBe(0.25 * GPS_PI);
  expect(e.omega).toBe(-0.125 * GPS_PI);
  expect(e.idot).toBe(-100 * 2 ** -43 * GPS_PI);
  expect(e.omegaDot).toBe(-50000 * 2 ** -43 * GPS_PI);
  expect(e.deltaN).toBe(3000 * 2 ** -43 * GPS_PI);
  expect(e.cuc).toBe(-200 * 2 ** -29);
  expect(e.cus).toBe(300 * 2 ** -29);
  expect(e.crc).toBe(250);
  expect(e.crs).toBe(-125);
  expect(e.cic).toBe(-700 * 2 ** -29);
  expect(e.cis).toBe(800 * 2 ** -29);
  expect(e.af0).toBe(-100000 * 2 ** -34);
  expect(e.af1).toBe(1000 * 2 ** -46);
  expect(e.af2).toBe(-3 * 2 ** -59);
  expect(e.tgd).toBe(-10 * 2 ** -32); // BGD E5a/E1 in both message types
}

/* ================================================================== */
/*  Page CRCs                                                          */
/* ================================================================== */

describe('galInavPageCrcOk / galFnavPageCrcOk', () => {
  it('accepts well-formed pages and rejects corrupted ones', () => {
    const ip = inavPage(inavWords()[0]!);
    expect(galInavPageCrcOk(ip)).toBe(true);
    const badI = ip.slice();
    badI[5] ^= 0x40;
    expect(galInavPageCrcOk(badI)).toBe(false);

    const fp = fnavPages()[0]!;
    expect(galFnavPageCrcOk(fp)).toBe(true);
    const badF = fp.slice();
    badF[10] ^= 0x01;
    expect(galFnavPageCrcOk(badF)).toBe(false);
  });

  it('rejects short buffers', () => {
    expect(galInavPageCrcOk(new Uint8Array(27))).toBe(false);
    expect(galFnavPageCrcOk(new Uint8Array(29))).toBe(false);
  });
});

/* ================================================================== */
/*  Assemblers (synthetic pages)                                       */
/* ================================================================== */

describe('GalInavAssembler (synthetic pages)', () => {
  it('emits after word types 1-5 with parseNavFile field conventions', () => {
    const a = new GalInavAssembler();
    const words = inavWords();
    for (let k = 0; k < 4; k++)
      expect(a.push(11, inavPage(words[k]!))).toBeNull();
    const eph = a.push(11, inavPage(words[4]!));
    expect(eph).not.toBeNull();
    expectSyntheticOrbit(eph!);
    // I/NAV health: E5b HS=1 → bit 7, E5b DVS=1 → bit 6 (RINEX layout)
    expect(eph!.svHealth).toBe((1 << 7) | (1 << 6));
  });

  it('suppresses unchanged repeats of the same data set', () => {
    const a = new GalInavAssembler();
    const words = inavWords();
    for (const w of words) a.push(11, inavPage(w));
    expect(a.push(11, inavPage(words[4]!))).toBeNull();
  });

  it('rejects mixed-IODNav word sets until refreshed', () => {
    const a = new GalInavAssembler();
    const words = inavWords();
    for (const w of words) a.push(11, inavPage(w));
    // word 1 of the next issue arrives, then word 5: IODNav mismatch
    expect(a.push(11, inavPage(inavWords(IOD + 1)[0]!))).toBeNull();
    expect(a.push(11, inavPage(words[4]!))).toBeNull();
    // remaining words of the new issue complete the set again
    const next = inavWords(IOD + 1);
    for (let k = 1; k < 4; k++) a.push(11, inavPage(next[k]!));
    const eph = a.push(11, inavPage(next[4]!));
    expect(eph).not.toBeNull();
    expect(eph!.iode).toBe(IOD + 1);
  });

  it('ignores alert pages and satellite mismatches', () => {
    const a = new GalInavAssembler();
    const words = inavWords();
    for (let k = 0; k < 4; k++) a.push(11, inavPage(words[k]!));
    expect(a.push(11, inavPage(words[4]!, true))).toBeNull(); // alert
    // word-4 SVID (11) disagrees with the pushing satellite
    const b = new GalInavAssembler();
    for (let k = 0; k < 5; k++)
      expect(b.push(12, inavPage(words[k]!))).toBeNull();
  });
});

describe('GalFnavAssembler (synthetic pages)', () => {
  it('emits after page types 1-4 with parseNavFile field conventions', () => {
    const a = new GalFnavAssembler();
    const pages = fnavPages();
    for (let k = 0; k < 3; k++) expect(a.push(11, pages[k]!)).toBeNull();
    const eph = a.push(11, pages[3]!);
    expect(eph).not.toBeNull();
    expectSyntheticOrbit(eph!);
    // F/NAV health: E5a HS=2 → bits 4-5, E5a DVS=1 → bit 3
    expect(eph!.svHealth).toBe((2 << 4) | (1 << 3));
  });

  it('ignores dummy pages (type 63) and suppresses repeats', () => {
    const a = new GalFnavAssembler();
    const dummy = new Uint8Array(31);
    setBitU(dummy, 0, 6, 63);
    expect(a.push(11, dummy)).toBeNull();
    const pages = fnavPages();
    for (const p of pages) a.push(11, p);
    expect(a.push(11, pages[3]!)).toBeNull(); // unchanged repeat
  });
});

/* ================================================================== */
/*  parseSbfGalNav (synthetic SBF blocks)                              */
/* ================================================================== */

/** Wrap a page in a GALRawINAV/GALRawFNAV SBF block (svid = E prn+70). */
function sbfGalBlock(
  id: number,
  svid: number,
  source: number,
  page: Uint8Array
): Uint8Array {
  const out = new Uint8Array(52);
  out[0] = 0x24;
  out[1] = 0x40;
  const view = new DataView(out.buffer);
  view.setUint16(4, id, true);
  view.setUint16(6, 52, true);
  view.setUint32(8, 431997000, true); // TOW
  view.setUint16(12, 2428, true); // WNc
  out[14] = svid;
  out[15] = 1; // CRCPassed
  out[17] = source;
  for (let k = 0; k < 8; k++) {
    const w =
      ((page[4 * k] ?? 0) << 24) |
      ((page[4 * k + 1] ?? 0) << 16) |
      ((page[4 * k + 2] ?? 0) << 8) |
      (page[4 * k + 3] ?? 0);
    view.setUint32(20 + 4 * k, w >>> 0, true);
  }
  view.setUint16(2, crc16(out, 4, 52), true);
  return out;
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

describe('parseSbfGalNav (synthetic blocks)', () => {
  it('assembles I/NAV and F/NAV blocks into tagged records', () => {
    const stream = concat([
      ...inavWords().map((w) => sbfGalBlock(4023, 81, 17, inavPage(w))),
      ...fnavPages().map((p) => sbfGalBlock(4022, 81, 20, p)),
    ]);
    const res = parseSbfGalNav(stream);
    expect(res.messages).toBe(9);
    expect(res.badCrc).toBe(0);
    expect(res.ephemerides.length).toBe(2);
    expect(res.ephemerides[0]!.source).toBe('inav');
    expect(res.ephemerides[1]!.source).toBe('fnav');
    for (const e of res.ephemerides) expectSyntheticOrbit(e);
  });

  it('skips non-Galileo signal sources and counts CRC failures', () => {
    const words = inavWords();
    const bad = inavPage(words[4]!);
    bad[3] ^= 0x08;
    const stream = concat([
      ...words.slice(0, 4).map((w) => sbfGalBlock(4023, 81, 17, inavPage(w))),
      sbfGalBlock(4023, 81, 0, inavPage(words[4]!)), // bogus source: L1CA
      sbfGalBlock(4023, 81, 21, bad), // corrupted page (E5b)
    ]);
    const res = parseSbfGalNav(stream);
    expect(res.messages).toBe(6);
    expect(res.badCrc).toBe(1);
    expect(res.ephemerides.length).toBe(0);
  });
});

/* ================================================================== */
/*  DLF5 capture slice                                                 */
/* ================================================================== */

/**
 * The slice holds the first 410 GALRawINAV/GALRawFNAV blocks of the
 * DLF5 mosaic-X5 log dlf5_long.sbf (TU Delft caster, 2026-07-23),
 * whole SBF frames — enough pages for 11 I/NAV and 3 F/NAV complete
 * ephemerides. Expected values are pinned from RTKLIB demo5 convbin's
 * RINEX 3.04 nav conversion of the same blocks (convbin emits the
 * same 14 records) — the full-file oracle (oracle-galraw.tmp.mjs)
 * matched all 34 records (816 fields) with a worst relative
 * difference of 3.7e-12, every I/NAV record's orbit and BGD E5a/E1
 * identical to its F/NAV twin with differing clock sets, and all 17
 * decoded GALNav blocks of the capture agreeing with the raw-decoded
 * records to 2.4e-15.
 */
describe.skipIf(!existsSync(SBF_FILE))('parseSbfGalNav (DLF5 slice)', () => {
  const res = existsSync(SBF_FILE)
    ? parseSbfGalNav(new Uint8Array(readFileSync(SBF_FILE)))
    : null!;

  it('assembles every complete data set with clean CRCs', () => {
    expect(res.messages).toBe(410);
    expect(res.badCrc).toBe(0);
    expect(res.ephemerides.length).toBe(14);
    const bySrc: Record<string, number> = {};
    for (const e of res.ephemerides)
      bySrc[e.source] = (bySrc[e.source] ?? 0) + 1;
    expect(bySrc).toEqual({ inav: 11, fnav: 3 });
  });

  it('decodes an I/NAV record — E18 vs convbin RINEX', () => {
    const e = res.ephemerides.find(
      (x) => x.prn === 'E18' && x.source === 'inav'
    )!;
    expect(e.tocDate.getTime()).toBe(Date.UTC(2026, 6, 23, 1, 50, 0));
    relClose(e.af0, 0.303157331655e-2);
    relClose(e.af1, 0.421067625211e-10);
    expect(e.af2).toBe(0);
    expect(e.iode).toBe(79); // IODNav
    relClose(e.crs, 72.09375);
    relClose(e.deltaN, 0.534165107264e-8);
    relClose(e.m0, -0.215534051047e1);
    relClose(e.cuc, 0.21867454052e-5);
    relClose(e.e, 0.168193023652);
    relClose(e.cus, 0.790506601334e-5);
    relClose(e.sqrtA, 0.52893720665e4);
    expect(e.toe).toBe(352200);
    relClose(e.cic, -0.342167913914e-5);
    relClose(e.omega0, -0.432025435685);
    relClose(e.cis, -0.239163637161e-5);
    relClose(e.i0, 0.852495562342);
    relClose(e.crc, 184.78125);
    relClose(e.omega, -0.312794621289e1);
    relClose(e.omegaDot, -0.693850330223e-8);
    relClose(e.idot, -0.667884962947e-10);
    expect(e.week).toBe(2428); // GST week + 1024, GPS-aligned
    expect(e.svHealth).toBe(195); // E5b HS/DVS + E1B HS/DVS set
    relClose(e.tgd, -0.325962901115e-8); // BGD E5a/E1
  });

  it('decodes an F/NAV record — E18 vs convbin RINEX', () => {
    const e = res.ephemerides.find(
      (x) => x.prn === 'E18' && x.source === 'fnav'
    )!;
    expect(e.tocDate.getTime()).toBe(Date.UTC(2026, 6, 23, 1, 50, 0));
    // The E1B/E5a clock set — close to, but distinct from, the I/NAV one
    relClose(e.af0, 0.303157343296e-2);
    relClose(e.af1, 0.420925516664e-10);
    expect(e.iode).toBe(79);
    expect(e.toe).toBe(352200);
    expect(e.week).toBe(2428);
    expect(e.svHealth).toBe(24); // E5a HS=1, E5a DVS=1 in bits 3-5
    relClose(e.tgd, -0.325962901115e-8); // same BGD E5a/E1 as I/NAV
  });

  it('decodes a healthy I/NAV record — E31 vs convbin RINEX', () => {
    const e = res.ephemerides.find(
      (x) => x.prn === 'E31' && x.source === 'inav'
    )!;
    expect(e.tocDate.getTime()).toBe(Date.UTC(2026, 6, 23, 2, 20, 0));
    relClose(e.af0, -0.158564769663e-3);
    relClose(e.af1, -0.294164692605e-11);
    expect(e.iode).toBe(82);
    relClose(e.crs, 66.4375);
    relClose(e.m0, 0.30603987984e1);
    relClose(e.e, 0.349018373527e-3);
    relClose(e.sqrtA, 0.544061367798e4);
    expect(e.toe).toBe(354000);
    relClose(e.omega0, -0.133002824234e1);
    relClose(e.i0, 0.960575126415);
    relClose(e.omega, -0.140505724079e1);
    relClose(e.omegaDot, -0.545808449398e-8);
    relClose(e.idot, -0.227866634417e-9);
    expect(e.svHealth).toBe(0);
    relClose(e.tgd, 0.325962901115e-8);
  });

  it('I/NAV and F/NAV records of one data set share the orbit and BGD', () => {
    const inav = res.ephemerides.filter((e) => e.source === 'inav');
    let pairs = 0;
    for (const i of inav) {
      const f = res.ephemerides.find(
        (x) => x.source === 'fnav' && x.prn === i.prn && x.toe === i.toe
      );
      if (!f) continue;
      pairs++;
      expect(f.iode).toBe(i.iode);
      // Orbit fields come from the same broadcast values: identical
      for (const fld of [
        'crs',
        'deltaN',
        'm0',
        'cuc',
        'e',
        'cus',
        'sqrtA',
        'cic',
        'omega0',
        'cis',
        'i0',
        'crc',
        'omega',
        'omegaDot',
        'idot',
        'week',
      ] as const) {
        expect(f[fld]).toBe(i[fld]);
      }
      // Both message types broadcast BGD E5a/E1 — the RINEX tgd slot
      expect(f.tgd).toBe(i.tgd);
      // The clock sets differ (E1B/E5b vs E1B/E5a)
      expect(f.af0).not.toBe(i.af0);
      expect(f.tocDate.getTime()).toBe(i.tocDate.getTime());
    }
    expect(pairs).toBe(3); // E18, E26, E31 complete on both types
  });
});
