/**
 * Solid-earth tide station displacement, the full model of the IERS
 * Conventions (2010), Section 7.1.1 (Petit & Luzum 2010, TN 36), built from
 * the equations and tables of the text:
 *
 *  Step 1 (time domain)
 *   - degree 2 in-phase, nominal h2 = 0.6078, l2 = 0.0847 with the
 *     latitude dependence h(2) = −0.0006, l(2) = 0.0002 (eq. 5);
 *   - degree 3 in-phase, h3 = 0.292, l3 = 0.015 (eq. 6);
 *   - the l(1) transverse terms, diurnal 0.0012 and semidiurnal 0.0024
 *     (eqs. 8, 9);
 *   - out-of-phase (mantle anelasticity) diurnal and semidiurnal terms
 *     (eqs. 10, 11).
 *  Step 2 (frequency domain)
 *   - the diurnal-band corrections of Table 7.3a (eq. 12) — the K1/ψ1/P1
 *     free-core-nutation resonance;
 *   - the long-period (zonal) corrections of Table 7.3b (eq. 13).
 *
 * The result is the *conventional tide-free* displacement: the permanent
 * (zero-frequency) part of the degree-2 tide is included, as the
 * Conventions prescribe, so positions corrected with it are tide-free like
 * ITRF/IGS/EUREF coordinates. {@link permanentTideEnu} gives the vector to
 * add to obtain mean-tide coordinates (eq. 14).
 *
 * Validated against the test cases documented for the IERS reference
 * implementation (DEHANTTIDEINEL, same Sun/Moon input): agreement ≪ 0.1 mm.
 */
import { getGpsLeap } from '../time/utc';

type Vec3 = [number, number, number];

/** GM_sun / GM_earth and GM_moon / GM_earth (IERS numerical standards). */
const MASS_RATIO_SUN = 332946.0482;
const MASS_RATIO_MOON = 0.0123000371;
/** Earth's equatorial radius (m), IERS numerical standards. */
const RE = 6378136.6;

const H20 = 0.6078;
const L20 = 0.0847;
const H3 = 0.292;
const L3 = 0.015;

const DEG = Math.PI / 180;
const ARCSEC = DEG / 3600;
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
/** TT − GPS time (s). */
const TT_MINUS_GPS = 51.184;

/** Table 7.3a: [τ s h p N' ps] multipliers, ΔR ip/op, ΔT ip/op (mm). */
const DIURNAL: readonly (readonly number[])[] = [
  [1, -2, 0, 1, 0, 0, -0.08, 0.0, -0.01, 0.01], // Q1
  [1, -1, 0, 0, -1, 0, -0.1, 0.0, 0.0, 0.0],
  [1, -1, 0, 0, 0, 0, -0.51, 0.0, -0.02, 0.03], // O1
  [1, 0, 0, 1, 0, 0, 0.06, 0.0, 0.0, 0.0], // NO1
  [1, 1, -3, 0, 0, 1, -0.06, 0.0, 0.0, 0.0], // π1
  [1, 1, -2, 0, 0, 0, -1.23, -0.07, 0.06, 0.01], // P1
  [1, 1, 0, 0, -1, 0, -0.22, 0.01, 0.01, 0.0],
  [1, 1, 0, 0, 0, 0, 12.0, -0.78, -0.67, -0.03], // K1
  [1, 1, 0, 0, 1, 0, 1.73, -0.12, -0.1, 0.0],
  [1, 1, 1, 0, 0, -1, -0.5, -0.01, 0.03, 0.0], // ψ1
  [1, 1, 2, 0, 0, 0, -0.11, 0.01, 0.01, 0.0], // φ1
];

/** Table 7.3b, same layout (zonal tides). */
const LONG_PERIOD: readonly (readonly number[])[] = [
  [0, 0, 0, 0, 1, 0, 0.47, 0.16, 0.23, 0.07],
  [0, 0, 2, 0, 0, 0, -0.2, -0.11, -0.12, -0.05], // Ssa
  [0, 1, 0, -1, 0, 0, -0.11, -0.09, -0.08, -0.04], // Mm
  [0, 2, 0, 0, 0, 0, -0.13, -0.15, -0.11, -0.07], // Mf
  [0, 2, 0, 0, 1, 0, -0.05, -0.06, -0.05, -0.03],
];

/**
 * Doodson fundamental arguments [τ, s, h, p, N', ps] (rad) at a GPS-scale
 * instant, from the IERS Chapter 5 Delaunay arguments (TT) and GMST
 * (UT1 ≈ UTC, ≤ 0.9 s — immaterial for a sub-mm correction).
 */
