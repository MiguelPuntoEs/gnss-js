import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  OSNMA_KNOWN_PUBLIC_KEYS,
  OSNMA_MERKLE_ROOT,
  OsnmaReceiver,
  merkleLeafOk,
  verifySbfOsnma,
} from '../src/osnma';
import { publicKeyLeaf } from '../src/osnma/merkle';

// TU Delft DLF500NLD1 (Septentrio), GALRawINAV E1-B pages only:
//  - dlf500_osnma_e1b.sbf: 16 min from 2026-11-09 20:47 UTC, a DSM-KROOT
//    completes ~8 min in;
//  - dlf500_osnma_pkr_e1b.sbf: 5 min from 2026-07-27 18:03 GST, inside
//    a DSM-PKR window (every 6 h).
const fixture = (f: string) =>
  new Uint8Array(readFileSync(join(__dirname, '../test-fixtures', f)));
const live = fixture('dlf500_osnma_e1b.sbf');
const pkr = fixture('dlf500_osnma_pkr_e1b.sbf');

/** E1-B pages of an SBF capture as [svid, wn, tow, page]. */
function pages(data: Uint8Array): [number, number, number, Uint8Array][] {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: [number, number, number, Uint8Array][] = [];
  for (let i = 0; i + 8 <= data.length;) {
    const len = v.getUint16(i + 6, true);
    const page = new Uint8Array(32);
    for (let k = 0; k < 8; k++) {
      const w = v.getUint32(i + 20 + 4 * k, true);
      page[4 * k] = w >>> 24;
      page[4 * k + 1] = (w >>> 16) & 0xff;
      page[4 * k + 2] = (w >>> 8) & 0xff;
      page[4 * k + 3] = w & 0xff;
    }
    const svid = data[i + 14]! - 70;
    const tow = Math.round(v.getUint32(i + 8, true) / 1000) - 2;
    out.push([svid, v.getUint16(i + 12, true) - 1024, tow, page]);
    i += len;
  }
  return out;
}

describe('OSNMA on a live Galileo E1-B capture', () => {
  const s = verifySbfOsnma(live);

  it('verifies the TESLA root key with the public key in force', () => {
    expect(s.nmaStatus).toBe('operational');
    expect(s.publicKeys).toEqual([{ pkid: 2, source: 'known' }]);
    expect(s.chains).toHaveLength(1);
    expect(s.chains[0]).toMatchObject({
      cid: 1,
      pkid: 2,
      hashFunction: 'SHA-256',
      macFunction: 'HMAC-SHA-256',
      keyBits: 128,
      tagBits: 40,
      maclt: 34,
      supported: true,
    });
    expect(s.events.map((e) => e.kind)).toEqual(['kroot-verified']);
  });

  it('verifies the chain keys and the navigation-data tags', () => {
    expect(s.keysVerified).toBeGreaterThan(10);
    expect(s.keysRejected).toBe(0);
    expect(s.tags.ok).toBeGreaterThan(150);
    expect(s.tags.failed).toBe(0);
    const authed = s.satellites.filter(
      (x) => x.ced.authenticatedIodNav !== null
    );
    expect(authed.length).toBeGreaterThanOrEqual(8);
    // Cross-authentication: satellites without OSNMA of their own.
    expect(authed.some((x) => !x.transmitsOsnma)).toBe(true);
    expect(s.satellites.some((x) => x.timing.lastAuthenticated)).toBe(true);
  });

  it('flags navigation data that differs from what Galileo signed', () => {
    const target = s.satellites.find((x) => x.ced.ok > 0)!;
    const svid = parseInt(target.prn.slice(1), 10);
    const rx = new OsnmaReceiver();
    for (const [sv, wn, tow, page] of pages(live)) {
      // A spoofer's word type 1 (ephemeris) for one satellite: flip a
      // bit of M0... with the page otherwise intact.
      if (sv === svid && ((page[0]! >> 2) & 0x3f) === 1) page[5]! ^= 0x10;
      rx.pushPage(sv, wn, tow, page);
    }
    rx.flush();
    const t = rx.status();
    const sat = t.satellites.find((x) => x.prn === target.prn)!;
    expect(sat.ced.failed).toBeGreaterThan(0);
    expect(sat.ced.ok).toBe(0);
    expect(
      t.events.some((e) => e.kind === 'tag-failed' && e.prn === target.prn)
    ).toBe(true);
    // Every other satellite still authenticates.
    for (const x of t.satellites)
      if (x.prn !== target.prn) expect(x.ced.failed).toBe(0);
  });

  it('fails closed without a trusted Merkle root', () => {
    const t = verifySbfOsnma(live, { merkleRoot: new Uint8Array(32) });
    expect(t.publicKeys).toEqual([]);
    expect(t.chains).toEqual([]);
    expect(t.tags.ok).toBe(0);
  });

  it('rejects a forged TESLA key', () => {
    const rx = new OsnmaReceiver();
    let forged = false;
    const all = pages(live);
    const start = all[0]![2];
    for (const [sv, wn, tow, page] of all) {
      // Last page of a subframe carries the end of the MACK key field.
      if (
        !forged &&
        tow > start + 120 &&
        tow % 30 === 27 &&
        page[18]! | page[19]! | page[20]!
      ) {
        page[19]! ^= 0x01; // MACK bits 140..171 → bytes 17.5..21.5
        forged = true;
      }
      rx.pushPage(sv, wn, tow, page);
    }
    rx.flush();
    const t = rx.status();
    expect(t.keysVerified).toBeGreaterThan(0);
    expect(t.keysRejected).toBe(1);
    expect(t.events.some((e) => e.kind === 'key-rejected')).toBe(true);
  });
});

describe('OSNMA public key distribution', () => {
  it('ships a public key that verifies against the Merkle root', () => {
    for (const k of OSNMA_KNOWN_PUBLIC_KEYS)
      expect(
        merkleLeafOk(
          publicKeyLeaf(k.npkt, k.pkid, k.key),
          k.mid,
          k.path,
          OSNMA_MERKLE_ROOT
        )
      ).toBe(true);
  });

  it('verifies a broadcast DSM-PKR against the Merkle root', () => {
    const s = verifySbfOsnma(pkr, { publicKeys: [] });
    expect(s.publicKeys).toEqual([{ pkid: 2, source: 'broadcast' }]);
    expect(s.events.some((e) => e.kind === 'public-key-verified')).toBe(true);
    // ...and it is the very key the library ships.
    const t = verifySbfOsnma(pkr);
    expect(
      t.events.find((e) => e.kind === 'public-key-verified')!.message
    ).toMatch(/matches the known key/);
  });
});
