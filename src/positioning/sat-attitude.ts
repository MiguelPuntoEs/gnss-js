/**
 * GNSS satellite attitude (yaw) models for PPP.
 *
 * The satellite antenna offset (PCO), its pattern and the carrier-phase
 * wind-up depend on how the spacecraft is turned about its Earth-pointing
 * axis. Outside eclipse seasons every constellation follows the nominal
 * yaw-steering law (solar panels perpendicular to the Sun). Near orbit noon
 * and midnight at small Sun elevations β above the orbital plane the nominal
 * yaw rate becomes unbounded and each satellite type does something of its
 * own — documented per law below. Getting it wrong costs up to a 180° yaw
 * error for tens of minutes: half a wind-up cycle (≈5 cm on the
 * ionosphere-free phase) and the full horizontal PCO (0.39 m on GPS IIF).
 *
 * Conventions (Kouba 2009; Montenbruck et al. 2015, "GNSS satellite geometry
 * and attitude models", Adv. Space Res. 56:1015):
 *  - β: elevation of the Sun above the orbital plane, positive on the side
 *    of the orbit normal r × v (inertial velocity).
 *  - μ: orbit angle of the satellite from orbit midnight (the point farthest
 *    from the Sun), increasing along the motion: midnight μ = 0, noon μ = π.
 *  - Yaw ψ: the body +X axis is cos ψ · t̂ − sin ψ · n̂ (t̂ along-track,
 *    n̂ orbit normal), +Z toward the Earth's centre, +Y = Z × X — the IGS
 *    body frame of the ANTEX satellite offsets. Nominal yaw steering is
 *    ψn = atan2(−tan β, sin μ); ψ = 0 is the orbit-normal attitude.
 *
 * Event timing (turn start, shadow entry) is computed on a circular orbit
 * with β held constant over the manoeuvre — the approximation of Kouba's
 * eclips model; it keeps the models stateless (a function of the epoch's
 * geometry only), so they need no per-satellite history.
 */

import type { OrbexFile } from '../rinex/orbex';
import { orbexQuaternion, quaternionAxes } from '../rinex/orbex';
import type { AntexFile } from '../antex/index';
import { SAT_BLOCK_TABLE } from './sat-blocks-data';

type Vec3 = [number, number, number];

