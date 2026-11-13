/**
 * RTCM 2.3 against RTKLIB convbin (test-fixtures/convbin/rtcm2_avl12.obs):
 * every Type 18 carrier phase and Type 19 pseudorange of the AVL12 capture,
 * the Type 3 reference position and the Type 22 L1 phase-centre offset.
 *
 * Conventions locked here:
 *  - Type 18 phase is transmitted with the opposite sign (RTCM 2.3 §4.3,
 *    "carrier phase" field = −φ): the decoder negates it, as RTKLIB does.
 *  - Z-count of GLONASS records is GLONASS time (UTC based): adding the GPS
 *    leap seconds puts it on the GPS scale RTKLIB writes (`utc2gpst`).
 *  - Type 3 is ECEF X, Y, Z in 0.01 m; Type 22 is an ECEF dX/dY/dZ in 1/256 cm.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { Rtcm2Decoder, rtcm2Observation, rtcm2Station } from '../src/rtcm2';
import { readRinex3Obs } from './helpers/rinex3-obs-oracle';

const FIX = join(__dirname, '..', 'test-fixtures');
const frames = new Rtcm2Decoder().decode(
  new Uint8Array(readFileSync(join(FIX, 'rtcm2_avl12_slice.bin')))
);
const oracleText = readFileSync(
  join(FIX, 'convbin', 'rtcm2_avl12.obs'),
  'utf8'
);
const oracle = readRinex3Obs(oracleText);
const HOUR = 3_600_000;
/** GPS − UTC at the capture (and at the convbin -tr reference). */
const LEAP_S = 18;

describe('RTCM 2.3 Types 18/19 match RTKLIB convbin', () => {
  // (ms within the GPS hour)|PRN|RINEX type → value
  const ours = new Map<string, number>();
  for (const f of frames) {
    const o = rtcm2Observation(f);
    if (!o) continue;
    for (const r of o.records) {
      const sec = f.zcountSec + (r.system === 'R' ? LEAP_S : 0);
      const t = (Math.round((sec + o.microSec * 1e-6) * 1000) + HOUR) % HOUR;
      const kind = f.messageType === 18 ? 'L' : 'C';
      const attr = r.code === 'P' ? 'P' : 'C';
      ours.set(
        `${t}|${r.prn}|${kind}${o.freq + 1}${attr}`,
        kind === 'L' ? r.phaseCycles! : r.pseudorangeM!
      );
    }
  }

  it('agrees on every pseudorange and carrier phase, GPS and GLONASS', () => {
    const n: Record<string, number> = {};
    let maxDiff = 0;
    for (const ep of oracle.epochs) {
      for (const [prn, obs] of ep.sats) {
        for (const [type, v] of obs) {
          const mine = ours.get(`${ep.timeMs % HOUR}|${prn}|${type}`);
          expect(mine, `${prn} ${type}`).toBeDefined();
          maxDiff = Math.max(maxDiff, Math.abs(mine! - v.value));
          const k = prn[0]! + type;
          n[k] = (n[k] ?? 0) + 1;
        }
      }
    }
    expect(oracle.epochs).toHaveLength(13);
    expect(maxDiff).toBeLessThanOrEqual(5e-4 + 1e-6);
    // Both systems, both frequencies, both kinds were compared.
    for (const k of ['GC1C', 'GL1C', 'RC1C', 'RL1C', 'GC2P', 'GL2P']) {
      expect(n[k], k).toBeGreaterThan(20);
    }
  });

  it('GLONASS Z-count is UTC: without the leap it misses every epoch', () => {
    const r = oracle.epochs[3]!.sats.get('R01')!.get('C1C')!.value;
    const tGps = oracle.epochs[3]!.timeMs % HOUR;
    expect(ours.get(`${tGps}|R01|C1C`)).toBe(r);
    // The same pseudorange tagged 18 s earlier would be a different epoch.
    expect(ours.get(`${tGps - LEAP_S * 1000}|R01|C1C`)).not.toBe(r);
  });

  it('phase is negated on decode (RINEX sign: grows with the range)', () => {
    // Over consecutive epochs dΦ·λ tracks dρ (same sign) — independent of
    // RTKLIB. A missed negation flips it.
    const lambda = 299792458 / 1575.42e6;
    let checked = 0;
    for (let i = 1; i < oracle.epochs.length; i++) {
      const a = oracle.epochs[i - 1]!;
      const b = oracle.epochs[i]!;
      for (const [prn, obs] of b.sats) {
        if (prn[0] !== 'G') continue;
        const pa = a.sats.get(prn);
        if (!pa?.has('L1C') || !obs.has('L1C')) continue;
        const t0 = a.timeMs % HOUR;
        const t1 = b.timeMs % HOUR;
        const dPhi =
          ours.get(`${t1}|${prn}|L1C`)! - ours.get(`${t0}|${prn}|L1C`)!;
        const dRho =
          ours.get(`${t1}|${prn}|C1C`)! - ours.get(`${t0}|${prn}|C1C`)!;
        expect(Math.abs(dPhi * lambda - dRho)).toBeLessThan(5);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe('RTCM 2.3 station messages match RTKLIB', () => {
  const header = (label: string) =>
    oracleText
      .split('\n')
      .find((l) => l.slice(60).trim() === label)!
      .slice(0, 42)
      .trim()
      .split(/\s+/)
      .map(Number);
  const pos = rtcm2Station(frames.find((f) => f.messageType === 3)!)!.position!;
  const t22 = rtcm2Station(frames.find((f) => f.messageType === 22)!)!;

  it('Type 3 is ECEF X, Y, Z (m) — negative Y kept in place', () => {
    const xyz = header('APPROX POSITION XYZ');
    expect(xyz).toEqual([4604889.27, -476930.73, 4372677.21]);
    pos.forEach((v, i) => expect(v).toBeCloseTo(xyz[i]!, 2));
  });

  it('Type 22 L1 offset is ECEF dX/dY/dZ: rotated to ENU it is RTKLIB’s H/E/N', () => {
    // RTKLIB (decode_type22 → convrnx) rotates the ECEF delta into the local
    // frame at the Type 3 position and writes ANTENNA: DELTA H/E/N.
    const [h, e, n] = header('ANTENNA: DELTA H/E/N');
    const [x, y, z] = pos;
    const lon = Math.atan2(y, x);
    const lat = Math.atan2(z, Math.hypot(x, y) * (1 - 0.00669438)); // ≈ geodetic
    const [dx, dy, dz] = t22.l1Offset!;
    const east = -Math.sin(lon) * dx + Math.cos(lon) * dy;
    const north =
      -Math.sin(lat) * Math.cos(lon) * dx -
      Math.sin(lat) * Math.sin(lon) * dy +
      Math.cos(lat) * dz;
    const up =
      Math.cos(lat) * Math.cos(lon) * dx +
      Math.cos(lat) * Math.sin(lon) * dy +
      Math.sin(lat) * dz;
    expect(e).toBe(-0.0034);
    expect(n).toBe(-0.0009);
    expect(east).toBeCloseTo(e!, 4);
    expect(north).toBeCloseTo(n!, 4);
    expect(up).toBeCloseTo(h!, 4);
  });
});
