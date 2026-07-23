import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { setBitU, setBitS } from '../src/navbits';
import { crc24q } from '../src/navbits/cnav';
import {
  rs255Encode,
  rs255EncodeBlock,
  rs255DecodeErasures,
  rs255GeneratorRow,
  RS255_N,
  RS255_K,
} from '../src/navbits/rs255';
import {
  HasAssembler,
  parseHasMessages,
  parseHasPage,
  hasPageCrcOk,
  HAS_DUMMY_HEADER,
  HAS_VALIDITY_SECONDS,
} from '../src/navbits/has';
import { parseSbfHas } from '../src/sbf/rawnav-has';

const SBF_FILE = join(__dirname, '../test-fixtures/dlf5_has_slice.sbf');

/* ================================================================== */
/*  Reed-Solomon (255,32) erasure decoding                             */
/* ================================================================== */

/** Deterministic pseudo-random bytes (xorshift) for synthetic tests. */
function prand(n: number, seed = 0xc0ffee): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
}

describe('rs255 erasure decoder', () => {
  it('is systematic: generator rows 1..32 are unit vectors', () => {
    for (const pid of [1, 17, 32]) {
      const row = rs255GeneratorRow(pid);
      for (let c = 0; c < RS255_K; c++)
        expect(row[c]).toBe(c === pid - 1 ? 1 : 0);
    }
  });

  it('matches the HASlib generator matrix on the first parity row', () => {
    // Row 33 (page ID 33) of galileo_has_decoder/resources/genMatrix.txt
    // in github.com/nlsfi/HASlib — the full 255x32 matrix was verified
    // entry for entry during development.
    expect(Array.from(rs255GeneratorRow(33))).toEqual([
      19, 143, 180, 59, 221, 29, 49, 45, 231, 9, 73, 73, 159, 2, 158, 136, 212,
      218, 14, 113, 215, 20, 187, 55, 137, 181, 203, 113, 97, 135, 14, 251,
    ]);
  });

  it('encodes systematically and round-trips through parity-only pages', () => {
    const k = 12;
    const width = 53;
    const message = prand(k * width);
    const block = rs255EncodeBlock(message, k);
    expect(block.length).toBe(RS255_N * width);
    // systematic: first k rows are the message itself
    expect(block.slice(0, k * width)).toEqual(message);

    // decode from parity pages only (page IDs 200..211)
    const pages = [];
    for (let p = 200; p < 200 + k; p++)
      pages.push({
        pageId: p,
        octets: block.slice((p - 1) * width, p * width),
      });
    expect(rs255DecodeErasures(pages, k)).toEqual(message);
  });

  it('recovers from any mix of systematic and parity pages', () => {
    const k = 7;
    const width = 5;
    const message = prand(k * width, 42);
    const block = rs255EncodeBlock(message, k);
    const pids = [3, 254, 40, 1, 99, 187, 61];
    const pages = pids.map((p) => ({
      pageId: p,
      octets: block.slice((p - 1) * width, p * width),
    }));
    expect(rs255DecodeErasures(pages, k)).toEqual(message);
  });

  it('ignores duplicate page IDs and extra pages', () => {
    const k = 3;
    const width = 4;
    const message = prand(k * width, 7);
    const block = rs255EncodeBlock(message, k);
    const page = (p: number) => ({
      pageId: p,
      octets: block.slice((p - 1) * width, p * width),
    });
    // duplicate of pid 50 does not count toward the k distinct pages
    expect(rs255DecodeErasures([page(50), page(50), page(60)], k)).toBeNull();
    expect(
      rs255DecodeErasures([page(50), page(50), page(60), page(70), page(80)], k)
    ).toEqual(message);
  });

  it('returns null with fewer than k pages or inconsistent widths', () => {
    const k = 4;
    const width = 2;
    const block = rs255EncodeBlock(prand(k * width, 3), k);
    const page = (p: number) => ({
      pageId: p,
      octets: block.slice((p - 1) * width, p * width),
    });
    expect(rs255DecodeErasures([page(1), page(2), page(3)], k)).toBeNull();
    expect(
      rs255DecodeErasures(
        [page(1), page(2), page(3), { pageId: 9, octets: new Uint8Array(3) }],
        k
      )
    ).toBeNull();
    expect(rs255DecodeErasures([], 0)).toBeNull();
    expect(rs255DecodeErasures([], 33)).toBeNull();
  });

  it('rejects oversized information vectors', () => {
    expect(() => rs255Encode(new Uint8Array(33))).toThrow(RangeError);
    expect(() => rs255EncodeBlock(new Uint8Array(33 * 2), 33)).toThrow(
      RangeError
    );
    expect(() => rs255GeneratorRow(0)).toThrow(RangeError);
    expect(() => rs255GeneratorRow(256)).toThrow(RangeError);
  });
});