/** Satellite body axes in ECEF (unit vectors). */
export interface SatFrame {
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

/** Attitude-relevant spacecraft families. */
export type SatBlock =
  | 'GPS-I'
  | 'GPS-II'
  | 'GPS-IIA'
  | 'GPS-IIR'
  | 'GPS-IIR-M'
  | 'GPS-IIF'
  | 'GPS-III'
  | 'GLO'
  | 'GLO-M'
  | 'GLO-K'
  | 'GAL-0'
  | 'GAL-IOV'
  | 'GAL-FOC'
  | 'BDS-2G'
  | 'BDS-2I'
  | 'BDS-2M'
  | 'BDS-3G'
  | 'BDS-3-CAST'
  | 'BDS-3-SECM'
  | 'QZS-1'
  | 'QZS-2I'
  | 'QZS-2A'
  | 'QZS-2G'
  | 'IRNSS-GEO'
  | 'IRNSS-IGSO'
  | 'OTHER';

/**
 * Map a satellite type string — ANTEX "TYPE" (BLOCK IIF, GALILEO-2,
 * BEIDOU-3M-CAST…) or ORBEX/IGS-metadata description (GPS-IIF, GAL-2,
 * BDS-3M-CA…) — to its attitude family.
 */
export function blockFromTypeName(name: string): SatBlock {
  const s = name.trim().toUpperCase().replace(/\s+/g, ' ');
  if (/^(BLOCK |GPS-)IIIA?|^(BLOCK |GPS-)IIIF/.test(s)) return 'GPS-III';
  if (/^(BLOCK |GPS-)IIF/.test(s)) return 'GPS-IIF';
  if (/^(BLOCK |GPS-)IIR-M/.test(s)) return 'GPS-IIR-M';
  if (/^(BLOCK |GPS-)IIR/.test(s)) return 'GPS-IIR';
  if (/^(BLOCK |GPS-)IIA/.test(s)) return 'GPS-IIA';
  if (/^(BLOCK |GPS-)II$/.test(s)) return 'GPS-II';
  if (/^(BLOCK |GPS-)I$/.test(s)) return 'GPS-I';
  if (/^GLONASS-K|^GLO-K/.test(s)) return 'GLO-K';
  if (/^GLONASS-M|^GLO-M/.test(s)) return 'GLO-M';
  if (/^GLONASS$|^GLO$/.test(s)) return 'GLO';
  if (/^GALILEO-1|^GAL-1/.test(s)) return 'GAL-IOV';
  if (/^GALILEO-2|^GAL-2/.test(s)) return 'GAL-FOC';
  if (/^GALILEO-0|^GAL-0/.test(s)) return 'GAL-0';
  if (/^(BEIDOU|BDS)-2G/.test(s)) return 'BDS-2G';
  if (/^(BEIDOU|BDS)-2I/.test(s)) return 'BDS-2I';
  if (/^(BEIDOU|BDS)-2M/.test(s)) return 'BDS-2M';
  if (/^(BEIDOU|BDS)-3G/.test(s)) return 'BDS-3G';
  if (/^(BEIDOU|BDS)-3.*(SECM|-SE)/.test(s)) return 'BDS-3-SECM';
  // BDS-3 IGSO (BEIDOU-3I, C38–C40) are CAST-built.
  if (/^(BEIDOU|BDS)-3/.test(s)) return 'BDS-3-CAST';
  if (/^QZS(S)?-2G|^QZS(S)?-3G/.test(s)) return 'QZS-2G';
  if (/^QZS(S)?-2A/.test(s)) return 'QZS-2A';
  if (/^QZS(S)?-2I/.test(s)) return 'QZS-2I';
  if (/^QZS(S)?(-1)?$/.test(s)) return 'QZS-1';
  if (/^IRNSS-\dGEO/.test(s)) return 'IRNSS-GEO';
  if (/^IRNSS-\dIGSO/.test(s)) return 'IRNSS-IGSO';
  return 'OTHER';
}

/** PRN → block over time, e.g. from ANTEX or the built-in table. */
export interface SatBlockTable {
  block(prn: string, timeMs: number): SatBlock | null;
}

interface BlockSpan {
  block: SatBlock;
  from: number;
  until: number;
}

function tableFromSpans(spans: Map<string, BlockSpan[]>): SatBlockTable {
  return {
    block(prn, timeMs) {
      const list = spans.get(prn);
      if (!list?.length) return null;
      // The span containing the epoch, else the nearest (a table older than
      // the data: the PRN's latest spacecraft).
      let best: BlockSpan | null = null;
      let bestDist = Infinity;
      for (const s of list) {
        if (timeMs >= s.from && timeMs < s.until) return s.block;
        const d = timeMs < s.from ? s.from - timeMs : timeMs - s.until;
        if (d < bestDist) {
          bestDist = d;
          best = s;
        }
      }
      return best?.block ?? null;
    },
  };
}

const antexMs = (s: string, open: number) => {
  const p = s
    .trim()
    .split(/[\s:-]+/)
    .map(Number);
  if (p.length < 3 || p.some((v) => Number.isNaN(v))) return open;
  return Date.UTC(p[0]!, (p[1]! || 1) - 1, p[2]! || 1, p[3] ?? 0, p[4] ?? 0);
};

/** Block table from an ANTEX file's satellite entries (PRN-keyed: 1.4, or
 *  2.0 after `antexWithPrns`). */
export function blockTableFromAntex(antex: AntexFile): SatBlockTable {
  const spans = new Map<string, BlockSpan[]>();
  for (const a of antex.antennas) {
    if (!a.isSatellite || !a.serialNo) continue;
    const list = spans.get(a.serialNo) ?? [];
    list.push({
      block: blockFromTypeName(a.type),
      from: antexMs(a.validFrom, -Infinity),
      until: antexMs(a.validUntil, Infinity),
    });
    spans.set(a.serialNo, list);
  }
  return tableFromSpans(spans);
}

let builtin: SatBlockTable | null = null;
/** The built-in PRN → block table (from igs20.atx; see sat-blocks-data.ts). */
export function builtinBlockTable(): SatBlockTable {
  if (builtin) return builtin;
  const spans = new Map<string, BlockSpan[]>();
  for (const row of SAT_BLOCK_TABLE.split(';')) {
    const [prn, type, from, until] = row.split(',');
    if (!prn || !type) continue;
    const list = spans.get(prn) ?? [];
    list.push({
      block: blockFromTypeName(type),
      from: from ? Date.parse(from + ':00Z') : -Infinity,
      until: until ? Date.parse(until + ':59.999Z') : Infinity,
    });
    spans.set(prn, list);
  }
  return (builtin = tableFromSpans(spans));
}

/** Block table from an ORBEX header (its satellite descriptions). */
export function blockTableFromOrbex(obx: OrbexFile): SatBlockTable {
  return {
    block(prn) {
      const t = obx.satTypes.get(prn);
      return t ? blockFromTypeName(t) : null;
    },
  };
}

/* ================================================================== */
/*  Geometry                                                           */
/* ================================================================== */

const OMEGA_E = 7.2921151467e-5;
const R_EARTH = 6378137;
const DEG = Math.PI / 180;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};
/** Wrap to (−π, π]. */
const wrap = (a: number) => {
  const w = a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
  return w <= -Math.PI ? w + 2 * Math.PI : w;
};
const sgn = (x: number) => (x < 0 ? -1 : 1);

