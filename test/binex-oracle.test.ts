/**
 * BINEX 0x7f-05 against RTKLIB convbin (test-fixtures/convbin/binex_7f05.obs).
 *
 * RTKLIB 2.4.2 resets the ObsFlags per observation block instead of
 * inheriting block 0's (see the note on decodeObsSat), so it mis-sizes the
 * blocks after the first satellites of this 45-satellite epoch: it decodes
 * G22, G21 and S33 correctly, then writes empty E30/R11 rows and a bogus
 * "E05" built from misaligned bytes (there is no E05 in the record). The
 * three clean satellites are compared value by value; the derailment is
 * pinned so a future convbin regeneration that fixes it is noticed.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseBinex } from '../src/binex';
import { compareWithOracle, readRinex3Obs } from './helpers/rinex3-obs-oracle';

const FIX = join(__dirname, '..', 'test-fixtures');
const res = parseBinex(
  new Uint8Array(readFileSync(join(FIX, 'binex_obs_7f05.bnx')))
);
const oracle = readRinex3Obs(
  readFileSync(join(FIX, 'convbin', 'binex_7f05.obs'), 'utf8')
);

describe('BINEX 0x7f-05 matches RTKLIB convbin where 2.4.2 decodes cleanly', () => {
  it('same epoch on the GPS scale (minutes since 1980-01-06 + ms)', () => {
    expect(oracle.epochs).toHaveLength(1);
    expect(oracle.epochs[0]!.timeMs).toBe(res.epochs[0]!.timeMs);
    expect(res.epochs[0]!.timeMs).toBe(Date.UTC(2023, 10, 29, 0, 59, 59));
  });

  it('agrees on G22, G21, S33: code, phase, Doppler sign, C/N0', () => {
    const clean = ['G22', 'G21', 'S33'];
    const ep = oracle.epochs[0]!;
    for (const prn of [...ep.sats.keys()]) {
      if (!clean.includes(prn)) ep.sats.delete(prn);
    }
    const r = compareWithOracle(oracle, res.epochs);
    for (const k of ['C', 'L', 'D', 'S'] as const) {
      expect(r[k].missing, k).toEqual([]);
    }
    expect(r.C.n).toBe(7); // G22 1C/1W/2W, G21 1C/2W, S33 1C/5I
    expect(r.L.n).toBe(7);
    expect(r.D.n).toBe(4);
    expect(r.C.maxDiff).toBeLessThanOrEqual(5e-4 + 1e-6);
    expect(r.L.maxDiff).toBeLessThanOrEqual(5e-4 + 1e-6);
    expect(r.D.maxDiff).toBeLessThanOrEqual(5e-4 + 1e-6);
    // BINEX C/N0 is 0.1 dB-Hz; RTKLIB stores 0.25 dB-Hz steps.
    expect(r.S.maxDiff).toBeLessThan(0.25);
  });

  it('pins where RTKLIB 2.4.2 derails (and that we decode those satellites)', () => {
    const rows = oracle.epochs[0]!.rows;
    expect(rows.map((r) => r.prn)).toEqual([
      'G22',
      'G21',
      'E30',
      'R11',
      'S33',
      'E05',
    ]);
    expect(rows[2]!.obs.size).toBe(0);
    expect(rows[3]!.obs.size).toBe(0);
    const ours = new Set(res.epochs[0]!.meas.map((m) => m.prn));
    expect(ours.has('E30')).toBe(true);
    expect(ours.has('R11')).toBe(true);
    expect(ours.has('E05')).toBe(false);
  });
});