/* ================================================================== */
/*  C/NAV page layer + synthetic MT1 assembly                          */
/* ================================================================== */

/** Frame one 53-octet HAS body into a 492-bit C/NAV page with CRC. */
function buildPage(
  header: { status: number; mt: number; mid: number; ms: number; pid: number },
  body: Uint8Array
): Uint8Array {
  const page = new Uint8Array(62);
  setBitU(page, 0, 14, 0x3fff); // reserved bits, all ones on air
  setBitU(page, 14, 2, header.status);
  setBitU(page, 18, 2, header.mt);
  setBitU(page, 20, 5, header.mid);
  setBitU(page, 25, 5, header.ms - 1);
  setBitU(page, 30, 8, header.pid);
  for (let i = 0; i < 53; i++) setBitU(page, 38 + 8 * i, 8, body[i]!);
  setBitU(page, 462, 24, crc24q(page, 462));
  return page;
}

function buildDummyPage(): Uint8Array {
  const page = new Uint8Array(62);
  setBitU(page, 0, 14, 0x3fff);
  setBitU(page, 14, 24, HAS_DUMMY_HEADER);
  setBitU(page, 462, 24, crc24q(page, 462));
  return page;
}

describe('C/NAV page layer', () => {
  const body = prand(53, 99);
  const page = buildPage({ status: 1, mt: 1, mid: 5, ms: 2, pid: 40 }, body);

  it('checks the CRC-24Q over the first 462 bits', () => {
    expect(hasPageCrcOk(page)).toBe(true);
    const bad = page.slice();
    bad[10] ^= 0x40;
    expect(hasPageCrcOk(bad)).toBe(false);
    expect(hasPageCrcOk(new Uint8Array(10))).toBe(false);
  });

  it('parses the HAS page header and body', () => {
    const p = parseHasPage(page)!;
    expect(p).not.toBeNull();
    expect(p.status).toBe(1);
    expect(p.messageType).toBe(1);
    expect(p.messageId).toBe(5);
    expect(p.messageSize).toBe(2);
    expect(p.pageId).toBe(40);
    expect(p.body).toEqual(body);
  });

  it('flags dummy pages', () => {
    const dummy = buildDummyPage();
    expect(hasPageCrcOk(dummy)).toBe(true);
    expect(parseHasPage(dummy)).toBeNull();
  });
});

/**
 * Build a complete synthetic MT1 message: one Galileo system mask with
 * two satellites (E03, E11) and two signals (E1-B index 0, E5b-I index
 * 6) plus an explicit cell mask, then orbit, full-set clock, clock
 * subset, code-bias and phase-bias blocks — exercising every sub-block
 * parser, the reserved not-available/do-not-use patterns, and the
 * delta-clock multiplier.
 */
