import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseRinexStream } from '../src/rinex';
import { crxRepair } from '../src/rinex/crx';
import { parseAntex } from '../src/antex';
import {
  buildPppAntenna,
  phaseWindup,
  satBodyFrame,
  enuToEcef,
} from '../src/positioning/ppp-antenna';
import { createPppCorrections } from '../src/positioning';
import { FREQ } from '../src/constants/gnss';
import { geodeticToEcef } from '../src/coordinates';

const FIX = join(__dirname, '..', 'test-fixtures');

/* ------------------------------------------------------------------ */
/*  Hatanaka (CRINEX) decoding — must match crx2rnx bit for bit        */
/* ------------------------------------------------------------------ */

describe('CRINEX epoch-line differencing', () => {
  it('copies a diff longer than the old line literally, spaces included', () => {
    // crx2rnx repair(): past the old line's end the diff is copied as is.
    expect(crxRepair('ABC', '   E 4')).toBe('ABCE 4');
    expect(crxRepair('ABCDEF', 'x &')).toBe('xB DEF');
    expect(crxRepair('AB', '  & &')).toBe('AB   ');
  });

  // First 92 epochs of IGS ANMG 2024-001 (Trimble NetR9): satellite counts
  // rise and fall, ids are written "G 2", and epoch 86's line is longer
  // than the previous one. Expected values: crx2rnx (RNXCMP 4.2.0) output,
  // digested independently of this library.
  it('decodes the ANMG slice exactly like crx2rnx', async () => {
    const bytes = new Uint8Array(readFileSync(join(FIX, 'anmg_crx_slice.crx')));
    let n = 0;
    let sum = 0;
    let epoch = 0;
    let last = -1;
    const prns86: string[] = [];
    let e04c1x: number | null = null;
    await parseRinexStream(
      new File([bytes], 'anmg.crx'),
      undefined,
      undefined,
      (time, prn, codes, values) => {
        if (time !== last) {
          epoch++;
          last = time;
        }
        if (epoch === 86) {
          prns86.push(prn);
          if (prn === 'E04') e04c1x = values[codes.indexOf('C1X')] ?? null;
        }
        for (const v of values)
          if (v !== null) {
            n++;
            sum += v;
          }
      }
    );
    expect(epoch).toBe(92);
    expect(n).toBe(39065);
    expect(sum).toBeCloseTo(1962322924180.2546, 2);
    expect(prns86.join(' ')).toBe(
      'R16 G26 G31 R05 R14 G32 R18 G29 G18 R03 R19 J02 J07 J04 J03 G28 G25 ' +
        'R20 R04 R15 G10 G23 G12 C29 C26 C13 C04 C19 C01 C05 C22 C06 C20 ' +
        'C03 C02 C16 E11 E10 E12 E14 E21 E19 E04'
    );
    expect(e04c1x).toBe(26324827.32);
  });
});

/* ------------------------------------------------------------------ */
/*  Satellite antenna selection by date                                 */
/* ------------------------------------------------------------------ */

describe('PPP antenna model', () => {
  const atx = parseAntex(
    readFileSync(join(FIX, 'antex_ppp_slice.atx'), 'utf8')
  );
  const model = buildPppAntenna(atx);
  const f1 = FREQ.G!['1']!;
  const f2 = FREQ.G!['2']!;
  const ifZ = (type: string) => {
    const e = atx.antennas.find(
      (a) => a.serialNo === 'G04' && a.type.trim() === type
    )!;
    const z = (c: string) =>
      e.frequencies.find((f) => f.frequency === c)!.pcoU / 1000;
    const g = (f1 * f1) / (f1 * f1 - f2 * f2);
    return g * z('G01') - (g - 1) * z('G02');
  };

  it('uses the satellite antenna valid on the observation date', () => {
    // G04 has flown on seven spacecraft; on 2024-01-01 it is a Block IIIA.
    const off = model.satOffset(
      'G04',
      Date.UTC(2024, 0, 1),
      'G01',
      'G02',
      f1,
      f2
    )!;
    expect(off.pco[2]).toBeCloseTo(ifZ('BLOCK IIIA'), 6);
    const old = model.satOffset(
      'G04',
      Date.UTC(2000, 0, 1),
      'G01',
      'G02',
      f1,
      f2
    )!;
    expect(old.pco[2]).toBeCloseTo(ifZ('BLOCK IIA'), 6);
  });

  it('applies the antenna height along the local vertical', () => {
    // A receiver at 50° N: raising the antenna 10 cm shortens the zenith
    // range by exactly 10 cm (geodetic radians, not degrees, set the frame).
    const rcvEcef = geodeticToEcef(
      (50 * Math.PI) / 180,
      (8 * Math.PI) / 180,
      200
    );
    const up = enuToEcef([0, 0, 1], (50 * Math.PI) / 180, (8 * Math.PI) / 180);
    const geom = {
      prn: 'G04',
      satEcef: [
        rcvEcef[0] + up[0] * 2e7,
        rcvEcef[1] + up[1] * 2e7,
        rcvEcef[2] + up[2] * 2e7,
      ] as [number, number, number],
      rcvEcef,
      los: up,
      elRad: Math.PI / 2,
      azRad: 0,
      f1,
      f2,
      band1: 'G01',
      band2: 'G02',
      g: (f1 * f1) / (f1 * f1 - f2 * f2),
    };
    const range = (h: number) =>
      createPppCorrections({
        antenna: model,
        rcvAntType: 'LEIAR25.R3      NONE',
        antDeltaEnu: [0, 0, h],
        satPco: false,
        tides: false,
        windup: false,
      }).evaluate!(geom, null).rangeM;
    expect(range(0.1) - range(0)).toBeCloseTo(-0.1, 9);
  });
});

