/**
 * Orbit geometry that doesn't depend on where the orbit came from:
 * classical elements from a state vector, a summary of a mean element set
 * (period, apsides, regime), the Sun's beta angle, Earth-shadow
 * (eclipse) state and events, and pass prediction for one observer.
 *
 * Positions are ECEF metres; the position functions take GPS-scale
 * epoch milliseconds (the library-wide convention).
 */

import { ecefToGeodetic } from '../coordinates/ecef';
import { sunEcef } from '../positioning/ppp-astro';
import { WGS72, type GpElements } from './sgp4';
import type { SatPosition } from './index';

const TWO_PI = 2 * Math.PI;
const RAD2DEG = 180 / Math.PI;
const OMEGA_EARTH = 7.2921151467e-5; // rad/s
const GM_EARTH = 3.986004418e14; // m³/s²
const R_EARTH = 6378137; // m
const R_SUN = 6.957e8; // m
const SIDEREAL_DAY_MIN = 1436.0682;

/* ------------------------------------------------------------------ */
/*  Elements                                                           */
/* ------------------------------------------------------------------ */

export type OrbitRegime = 'LEO' | 'MEO' | 'GEO' | 'IGSO' | 'HEO' | 'Beyond GEO';

export interface ElementSummary {
  /** Minutes. */
  periodMin: number;
  revsPerDay: number;
  /** Mean semi-major axis, km (un-Kozai'd, as SGP4 uses it). */
  semiMajorAxisKm: number;
  /** Altitudes above the equatorial radius, km. */
  apogeeKm: number;
  perigeeKm: number;
  regime: OrbitRegime;
}

/**
 * Period, apsides and regime of a mean element set. Regimes: GEO
 * (geosynchronous, i < 3°, e < 0.01), IGSO (geosynchronous otherwise —
 * BeiDou IGSO, QZSS), HEO (e > 0.25: Molniya, GTO), LEO (perigee below
 * 2000 km), MEO up to GEO height.
 */
export function elementSummary(el: GpElements): ElementSummary {
  const { xke, radiusEarthKm, j2 } = WGS72;
  const noKozai = (el.meanMotion * TWO_PI) / 1440; // rad/min
  // Kozai → Brouwer mean motion, as sgp4init's initl does
  const e2 = el.eccentricity * el.eccentricity;
  const cosi = Math.cos(el.inclination / RAD2DEG);
  const ak = Math.pow(xke / noKozai, 2 / 3);
  const d1 = (0.75 * j2 * (3 * cosi * cosi - 1)) / Math.pow(1 - e2, 1.5);
  let del = d1 / (ak * ak);
  const adel = ak * (1 - del * del - del * (1 / 3 + (134 * del * del) / 81));
  del = d1 / (adel * adel);
  const no = noKozai / (1 + del);
  const aEr = Math.pow(xke / no, 2 / 3);
  const a = aEr * radiusEarthKm;
  const apogeeKm = a * (1 + el.eccentricity) - radiusEarthKm;
  const perigeeKm = a * (1 - el.eccentricity) - radiusEarthKm;
  const periodMin = 1440 / el.meanMotion;

  let regime: OrbitRegime;
  if (el.eccentricity > 0.25) regime = 'HEO';
  else if (perigeeKm < 2000) regime = 'LEO';
  else if (Math.abs(periodMin - SIDEREAL_DAY_MIN) < 30)
    regime = el.inclination < 3 && el.eccentricity < 0.01 ? 'GEO' : 'IGSO';
  else if (periodMin < SIDEREAL_DAY_MIN) regime = 'MEO';
  else regime = 'Beyond GEO';

  return {
    periodMin,
    revsPerDay: el.meanMotion,
    semiMajorAxisKm: a,
    apogeeKm,
    perigeeKm,
    regime,
  };
}

/** Classical (osculating) elements, angles in degrees. */
export interface KeplerianElements {
  /** m */
  a: number;
  e: number;
  i: number;
  raan: number;
  argPerigee: number;
  trueAnomaly: number;
  meanAnomaly: number;
  /** s */
  period: number;
}

/**
 * Osculating elements from an inertial state (m, m/s). For an ECEF state,
 * pass the inertial velocity (`inertialVelocity`) — the node is then
 * referred to the Greenwich meridian of that instant.
 */
