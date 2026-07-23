import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseUbxNav, parseUbxRawx, ubxFrames } from '../src/ubx';
import { getBitU, setBitU } from '../src/navbits';
import type { KeplerEphemeris } from '../src/rinex/nav';

const FILE = join(__dirname, '../test-fixtures/f9p_sfrbx_slice.ubx');

/** Relative-error assertion at RINEX printing precision. */
const close = (got: number, pin: number) => {
  expect(Math.abs(got - pin)).toBeLessThanOrEqual(Math.abs(pin) * 1e-11);
};

/* ── synthetic UBX stream helpers ──────────────────────────────── */

/** Wrap a payload in a UBX frame (sync + class/id + len + Fletcher-8). */
function ubxFrame(
  msgClass: number,
  msgId: number,
  payload: Uint8Array
): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  out.set([0xb5, 0x62, msgClass, msgId, payload.length & 0xff]);
  out[5] = payload.length >> 8;
  out.set(payload, 6);
  let ckA = 0;
  let ckB = 0;
  for (let j = 2; j < 6 + payload.length; j++) {
    ckA = (ckA + out[j]!) & 0xff;
    ckB = (ckB + ckA) & 0xff;
  }
  out[6 + payload.length] = ckA;
  out[7 + payload.length] = ckB;
  return out;
}

/**
 * Minimal parity-stripped LNAV subframe (30 bytes of 24-bit words):
 * TLM preamble, subframe ID and the issue-of-data fields the decoder
 * cross-checks; week10 89 resolves to 2137 against refWeek 2137.
 */
function lnavSubframe(id: number, iod: number): Uint8Array {
  const b = new Uint8Array(30);
  setBitU(b, 0, 8, 0x8b); // TLM preamble
  setBitU(b, 43, 3, id); // subframe ID (HOW)
  if (id === 1) {
    setBitU(b, 48, 10, 89); // week10
    setBitU(b, 70, 2, 0); // IODC MSBs
    setBitU(b, 168, 8, iod); // IODC LSBs
  } else if (id === 2) {
    setBitU(b, 48, 8, iod); // IODE
  } else if (id === 3) {
    setBitU(b, 216, 8, iod); // IODE
  }
  return b;
}

/** RXM-SFRBX frame carrying an LNAV subframe as 30-LSB dwrd words. */
function sfrbx(
  gnssId: number,
  svId: number,
  sf: Uint8Array,
  parityBits = 0
): Uint8Array {
  const payload = new Uint8Array(8 + 40);
  payload[0] = gnssId;
  payload[1] = svId;
  payload[4] = 10; // numWords
  payload[6] = 2; // version
  const view = new DataView(payload.buffer);
  for (let k = 0; k < 10; k++) {
    view.setUint32(8 + 4 * k, getBitU(sf, 24 * k, 24) * 64 + parityBits, true);
  }
  return ubxFrame(0x02, 0x13, payload);
}