/* ------------------------------------------------------------------ */
/*  Phase wind-up — RTKLIB windupcorr() transcribed independently       */
/* ------------------------------------------------------------------ */

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const nrm = (a: V3) => Math.hypot(...a);

/** RTKLIB rtkcmn.c windupcorr(), one call, fresh state (cycles). */
function rtklibWindup(rs: V3, rr: V3, sun: V3, lat: number, lon: number) {
  const r = nrm([rs[0] - rr[0], rs[1] - rr[1], rs[2] - rr[2]]);
  const ek: V3 = [
    (rr[0] - rs[0]) / r,
    (rr[1] - rs[1]) / r,
    (rr[2] - rs[2]) / r,
  ];
  // Nominal yaw attitude: ez → Earth, es → Sun.
  const ezs: V3 = [-rs[0] / nrm(rs), -rs[1] / nrm(rs), -rs[2] / nrm(rs)];
  const sd: V3 = [sun[0] - rs[0], sun[1] - rs[1], sun[2] - rs[2]];
  const ess: V3 = [sd[0] / nrm(sd), sd[1] / nrm(sd), sd[2] / nrm(sd)];
  const c1 = cross(ezs, ess);
  const eys: V3 = [c1[0] / nrm(c1), c1[1] / nrm(c1), c1[2] / nrm(c1)];
  const exs = cross(eys, ezs);
  // Receiver: x = north, y = west.
  const sl = Math.sin(lat),
    cl = Math.cos(lat),
    so = Math.sin(lon),
    co = Math.cos(lon);
  const exr: V3 = [-sl * co, -sl * so, cl];
  const eyr: V3 = [so, -co, 0];
  const eks = cross(ek, eys);
  const ekr = cross(ek, eyr);
  const ds: V3 = [0, 1, 2].map(
    (i) => exs[i]! - ek[i]! * dot(ek, exs) - eks[i]!
  ) as V3;
  const dr: V3 = [0, 1, 2].map(
    (i) => exr[i]! - ek[i]! * dot(ek, exr) + ekr[i]!
  ) as V3;
  let cosp = dot(ds, dr) / nrm(ds) / nrm(dr);
  cosp = Math.max(-1, Math.min(1, cosp));
  let ph = Math.acos(cosp) / 2 / Math.PI;
  if (dot(ek, cross(ds, dr)) < 0) ph = -ph;
  return ph;
}

describe('phaseWindup', () => {
  it('matches RTKLIB windupcorr on random geometries', () => {
    let seed = 7;
    const rnd = () =>
      ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let k = 0; k < 200; k++) {
      const lat = rnd() * 1.4;
      const lon = rnd() * Math.PI;
      const rr: V3 = geodeticToEcef(lat, lon, 100);
      const up = enuToEcef([rnd() * 0.6, rnd() * 0.6, 1], lat, lon);
      const rs: V3 = [
        rr[0] + up[0] * 2.2e7,
        rr[1] + up[1] * 2.2e7,
        rr[2] + up[2] * 2.2e7,
      ];
      const sun: V3 = [1.4e11 * rnd(), 1.4e11 * rnd(), 5e10 * rnd()];
      const los: V3 = [rs[0] - rr[0], rs[1] - rr[1], rs[2] - rr[2]];
      const n = nrm(los);
      const ours = phaseWindup(
        'G01',
        [los[0] / n, los[1] / n, los[2] / n],
        satBodyFrame(rs, sun),
        lat,
        lon,
        new Map()
      );
      expect(ours).toBeCloseTo(rtklibWindup(rs, rr, sun, lat, lon), 9);
    }
  });
});