export function stateToKeplerian(
  r: readonly [number, number, number],
  v: readonly [number, number, number],
  mu = GM_EARTH
): KeplerianElements {
  const [x, y, z] = r;
  const [vx, vy, vz] = v;
  const rn = Math.hypot(x, y, z);
  const v2 = vx * vx + vy * vy + vz * vz;
  const hx = y * vz - z * vy;
  const hy = z * vx - x * vz;
  const hz = x * vy - y * vx;
  const h = Math.hypot(hx, hy, hz);
  const rv = x * vx + y * vy + z * vz;
  const ex = ((v2 - mu / rn) * x - rv * vx) / mu;
  const ey = ((v2 - mu / rn) * y - rv * vy) / mu;
  const ez = ((v2 - mu / rn) * z - rv * vz) / mu;
  const e = Math.hypot(ex, ey, ez);
  const a = 1 / (2 / rn - v2 / mu);
  const i = Math.acos(hz / h);
  // node vector n = k × h
  const nx = -hy;
  const ny = hx;
  const nn = Math.hypot(nx, ny);
  let raan = nn > 1e-12 ? Math.atan2(ny, nx) : 0;
  if (raan < 0) raan += TWO_PI;
  let argp: number;
  let nu: number;
  if (e > 1e-10) {
    if (nn > 1e-12) {
      argp = Math.acos(clamp((nx * ex + ny * ey) / (nn * e)));
      if (ez < 0) argp = TWO_PI - argp;
    } else {
      argp = Math.atan2(ey, ex);
      if (argp < 0) argp += TWO_PI;
    }
    nu = Math.acos(clamp((ex * x + ey * y + ez * z) / (e * rn)));
    if (rv < 0) nu = TWO_PI - nu;
  } else {
    // circular: argument of latitude as true anomaly
    argp = 0;
    nu =
      nn > 1e-12
        ? Math.acos(clamp((nx * x + ny * y) / (nn * rn)))
        : Math.atan2(y, x);
    if (nn > 1e-12 && z < 0) nu = TWO_PI - nu;
    if (nu < 0) nu += TWO_PI;
  }
  const E = 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(nu / 2));
  let M = E - e * Math.sin(E);
  if (M < 0) M += TWO_PI;
  return {
    a,
    e,
    i: i * RAD2DEG,
    raan: raan * RAD2DEG,
    argPerigee: argp * RAD2DEG,
    trueAnomaly: nu * RAD2DEG,
    meanAnomaly: M * RAD2DEG,
    period: a > 0 ? TWO_PI * Math.sqrt((a * a * a) / mu) : NaN,
  };
}

function clamp(x: number): number {
  return Math.max(-1, Math.min(1, x));
}

/** ECEF velocity → velocity in the instantaneous inertial frame (v + ω×r). */
export function inertialVelocity(p: SatPosition): [number, number, number] {
  return [p.vx - OMEGA_EARTH * p.y, p.vy + OMEGA_EARTH * p.x, p.vz];
}

/* ------------------------------------------------------------------ */
/*  Sun geometry                                                       */
/* ------------------------------------------------------------------ */

/**
 * Beta angle (degrees): elevation of the Sun above the orbital plane.
 * |β| small → eclipse season and noon/midnight turns (yaw manoeuvres);
 * the sign tells which side of the plane the Sun is on.
 */
export function betaAngle(p: SatPosition, sun: readonly number[]): number {
  const v = inertialVelocity(p);
  const hx = p.y * v[2] - p.z * v[1];
  const hy = p.z * v[0] - p.x * v[2];
  const hz = p.x * v[1] - p.y * v[0];
  const h = Math.hypot(hx, hy, hz);
  const s = Math.hypot(sun[0]!, sun[1]!, sun[2]!);
  return (
    Math.asin(clamp((hx * sun[0]! + hy * sun[1]! + hz * sun[2]!) / (h * s))) *
    RAD2DEG
  );
}

/**
 * Fraction of the solar disc visible from the satellite: 1 sunlit,
 * 0 umbra, in between penumbra (conical shadow, spherical Earth —
 * Montenbruck & Gill §3.4.2).
 */