function buildSyntheticMt1(): { payload: Uint8Array; ms: number } {
  const buf = new Uint8Array(6 * 53);
  let i = 0;
  const u = (len: number, v: number) => {
    setBitU(buf, i, len, v);
    i += len;
  };
  const s = (len: number, v: number) => {
    setBitS(buf, i, len, v);
    i += len;
  };
  // header
  u(12, 2345); // TOH
  u(6, 0b111111); // all blocks present
  u(4, 0); // reserved
  u(5, 9); // mask ID
  u(5, 21); // IOD set ID
  // mask block: 1 system
  u(4, 1); // Nsys
  u(4, 2); // GNSS ID: Galileo
  for (let b = 0; b < 40; b++) u(1, b === 2 || b === 10 ? 1 : 0); // E03, E11
  for (let b = 0; b < 16; b++) u(1, b === 0 || b === 6 ? 1 : 0); // E1-B, E5b-I
  u(1, 1); // cell mask availability
  u(4, 0b1101); // E03: E1-B+E5b-I; E11: E5b-I only
  u(3, 0); // nav message: I/NAV
  u(6, 0); // reserved
  // orbit block
  u(4, 11); // validity index -> 600 s
  u(10, 96); // E03 IODNav
  s(13, -100); // dR  = -0.25 m
  s(12, 50); //  dI  = +0.40 m
  s(12, -25); // dC  = -0.20 m
  u(10, 97); // E11 IODNav
  s(13, -4096); // dR not available
  s(12, 100);
  s(12, 30);
  // clock full-set block
  u(4, 2); // validity index -> 15 s
  u(2, 2); // multiplier - 1 -> x3
  s(13, 200); // E03: 200 * 0.0025 * 3 = +1.5 m
  s(13, 4095); // E11: do not use
  // clock subset block: 1 system, only E11 selected, multiplier x2
  u(4, 3); // validity index -> 20 s
  u(4, 1); // Nsys subset
  u(4, 2); // GNSS ID Galileo
  u(2, 1); // multiplier - 1 -> x2
  u(1, 0); // E03 not in subset
  u(1, 1); // E11 in subset
  s(13, -300); // E11: -300 * 0.0025 * 2 = -1.5 m
  // code-bias block (cells: E03 x2 signals, E11 x1)
  u(4, 5); // validity index -> 60 s
  s(11, 73); // E03 E1-B: +1.46 m
  s(11, -1024); // E03 E5b-I: not available
  s(11, -50); // E11 E5b-I: -1.0 m
  // phase-bias block
  u(4, 6); // validity index -> 90 s
  s(11, 25); // E03 E1-B: +0.25 cycles
  u(2, 1);
  s(11, -75); // E03 E5b-I: -0.75 cycles
  u(2, 3);
  s(11, -1024); // E11 E5b-I: not available
  u(2, 0);
  const ms = Math.ceil(i / 424);
  return { payload: buf.slice(0, ms * 53), ms };
}

