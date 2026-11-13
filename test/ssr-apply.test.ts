import { describe, it, expect } from 'vitest';
import {
  applyOrbitClock,
  hasToOrbitClock,
  type OrbitClockCorrection,
} from '../src/positioning/ssr-apply';
import { computeSatPosition } from '../src/orbit';
import type { KeplerEphemeris } from '../src/rinex/nav';
import { C_LIGHT } from '../src/constants/gnss';

const GPS_EPOCH = Date.UTC(1980, 0, 6);
const T0 = Date.UTC(2025, 2, 26, 4, 0, 0);
const sowOf = (ms: number) => ((ms - GPS_EPOCH) / 1000) % 604800;
const weekOf = (ms: number) => Math.floor((ms - GPS_EPOCH) / (604800 * 1000));

/** A circular MEO GPS ephemeris with IODE 1 — gives a finite, non-degenerate
 *  position + velocity so the RAC frame is well defined. */
const eph: KeplerEphemeris = {
  system: 'G',
  prn: 'G01',
  toc: sowOf(T0),
  tocDate: new Date(T0),
  af0: 0,
  af1: 0,
  af2: 0,
  iode: 1,
  crs: 0,
  deltaN: 0,
  m0: 0.3,
  cuc: 0,
  e: 0,
  cus: 0,
  sqrtA: Math.sqrt(26559800),
  toe: sowOf(T0),
  cic: 0,
  omega0: 1.1,
  cis: 0,
  i0: 0.9617,
  crc: 0,
  omega: 0,
  omegaDot: 0,
  idot: 0,
  week: weekOf(T0),
  svHealth: 0,
  tgd: 0,
};

const baseCorr = (
  over: Partial<OrbitClockCorrection> = {}
): OrbitClockCorrection => ({
  prn: 'G01',
  iod: 1,
  refTimeMs: T0,
  radial: 0,
  along: 0,
  cross: 0,
  clockC0: 0,
  validitySeconds: null,
  ...over,
});

const dist = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('applyOrbitClock', () => {
  it('rejects a correction whose IOD does not match the ephemeris', () => {
    expect(applyOrbitClock(eph, baseCorr({ iod: 2 }), T0)).toBeNull();
  });

  it('leaves the orbit unchanged and clock zero for a null correction', () => {
    const broadcast = computeSatPosition(eph, T0);
    const out = applyOrbitClock(eph, baseCorr(), T0)!;
    expect(out).not.toBeNull();
    expect(dist(out, broadcast)).toBeLessThan(1e-6);
    expect(out.clockOffsetS).toBe(0);
  });

  it('shifts the position by exactly |Δ| (orthonormal RAC rotation)', () => {
    const broadcast = computeSatPosition(eph, T0);
    const dr = 1.5,
      da = -2.3,
      dc = 0.7;
    const out = applyOrbitClock(
      eph,
      baseCorr({ radial: dr, along: da, cross: dc }),
      T0
    )!;
    expect(dist(out, broadcast)).toBeCloseTo(Math.hypot(dr, da, dc), 6);
  });

  it('directs a pure radial correction along the position vector', () => {
    const broadcast = computeSatPosition(eph, T0);
    const dr = 2.0;
    const out = applyOrbitClock(eph, baseCorr({ radial: dr }), T0)!;
    const shift = [
      out.x - broadcast.x,
      out.y - broadcast.y,
      out.z - broadcast.z,
    ];
    const rn = Math.hypot(broadcast.x, broadcast.y, broadcast.z);
    const rhat = [broadcast.x / rn, broadcast.y / rn, broadcast.z / rn];
    const along =
      shift[0]! * rhat[0]! + shift[1]! * rhat[1]! + shift[2]! * rhat[2]!;
    const perp = Math.hypot(
      shift[0]! - along * rhat[0]!,
      shift[1]! - along * rhat[1]!,
      shift[2]! - along * rhat[2]!
    );
    expect(along).toBeCloseTo(dr, 6); // radial pushes outward, positive
    expect(perp).toBeLessThan(1e-6); // nothing perpendicular
  });

  it('applies the linear rate of the deltas over time', () => {
    const t = T0 + 10_000; // age 10 s
    const out = applyOrbitClock(eph, baseCorr({ dotRadial: 0.1 }), t)!;
    const broadcast = computeSatPosition(eph, t);
    // radial component of the shift = radial + dotRadial·age = 0 + 0.1·10 = 1 m
    expect(dist(out, broadcast)).toBeCloseTo(1.0, 6);
  });

  it('converts the clock polynomial to seconds (c0 + c1·dt + high-rate)', () => {
    const t = T0 + 5_000; // age 5 s
    const out = applyOrbitClock(
      eph,
      baseCorr({ clockC0: 3.0, clockC1: 0.2, highRateClock: 0.5 }),
      t
    )!;
    const expectedM = 3.0 + 0.2 * 5 + 0.5;
    expect(out.clockOffsetS).toBeCloseTo(expectedM / C_LIGHT, 15);
  });

  it('rejects an expired correction (age beyond validity)', () => {
    const t = T0 + 30_000; // age 30 s
    expect(
      applyOrbitClock(eph, baseCorr({ validitySeconds: 20 }), t)
    ).toBeNull();
  });
});