export function doodsonArguments(timeMs: number): number[] {
  const T = (timeMs + TT_MINUS_GPS * 1000 - J2000_MS) / 86400000 / 36525;
  const poly = (c: number[]) =>
    c[0]! * 3600 + T * (c[1]! + T * (c[2]! + T * (c[3]! + T * c[4]!)));
  // Delaunay arguments (arcsec), IERS Conventions (2010) eq. 5.43.
  const l = poly([
    134.96340251, 1717915923.2178, 31.8792, 0.051635, -0.0002447,
  ]);
  const lp = poly([
    357.52910918, 129596581.0481, -0.5532, 0.000136, -0.00001149,
  ]);
  const F = poly([
    93.27209062, 1739527262.8478, -12.7512, -0.001037, 0.00000417,
  ]);
  const D = poly([
    297.85019547, 1602961601.209, -6.3706, 0.006593, -0.00003169,
  ]);
  const Om = poly([125.04455501, -6962890.5431, 7.4722, 0.007702, -0.00005939]);
  const s = (F + Om) * ARCSEC;
  const h = (F + Om - D) * ARCSEC;
  const p = (F + Om - l) * ARCSEC;
  const nPrime = -Om * ARCSEC;
  const ps = (F + Om - D - lp) * ARCSEC;
  const tau = gmstUtc(timeMs) + Math.PI - s;
  return [tau, s, h, p, nPrime, ps];
}

/** GMST (rad) from UTC standing in for UT1 (IAU 1982 expression). */
function gmstUtc(timeMs: number): number {
  const utcMs = timeMs - getGpsLeap(new Date(timeMs)) * 1000;
  const d = (utcMs - J2000_MS) / 86400000;
  const Tu = d / 36525;
  const sec =
    67310.54841 +
    (876600 * 3600 + 8640184.812866) * Tu +
    0.093104 * Tu * Tu -
    6.2e-6 * Tu * Tu * Tu;
  return ((((sec % 86400) + 86400) % 86400) * (2 * Math.PI)) / 86400;
}

/**
 * Solid-earth tide displacement (ECEF, m) of the station at `rcv` (ECEF, m),
 * at GPS-scale `timeMs`, for Sun and Moon at `sun`, `moon` (ECEF, m). IERS
 * Conventions (2010) Steps 1 + 2; conventional tide-free.
 */
