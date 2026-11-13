import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseUbxRawx } from '../src/ubx';
import {
  readRinexObs,
  writeCrx,
  writeRinex2ObsBlob,
  writeRinexObsBlob,
  type CompactEpoch,
  type RinexHeader,
  type RinexObsData,
} from '../src/rinex';

/**
 * Raw receiver data → RINEX, end to end, against an independent converter:
 * the u-blox F9P RXM-RAWX slice decoded by parseUbxRawx and turned into
 * CompactEpochs the way gnsscalc does it (receiver-decode.ts: C = pr,
 * L = cp, D = doppler, S = cn0 per signal), written as RINEX 3.04, then on
 * through RINEX 2.11 → CRINEX 1.0 → RINEX 3.04, compared value by value with
 * RTKLIB 2.4.2 p13 convbin's RINEX 3.04 of the same bytes
 * (test-fixtures/f9p_rawx_convbin.obs, see README.rinex-obs).
 *
 * Conventions this pins: pseudorange metres, carrier phase cycles with the
 * receiver's sign, Doppler Hz positive for approaching satellites (u-blox
 * M8 spec RXM-RAWX doMes and RINEX 3.04 section 5: no sign flip), C/N0
 * dB-Hz, epochs in GPS time.
 */

const FIX = (name: string) => `${__dirname}/../test-fixtures/${name}`;

async function text(blob: Blob): Promise<string> {
  return gunzipSync(Buffer.from(await blob.arrayBuffer())).toString('latin1');
}
const reread = (t: string) => readRinexObs(new File([t], 'x.obs'));

/** RXM-RAWX → CompactEpochs, as gnsscalc's receiver-decode emits them. */
function ubxToCompact(): RinexObsData {
  const r = parseUbxRawx(
    new Uint8Array(readFileSync(FIX('f9p_rawx_slice.ubx')))
  );
  const obsTypes = new Map<string, string[]>();
  for (const [sys, sigs] of Object.entries(r.obsCodes))
    obsTypes.set(
      sys,
      [...sigs].sort().flatMap((c) => ['C', 'L', 'D', 'S'].map((k) => k + c))
    );
  const epochs: CompactEpoch[] = r.epochs.map((e) => {
    const sats = new Map<string, Float64Array>();
    for (const m of e.meas) {
      const codes = obsTypes.get(m.prn[0]!)!;
      let v = sats.get(m.prn);
      if (!v) sats.set(m.prn, (v = new Float64Array(codes.length).fill(NaN)));
      const put = (k: string, x: number | null) => {
        if (x !== null) v[codes.indexOf(k + m.code)] = x;
      };
      put('C', m.pr);
      put('L', m.cp);
      put('D', m.doppler);
      put('S', m.cn0);
    }
    return { time: e.timeMs, sats };
  });
  const header = {
    version: 3.04,
    type: 'O',
    satSystem: 'M',
    markerName: 'F9P',
    markerType: '',
    observer: '',
    agency: '',
    receiverNumber: '',
    receiverType: 'U-BLOX ZED-F9P',
    receiverVersion: '',
    antNumber: '',
    antType: '',
    approxPosition: null,
    antDelta: null,
    interval: null,
    timeOfFirstObs: null,
    timeOfLastObs: null,
    obsTypes: Object.fromEntries(obsTypes),
    glonassSlots: {},
    isCrx: false,
    crxVersion: 0,
  } satisfies RinexHeader;
  return { header, epochs, obsTypes };
}

/** sat → signal → [C, L, D, S] from a read file, codes as RINEX 3. */
function table(d: RinexObsData) {
  const out = new Map<string, number | null>();
  for (const e of d.epochs)
    for (const [prn, v] of e.sats) {
      const codes = d.obsTypes.get(prn[0]!)!;
      codes.forEach((c, i) => {
        if (Number.isNaN(v[i]!)) return;
        // RTKLIB 2.4.2 names BeiDou B1I "1I" (the RINEX 3.02 label) and
        // Galileo E1 "1X" in RXM-RAWX output; key both by type + band.
        // RINEX 3.03+ moved B1I to band 2 (C2I); RTKLIB 2.4.2 still says C1I.
        const band = prn[0] === 'C' && c.slice(1) === '1I' ? '2' : c[1];
        out.set(`${e.time} ${prn} ${c[0]}${band}`, v[i]!);
      });
    }
  return out;
}