/** Minimal RXM-RAWX frame: only the GPS week field matters here. */
function rawx(week: number): Uint8Array {
  const payload = new Uint8Array(16);
  new DataView(payload.buffer).setUint16(8, week, true);
  return ubxFrame(0x02, 0x15, payload);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const frame123 = (gnssId: number, svId: number, iod: number, parity = 0) =>
  concat(
    sfrbx(gnssId, svId, lnavSubframe(1, iod), parity),
    sfrbx(gnssId, svId, lnavSubframe(2, iod), parity),
    sfrbx(gnssId, svId, lnavSubframe(3, iod), parity)
  );

/* ── synthetic-stream tests ────────────────────────────────────── */

describe('parseUbxNav (synthetic LNAV)', () => {
  it('assembles subframes 1-3 and resolves the week against refWeek', () => {
    const res = parseUbxNav(frame123(0, 7, 5), { refWeek: 2137 });
    expect(res.badParity).toBe(0);
    expect(res.ephemerides.length).toBe(1);
    const eph = res.ephemerides[0] as KeplerEphemeris;
    expect(eph.prn).toBe('G07');
    expect(eph.system).toBe('G');
    expect(eph.iode).toBe(5);
    expect(eph.week).toBe(2137); // 89 + 2·1024
  });

  it('ignores the 6 parity LSBs of each dwrd (data bits pre-resolved)', () => {
    const clean = parseUbxNav(frame123(0, 7, 5), { refWeek: 2137 });
    const noisy = parseUbxNav(frame123(0, 7, 5, 0b111111), { refWeek: 2137 });
    expect(noisy.ephemerides).toEqual(clean.ephemerides);
  });

  it('rejects a frame whose subframe-3 IODE disagrees', () => {
    const stream = concat(
      sfrbx(0, 7, lnavSubframe(1, 5)),
      sfrbx(0, 7, lnavSubframe(2, 5)),
      sfrbx(0, 7, lnavSubframe(3, 6)) // stale/next issue of data
    );
    const res = parseUbxNav(stream, { refWeek: 2137 });
    expect(res.ephemerides.length).toBe(0);
    expect(res.badParity).toBe(1);
  });

  it('suppresses repeated broadcasts, keeps new issues of data', () => {
    const stream = concat(
      frame123(0, 7, 5),
      frame123(0, 7, 5), // identical rebroadcast
      frame123(0, 7, 9) // new issue of data
    );
    const res = parseUbxNav(stream, { refWeek: 2137 });
    expect(res.ephemerides.map((e) => (e as KeplerEphemeris).iode)).toEqual([
      5, 9,
    ]);
  });

  it('decodes QZSS LNAV under the J prefix', () => {
    const res = parseUbxNav(frame123(5, 3, 12), { refWeek: 2137 });
    expect(res.ephemerides.length).toBe(1);
    expect(res.ephemerides[0]!.prn).toBe('J03');
    expect(res.ephemerides[0]!.system).toBe('J');
  });

  it('skips CNAV messages silently (0x8B preamble in the top byte)', () => {
    const payload = new Uint8Array(48);
    payload[0] = 0;
    payload[1] = 7;
    payload[4] = 10;
    payload[6] = 2;
    new DataView(payload.buffer).setUint32(8, 0x8b000000, true);
    const res = parseUbxNav(ubxFrame(0x02, 0x13, payload), { refWeek: 2137 });
    expect(res.ephemerides.length).toBe(0);
    expect(res.badParity).toBe(0);
  });

  it('harvests the reference week from RXM-RAWX in the same stream', () => {
    const res = parseUbxNav(concat(rawx(2137), frame123(0, 7, 5)));
    expect(res.ephemerides.length).toBe(1);
    expect((res.ephemerides[0] as KeplerEphemeris).week).toBe(2137);
  });

  it('yields nothing without any week reference (no clock fallback)', () => {
    const res = parseUbxNav(frame123(0, 7, 5));
    expect(res.ephemerides.length).toBe(0);
  });
});

describe('ubxFrames', () => {
  it('drops corrupted frames and counts the bad checksum', () => {
    const stream = concat(rawx(2137), frame123(0, 7, 5));
    stream[10] ^= 0xff; // corrupt the RAWX payload
    const stats = { badChecksums: 0 };
    const frames = [...ubxFrames(stream, stats)];
    expect(stats.badChecksums).toBe(1);
    expect(frames.length).toBe(3); // the three SFRBX survive
    expect(frames.every((f) => f.msgId === 0x13)).toBe(true);
  });
});

/* ── fixture end-to-end (vs RTKLIB demo5 convbin) ──────────────── */

/**
 * The slice is ~130 s of RXM-SFRBX + RXM-RAWX frames from
 * rtklibexplorer's public F9P PPP dataset (rover.ubx, 2020-12-24).
 * Expected values are pinned from RTKLIB demo5 convbin's RINEX 3.04
 * nav conversion of the same bytes; the full-file oracle
 * (oracle-ubxnav.tmp.mjs) matched 22/22 GPS records at rel < 5e-12.
 */
describe.skipIf(!existsSync(FILE))('parseUbxNav (F9P slice)', () => {
  // Guarded read: describe bodies execute even under skipIf.
  const res = existsSync(FILE)
    ? parseUbxNav(new Uint8Array(readFileSync(FILE)))
    : null!;

  it('decodes the nine GPS ephemerides convbin finds, cleanly', () => {
    expect(res.badParity).toBe(0);
    expect(res.ephemerides.map((e) => e.prn).sort()).toEqual([
      'G03',
      'G04',
      'G07',
      'G08',
      'G09',
      'G16',
      'G22',
      'G26',
      'G27',
    ]);
  });

  it('agrees with the framing scan of parseUbxRawx', () => {
    const data = new Uint8Array(readFileSync(FILE));
    const counts: Record<string, number> = {};
    for (const f of ubxFrames(data)) {
      const key = `${f.msgClass.toString(16).padStart(2, '0')}-${f.msgId
        .toString(16)
        .padStart(2, '0')}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const raw = parseUbxRawx(data);
    expect(counts).toEqual(raw.messageCounts);
    expect(raw.badChecksums).toBe(0);
    expect(raw.epochs.length).toBe(130);
  });

  it('matches convbin field-for-field (G04, week from RAWX)', () => {
    const g04 = res.ephemerides.find((e) => e.prn === 'G04') as KeplerEphemeris;
    expect(g04).toBeDefined();

    // Epoch: 2020-12-24 22:00:00 GPS, week 2137 (harvested from RAWX)
    expect(g04.tocDate.getTime()).toBe(Date.UTC(2020, 11, 24, 22));
    expect(g04.week).toBe(2137);
    expect(g04.toe).toBe(424800);
    expect(g04.iode).toBe(228);
    expect(g04.svHealth).toBe(0);

    // Clock (convbin: -.167160294950D-03 -.318323145621D-11 0)
    close(g04.af0, -0.16716029495e-3);
    close(g04.af1, -0.318323145621e-11);
    expect(g04.af2).toBe(0);
    close(g04.tgd, -0.419095158577e-8);

    // Orbit
    expect(g04.crs).toBe(-31.78125); // exact: -1017 × 2^-5
    expect(g04.crc).toBe(237.9375); // exact: 7614 × 2^-5
    close(g04.deltaN, 0.4717696511e-8);
    close(g04.m0, -0.585116333861);
    close(g04.cuc, -0.165030360222e-5);
    close(g04.e, 0.100494129583e-2);
    close(g04.cus, 0.721216201782e-5);
    close(g04.sqrtA, 0.515359848213e4);
    close(g04.cic, 0.391155481339e-7);
    close(g04.omega0, 0.14349562142e1);
    close(g04.cis, -0.167638063431e-7);
    close(g04.i0, 0.959788739191);
    close(g04.omega, -0.307413575716e1);
    close(g04.omegaDot, -0.809783730743e-8);
    close(g04.idot, -0.220366321999e-9);
  });

  it('a refWeek override reproduces the harvested-week decode', () => {
    const data = new Uint8Array(readFileSync(FILE));
    const forced = parseUbxNav(data, { refWeek: 2137 });
    expect(forced.ephemerides).toEqual(res.ephemerides);
  });
});