describe('hasToOrbitClock', () => {
  it('maps HAS orbit + clock into an additive correction (no sign flip)', () => {
    const c = hasToOrbitClock(
      {
        system: 'G',
        prn: 'G01',
        gnssIod: 7,
        deltaRadial: 0.4,
        deltaInTrack: -0.8,
        deltaCrossTrack: 0.2,
      },
      { system: 'G', prn: 'G01', deltaClock: 1.5, notUsable: false },
      T0,
      10
    )!;
    expect(c).toMatchObject({
      prn: 'G01',
      iod: 7,
      radial: 0.4,
      along: -0.8,
      cross: 0.2,
      clockC0: 1.5,
      validitySeconds: 10,
    });
  });

  it('returns null when the orbit deltas are unavailable', () => {
    const c = hasToOrbitClock(
      {
        system: 'G',
        prn: 'G01',
        gnssIod: 7,
        deltaRadial: null,
        deltaInTrack: 0.1,
        deltaCrossTrack: 0.1,
      },
      undefined,
      T0,
      10
    );
    expect(c).toBeNull();
  });

  it('zeroes the clock when the satellite is flagged not-usable', () => {
    const c = hasToOrbitClock(
      {
        system: 'G',
        prn: 'G01',
        gnssIod: 7,
        deltaRadial: 0.1,
        deltaInTrack: 0.1,
        deltaCrossTrack: 0.1,
      },
      { system: 'G', prn: 'G01', deltaClock: 5, notUsable: true },
      T0,
      10
    )!;
    expect(c.clockC0).toBe(0);
  });
});

describe('applyOrbitClock RAC frame on an eccentric orbit', () => {
  // RTCM 10403.3 eq. 3.12-2…4 and HAS SIS ICD §7.2 eq. 18–20: e_along =
  // ṙ/|ṙ|, e_cross = r×ṙ/|r×ṙ|, e_radial = e_along × e_cross — not r̂
  // (RTCM note 188). QZSS-IGSO-like e = 0.075 makes the two differ by ~4°,
  // so a pure along-track correction must move the satellite along ṙ.
  const ecc: KeplerEphemeris = { ...eph, e: 0.075, m0: 1.2, omega: -1.6 };
  const unitV = (a: number[]) => {
    const n = Math.hypot(a[0]!, a[1]!, a[2]!);
    return a.map((x) => x / n);
  };
  const crossV = (a: number[], b: number[]) => [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
  const shiftOf = (c: Partial<OrbitClockCorrection>) => {
    const b = computeSatPosition(ecc, T0);
    const o = applyOrbitClock(ecc, baseCorr(c), T0)!;
    return { s: [o.x - b.x, o.y - b.y, o.z - b.z], b };
  };

  it('along = velocity, cross = r × v, radial = along × cross', () => {
    const { s: sa, b } = shiftOf({ along: 1 });
    const { s: sc } = shiftOf({ cross: 1 });
    const { s: sr } = shiftOf({ radial: 1 });
    const ea = unitV([b.vx, b.vy, b.vz]);
    const ec = unitV(crossV([b.x, b.y, b.z], [b.vx, b.vy, b.vz]));
    const er = crossV(ea, ec);
    for (let k = 0; k < 3; k++) {
      expect(sa[k]!).toBeCloseTo(ea[k]!, 6);
      expect(sc[k]!).toBeCloseTo(ec[k]!, 6);
      expect(sr[k]!).toBeCloseTo(er[k]!, 6);
    }
    // ...and that radial is measurably not r̂ on this orbit (> 1°).
    const rh = unitV([b.x, b.y, b.z]);
    const cosAng = er[0]! * rh[0]! + er[1]! * rh[1]! + er[2]! * rh[2]!;
    expect(Math.acos(Math.min(1, cosAng))).toBeGreaterThan(Math.PI / 180);
  });
});