export function sunlitFraction(
  sat: readonly [number, number, number],
  sun: readonly number[]
): number {
  const dx = sun[0]! - sat[0];
  const dy = sun[1]! - sat[1];
  const dz = sun[2]! - sat[2];
  const dSun = Math.hypot(dx, dy, dz);
  const rSat = Math.hypot(sat[0], sat[1], sat[2]);
  const a = Math.asin(R_SUN / dSun); // apparent solar radius
  const b = Math.asin(Math.min(1, R_EARTH / rSat)); // apparent Earth radius
  const c = Math.acos(
    clamp(-(sat[0] * dx + sat[1] * dy + sat[2] * dz) / (rSat * dSun))
  );
  if (c >= a + b) return 1;
  if (c <= b - a) return 0;
  const x = (c * c + a * a - b * b) / (2 * c);
  const y = Math.sqrt(Math.max(0, a * a - x * x));
  const area =
    a * a * Math.acos(clamp(x / a)) +
    b * b * Math.acos(clamp((c - x) / b)) -
    c * y;
  return Math.max(0, Math.min(1, 1 - area / (Math.PI * a * a)));
}

export interface ShadowInterval {
  /** Penumbra entry / exit, GPS-scale ms. */
  start: number;
  end: number;
  /** Umbra entry / exit, when the satellite reaches full shadow. */
  umbraStart?: number;
  umbraEnd?: number;
  /** Deepest point: lowest sunlit fraction. */
  minFraction: number;
}

type PositionFn = (gpsMs: number) => SatPosition | null;

/**
 * Earth-shadow passages between t0 and t1, edges refined to ~1 s.
 * @param pos Position function (e.g. `t => tlePositionEcef(sat, t)`)
 * @param stepMs Scan step — keep it below the shortest shadow (default 60 s)
 */