describe('HasAssembler (synthetic MT1)', () => {
  const { payload, ms } = buildSyntheticMt1();
  // spread the message over parity-only pages, delivered out of order
  const block = rs255EncodeBlock(payload, ms);
  const pids = [77, 213, 34, 150, 91, 255].slice(0, ms);
  const pages = pids.map((pid) =>
    buildPage(
      { status: 1, mt: 1, mid: 30, ms, pid },
      block.slice((pid - 1) * 53, pid * 53)
    )
  );

  it('assembles once messageSize distinct pages arrived', () => {
    const a = new HasAssembler();
    expect(a.push(buildDummyPage())).toBeNull();
    for (let k = 0; k < pages.length - 1; k++)
      expect(a.push(pages[k]!, 100 + k)).toBeNull();
    const m = a.push(pages[pages.length - 1]!, 200)!;
    expect(m).not.toBeNull();
    expect(a.stats.dummyPages).toBe(1);
    expect(a.stats.messages).toBe(1);

    expect(m.parseError).toBeNull();
    expect(m.tow).toBe(200);
    expect(m.status).toBe(1);
    expect(m.messageId).toBe(30);
    expect(m.messageSize).toBe(ms);
    expect(m.toh).toBe(2345);
    expect(m.maskId).toBe(9);
    expect(m.iodSetId).toBe(21);
    expect(m.flags).toEqual({
      mask: true,
      orbit: true,
      clockFullSet: true,
      clockSubset: true,
      codeBias: true,
      phaseBias: true,
    });

    // mask
    const sys = m.masks!.systems[0]!;
    expect(m.masks!.systems.length).toBe(1);
    expect(sys.gnssId).toBe(2);
    expect(sys.system).toBe('E');
    expect(sys.prns).toEqual(['E03', 'E11']);
    expect(sys.signalIndices).toEqual([0, 6]);
    expect(sys.signals).toEqual(['E1-B', 'E5b-I']);
    expect(sys.cellMask).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(sys.navMessage).toBe(0);

    // orbit
    expect(m.orbit!.validityIndex).toBe(11);
    expect(m.orbit!.validitySeconds).toBe(600);
    const [o1, o2] = m.orbit!.corrections;
    expect(o1).toEqual({
      system: 'E',
      prn: 'E03',
      gnssIod: 96,
      deltaRadial: -0.25,
      deltaInTrack: 0.4,
      deltaCrossTrack: -0.2,
    });
    expect(o2!.gnssIod).toBe(97);
    expect(o2!.deltaRadial).toBeNull(); // reserved pattern
    expect(o2!.deltaInTrack).toBeCloseTo(0.8, 12);

    // full-set clock with x3 multiplier
    expect(m.clockFullSet!.validitySeconds).toBe(15);
    expect(m.clockFullSet!.multipliers).toEqual([
      { system: 'E', multiplier: 3 },
    ]);
    const [c1, c2] = m.clockFullSet!.corrections;
    expect(c1!.deltaClock).toBeCloseTo(1.5, 12);
    expect(c1!.notUsable).toBe(false);
    expect(c2!.deltaClock).toBeNull();
    expect(c2!.notUsable).toBe(true); // 0111...1 = do not use

    // clock subset with x2 multiplier
    expect(m.clockSubset!.validitySeconds).toBe(20);
    expect(m.clockSubset!.corrections).toEqual([
      { system: 'E', prn: 'E11', deltaClock: -1.5, notUsable: false },
    ]);

    // code biases follow the cell mask (E03 two cells, E11 one)
    expect(m.codeBias!.validitySeconds).toBe(60);
    expect(m.codeBias!.biases).toEqual([
      { system: 'E', prn: 'E03', signalIndex: 0, signal: 'E1-B', bias: 1.46 },
      { system: 'E', prn: 'E03', signalIndex: 6, signal: 'E5b-I', bias: null },
      { system: 'E', prn: 'E11', signalIndex: 6, signal: 'E5b-I', bias: -1.0 },
    ]);

    // phase biases carry the discontinuity indicator
    expect(m.phaseBias!.validitySeconds).toBe(90);
    const [p1, p2, p3] = m.phaseBias!.biases;
    expect(p1!.bias).toBeCloseTo(0.25, 12);
    expect(p1!.discontinuity).toBe(1);
    expect(p2!.bias).toBeCloseTo(-0.75, 12);
    expect(p2!.discontinuity).toBe(3);
    expect(p3!.bias).toBeNull();
  });

  it('parseHasMessages counts pages, CRC failures and dummies', () => {
    const bad = pages[0]!.slice();
    bad[20] ^= 0xff;
    const r = parseHasMessages([bad, buildDummyPage(), ...pages]);
    expect(r.pages).toBe(pages.length + 2);
    expect(r.badCrc).toBe(1);
    expect(r.dummyPages).toBe(1);
    expect(r.messages.length).toBe(1);
    expect(r.messages[0]!.toh).toBe(2345);
  });

  it('uses the cached mask for messages without a mask block', () => {
    // clock-only message referencing mask ID 9 (no mask of its own)
    const clkOnly = new Uint8Array(53);
    let i = 0;
    setBitU(clkOnly, i, 12, 2400);
    i += 12;
    setBitU(clkOnly, i, 6, 0b001000); // clock full-set only
    i += 6;
    i += 4;
    setBitU(clkOnly, i, 5, 9); // same mask ID
    i += 5;
    setBitU(clkOnly, i, 5, 21);
    i += 5;
    setBitU(clkOnly, i, 4, 0);
    i += 4;
    setBitU(clkOnly, i, 2, 0); // multiplier x1
    i += 2;
    setBitS(clkOnly, i, 13, 40); // E03: +0.1 m
    i += 13;
    setBitS(clkOnly, i, 13, -40); // E11: -0.1 m
    const clkBlock = rs255EncodeBlock(clkOnly, 1);
    const clkPage = buildPage(
      { status: 1, mt: 1, mid: 31, ms: 1, pid: 111 },
      clkBlock.slice(110 * 53, 111 * 53)
    );

    // without the mask in cache the message is returned unparsed
    const fresh = new HasAssembler();
    const orphan = fresh.push(clkPage)!;
    expect(orphan.parseError).toBe('mask-unavailable');
    expect(fresh.stats.parseErrors).toBe(1);

    // after the full message, the cached mask resolves it
    const a = new HasAssembler();
    for (const p of pages) a.push(p);
    const m = a.push(clkPage)!;
    expect(m).not.toBeNull();
    expect(m.parseError).toBeNull();
    expect(m.maskFromCache).toBe(true);
    expect(m.clockFullSet!.corrections.map((c) => c.deltaClock)).toEqual([
      0.1, -0.1,
    ]);
  });

  it('exposes the ICD validity-interval table', () => {
    expect(HAS_VALIDITY_SECONDS[0]).toBe(5);
    expect(HAS_VALIDITY_SECONDS[14]).toBe(3600);
    expect(HAS_VALIDITY_SECONDS[15]).toBeNull();
  });
});