/** Orbit geometry of one satellite at one epoch. */
export interface OrbitGeometry {
  /** Unit radial, along-track (n × r̂) and orbit-normal vectors, ECEF. */
  r: Vec3;
  t: Vec3;
  n: Vec3;
  /** Geocentric radius (m). */
  radius: number;
  betaRad: number;
  muRad: number;
  /** Orbit angle rate (rad/s), circular approximation. */
  muDot: number;
  /** Nominal yaw (rad) from the satellite → Sun direction. */
  nominalYawRad: number;
}

/**
 * β, μ and the nominal yaw from an ECEF position/velocity (m, m/s) and the
 * Sun's ECEF position (m). The velocity is made inertial (+ ω × r) so the
 * orbit normal is the orbital plane's, not the rotating frame's.
 */
export function orbitGeometry(pos: Vec3, vel: Vec3, sun: Vec3): OrbitGeometry {
  const vi: Vec3 = [
    vel[0] - OMEGA_E * pos[1],
    vel[1] + OMEGA_E * pos[0],
    vel[2],
  ];
  const radius = Math.hypot(pos[0], pos[1], pos[2]);
  const r = unit(pos);
  const n = unit(cross(pos, vi));
  const t = cross(n, r);
  const s = unit(sun);
  const sn = dot(s, n);
  const betaRad = Math.asin(Math.max(-1, Math.min(1, sn)));
  // Midnight direction: the Sun's projection on the plane, reversed.
  const m = unit([
    -(s[0] - sn * n[0]),
    -(s[1] - sn * n[1]),
    -(s[2] - sn * n[2]),
  ]);
  const muRad = Math.atan2(dot(cross(m, r), n), dot(m, r));
  const vt = Math.hypot(vi[0], vi[1], vi[2]);
  const muDot = vt / radius;
  // Nominal: from the satellite → Sun direction (what the Sun sensors see).
  const es = unit([sun[0] - pos[0], sun[1] - pos[1], sun[2] - pos[2]]);
  const nominalYawRad = Math.atan2(-dot(es, n), dot(es, t));
  return { r, t, n, radius, betaRad, muRad, muDot, nominalYawRad };
}

/** Body frame for a yaw angle on an orbit geometry. */
export function frameFromYaw(g: OrbitGeometry, yawRad: number): SatFrame {
  const c = Math.cos(yawRad);
  const s = Math.sin(yawRad);
  const x: Vec3 = [
    c * g.t[0] - s * g.n[0],
    c * g.t[1] - s * g.n[1],
    c * g.t[2] - s * g.n[2],
  ];
  const z: Vec3 = [-g.r[0], -g.r[1], -g.r[2]];
  return { x, y: cross(z, x), z };
}

/** Yaw (rad) of a body frame on an orbit geometry (the inverse of
 *  {@link frameFromYaw}, for comparing against ORBEX). */
export function yawOfFrame(g: OrbitGeometry, f: SatFrame): number {
  return Math.atan2(-dot(f.x, g.n), dot(f.x, g.t));
}

/* ================================================================== */
/*  Attitude laws                                                      */
/* ================================================================== */

/** Nominal yaw on a circular orbit with fixed β (Kouba 2009, eq. 1). */
const nominal = (beta: number, mu: number) =>
  Math.atan2(-Math.tan(beta), Math.sin(mu));

export type AttitudeMode =
  | 'nominal'
  | 'noon-turn'
  | 'midnight-turn'
  | 'shadow'
  | 'post-shadow'
  | 'orbit-normal'
  | 'smoothed';

export interface AttitudeState {
  yawRad: number;
  mode: AttitudeMode;
}

