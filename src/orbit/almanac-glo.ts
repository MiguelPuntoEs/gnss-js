/**
 * GLONASS almanac orbit propagation — the osculating-elements method
 * of the GLONASS ICD (Edition 5.1, 2008), Appendix A.3.2 "Algorithm of
 * calculation of satellite motion parameters using almanac": semi-major
 * axis by successive approximation from the Draconian period, node
 * passage extrapolation with ΔT/ΔT′, first-order C20 (J2) secular and
 * periodic corrections to the osculating elements, Kepler solution,
 * PZ-90 ECEF output.
 *
 * The ICD computes coordinates in an absolute (inertial) frame OXaYaZa
 * offset from Greenwich by true sidereal time S; here the node is
 * carried directly in the Greenwich frame — Ωg = λk + δΩ − ωз·(ti−tλk)
 * — which is algebraically identical (the S0 sidereal terms cancel) and
 * needs no sidereal-time model. Verified against the ICD A.3.2.3 worked
 * example to sub-metre level (see test/orbit-almanac-glo.test.ts).
 *
 * Constants are the ICD's own (km-based; the worked example pins them).
 * ωз is 0.7292115e-4 s⁻¹ per the Russian original and the CDMA-era
 * General Description ICD — the English 5.1 translation misprints it as
 * 0.7392115e-4, which moves the worked example by ~278 km.
 *
 * Time handling follows `almanacSatPosition`: `timeMs` is GPS-scale
 * epoch ms (repo-wide convention) and the offset from the almanac epoch
 * is deliberately NOT folded into a half-week window — almanacs are
 * propagated days ahead. The almanac epoch (instant of the first
 * ascending-node passage tλ) is reconstructed from the GLONASS calendar
 * fields N4/NA/tλ, which are Moscow time (UTC+3 h): the SBF `toaSec`
 * field is a day-boundary reference rounded by the receiver, up to
 * ±12 h away from tλ, and must not be used as the propagation origin.
 */

import { getGpsLeap } from '../time/utc';
import type { SbfGlonassAlmanac } from '../sbf/nav';
import type { AlmanacPosition } from './almanac';

/* GLONASS ICD 5.1 A.3.2.2 constants (km / s) */
const C20 = -1082.63e-6;
const J = -1.5 * C20;
/** Equatorial radius of Earth, km. */
const AE = 6378.136;
/** Gravitational constant, km³/s². */
const MU = 398600.44;
/** Earth rotation rate, rad/s (see the misprint note above). */
const OMEGA_Z = 0.7292115e-4;
/** Mean inclination of GLONASS orbital planes, rad (63°). */
const I_MEAN = (63 * Math.PI) / 180;
/** Mean Draconian period, s. */
const T_MEAN = 43200;

/** Start of the GLONASS four-year calendar (N4 = 1), Moscow midnight. */
const GLO_1996_UTC_MS = Date.UTC(1996, 0, 1) - 10_800_000;
const DAY_MS = 86_400_000;
/** Days per four-year interval (1996, 2000, … are all leap years). */
const FOUR_YEARS_DAYS = 1461;

/**
 * GPS-scale epoch ms of the almanac reference instant tλ (the first
 * ascending-node passage within day NA), from the GLONASS calendar
 * fields N4/NA and the Moscow-time seconds of day tλ.
 */
export function glonassAlmanacEpochMs(alm: SbfGlonassAlmanac): number {
  const utcMs =
    GLO_1996_UTC_MS +
    ((alm.n4 - 1) * FOUR_YEARS_DAYS + (alm.nDay - 1)) * DAY_MS +
    alm.tLambda * 1000;
  return utcMs + getGpsLeap(new Date(utcMs)) * 1000;
}

/**
 * The C20 periodic-correction bracket terms of ICD 5.1 formulae (1),
 * evaluated at mean longitude λ̄ and elapsed time τ from the node.
 * `B` is J·(ae/a)²; h/l are the eccentricity-vector components;
 * n is the mean motion 2π/Tдр.
 */
