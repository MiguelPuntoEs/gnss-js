/**
 * Rotational deformation from polar motion — the solid-earth pole tide
 * (IERS Conventions 2010, 7.1.4, with the 2018 secular pole) and the ocean
 * pole tide loading (7.1.5, Desai 2002 self-consistent equilibrium model).
 *
 * Both are driven by the wobble (m1, m2): the instantaneous pole (xp, yp)
 * relative to the IERS 2018 linear secular pole (xs, ys),
 * m1 = xp − xs, m2 = −(yp − ys). The solid pole tide reaches ~25 mm
 * radially and ~7 mm horizontally; the ocean pole tide ~2 mm radial.
 * Both vary slowly (Chandler + annual wobble), so over a day they act as
 * a near-constant station offset.
 */

const AS2RAD = Math.PI / 180 / 3600;
const MJD_J2000 = 51544.5;

/**
 * IERS 2018 secular pole (arcsec) at a UTC MJD — eq. (21) of the 2018
 * update of Chapter 7: xs = 55.0 + 1.677 (t − 2000), ys = 320.5 + 3.460
 * (t − 2000) mas, t in years of 365.25 days.
 */
export function secularPole(mjd: number): { xs: number; ys: number } {
  const dt = (mjd - MJD_J2000) / 365.25;
  return { xs: (55.0 + 1.677 * dt) / 1000, ys: (320.5 + 3.46 * dt) / 1000 };
}

/** Wobble parameters (arcsec) from the pole (arcsec) at a UTC MJD. */
export function wobble(
  xp: number,
  yp: number,
  mjd: number
): { m1: number; m2: number } {
  const { xs, ys } = secularPole(mjd);
  return { m1: xp - xs, m2: -(yp - ys) };
}

/**
 * Solid-earth pole tide, [East, North, Up] (m), at geocentric latitude
 * `latRad`, longitude `lonRad`, for wobble (m1, m2) in arcsec — IERS
 * Conventions eq. (26) (h2 = 0.6207, l2 = 0.0836, |r| = a):
 *   Sθ = −9 cos2θ (m1 cosλ + m2 sinλ),  Sλ = 9 cosθ (m1 sinλ − m2 cosλ),
 *   Sr = −33 sin2θ (m1 cosλ + m2 sinλ)  [mm], θ = colatitude, Sθ southward.
 */
export function solidPoleTideEnu(
  latRad: number,
  lonRad: number,
  m1: number,
  m2: number
): [number, number, number] {
  const th = Math.PI / 2 - latRad;
  const c = m1 * Math.cos(lonRad) + m2 * Math.sin(lonRad);
  const sTheta = -9 * Math.cos(2 * th) * c;
  const sLambda =
    9 * Math.cos(th) * (m1 * Math.sin(lonRad) - m2 * Math.cos(lonRad));
  const sR = -33 * Math.sin(2 * th) * c;
  return [sLambda * 1e-3, -sTheta * 1e-3, sR * 1e-3];
}

/** Desai (2002) ocean pole load tide coefficients at a point (dimensionless). */
export interface OceanPoleTideCoefficients {
  /** Real parts [radial, north, east]. */
  re: [number, number, number];
  /** Imaginary parts [radial, north, east]. */
  im: [number, number, number];
}

// Eq. (29) constants (IERS Conventions Chapter 1 values).
const G = 6.67428e-11;
const A_E = 6378136.6;
const GM = 3.986004418e14;
const OMEGA = 7.292115e-5;
const G_E = 9.7803278;
const RHO_W = 1025;
const GAMMA_R = 0.687;
const GAMMA_I = 0.0036;
/** Hp = √(8π/15) Ω² a⁴ / GM (m). */
const HP = (Math.sqrt((8 * Math.PI) / 15) * OMEGA * OMEGA * A_E ** 4) / GM;
/** K = 4π G a ρw Hp / (3 g) (m). */
const K_OPT = (4 * Math.PI * G * A_E * RHO_W * HP) / (3 * G_E);