/* ================================================================== */
/*  Septentrio GALRawCNAV (DLF5 slice)                                 */
/* ================================================================== */

/**
 * The SBF slice holds the first 152 GALRawCNAV blocks of the TU Delft
 * DLF5 mosaic-X5 capture dlf5_long.sbf (caster, 2026-07-23 02:31 UTC,
 * GPS week 2428) — 13 seconds of E6-B from 11 satellites, completing
 * three HAS messages. Expected values are pinned from FGI's HASlib
 * reference decoder (github.com/nlsfi/HASlib) run over the same
 * capture: on the full file both decoders produce identical output —
 * 191 messages, 49 630 compared fields, 0 mismatches — and the
 * decoded corrections pass a physical continuity oracle across 34
 * Galileo IODNav switchovers (orbit discontinuity RMS 0.115 m raw vs
 * 0.006 m HAS-corrected; clock 0.049 m vs 0.012 m; flipping the
 * correction sign doubles both — see oracle-has.tmp.mjs).
 */
describe.skipIf(!existsSync(SBF_FILE))('parseSbfHas (DLF5 slice)', () => {
  const res = existsSync(SBF_FILE)
    ? parseSbfHas(new Uint8Array(readFileSync(SBF_FILE)))
    : null!;

  it('decodes every page with clean CRC-24Q and assembles 3 messages', () => {
    expect(res.pagesSeen).toBe(152);
    expect(res.pagesBadCrc).toBe(0);
    expect(res.pagesDummy).toBe(87);
    expect(res.pagesHas).toBe(65);
    expect(res.messages.length).toBe(3);
    expect(res.messages.map((m) => m.messageId)).toEqual([13, 12, 14]);
    // the very first message precedes any mask broadcast
    expect(res.messages[0]!.parseError).toBe('mask-unavailable');
    expect(res.messages[1]!.parseError).toBeNull();
    expect(res.messages[2]!.parseError).toBeNull();
  });

  it('decodes the full message (mask + orbit + code bias)', () => {
    const m = res.messages[1]!;
    expect(m.tow).toBe(354711);
    expect(m.wnc).toBe(2428);
    expect(m.status).toBe(1); // operational
    expect(m.messageSize).toBe(12);
    expect(m.toh).toBe(1900);
    expect(m.maskId).toBe(2);
    expect(m.iodSetId).toBe(1);
    expect(m.flags).toEqual({
      mask: true,
      orbit: true,
      clockFullSet: false,
      clockSubset: false,
      codeBias: true,
      phaseBias: false,
    });

    const [gps, gal] = m.masks!.systems;
    expect(gps!.system).toBe('G');
    expect(gps!.prns.length).toBe(27);
    expect(gps!.signals).toEqual(['L1 C/A', 'L2 CL', 'L2 P']);
    expect(gps!.cellMask).not.toBeNull();
    expect(gps!.navMessage).toBe(0);
    expect(gal!.system).toBe('E');
    expect(gal!.prns.length).toBe(27);
    expect(gal!.prns[0]).toBe('E02');
    expect(gal!.signals).toEqual(['E1-C', 'E5a-Q', 'E5b-Q', 'E6-C']);
    expect(gal!.cellMask).toBeNull(); // all sat x signal combinations

    expect(m.orbit!.validitySeconds).toBe(300);
    expect(m.orbit!.corrections.length).toBe(54);
    const e05 = m.orbit!.corrections.find((c) => c.prn === 'E05')!;
    expect(e05.system).toBe('E');
    expect(e05.gnssIod).toBe(81); // IODNav, 10 bits
    expect(e05.deltaRadial).toBeCloseTo(-0.1525, 12);
    expect(e05.deltaInTrack).toBeCloseTo(0.184, 12);
    expect(e05.deltaCrossTrack).toBeCloseTo(0.064, 12);
    const g05 = m.orbit!.corrections.find((c) => c.prn === 'G05')!;
    expect(g05.gnssIod).toBe(29); // IODE, 8 bits
    expect(g05.deltaRadial).toBeCloseTo(-0.0175, 12);
    expect(g05.deltaInTrack).toBeCloseTo(0.592, 12);
    expect(g05.deltaCrossTrack).toBeCloseTo(0.296, 12);

    expect(m.codeBias!.validitySeconds).toBe(300);
    expect(m.codeBias!.biases.length).toBe(186);
    const e05cb = m.codeBias!.biases.filter((b) => b.prn === 'E05');
    expect(e05cb.map((b) => b.signalIndex)).toEqual([1, 4, 7, 13]);
    expect(e05cb.map((b) => b.signal)).toEqual([
      'E1-C',
      'E5a-Q',
      'E5b-Q',
      'E6-C',
    ]);
    expect(e05cb[0]!.bias).toBeCloseTo(-1.0, 12);
    expect(e05cb[3]!.bias).toBeCloseTo(-0.18, 12);
  });

  it('decodes the clock-only message against the cached mask', () => {
    const m = res.messages[2]!;
    expect(m.tow).toBe(354718);
    expect(m.messageSize).toBe(2);
    expect(m.toh).toBe(1917);
    expect(m.maskFromCache).toBe(true);
    expect(m.flags.clockFullSet).toBe(true);
    expect(m.flags.orbit).toBe(false);

    const clk = m.clockFullSet!;
    expect(clk.validitySeconds).toBe(60);
    expect(clk.multipliers).toEqual([
      { system: 'G', multiplier: 1 },
      { system: 'E', multiplier: 1 },
    ]);
    expect(clk.corrections.length).toBe(54);
    expect(
      clk.corrections.find((c) => c.prn === 'E05')!.deltaClock
    ).toBeCloseTo(0.0575, 12);
    expect(
      clk.corrections.find((c) => c.prn === 'G05')!.deltaClock
    ).toBeCloseTo(0.6525, 12);
    expect(clk.corrections.filter((c) => c.deltaClock === null).length).toBe(1);
    expect(clk.corrections.filter((c) => c.notUsable).length).toBe(0);
  });
});