interface C20Deltas {
  daOverA: number;
  dh: number;
  dl: number;
  dOmega: number;
  di: number;
  dLambda: number;
}

function c20Deltas(
  lam: number,
  tau: number,
  B: number,
  h: number,
  l: number,
  n: number,
  sinI: number,
  cosI: number
): C20Deltas {
  const sin2i = sinI * sinI;
  const cos2i = cosI * cosI;
  const s1 = Math.sin(lam);
  const c1 = Math.cos(lam);
  const s2 = Math.sin(2 * lam);
  const c2 = Math.cos(2 * lam);
  const s3 = Math.sin(3 * lam);
  const c3 = Math.cos(3 * lam);
  const s4 = Math.sin(4 * lam);
  const c4 = Math.cos(4 * lam);

  const daOverA =
    2 * B * (1 - 1.5 * sin2i) * (l * c1 + h * s1) +
    B *
      sin2i *
      (0.5 * h * s1 - 0.5 * l * c1 + c2 + 3.5 * l * c3 + 3.5 * h * s3);

  const dh =
    B * (1 - 1.5 * sin2i) * (l * n * tau + s1 + 1.5 * l * s2 - 1.5 * h * c2) -
    0.25 *
      B *
      sin2i *
      (s1 - (7 / 3) * s3 + 5 * l * s2 - 8.5 * l * s4 + 8.5 * h * c4 + h * c2) +
    B * cos2i * (l * n * tau - 0.5 * l * s2);

  const dl =
    B * (1 - 1.5 * sin2i) * (-h * n * tau + c1 + 1.5 * l * c2 + 1.5 * h * s2) -
    0.25 *
      B *
      sin2i *
      (-c1 - (7 / 3) * c3 - 5 * h * s2 - 8.5 * l * c4 - 8.5 * h * s4 + l * c2) +
    B * cos2i * (-h * n * tau + 0.5 * h * s2);

  const nodeBracket =
    n * tau +
    3.5 * l * s1 -
    2.5 * h * c1 -
    0.5 * s2 -
    (7 / 6) * l * s3 +
    (7 / 6) * h * c3;

  const dOmega = -B * cosI * nodeBracket;

  const di =
    0.5 *
    B *
    sinI *
    cosI *
    (-l * c1 + h * s1 + c2 + (7 / 3) * l * c3 + (7 / 3) * h * s3);

  const dLambda =
    2 * B * (1 - 1.5 * sin2i) * (n * tau + 1.75 * l * s1 - 1.75 * h * c1) +
    3 *
      B *
      sin2i *
      (-(7 / 24) * h * c1 -
        (7 / 24) * l * s1 -
        (49 / 72) * h * c3 +
        (49 / 72) * l * s3 +
        0.25 * s2) +
    B * cos2i * nodeBracket;

  return { daOverA, dh, dl, dOmega, di, dLambda };
}

/**
 * Propagate a GLONASS almanac to `timeMs` (GPS-scale epoch ms).
 * Returns PZ-90 ECEF metres (PZ-90.11 is aligned with WGS84 to
 * centimetres — no frame transformation is applied, matching the
 * ephemeris path). `clockBias` is −τnA (the RINEX/af0 sign convention
 * used repo-wide: positioning adds +tauN, and tauN = −τn of the ICD).
 *
 * Almanac-class accuracy: sub-km at the reference epoch, a few km
 * after a day, ~10 km-class after several days.
 */