describe('u-blox RXM-RAWX → RINEX vs RTKLIB convbin', () => {
  it('our RINEX 3.04 equals convbin, value by value', async () => {
    const ours = await reread(
      await text(await writeRinexObsBlob(...args(ubxToCompact())))
    );
    const rtk = rtklibRecords();
    expect([...new Set(rtk.map((r) => r.time))]).toEqual(
      ours.epochs.map((e) => e.time)
    );
    let doppler = 0;
    for (const r of rtk) {
      // Our signal of this satellite whose pseudorange (else phase) is
      // RTKLIB's: RTKLIB 2.4.2 labels every RXM-RAWX signal band 1.
      const e = ours.epochs.find((x) => x.time === r.time)!;
      const v = e.sats.get(r.prn)!;
      const codes = ours.obsTypes.get(r.prn[0]!)!;
      const sigs = [...new Set(codes.map((c) => c.slice(1)))].map((sig) =>
        ['C', 'L', 'D', 'S'].map((k) => {
          const i = codes.indexOf(k + sig);
          return i < 0 || Number.isNaN(v[i]!) ? null : v[i]!;
        })
      );
      const key = r.v[0] !== null ? 0 : 1;
      const match = sigs.find(
        (q) => q[key] !== null && Math.abs(q[key]! - r.v[key]!) < 0.0011
      );
      expect(match, `${r.time} ${r.prn}`).toBeDefined();
      // F14.3 on both sides: equal to the printed mm / milli-cycle / mHz
      for (let k = 0; k < 4; k++) {
        if (r.v[k] === null) continue;
        expect(
          Math.abs(match![k]! - r.v[k]!),
          `${r.prn} ${'CLDS'[k]}`
        ).toBeLessThan(0.0011);
      }
      if (r.v[2] !== null && Math.abs(r.v[2]) > 100) {
        expect(Math.sign(match![2]!)).toBe(Math.sign(r.v[2]));
        doppler++;
      }
    }
    expect(rtk.length).toBe(241); // every non-blank convbin record
    expect(doppler).toBeGreaterThan(150);
  });

  it('spec oracle: G04 at 21:28:42.005 GPST (RAWX doMes, prMes, cpMes, cno)', async () => {
    // convbin's first record: G 4 21756763.556 114332579.336 -1109.248 46
    const ours = await reread(
      await text(await writeRinexObsBlob(...args(ubxToCompact())))
    );
    const e = ours.epochs[0]!;
    expect(e.time).toBe(Date.UTC(2020, 11, 24, 21, 28, 42, 5)); // GPS-scale
    const v = e.sats.get('G04')!;
    const codes = ours.obsTypes.get('G')!;
    const at = (c: string) => v[codes.indexOf(c)]!;
    expect(at('C1C')).toBeCloseTo(21756763.556, 3); // metres
    expect(at('L1C')).toBeCloseTo(114332579.336, 3); // cycles ≈ C / λ1
    expect(at('L1C') * (299792458 / 1575.42e6)).toBeCloseTo(at('C1C'), -3);
    expect(at('D1C')).toBeCloseTo(-1109.248, 3); // receding: negative
    expect(at('S1C')).toBe(46);
  });

  it('chain RINEX 3.04 → 2.11 → CRINEX 1.0 → 3.04 keeps every L1 value', async () => {
    const src = ubxToCompact();
    const v3 = await reread(await text(await writeRinexObsBlob(...args(src))));
    const v2 = await reread(await text(await writeRinex2ObsBlob(...args(v3))));
    const crx = await reread(
      writeCrx(await text(await writeRinex2ObsBlob(...args(v2))))
    );
    const back = await reread(
      await text(await writeRinexObsBlob(...args(crx)))
    );
    const a = table(v3);
    const b = table(back);
    // RINEX 2.11 has no BeiDou or QZSS: those drop out, nothing else does.
    const kept = [...a].filter(([k]) => !/ [CJ]\d\d /.test(k));
    expect(kept.length).toBeGreaterThan(600);
    for (const [k, v] of kept) expect(b.get(k), k).toBe(v);
    expect([...b.keys()].filter((k) => / [CJ]\d\d /.test(k))).toEqual([]);
  });
});

/**
 * convbin's records, one per line: time, satellite, [C, L, D, S]. RTKLIB
 * 2.4.2 predates the F9P's dual-frequency RXM-RAWX (sigId): it labels every
 * measurement band 1 (C1C/L1C/…, BeiDou C1I, Galileo C1X), so an L2
 * measurement is a second record of the satellite in the same epoch — read
 * here as text, since a RINEX reader would merge the two.
 */
function rtklibRecords() {
  const lines = readFileSync(FIX('f9p_rawx_convbin.obs'), 'latin1').split('\n');
  const out: { time: number; prn: string; v: (number | null)[] }[] = [];
  let time = 0;
  for (const l of lines.slice(
    lines.findIndex((x) => x.includes('END OF HEADER')) + 1
  )) {
    if (l.startsWith('>')) {
      const [y, mo, d, h, mi] = l.slice(2, 18).trim().split(/\s+/).map(Number);
      time =
        Date.UTC(y!, mo! - 1, d, h, mi) +
        Math.round(parseFloat(l.slice(18, 29)) * 1000);
    } else if (l.trim()) {
      const v = [0, 1, 2, 3].map((k) => {
        const f = l.slice(3 + 16 * k, 17 + 16 * k).trim();
        return f ? parseFloat(f) : null;
      });
      // Galileo records come out blank: the data say E1 "1X", the header
      // declares C1C/L1C, so RTKLIB fills no column. Nothing to compare.
      if (v.every((x) => x === null)) continue;
      out.push({ time, prn: l[0]! + l.slice(1, 3).replace(' ', '0'), v });
    }
  }
  return out;
}

function args(d: RinexObsData) {
  return [d.header, d.epochs, d.obsTypes] as const;
}
