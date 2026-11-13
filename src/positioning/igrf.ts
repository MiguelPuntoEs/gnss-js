/**
 * The geomagnetic main field from IGRF-14 — spherical-harmonic synthesis of
 * the IAGA coefficients ({@link ./igrf14-coeffs}), for the higher-order
 * ionospheric delay (the field at the ionospheric pierce point).
 *
 *   V = a Σₙ (a/r)ⁿ⁺¹ Σₘ (gₙᵐ cos mφ + hₙᵐ sin mφ) Pₙᵐ(cos θ),  B = −∇V,
 *
 * a = 6371.2 km, Pₙᵐ Schmidt semi-normalised. Coefficients are linear in
 * time between the 5-yearly models (2000–2025) and extrapolated with the
 * secular variation after 2025 (valid to 2030); before 2000 the 2000 model
 * is used.
 */
import { IGRF14_EPOCHS, IGRF14_GH, IGRF14_SV } from './igrf14-coeffs';

const NMAX = 13;
const A_REF = 6371200; // m
const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;

/** Coefficients (nT) at a decimal year. */
function coefficientsAt(year: number): number[] {
  const ep = IGRF14_EPOCHS;
  const last = ep.length - 1;
  if (year >= ep[last]!) {
    const dt = year - ep[last]!;
    return IGRF14_GH[last]!.map((g, k) => g + IGRF14_SV[k]! * dt);
  }
  if (year <= ep[0]!) return [...IGRF14_GH[0]!];
  const i = Math.floor((year - ep[0]!) / 5);
  const f = (year - ep[i]!) / 5;
  const a = IGRF14_GH[i]!;
  const b = IGRF14_GH[i + 1]!;
  return a.map((g, k) => g + f * (b[k]! - g));
}

/** Decimal year of a ms timestamp (any scale — seconds don't matter). */
export function decimalYear(timeMs: number): number {
  const y = new Date(timeMs).getUTCFullYear();
  const t0 = Date.UTC(y, 0, 1);
  const t1 = Date.UTC(y + 1, 0, 1);
  return y + (timeMs - t0) / (t1 - t0);
}

/** Field in the geocentric spherical frame (nT) at radius r (m),
 *  colatitude θ, longitude φ (rad). */
function fieldSpherical(
  gh: readonly number[],
  r: number,
  theta: number,
  phi: number
): { br: number; bt: number; bp: number } {
  const ct = Math.cos(theta);
  const st = Math.max(1e-12, Math.sin(theta));
  // Schmidt semi-normalised P[n][m] and dP/dθ.
  const P: number[][] = [];
  const dP: number[][] = [];
  for (let n = 0; n <= NMAX; n++) {
    P.push(new Array<number>(n + 1).fill(0));
    dP.push(new Array<number>(n + 1).fill(0));
  }
  P[0]![0] = 1;
  P[1]![1] = st;
  dP[1]![1] = ct;
  for (let n = 2; n <= NMAX; n++) {
    const k = Math.sqrt((2 * n - 1) / (2 * n));
    P[n]![n] = k * st * P[n - 1]![n - 1]!;
    dP[n]![n] = k * (ct * P[n - 1]![n - 1]! + st * dP[n - 1]![n - 1]!);
  }
  for (let m = 0; m < NMAX; m++)
    for (let n = m + 1; n <= NMAX; n++) {
      const den = Math.sqrt(n * n - m * m);
      const p2 = n - 2 >= m ? P[n - 2]![m]! : 0;
      const d2 = n - 2 >= m ? dP[n - 2]![m]! : 0;
      const c2 = Math.sqrt((n - 1) * (n - 1) - m * m);
      P[n]![m] = ((2 * n - 1) * ct * P[n - 1]![m]! - c2 * p2) / den;
      dP[n]![m] =
        ((2 * n - 1) * (ct * dP[n - 1]![m]! - st * P[n - 1]![m]!) - c2 * d2) /
        den;
    }
  let br = 0;
  let bt = 0;
  let bp = 0;
  let k = 0;
  const ar = A_REF / r;
  let arn = ar * ar; // (a/r)^(n+2) at n = 0
  for (let n = 1; n <= NMAX; n++) {
    arn *= ar;
    for (let m = 0; m <= n; m++) {
      const g = gh[k++]!;
      const h = m > 0 ? gh[k++]! : 0;
      const cm = Math.cos(m * phi);
      const sm = Math.sin(m * phi);
      const gc = g * cm + h * sm;
      br += (n + 1) * arn * gc * P[n]![m]!;
      bt -= arn * gc * dP[n]![m]!;
      bp -= (arn * m * (-g * sm + h * cm) * P[n]![m]!) / st;
    }
  }
  return { br, bt, bp };
}

/**
 * IGRF-14 main field at a geodetic position (WGS84; rad, rad, m) and time,
 * as geodetic North/East/Down (nT) and as an ECEF vector (nT).
 */
export function igrfField(
  latRad: number,
  lonRad: number,
  heightM: number,
  timeMs: number
): {
  north: number;
  east: number;
  down: number;
  ecef: [number, number, number];
} {
  // Geodetic → ECEF → geocentric spherical.
  const e2 = WGS84_F * (2 - WGS84_F);
  const sl = Math.sin(latRad);
  const cl = Math.cos(latRad);
  const N = WGS84_A / Math.sqrt(1 - e2 * sl * sl);
  const rho = (N + heightM) * cl;
  const z = (N * (1 - e2) + heightM) * sl;
  const r = Math.hypot(rho, z);
  const theta = Math.atan2(rho, z);
  const { br, bt, bp } = fieldSpherical(
    coefficientsAt(decimalYear(timeMs)),
    r,
    theta,
    lonRad
  );
  // Geocentric north/down, rotated by ψ = geodetic − geocentric latitude.
  const xc = -bt;
  const zc = -br;
  const psi = latRad - (Math.PI / 2 - theta);
  const north = xc * Math.cos(psi) + zc * Math.sin(psi);
  const down = -xc * Math.sin(psi) + zc * Math.cos(psi);
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const cp = Math.cos(lonRad);
  const sp = Math.sin(lonRad);
  const ecef: [number, number, number] = [
    br * st * cp + bt * ct * cp - bp * sp,
    br * st * sp + bt * ct * sp + bp * cp,
    br * ct - bt * st,
  ];
  return { north, east: bp, down, ecef };
}
