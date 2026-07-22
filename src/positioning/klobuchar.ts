/**
 * Klobuchar broadcast ionospheric model (IS-GPS-200, 20.3.3.5.2.5).
 *
 * Evaluates the single-frequency vertical→slant ionospheric delay from
 * the eight coefficients broadcast in the GPS navigation message (and
 * carried in RINEX nav headers as GPSA/GPSB, or ION ALPHA/BETA in
 * RINEX 2). The model captures ~50% RMS of the actual delay — crude,
 * but exactly what a single-frequency receiver applies, which makes it
 * both a useful SPP correction and an honest "what broadcast users
 * get" reference against measured or GIM TEC.
 */

/** The eight Klobuchar coefficients from the navigation message. */
export interface KlobucharCoeffs {
  /** GPSA: alpha0..alpha3 (s, s/sc, s/sc², s/sc³). */
  alpha: number[];
  /** GPSB: beta0..beta3 (s, s/sc, s/sc², s/sc³). */
  beta: number[];
}

/**
 * Slant ionospheric group delay on GPS L1, in seconds.
 *
 * @param coeffs Broadcast alpha/beta coefficients
 * @param latRad Receiver geodetic latitude (radians)
 * @param lonRad Receiver geodetic longitude (radians)
 * @param azRad Satellite azimuth (radians)
 * @param elRad Satellite elevation (radians)
 * @param gpsTowSec GPS time of week (seconds)
 */
export function klobucharDelay(
  coeffs: KlobucharCoeffs,
  latRad: number,
  lonRad: number,
  azRad: number,
  elRad: number,
  gpsTowSec: number
): number {
  const { alpha, beta } = coeffs;
  if (alpha.length < 4 || beta.length < 4) return 0;

  // The model works in semicircles
  const E = elRad / Math.PI;
  const phiU = latRad / Math.PI;
  const lambdaU = lonRad / Math.PI;

  // Earth-centred angle to the ionospheric pierce point
  const psi = 0.0137 / (E + 0.11) - 0.022;

  // Pierce-point latitude, clamped to ±0.416 sc (±74.88°)
  let phiI = phiU + psi * Math.cos(azRad);
  if (phiI > 0.416) phiI = 0.416;
  else if (phiI < -0.416) phiI = -0.416;

  // Pierce-point longitude and geomagnetic latitude
  const lambdaI = lambdaU + (psi * Math.sin(azRad)) / Math.cos(phiI * Math.PI);
  const phiM = phiI + 0.064 * Math.cos((lambdaI - 1.617) * Math.PI);

  // Local time at the pierce point
  let t = 4.32e4 * lambdaI + gpsTowSec;
  t %= 86400;
  if (t < 0) t += 86400;

  // Amplitude and period of the cosine (floors per spec)
  let amp = 0;
  let per = 0;
  for (let n = 3; n >= 0; n--) {
    amp = amp * phiM + alpha[n]!;
    per = per * phiM + beta[n]!;
  }
  if (amp < 0) amp = 0;
  if (per < 72000) per = 72000;

  // Obliquity (slant) factor
  const F = 1 + 16 * Math.pow(0.53 - E, 3);

  const x = (2 * Math.PI * (t - 50400)) / per;
  if (Math.abs(x) >= 1.57) return F * 5e-9;
  const x2 = x * x;
  return F * (5e-9 + amp * (1 - x2 / 2 + (x2 * x2) / 24));
}