export function shadowIntervals(
  pos: PositionFn,
  t0: number,
  t1: number,
  stepMs = 60_000
): ShadowInterval[] {
  const frac = (t: number): number => {
    const p = pos(t);
    return p ? sunlitFraction([p.x, p.y, p.z], sunEcef(t)) : 1;
  };
  const state = (f: number): 0 | 1 | 2 => (f >= 1 ? 0 : f <= 0 ? 2 : 1);
  const edge = (a: number, b: number, test: (f: number) => boolean) => {
    // test(a) differs from test(b): bisect to 1 s
    while (b - a > 1000) {
      const m = (a + b) / 2;
      if (test(frac(m)) === test(frac(a))) a = m;
      else b = m;
    }
    return (a + b) / 2;
  };

  const out: ShadowInterval[] = [];
  let cur: ShadowInterval | null = null;
  let tPrev = t0;
  let fPrev = frac(t0);
  if (fPrev < 1) cur = { start: t0, end: t0, minFraction: fPrev };
  if (cur && fPrev <= 0) cur.umbraStart = t0;
  for (let t = t0 + stepMs; ; t += stepMs) {
    const tt = Math.min(t, t1);
    const f = frac(tt);
    const sPrev = state(fPrev);
    const s = state(f);
    if (sPrev === 0 && s !== 0) {
      cur = { start: edge(tPrev, tt, (x) => x < 1), end: tt, minFraction: f };
    }
    if (cur) {
      cur.minFraction = Math.min(cur.minFraction, f);
      if (sPrev !== 2 && s === 2)
        cur.umbraStart = edge(tPrev, tt, (x) => x <= 0);
      if (sPrev === 2 && s !== 2) cur.umbraEnd = edge(tPrev, tt, (x) => x <= 0);
      if (s === 0) {
        cur.end = edge(tPrev, tt, (x) => x < 1);
        out.push(cur);
        cur = null;
      }
    }
    tPrev = tt;
    fPrev = f;
    if (tt >= t1) break;
  }
  if (cur) {
    cur.end = t1;
    out.push(cur);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Passes                                                             */
/* ------------------------------------------------------------------ */

export interface Pass {
  /** Rise above the mask / set below it, GPS-scale ms (clipped to the window). */
  rise: number;
  set: number;
  /** Culmination. */
  maxTime: number;
  /** Degrees. */
  maxElevation: number;
  riseAzimuth: number;
  setAzimuth: number;
  maxAzimuth: number;
  /** True when the satellite is sunlit at culmination and the observer's
   *  Sun is below −6° (civil twilight): a naked-eye pass, if bright enough. */
  visible: boolean;
}

/** Azimuth/elevation (degrees) of an ECEF point from an observer. */
export function lookAngles(
  rx: readonly [number, number, number],
  p: readonly [number, number, number]
): { az: number; el: number; range: number } {
  const [lat, lon] = ecefToGeodetic(rx[0], rx[1], rx[2]);
  const sl = Math.sin(lat);
  const cl = Math.cos(lat);
  const so = Math.sin(lon);
  const co = Math.cos(lon);
  const dx = p[0] - rx[0];
  const dy = p[1] - rx[1];
  const dz = p[2] - rx[2];
  const e = -so * dx + co * dy;
  const n = -sl * co * dx - sl * so * dy + cl * dz;
  const u = cl * co * dx + cl * so * dy + sl * dz;
  let az = Math.atan2(e, n) * RAD2DEG;
  if (az < 0) az += 360;
  return {
    az,
    el: Math.atan2(u, Math.hypot(e, n)) * RAD2DEG,
    range: Math.hypot(dx, dy, dz),
  };
}

/**
 * Passes of one satellite over one observer, rise/set refined to ~1 s and
 * culmination by golden-section search. Works for any regime; for LEO keep
 * `stepMs` at or below 60 s (a low pass lasts a few minutes).
 */
export function predictPasses(
  pos: PositionFn,
  rx: readonly [number, number, number],
  t0: number,
  t1: number,
  opts: { maskDeg?: number; stepMs?: number } = {}
): Pass[] {
  const mask = opts.maskDeg ?? 10;
  const step = opts.stepMs ?? 30_000;
  const elAt = (t: number): number => {
    const p = pos(t);
    return p ? lookAngles(rx, [p.x, p.y, p.z]).el : -90;
  };
  const azAt = (t: number): number => {
    const p = pos(t);
    return p ? lookAngles(rx, [p.x, p.y, p.z]).az : NaN;
  };
  const cross = (a: number, b: number): number => {
    const above = elAt(a) >= mask;
    while (b - a > 1000) {
      const m = (a + b) / 2;
      if (elAt(m) >= mask === above) a = m;
      else b = m;
    }
    return (a + b) / 2;
  };

  const passes: Pass[] = [];
  let riseT: number | null = elAt(t0) >= mask ? t0 : null;
  let tPrev = t0;
  for (let t = t0 + step; ; t += step) {
    const tt = Math.min(t, t1);
    const above = elAt(tt) >= mask;
    if (riseT === null && above) riseT = cross(tPrev, tt);
    else if (riseT !== null && (!above || tt >= t1)) {
      const setT = above ? tt : cross(tPrev, tt);
      passes.push(finishPass(riseT, setT));
      riseT = null;
    }
    tPrev = tt;
    if (tt >= t1) break;
  }
  return passes;

  function finishPass(rise: number, set: number): Pass {
    // golden-section search for the elevation maximum
    const g = (Math.sqrt(5) - 1) / 2;
    let a = rise;
    let b = set;
    let c = b - g * (b - a);
    let d = a + g * (b - a);
    let fc = elAt(c);
    let fd = elAt(d);
    while (b - a > 1000) {
      if (fc > fd) {
        b = d;
        d = c;
        fd = fc;
        c = b - g * (b - a);
        fc = elAt(c);
      } else {
        a = c;
        c = d;
        fc = fd;
        d = a + g * (b - a);
        fd = elAt(d);
      }
    }
    const maxTime = (a + b) / 2;
    const p = pos(maxTime);
    const sun = sunEcef(maxTime);
    const sunEl = lookAngles(rx, [sun[0], sun[1], sun[2]]).el;
    const lit = p ? sunlitFraction([p.x, p.y, p.z], sun) > 0.5 : false;
    return {
      rise,
      set,
      maxTime,
      maxElevation: elAt(maxTime),
      riseAzimuth: azAt(rise),
      setAzimuth: azAt(set),
      maxAzimuth: azAt(maxTime),
      visible: lit && sunEl < -6,
    };
  }
}
