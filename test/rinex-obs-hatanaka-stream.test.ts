import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  readRinexObs,
  writeCrx,
  writeRinex2ObsBlob,
  writeRinex4ObsBlob,
  writeRinexObsBlob,
  type CompactEpoch,
  type RinexObsData,
} from '../src/rinex';

/**
 * The writers' `hatanaka` option compresses as it writes: it must give
 * exactly what writeCrx (byte-exact with rnx2crx, see rinex-crx.test.ts)
 * makes of the plain file — across the writers' 200-epoch flushes, with
 * clock offsets, events and RINEX 2's continuation lines.
 */

const FIX = (name: string) => `${__dirname}/../test-fixtures/${name}`;
const fixture = (name: string) =>
  readRinexObs(new File([readFileSync(FIX(name))], name));
const text = async (b: Blob) =>
  gunzipSync(Buffer.from(await b.arrayBuffer())).toString('latin1');
const DATE = '01-Jan-24 00:00';

/** The fixture's epochs repeated past several flushes, with a clock
 *  offset on some and an event in the middle. */
function longer(d: RinexObsData, n = 650): CompactEpoch[] {
  const obs = d.epochs.filter((e) => (e.flag ?? 0) < 2);
  const span = obs[obs.length - 1]!.time - obs[0]!.time + 1000;
  const out: CompactEpoch[] = [];
  for (let i = 0; out.length < n; i++) {
    const e = obs[i % obs.length]!;
    out.push({
      ...e,
      time: e.time + Math.floor(i / obs.length) * span,
      clockOffset: i % 7 === 3 ? 0.000123456789 * (i % 5) : e.clockOffset,
    });
    if (out.length === 333)
      out.push({
        time: NaN,
        sats: new Map(),
        flag: 4,
        records: [
          'EVENT IN THE MIDDLE                                         COMMENT',
        ],
      });
  }
  return out;
}

const writers = {
  '2.11': writeRinex2ObsBlob,
  '3.04': writeRinexObsBlob,
  '4.01': writeRinex4ObsBlob,
};

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-15T09:00:00Z'));
});
afterAll(() => vi.useRealTimers());

describe('hatanaka while writing = writeCrx of the written file', () => {
  for (const file of [
    'sur4_obs_slice.rnx',
    'anmg_obs_slice.rnx',
    'inab_obs_slice.25o',
    'f9p_rawx_convbin.obs',
  ])
    for (const [version, write] of Object.entries(writers))
      it(`${file} → RINEX ${version}`, async () => {
        const d = await fixture(file);
        const epochs = longer(d);
        const plain = await text(await write(d.header, epochs, d.obsTypes));
        const direct = await text(
          await write(d.header, epochs, d.obsTypes, {
            hatanaka: { date: DATE },
          })
        );
        expect(direct.length).toBeGreaterThan(1000);
        expect(direct).toBe(writeCrx(plain, { date: DATE }));
      });

  it('`true` means the defaults', async () => {
    const d = await fixture('sur4_obs_slice.rnx');
    const crx = await text(
      await writeRinex4ObsBlob(d.header, d.epochs, d.obsTypes, {
        hatanaka: true,
      })
    );
    expect(crx.slice(0, 20).trim()).toBe('3.0');
    expect(crx).toContain('gnss-js writeCrx');
    const back = await readRinexObs(new File([crx], 'x.crx'));
    expect(back.epochs.length).toBe(d.epochs.length);
  });
});