export function solidEarthTideIers(
  rcv: Vec3,
  sun: Vec3,
  moon: Vec3,
  timeMs: number
): Vec3 {
  const r = Math.hypot(rcv[0], rcv[1], rcv[2]);
  const rh: Vec3 = [rcv[0] / r, rcv[1] / r, rcv[2] / r];
  // Geocentric latitude and longitude, as the Conventions use.
  const sinPhi = rcv[2] / r;
  const cosPhi = Math.hypot(rcv[0], rcv[1]) / r;
  const lam = Math.atan2(rcv[1], rcv[0]);
  const sinLa = Math.sin(lam);
  const cosLa = Math.cos(lam);
  const p2 = (3 * sinPhi * sinPhi - 1) / 2;
  const h2 = H20 - 0.0006 * p2;
  const l2 = L20 + 0.0002 * p2;
  const cos2Phi = cosPhi * cosPhi - sinPhi * sinPhi;
  const sin2Phi = 2 * sinPhi * cosPhi;
  const sin2La = 2 * sinLa * cosLa;
  const cos2La = cosLa * cosLa - sinLa * sinLa;

  const out: Vec3 = [0, 0, 0];
  // Local radial/north/east increments, rotated to ECEF at the end.
  let dr = 0;
  let dn = 0;
  let de = 0;

  for (const [body, ratio] of [
    [moon, MASS_RATIO_MOON],
    [sun, MASS_RATIO_SUN],
  ] as const) {
    const [X, Y, Z] = body;
    const R2 = X * X + Y * Y + Z * Z;
    const R = Math.sqrt(R2);
    const jh: Vec3 = [X / R, Y / R, Z / R];
    const scal = rh[0] * jh[0] + rh[1] * jh[1] + rh[2] * jh[2];
    const fac2 = (ratio * RE * RE * RE * RE) / (R2 * R);
    const fac3 = (fac2 * RE) / R;
    // Degree 2 (eq. 5) and degree 3 (eq. 6), in-phase.
    const a2 = fac2 * h2 * (1.5 * scal * scal - 0.5);
    const b2 = fac2 * 3 * l2 * scal;
    const a3 = fac3 * H3 * (2.5 * scal * scal * scal - 1.5 * scal);
    const b3 = fac3 * L3 * (7.5 * scal * scal - 1.5);
    for (let k = 0; k < 3; k++)
      out[k] += (a2 + a3) * rh[k]! + (b2 + b3) * (jh[k]! - scal * rh[k]!);

    // Body terms in Cartesian form (eq. 7): sin2Φj·sin/cos(λ − λj) and
    // cos²Φj·sin/cos 2(λ − λj).
    const s2Psin = (2 * Z * (X * sinLa - Y * cosLa)) / R2;
    const s2Pcos = (2 * Z * (X * cosLa + Y * sinLa)) / R2;
    const c2Psin2 = ((X * X - Y * Y) * sin2La - 2 * X * Y * cos2La) / R2;
    const c2Pcos2 = ((X * X - Y * Y) * cos2La + 2 * X * Y * sin2La) / R2;

    // l(1) transverse terms: diurnal (eq. 8; P21 = 1.5 sin2Φ) …
    const l1d = 0.0012;
    dn += -l1d * sinPhi * fac2 * 1.5 * sinPhi * s2Pcos;
    de += l1d * sinPhi * fac2 * 1.5 * cos2Phi * s2Psin;
    // … and semidiurnal (eq. 9; P22 = 3 cos²Φ).
    const l1s = 0.0024;
    dn += -0.5 * l1s * sinPhi * cosPhi * fac2 * 3 * c2Pcos2;
    de += -0.5 * l1s * sinPhi * cosPhi * fac2 * 3 * sinPhi * c2Psin2;

    // Out-of-phase, diurnal (eq. 10) …
    const hId = -0.0025;
    const lId = -0.0007;
    dr += -0.75 * hId * fac2 * sin2Phi * s2Psin;
    dn += -1.5 * lId * fac2 * cos2Phi * s2Psin;
    de += -1.5 * lId * fac2 * sinPhi * s2Pcos;
    // … and semidiurnal (eq. 11).
    const hIs = -0.0022;
    const lIs = -0.0007;
    dr += -0.75 * hIs * fac2 * cosPhi * cosPhi * c2Psin2;
    dn += 0.75 * lIs * fac2 * sin2Phi * c2Psin2;
    de += -0.75 * lIs * fac2 * 2 * cosPhi * c2Pcos2;
  }

  // Step 2: frequency dependence of the Love/Shida numbers.
  const beta = doodsonArguments(timeMs);
  for (const row of DIURNAL) {
    let th = 0;
    for (let i = 0; i < 6; i++) th += row[i]! * beta[i]!;
    const a = th + lam;
    const sa = Math.sin(a);
    const ca = Math.cos(a);
    const [Rip, Rop, Tip, Top] = [row[6]!, row[7]!, row[8]!, row[9]!];
    dr += 1e-3 * (Rip * sa + Rop * ca) * sin2Phi;
    de += 1e-3 * (Tip * ca - Top * sa) * sinPhi;
    dn += 1e-3 * (Tip * sa + Top * ca) * cos2Phi;
  }
  for (const row of LONG_PERIOD) {
    let th = 0;
    for (let i = 0; i < 6; i++) th += row[i]! * beta[i]!;
    const st = Math.sin(th);
    const ct = Math.cos(th);
    const [Rip, Rop, Tip, Top] = [row[6]!, row[7]!, row[8]!, row[9]!];
    dr += 1e-3 * (1.5 * sinPhi * sinPhi - 0.5) * (Rip * ct + Rop * st);
    dn += 1e-3 * (Tip * ct + Top * st) * sin2Phi;
  }

  // Radial / north / east (geocentric) → ECEF.
  const nh: Vec3 = [-sinPhi * cosLa, -sinPhi * sinLa, cosPhi];
  const eh: Vec3 = [-sinLa, cosLa, 0];
  for (let k = 0; k < 3; k++) out[k] += dr * rh[k]! + dn * nh[k]! + de * eh[k]!;
  return out;
}

/**
 * The permanent (zero-frequency) tide that conventional tide-free
 * coordinates exclude, as [East, North, Up] (m) at geocentric latitude
 * `latRad` — IERS Conventions (2010) eq. 14. Add it to a tide-free position
 * to obtain the mean-tide position (≈ −12 cm Up at the poles, +6 cm at the
 * equator). The radial component is used as Up.
 */
export function permanentTideEnu(latRad: number): Vec3 {
  const s = Math.sin(latRad);
  const P2 = (3 * s * s - 1) / 2;
  const up = (-0.1206 + 0.0001 * P2) * P2;
  const north = (-0.0252 - 0.0001 * P2) * Math.sin(2 * latRad);
  return [0, north, up];
}