/**
 * Ocean pole tide loading, [East, North, Up] (m), for the station's Desai
 * coefficients and wobble (m1, m2) in arcsec — IERS Conventions eq. (29):
 *   u = K [(m1 γR + m2 γI) u^R + (m2 γR − m1 γI) u^I],  m in radians.
 */
export function oceanPoleTideEnu(
  c: OceanPoleTideCoefficients,
  m1: number,
  m2: number
): [number, number, number] {
  const a = K_OPT * (m1 * GAMMA_R + m2 * GAMMA_I) * AS2RAD;
  const b = K_OPT * (m2 * GAMMA_R - m1 * GAMMA_I) * AS2RAD;
  const r = a * c.re[0] + b * c.im[0];
  const n = a * c.re[1] + b * c.im[1];
  const e = a * c.re[2] + b * c.im[2];
  return [e, n, r];
}

/** A global grid of ocean pole tide coefficients (Desai 2002 file). */
export interface OceanPoleTideGrid {
  lat0: number;
  lon0: number;
  step: number;
  nLat: number;
  nLon: number;
  /** [(i·nLon + j)·6 + k], k = urR urI unR unI ueR ueI. */
  values: Float32Array;
}

/**
 * Parse the IERS distribution of the Desai (2002) coefficients
 * (`opoleloadcoefcmcor.txt`: header, then `lon lat urR urI unR unI ueR ueI`
 * rows on a regular 0.5° grid, longitude fastest).
 */
export function parseOceanPoleTideGrid(text: string): OceanPoleTideGrid {
  const head = (key: string) => {
    const m = new RegExp(`${key}\\s*=\\s*([-\\d.]+)`).exec(text);
    if (!m) throw new Error(`ocean pole tide grid: no ${key}`);
    return Number(m[1]);
  };
  const nLon = head('Number_longitude_Grid_Points');
  const nLat = head('Number_latitude_grid_points');
  const lon0 = head('First_longitude_degrees');
  const lat0 = head('First_latitude_degrees');
  const step = head('Longitude_step_degrees');
  // Nodes missing from the text (an excerpt) stay NaN.
  const values = new Float32Array(nLat * nLon * 6).fill(NaN);
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length !== 8) continue;
    const v = f.map(Number);
    if (v.some((x) => !Number.isFinite(x))) continue;
    const j = Math.round((v[0]! - lon0) / step);
    const i = Math.round((v[1]! - lat0) / step);
    if (i < 0 || i >= nLat || j < 0 || j >= nLon) continue;
    for (let k = 0; k < 6; k++) values[(i * nLon + j) * 6 + k] = v[2 + k]!;
    n++;
  }
  if (!n) throw new Error('ocean pole tide grid: no nodes');
  return { lat0, lon0, step, nLat, nLon, values };
}

/** Bilinear interpolation of the grid at a point (degrees). */
export function oceanPoleTideAt(
  g: OceanPoleTideGrid,
  latDeg: number,
  lonDeg: number
): OceanPoleTideCoefficients {
  const fi = Math.max(0, Math.min(g.nLat - 1, (latDeg - g.lat0) / g.step));
  let fj = (lonDeg - g.lon0) / g.step;
  fj = ((fj % g.nLon) + g.nLon) % g.nLon;
  const i0 = Math.min(g.nLat - 2, Math.floor(fi));
  const j0 = Math.floor(fj);
  const j1 = (j0 + 1) % g.nLon;
  const di = fi - i0;
  const dj = fj - j0;
  const v = (i: number, j: number, k: number) =>
    g.values[(i * g.nLon + j) * 6 + k]!;
  const at = (k: number) =>
    (1 - di) * ((1 - dj) * v(i0, j0, k) + dj * v(i0, j1, k)) +
    di * ((1 - dj) * v(i0 + 1, j0, k) + dj * v(i0 + 1, j1, k));
  return { re: [at(0), at(2), at(4)], im: [at(1), at(3), at(5)] };
}