/**
 * Half-width Δ (rad of μ) of a symmetric max-rate turn about orbit noon or
 * midnight: the satellite leaves nominal at μc − Δ, yaws at its hardware
 * limit R and meets nominal again at μc + Δ, so R·2Δ/μ̇ equals the nominal
 * yaw change over the window, π − 2·atan(|tan β| / sin Δ). Null when the
 * nominal rate at μc (μ̇ / |tan β|) never exceeds R — no turn manoeuvre.
 */
function turnHalfWidth(
  beta: number,
  muDot: number,
  rateMax: number
): number | null {
  const tb = Math.abs(Math.tan(beta));
  if (tb * rateMax >= muDot) return null;
  const h = (d: number) =>
    Math.PI - 2 * Math.atan(tb / Math.sin(d)) - (2 * rateMax * d) / muDot;
  let lo = 1e-9;
  let hi = Math.PI / 2;
  if (h(hi) > 0) return hi;
  for (let k = 0; k < 60; k++) {
    const mid = 0.5 * (lo + hi);
    if (h(mid) > 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * A max-rate noon or midnight turn (GPS IIA/IIR/IIF noon, GLONASS-M noon,
 * Kouba 2009 §"noon turn"; Dilssner 2010; Dilssner et al. 2011). The turn
 * runs in the sense of the nominal yaw rate at the turn point: −sign β at
 * noon, +sign β at midnight. `betaSign` overrides the sign (GPS IIA yaw
 * bias).
 */
function maxRateTurn(
  g: OrbitGeometry,
  center: 0 | typeof Math.PI,
  rateMax: number,
  betaSign?: number
): number | null {
  const d = turnHalfWidth(g.betaRad, g.muDot, rateMax);
  if (d === null) return null;
  const off = wrap(g.muRad - center);
  if (Math.abs(off) >= d) return null;
  const dt = (off + d) / g.muDot;
  const sb = betaSign ?? sgn(g.betaRad);
  const dir = center === 0 ? sb : -sb;
  return nominal(g.betaRad, center - d) + dir * rateMax * dt;
}

/** Nominal yaw on a circular orbit with fixed β, continuous in μ (no ±π
 *  wrap): sign β · (−π/2 + atan2(sin μ, |tan β|)). */
const nominalCont = (beta: number, mu: number) =>
  sgn(beta) *
  (-Math.PI / 2 + Math.atan2(Math.sin(mu), Math.abs(Math.tan(beta))));

/**
 * A max-rate turn that lags the nominal (Kouba 2009, GPS IIR; the IIF/III
 * noon turn alike): the satellite follows nominal yaw steering until the
 * nominal rate |dψn/dt| = μ̇·|tan β|·cos Δ / (sin²Δ + tan²β) exceeds the
 * hardware limit R, yaws at R in the same sense from there, and resumes
 * nominal steering when it has caught up — an asymmetric manoeuvre that
 * ends well after noon/midnight. Matches CODE's ORBEX for GPS IIR to < 1°.
 */
function laggingTurn(
  g: OrbitGeometry,
  center: 0 | typeof Math.PI,
  rateMax: number,
  betaSign?: number
): number | null {
  const tb = Math.abs(Math.tan(g.betaRad));
  if (tb * rateMax >= g.muDot) return null;
  const off = wrap(g.muRad - center);
  if (Math.abs(off) > Math.PI / 2) return null;
  // Start: the nominal rate reaches R (Δs < 0).
  const rate = (d: number) =>
    (g.muDot * tb * Math.cos(d)) / (Math.sin(d) ** 2 + tb * tb);
  let lo = -Math.PI / 2;
  let hi = 0;
  for (let k = 0; k < 50; k++) {
    const mid = 0.5 * (lo + hi);
    if (rate(mid) > rateMax) hi = mid;
    else lo = mid;
  }
  const ds = 0.5 * (lo + hi);
  if (off < ds) return null;
  const sb = betaSign ?? sgn(g.betaRad);
  const beta = sb * Math.abs(g.betaRad);
  const dir = center === 0 ? sb : -sb;
  const psiS = nominalCont(beta, center + ds);
  const turned = (d: number) => (rateMax * (d - ds)) / g.muDot;
  // End: the max-rate yaw meets the nominal again (Δe > 0).
  const h = (d: number) =>
    dir * (nominalCont(beta, center + d) - psiS) - turned(d);
  if (h(off) <= 0 && off > 0) return null;
  return psiS + dir * turned(off);
}

/** Sun radius minus Earth radius over 1 AU: the half-opening of the
 *  umbra cone (rad). */
const UMBRA_K = (695_700e3 - R_EARTH) / 1.495978707e11;

/** Half-angle (rad of μ) of the Earth's umbra about orbit midnight; null
 *  when the orbit doesn't enter it (|β| too large). Conical umbra: at a
 *  distance x behind the Earth its radius is R⊕ − k·x — ~120 km narrower
 *  than the cylinder at GNSS altitudes, i.e. ~30 s later entry; CODE's
 *  ORBEX shadow events (GLONASS-M, GPS IIF) start on the cone. */
function shadowHalfAngle(g: OrbitGeometry): number | null {
  const r = g.radius;
  const k = UMBRA_K;
  // c = cos β cos μ solves r²(1 − c²) = (R⊕ − k r c)².
  const a = (1 + k * k) * r * r;
  const b = -2 * R_EARTH * k * r;
  const cc = R_EARTH * R_EARTH - r * r;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return null;
  const c = (-b + Math.sqrt(disc)) / (2 * a) / Math.cos(g.betaRad);
  return c >= 1 ? null : Math.acos(c);
}

/** Unwrapped nominal yaw change across ±d about midnight (sense +sign β). */
const midnightSweep = (beta: number, d: number) =>
  sgn(beta) * (Math.PI - 2 * Math.atan(Math.abs(Math.tan(beta)) / Math.sin(d)));

const nom = (g: OrbitGeometry): AttitudeState => ({
  yawRad: g.nominalYawRad,
  mode: 'nominal',
});

/** Hardware yaw-rate limits (rad/s) and law parameters per family. */
export const ATTITUDE_PARAMS = {
  /** GPS IIA: 0.10–0.13°/s by SVN (Bar-Sever 1996); a mean value here.
   *  Yaw bias +0.5° since Nov 1995 (Bar-Sever 1996). */
  gpsIIaRate: 0.12 * DEG,
  gpsIIaBias: 0.5 * DEG,
  /** GPS IIR/IIR-M: 0.20°/s (Kouba 2009). */
  gpsIIrRate: 0.2 * DEG,
  /** GPS IIF: 0.11°/s noon turns (Dilssner 2010; Kouba 2013). */
  gpsIIfRate: 0.11 * DEG,
  /** GPS III: treated as IIR (Lockheed Martin bus heritage). */
  gpsIIIRate: 0.2 * DEG,
  /** GLONASS-M: 0.25°/s (Dilssner et al. 2011). */
  gloMRate: 0.25 * DEG,
  /** Galileo IOV: |β| < 2°, |S_t| < sin 15° (GSC satellite metadata). */
  galIovBeta: 2 * DEG,
  galIovWindow: 15 * DEG,
  /** Galileo FOC: |β| < 4.1°, ±10° window, 5656 s period (GSC metadata). */
  galFocBeta: 4.1 * DEG,
  galFocWindow: 10 * DEG,
  galFocPeriodS: 5656,
  /** BDS-2 IGSO/MEO: orbit-normal when |β| < 4° (Guo et al. 2013;
   *  Montenbruck et al. 2015). */
  bds2OnBeta: 4 * DEG,
  /** BDS-3 CAST and SECM MEO/IGSO: modified yaw steering at |β| < 3°
   *  (threshold: Wang et al. 2018, CSNO satellite metadata). The law's
   *  shape here is the Sun-vector smoothing of Galileo IOV with β0 = 3°
   *  and a ±6.75° window, FITTED to CODE's ORBEX (2024 eclipse days:
   *  0.5° RMS for both makers vs 11–16° for nominal); the published CSNO
   *  law could not be checked. */
  bds3Beta: 3 * DEG,
  bds3Beta0: 3 * DEG,
  bds3Window: 6.75 * DEG,
  /** QZS-1: orbit-normal when |β| < 20° (Ishijima et al. 2009). */
  qzs1OnBeta: 20 * DEG,
  /** QZS-2 IGSO/QZO: modified yaw steering near noon/midnight (Cabinet
   *  Office QZSS metadata); a max-rate turn here. */
  qzs2Rate: 0.055 * DEG,
};
const P = ATTITUDE_PARAMS;

/** GPS IIA (Bar-Sever 1996; Kouba 2009): yaw bias, max-rate noon turns,
 *  shadow crossing at max rate in the bias sense, post-shadow recovery. */
function gpsIIa(g: OrbitGeometry): AttitudeState {
  const R = P.gpsIIaRate;
  const b = P.gpsIIaBias;
  // With the +0.5° bias the turn sense near β ≈ 0 is that of the bias.
  const bs = Math.abs(g.betaRad) < 0.5 * DEG ? 1 : sgn(g.betaRad);
  const noon = laggingTurn(g, Math.PI, R, bs);
  if (noon !== null) return { yawRad: noon, mode: 'noon-turn' };
  const sh = shadowHalfAngle(g);
  if (sh !== null) {
    const off = wrap(g.muRad);
    const entryYaw = nominal(g.betaRad, -sh) + b;
    if (Math.abs(off) < sh) {
      // In shadow the Sun sensors see nothing: the bias makes the yaw
      // control spin at the maximum rate, positive (Bar-Sever 1996).
      const dt = (off + sh) / g.muDot;
      return { yawRad: entryYaw + R * dt, mode: 'shadow' };
    }
    // Post-shadow: from the exit yaw back to nominal at the max rate, the
    // shortest way (Kouba 2009, eq. 7) — up to ~30 min.
    const sinceExit = (off - sh) / g.muDot;
    if (off > 0 && sinceExit < 3600) {
      const exitYaw = entryYaw + (R * 2 * sh) / g.muDot;
      const nomNow = g.nominalYawRad + b;
      // Integrate on a coarse grid: the recovery ends when the max-rate
      // yaw meets the (moving) nominal.
      let yaw = exitYaw;
      const step = 10;
      for (let s = 0; s < sinceExit; s += step) {
        const h = Math.min(step, sinceExit - s);
        const target = nominal(g.betaRad, sh + (s + h) * g.muDot) + b;
        const diff = wrap(target - yaw);
        if (Math.abs(diff) <= R * h) return nom2(nomNow);
        yaw += sgn(diff) * R * h;
      }
      return { yawRad: yaw, mode: 'post-shadow' };
    }
  }
  return nom2(g.nominalYawRad + b);
}
const nom2 = (yaw: number): AttitudeState => ({ yawRad: yaw, mode: 'nominal' });

/** GPS IIR/IIR-M/III (Kouba 2009): nominal with max-rate noon and midnight
 *  turns; the IIR keeps yaw steering through the shadow. */
function maxRateBoth(g: OrbitGeometry, R: number): AttitudeState {
  const noon = laggingTurn(g, Math.PI, R);
  if (noon !== null) return { yawRad: noon, mode: 'noon-turn' };
  const mid = laggingTurn(g, 0, R);
  if (mid !== null) return { yawRad: mid, mode: 'midnight-turn' };
  return nom(g);
}

/** GPS IIF (Dilssner 2010; Kouba 2013): max-rate noon turns at 0.11°/s;
 *  in shadow a constant yaw rate from the entry yaw to the exit nominal. */
function gpsIIf(g: OrbitGeometry): AttitudeState {
  const noon = laggingTurn(g, Math.PI, P.gpsIIfRate);
  if (noon !== null) return { yawRad: noon, mode: 'noon-turn' };
  const sh = shadowHalfAngle(g);
  if (sh !== null) {
    const off = wrap(g.muRad);
    if (Math.abs(off) < sh) {
      const entryYaw = nominal(g.betaRad, -sh);
      const sweep = midnightSweep(g.betaRad, sh);
      return {
        yawRad: entryYaw + (sweep * (off + sh)) / (2 * sh),
        mode: 'shadow',
      };
    }
  } else {
    const mid = laggingTurn(g, 0, P.gpsIIfRate);
    if (mid !== null) return { yawRad: mid, mode: 'midnight-turn' };
  }
  return nom(g);
}

/** GLONASS-M (Dilssner et al. 2011): max-rate noon turns at 0.25°/s; in
 *  shadow it yaws at the max rate from the entry yaw until it reaches the
 *  exit nominal, then holds until the exit. */
function gloM(g: OrbitGeometry): AttitudeState {
  const R = P.gloMRate;
  const noon = maxRateTurn(g, Math.PI, R);
  if (noon !== null) return { yawRad: noon, mode: 'noon-turn' };
  const sh = shadowHalfAngle(g);
  if (sh !== null) {
    const off = wrap(g.muRad);
    if (Math.abs(off) < sh) {
      const entryYaw = nominal(g.betaRad, -sh);
      const sweep = midnightSweep(g.betaRad, sh);
      const dt = (off + sh) / g.muDot;
      const turned = Math.min(R * dt, Math.abs(sweep));
      return { yawRad: entryYaw + sgn(sweep) * turned, mode: 'shadow' };
    }
  }
  return nom(g);
}

/** Galileo IOV (GSC "Galileo satellite metadata", attitude law): near noon
 *  and midnight at |β| < 2° the Sun's orbit-normal component is replaced by
 *  a smoothed one that never drops below sin 2°. */
function galIov(g: OrbitGeometry): AttitudeState {
  const st = smoothedSun(g, P.galIovBeta, P.galIovBeta, P.galIovWindow);
  return st.mode === 'nominal' ? st : { ...st, mode: 'smoothed' };
}

/** Galileo FOC (GSC "Galileo satellite metadata", attitude law): near noon
 *  and midnight at |β| < 4.1° the yaw follows
 *  ψ = ψmid + (ψinit − ψmid)·cos(2π·Δt/5656 s) from the window entry,
 *  ψmid = −90°·sign β (the nominal yaw at the turn point). */
function galFoc(g: OrbitGeometry): AttitudeState {
  if (Math.abs(g.betaRad) >= P.galFocBeta) return nom(g);
  const half = Math.asin(
    Math.min(1, Math.sin(P.galFocWindow) / Math.cos(g.betaRad))
  );
  const center = Math.abs(wrap(g.muRad)) < Math.PI / 2 ? 0 : Math.PI;
  const off = wrap(g.muRad - center);
  if (Math.abs(off) >= half) return nom(g);
  // In time from the window entry, as GSC states it (CODE's ORBEX agrees
  // to 0.02° for the nominal-orbit satellites; the same law in orbit angle
  // is 0.4° off). E14/E18 (eccentric orbits) don't follow it — see docs.
  const dt = (off + half) / g.muDot;
  if (dt > P.galFocPeriodS / 2) return nom(g);
  const init = nominal(g.betaRad, center - half);
  const mid = -sgn(g.betaRad) * (Math.PI / 2);
  return {
    yawRad:
      mid + wrap(init - mid) * Math.cos((2 * Math.PI * dt) / P.galFocPeriodS),
    mode: center === 0 ? 'midnight-turn' : 'noon-turn',
  };
}

/**
 * Sun-vector smoothing near noon/midnight (the Galileo IOV law's form): for
 * |β| < βmax and |S_t| < sin w, the orbit-normal Sun component S_n is
 * replaced by
 *   S_n' = ½(s0 + S_n) + ½(s0 − S_n)·cos(π·|S_t| / sin w),  s0 = sin β0·sign S_n
 * and ψ = atan2(−S_n', S_t), S_t = cos β sin μ the along-track component.
 */
function smoothedSun(
  g: OrbitGeometry,
  betaMax: number,
  beta0: number,
  window: number
): AttitudeState {
  const st = Math.cos(g.betaRad) * Math.sin(g.muRad);
  const sn = Math.sin(g.betaRad);
  const lim = Math.sin(window);
  if (Math.abs(g.betaRad) >= betaMax || Math.abs(st) >= lim) return nom(g);
  const s0 = Math.sin(beta0) * sgn(sn);
  const snMod =
    0.5 * (s0 + sn) +
    0.5 * (s0 - sn) * Math.cos((Math.PI * Math.abs(st)) / lim);
  return {
    yawRad: Math.atan2(-snMod, st),
    mode: Math.abs(wrap(g.muRad)) < Math.PI / 2 ? 'midnight-turn' : 'noon-turn',
  };
}

/**
 * Model attitude (yaw + body frame) for one satellite family at one epoch.
 * `pos`/`vel` ECEF (m, m/s), `sun` ECEF (m).
 */
export function modelAttitude(
  block: SatBlock | null,
  pos: Vec3,
  vel: Vec3,
  sun: Vec3
): AttitudeState & { geometry: OrbitGeometry; frame: SatFrame } {
  const g = orbitGeometry(pos, vel, sun);
  const st = attitudeLaw(block, g);
  return { ...st, geometry: g, frame: frameFromYaw(g, st.yawRad) };
}

/** The family's yaw law on a geometry. */
export function attitudeLaw(
  block: SatBlock | null,
  g: OrbitGeometry
): AttitudeState {
  const on: AttitudeState = { yawRad: 0, mode: 'orbit-normal' };
  switch (block) {
    case 'GPS-II':
    case 'GPS-IIA':
      return gpsIIa(g);
    case 'GPS-IIR':
    case 'GPS-IIR-M':
      return maxRateBoth(g, P.gpsIIrRate);
    case 'GPS-III':
      return maxRateBoth(g, P.gpsIIIRate);
    case 'GPS-IIF':
      return gpsIIf(g);
    case 'GLO':
    case 'GLO-M':
      return gloM(g);
    // GLONASS-K1: CODE's ORBEX keeps nominal yaw steering through β ≈ 0
    // (no published law; the K bus has fast reaction wheels).
    case 'GAL-IOV':
      return galIov(g);
    case 'GAL-FOC':
      return galFoc(g);
    case 'BDS-2G':
    case 'BDS-3G':
    case 'QZS-2G':
    case 'IRNSS-GEO':
      return on;
    case 'BDS-2I':
    case 'BDS-2M':
      return Math.abs(g.betaRad) < P.bds2OnBeta ? on : nom(g);
    case 'BDS-3-CAST':
    case 'BDS-3-SECM':
      return smoothedSun(g, P.bds3Beta, P.bds3Beta0, P.bds3Window);
    case 'QZS-1':
      return Math.abs(g.betaRad) < P.qzs1OnBeta ? on : nom(g);
    case 'QZS-2I':
    case 'QZS-2A':
      return maxRateBoth(g, P.qzs2Rate);
    default:
      return nom(g);
  }
}

/* ================================================================== */
/*  Provider for the PPP corrections                                   */
/* ================================================================== */

/**
 * Satellite attitude source for {@link createPppCorrections}:
 *  - 'nominal': yaw steering everywhere (the pre-2.46 behaviour);
 *  - 'model': the per-family eclipse/turn laws above;
 *  - 'orbex': the analysis centre's own attitude (quaternions), falling back
 *    to the model where the file has no record.
 */
export type SatAttitudeSource = 'nominal' | 'model' | 'orbex';

export interface SatAttitudeOptions {
  mode: SatAttitudeSource;
  /** Attitude quaternions consistent with the orbit/clock product. */
  orbex?: OrbexFile;
  /** PRN → block; default the ORBEX header's types, else built-in. */
  blocks?: SatBlockTable;
  /** Drop GPS IIA observations in shadow and for 30 min after (their yaw
   *  is poorly predictable there; Kouba 2009 recommends it). Default true. */
  excludeIIaShadow?: boolean;
}

export interface SatAttitudeProvider {
  readonly mode: SatAttitudeSource;
  /** Body frame in ECEF; null → the caller's nominal frame. */
  frame(prn: string, timeMs: number, pos: Vec3, vel: Vec3, sun: Vec3): SatFrame;
  /** Whether the satellite should be left out at this epoch. */
  exclude(
    prn: string,
    timeMs: number,
    pos: Vec3,
    vel: Vec3,
    sun: Vec3
  ): boolean;
}

export function createSatAttitude(
  opts: SatAttitudeOptions
): SatAttitudeProvider {
  const table = opts.blocks ?? builtinBlockTable();
  const obxTable = opts.orbex ? blockTableFromOrbex(opts.orbex) : null;
  const blockOf = (prn: string, t: number) =>
    obxTable?.block(prn, t) ?? table.block(prn, t);
  const excludeIIa = opts.excludeIIaShadow ?? true;
  return {
    mode: opts.mode,
    frame(prn, timeMs, pos, vel, sun) {
      if (opts.mode === 'orbex' && opts.orbex) {
        const q = orbexQuaternion(opts.orbex, prn, timeMs);
        if (q) return quaternionAxes(q);
      }
      if (opts.mode === 'nominal') {
        const g = orbitGeometry(pos, vel, sun);
        return frameFromYaw(g, g.nominalYawRad);
      }
      return modelAttitude(blockOf(prn, timeMs), pos, vel, sun).frame;
    },
    exclude(prn, timeMs, pos, vel, sun) {
      if (!excludeIIa || prn[0] !== 'G') return false;
      const b = blockOf(prn, timeMs);
      if (b !== 'GPS-IIA' && b !== 'GPS-II') return false;
      const g = orbitGeometry(pos, vel, sun);
      const sh = shadowHalfAngle(g);
      if (sh === null) return false;
      const off = wrap(g.muRad);
      return off > -sh && off < sh + 1800 * g.muDot;
    },
  };
}
