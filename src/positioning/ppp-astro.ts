/**
 * Low-precision Sun/Moon ephemerides, sidereal time, and the IERS degree-2
 * solid-earth tide — enough for the PPP corrections (satellite attitude,
 * solid-earth tides, phase wind-up) at the millimetre–centimetre level.
 *
 * Sun ~0.01°, Moon ~0.1–0.3° accuracy; solid-earth-tide step-1 (in-phase)
 * displacement good to ~mm. Precession/nutation/polar-motion are neglected
 * (their effect on the Sun/Moon *direction* used here is well below the
 * correction accuracy needed).
 */

import { getGpsLeap } from '../time/utc';

const AU = 149597870700; // m
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
const DEG = Math.PI / 180;

/** Days since J2000.0 (UTC ≈ UT1). timeMs is GPS-scale. */
function daysSinceJ2000(timeMs: number): number {
  return (timeMs - getGpsLeap(new Date(timeMs)) * 1000 - J2000_MS) / 86400000;
}

/** Greenwich mean sidereal time (rad). */
export function gmst(timeMs: number): number {
  const d = daysSinceJ2000(timeMs);
  let deg = 280.46061837 + 360.98564736629 * d;
  deg %= 360;
  if (deg < 0) deg += 360;
  return deg * DEG;
}

/** Rotate an ECI (equatorial, of-date) vector to ECEF using GMST only. */
function eciToEcef(
  v: [number, number, number],
  theta: number
): [number, number, number] {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [v[0] * c + v[1] * s, -v[0] * s + v[1] * c, v[2]];
}

/** Sun position in ECEF (m). Low-precision almanac (Meeus). */
export function sunEcef(timeMs: number): [number, number, number] {
  const n = daysSinceJ2000(timeMs);
  const L = (280.46 + 0.9856474 * n) * DEG;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const R = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * AU;
  const eci: [number, number, number] = [
    R * Math.cos(lambda),
    R * Math.cos(eps) * Math.sin(lambda),
    R * Math.sin(eps) * Math.sin(lambda),
  ];
  return eciToEcef(eci, gmst(timeMs));
}

/**
 * Moon position in ECEF (m). The analytical series of Montenbruck & Gill
 * (Satellite Orbits, §3.3.2), referred to the mean equinox *of date* so it
 * matches the GMST rotation (no −1.3972°/century precession term: that
 * would refer it to J2000 and leave a ~0.3° error by 2024). Against JPL
 * DE421 ≤ 0.03° and ≤ 0.07 % in distance — solid-earth tide error
 * ≲ 0.2 mm (it was up to 1.7 mm with the earlier truncated series).
 */
export function moonEcef(timeMs: number): [number, number, number] {
  const T = daysSinceJ2000(timeMs) / 36525;
  const AS = DEG / 3600;
  // Mean arguments (rad).
  const L0 = (218.31617 + 481267.88088 * T) * DEG;
  const l = (134.96292 + 477198.86753 * T) * DEG;
  const lp = (357.52543 + 35999.04944 * T) * DEG;
  const F = (93.27283 + 483202.01873 * T) * DEG;
  const D = (297.85027 + 445267.11135 * T) * DEG;
  const s = Math.sin;
  const c = Math.cos;
  const lon =
    L0 +
    (22640 * s(l) +
      769 * s(2 * l) -
      4586 * s(l - 2 * D) +
      2370 * s(2 * D) -
      668 * s(lp) -
      412 * s(2 * F) -
      212 * s(2 * l - 2 * D) -
      206 * s(l + lp - 2 * D) +
      192 * s(l + 2 * D) -
      165 * s(lp - 2 * D) +
      148 * s(l - lp) -
      125 * s(D) -
      110 * s(l + lp) -
      55 * s(2 * F - 2 * D)) *
      AS;
  const lat =
    18520 * AS * s(F + lon - L0 + (412 * s(2 * F) + 541 * s(lp)) * AS) +
    (-526 * s(F - 2 * D) +
      44 * s(l + F - 2 * D) -
      31 * s(-l + F - 2 * D) -
      25 * s(-2 * l + F) -
      23 * s(lp + F - 2 * D) +
      21 * s(-l + F) +
      11 * s(-lp + F - 2 * D)) *
      AS;
  const r =
    (385000 -
      20905 * c(l) -
      3699 * c(2 * D - l) -
      2956 * c(2 * D) -
      570 * c(2 * l) +
      246 * c(2 * l - 2 * D) -
      205 * c(lp - 2 * D) -
      171 * c(l + 2 * D) -
      152 * c(l + lp - 2 * D)) *
    1000;
  const eps = (23.4393 - 0.0000004 * daysSinceJ2000(timeMs)) * DEG;
  // Ecliptic → equatorial (ECI).
  const xe = r * Math.cos(lat) * Math.cos(lon);
  const ye = r * Math.cos(lat) * Math.sin(lon);
  const ze = r * Math.sin(lat);
  const eci: [number, number, number] = [
    xe,
    ye * Math.cos(eps) - ze * Math.sin(eps),
    ye * Math.sin(eps) + ze * Math.cos(eps),
  ];
  return eciToEcef(eci, gmst(timeMs));
}

const H2 = 0.6078; // degree-2 Love number
const L2 = 0.0847; // degree-2 Shida number
const RE = 6378137.0; // m
const GM_SUN_RATIO = 332946.0482; // GM_sun / GM_earth
const GM_MOON_RATIO = 0.0123000371; // GM_moon / GM_earth

/**
 * Solid-earth-tide displacement of a station (ECEF, m). IERS conventions
 * step-1 (degree 2, in-phase) — the dominant few-cm/dm periodic term.
 */
export function solidEarthTide(
  rcv: [number, number, number],
  sun: [number, number, number],
  moon: [number, number, number]
): [number, number, number] {
  const rNorm = Math.hypot(rcv[0], rcv[1], rcv[2]);
  const rHat: [number, number, number] = [
    rcv[0] / rNorm,
    rcv[1] / rNorm,
    rcv[2] / rNorm,
  ];
  const disp: [number, number, number] = [0, 0, 0];
  for (const [body, ratio] of [
    [sun, GM_SUN_RATIO],
    [moon, GM_MOON_RATIO],
  ] as const) {
    const rj = Math.hypot(body[0], body[1], body[2]);
    const jHat: [number, number, number] = [
      body[0] / rj,
      body[1] / rj,
      body[2] / rj,
    ];
    const dot = rHat[0] * jHat[0] + rHat[1] * jHat[1] + rHat[2] * jHat[2];
    const factor = (ratio * RE * RE * RE * RE) / (rj * rj * rj);
    // Δr = factor·[ h2·r̂·(1.5 dot² − 0.5) + 3 l2 dot (Ĵ − dot·r̂) ]
    const radialScale = H2 * (1.5 * dot * dot - 0.5);
    const tanScale = 3 * L2 * dot;
    for (let k = 0; k < 3; k++) {
      disp[k] +=
        factor * (radialScale * rHat[k] + tanScale * (jHat[k] - dot * rHat[k]));
    }
  }
  return disp;
}