export function glonassAlmanacPosition(
  alm: SbfGlonassAlmanac,
  timeMs: number
): AlmanacPosition {
  const i = I_MEAN + alm.deltaI;
  const sinI = Math.sin(i);
  const cosI = Math.cos(i);
  const sin2i = sinI * sinI;
  const e = alm.epsilon;
  const oneMinusE2 = 1 - e * e;
  const Tdr = T_MEAN + alm.deltaT;
  const n = (2 * Math.PI) / Tdr;

  // Semi-major axis by successive approximation (ICD: |Δa| < 1e-3 km,
  // "usually three iterations"). υ = −ω at the ascending node, so
  // cos υ = cos ω.
  const cosW = Math.cos(alm.omega);
  let a = Math.cbrt((Tdr / (2 * Math.PI)) ** 2 * MU);
  for (let k = 0; k < 10; k++) {
    const p = a * oneMinusE2;
    const tOsc =
      Tdr /
      (1 +
        1.5 *
          C20 *
          (AE / p) ** 2 *
          ((2 - 2.5 * sin2i) *
            (Math.pow(oneMinusE2, 1.5) / (1 + e * cosW) ** 2) +
            (1 + e * cosW) ** 3 / oneMinusE2));
    const aNext = Math.cbrt((tOsc / (2 * Math.PI)) ** 2 * MU);
    const converged = Math.abs(aNext - a) < 1e-3;
    a = aNext;
    if (converged) break;
  }

  // Node passage of the orbital period containing ti. W is the whole
  // number of Draconian periods elapsed since tλ (floor keeps
  // τ ∈ [0, Tдр) for backward propagation too). No half-week fold —
  // t* is the plain difference from the almanac epoch.
  const tStar = (timeMs - glonassAlmanacEpochMs(alm)) / 1000;
  const W = Math.floor(tStar / Tdr);
  const nodeShift = Tdr * W + alm.deltaTDot * W * W;
  const omegaDot = 1.5 * C20 * n * (AE / a) ** 2 * cosI * oneMinusE2 ** -2;
  const lambdaK = alm.lambda + (omegaDot - OMEGA_Z) * nodeShift;
  /** τ = ti − tλk: time since the node passage. */
  const tau = tStar - nodeShift;

  // Eccentricity vector and mean longitude at the node (υ = −ω).
  const h = e * Math.sin(alm.omega);
  const l = e * cosW;
  const E0 =
    2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(-alm.omega / 2));
  const M = E0 - e * Math.sin(E0);

  const B = J * (AE / a) ** 2;
  const d1 = c20Deltas(M + alm.omega, 0, B, h, l, n, sinI, cosI);
  const d2 = c20Deltas(M + alm.omega + n * tau, tau, B, h, l, n, sinI, cosI);

  // Perturbed osculating elements at ti.
  const hi = h + (d2.dh - d1.dh);
  const li = l + (d2.dl - d1.dl);
  const epsI = Math.hypot(hi, li);
  const omegaI = epsI === 0 ? 0 : Math.atan2(hi, li);
  const aI = a + a * (d2.daOverA - d1.daOverA);
  const iI = i + (d2.di - d1.di);
  // Greenwich node instead of the ICD's inertial Ω = λk + S: the
  // sidereal terms cancel against the final Rz(S(ti)) rotation.
  const omegaG = lambdaK + (d2.dOmega - d1.dOmega) - OMEGA_Z * tau;
  const lambdaStar = M + alm.omega + n * tau + (d2.dLambda - d1.dLambda);
  const Mi = lambdaStar - omegaI;

  // Kepler equation, fixed point per the ICD (ε ≲ 0.03 ⇒ fast).
  let E = Mi;
  for (let k = 0; k < 30; k++) {
    const next = Mi + epsI * Math.sin(E);
    const converged = Math.abs(next - E) < 1e-12;
    E = next;
    if (converged) break;
  }
  const v = 2 * Math.atan(Math.sqrt((1 + epsI) / (1 - epsI)) * Math.tan(E / 2));
  const u = v + omegaI;
  const rKm = aI * (1 - epsI * Math.cos(E));

  const cosU = Math.cos(u);
  const sinU = Math.sin(u);
  const cosO = Math.cos(omegaG);
  const sinO = Math.sin(omegaG);
  const cosIi = Math.cos(iI);
  const sinIi = Math.sin(iI);

  return {
    prn: alm.prn,
    x: 1000 * rKm * (cosU * cosO - sinU * sinO * cosIi),
    y: 1000 * rKm * (cosU * sinO + sinU * cosO * cosIi),
    z: 1000 * rKm * sinU * sinIi,
    clockBias: -alm.tau,
  };
}
