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

const AU = 149597870700; // m
const GPS_UTC_LEAP = 18; // s, valid 2017-01 … (2024 epoch)
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
const DEG = Math.PI / 180;

/** Days since J2000.0 (UTC ≈ UT1). timeMs is GPS-scale. */
function daysSinceJ2000(timeMs: number): number {
  return (timeMs - GPS_UTC_LEAP * 1000 - J2000_MS) / 86400000;
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

/** Moon position in ECEF (m). Low-precision series (Montenbruck & Gill). */
export function moonEcef(timeMs: number): [number, number, number] {
  const T = daysSinceJ2000(timeMs) / 36525;
  // Fundamental arguments (deg).
  const L0 = 218.31617 + 481267.88088 * T - 1.3972 * T;
  const l = 134.96292 + 477198.86753 * T;
  const lp = 357.52543 + 35999.04944 * T;
  const F = 93.27283 + 483202.01873 * T;
  const D = 297.85027 + 445267.11135 * T;
  const s = (x: number) => Math.sin(x * DEG);
  const c = (x: number) => Math.cos(x * DEG);
  // Ecliptic longitude (deg) — main periodic terms.
  const lon =
    L0 +
    6.28875 * s(l) +
    1.274018 * s(2 * D - l) +
    0.658309 * s(2 * D) +
    0.213616 * s(2 * l) -
    0.185596 * s(lp) -
    0.114336 * s(2 * F) +
    0.058793 * s(2 * D - 2 * l) +
    0.057212 * s(2 * D - lp - l) +
    0.05332 * s(2 * D + l);
  // Ecliptic latitude (deg).
  const lat =
    5.128189 * s(F) +
    0.280606 * s(l + F) +
    0.277693 * s(l - F) +
    0.173238 * s(2 * D - F) +
    0.055413 * s(2 * D + F - l) +
    0.046272 * s(2 * D - F - l);
  // Distance (Earth radii → m). ~60.3 ER mean.
  const r =
    (385000 -
      20905 * c(l) -
      3699 * c(2 * D - l) -
      2956 * c(2 * D) -
      570 * c(2 * l)) *
    1000;
  const eps = (23.4393 - 0.0000004 * daysSinceJ2000(timeMs)) * DEG;
  const lonR = lon * DEG;
  const latR = lat * DEG;
  // Ecliptic → equatorial (ECI).
  const xe = r * Math.cos(latR) * Math.cos(lonR);
  const ye = r * Math.cos(latR) * Math.sin(lonR);
  const ze = r * Math.sin(latR);
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
