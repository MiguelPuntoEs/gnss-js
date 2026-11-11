import { describe, it, expect } from 'vitest';
import { computeSatPosition } from '../src/orbit/index';
import type { KeplerEphemeris } from '../src/rinex/nav';

/**
 * BeiDou broadcast orbits are defined with the CGCS2000 Earth rotation
 * rate (7.2921150e-5 rad/s), not WGS84's 7.2921151467e-5. Through the
 * Ωe·toe term the WGS84 value rotated BeiDou satellites by 1.467e-12·toe
 * rad — growing through the week to ~15–35 m by Saturday. Pinned against
 * ESA's final orbit (ESA0OPSFIN, 2026-09-19 12:00 GPST, toe = 561600 s BDT)
 * and the IGS combined broadcast file (BRDC00IGS 2026 262).
 */
const IGSO_MEO: [KeplerEphemeris, [number, number, number]][] = [
  [
    {
      system: 'C',
      prn: 'C30',
      tocDate: new Date('2026-09-19T12:00:00.000Z'),
      toc: 561600,
      af0: 0.000531063298695,
      af1: 7.24131865582e-12,
      af2: 0,
      iode: 1,
      crs: 71.140625,
      deltaN: 4.07659837811e-9,
      m0: 0.531044881842,
      cuc: 0.00000330153852701,
      e: 0.000387045089155,
      cus: 0.00000586314126849,
      sqrtA: 5282.64798737,
      toe: 561600,
      cic: 1.86264514923e-9,
      omega0: -0.965147721179,
      cis: 1.02445483208e-8,
      i0: 0.944060413917,
      crc: 235.1875,
      omega: 0.786407013649,
      omegaDot: -6.93707467129e-9,
      idot: -7.6431755118e-11,
      week: 1080,
      svHealth: 0,
      tgd: -9.6999999144e-9,
    } as KeplerEphemeris,
    [-17273691.13, -1330132.287, 21865180.412],
  ],
  [
    {
      system: 'C',
      prn: 'C08',
      tocDate: new Date('2026-09-19T12:00:00.000Z'),
      toc: 561600,
      af0: -0.000269096111879,
      af1: -3.7463365743e-12,
      af2: 0,
      iode: 1,
      crs: 497.640625,
      deltaN: 7.64674708914e-10,
      m0: -3.13903415177,
      cuc: 0.0000161598436534,
      e: 0.00461753702257,
      cus: 0.00000979145988822,
      sqrtA: 6493.69014931,
      toe: 561600,
      cic: -6.61239027977e-8,
      omega0: -1.25822947381,
      cis: -1.35041773319e-8,
      i0: 0.953057522488,
      crc: -52.40625,
      omega: -2.84334885262,
      omegaDot: -1.81721855159e-9,
      idot: -3.74301305437e-10,
      week: 1080,
      svHealth: 0,
      tgd: 9.00000018955e-10,
    } as KeplerEphemeris,
    [-15210201.798, 38200299.847, 10198406.168],
  ],
];

describe('BeiDou Earth rotation rate (CGCS2000)', () => {
  const t = Date.parse('2026-09-19T12:00:00.000Z');
  for (const [eph, [x, y, z]] of IGSO_MEO) {
    it(`${eph.prn} late in the week matches the precise orbit`, () => {
      const p = computeSatPosition(eph, t);
      // Broadcast vs precise: ~1–2 m (incl. CoM vs APC); was 14 m (C30)
      // and 33 m (C08) with the WGS84 rate.
      expect(Math.hypot(p.x - x, p.y - y, p.z - z)).toBeLessThan(3);
    });
  }
});
