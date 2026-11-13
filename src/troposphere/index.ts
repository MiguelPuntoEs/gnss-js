/**
 * Troposphere models beyond the standard atmosphere: GPT3 (an empirical
 * 5°×5° climatology of pressure, temperature, humidity, mapping-function
 * coefficients and gradients, with annual and semi-annual terms) and the
 * VMF3 mapping functions built from it (Landskron & Böhm 2018, "VMF3/GPT3:
 * refined discrete and empirical troposphere mapping functions", J Geod
 * 92:349–360). The grid is TU Wien's gpt3_5.grd (VMF Data Server,
 * vmf.geo.tuwien.ac.at, CC BY 4.0 — please acknowledge it and the ECMWF).
 *
 * `createGpt3Troposphere(grid)` gives the PPP engine its troposphere: the
 * a-priori zenith hydrostatic delay from GPT3 pressure (Saastamoinen), VMF3
 * hydrostatic and wet mapping with the height correction, and GPT3's
 * a-priori horizontal gradients.
 */
import {
  ANM_BH,
  ANM_BW,
  ANM_CH,
  ANM_CW,
  BNM_BH,
  BNM_BW,
  BNM_CH,
  BNM_CW,
} from './vmf3-coefficients';

/** Parameters per grid cell, each [mean, A1, B1, A2, B2] (cos/sin annual,
 *  cos/sin semi-annual), except the two constants. */
export interface Gpt3Grid {
  /** Cell centres are at 2.5°, 7.5°… ; 36 × 72 cells, row-major from the
   *  north pole (polar distance) then longitude 0…360°. */
  p: Float64Array; // Pa
  T: Float64Array; // K
  Q: Float64Array; // kg/kg
  dT: Float64Array; // K/m
  undu: Float64Array; // m (constant)
  Hs: Float64Array; // m (constant)
  ah: Float64Array;
  aw: Float64Array;
  la: Float64Array;
  Tm: Float64Array; // K
  Gn_h: Float64Array; // m
  Ge_h: Float64Array;
  Gn_w: Float64Array;
  Ge_w: Float64Array;
}

const CELLS = 36 * 72;

/** Parse TU Wien's gpt3_5.grd (text: a header line, then one row per cell). */
export function parseGpt3Grid(text: string): Gpt3Grid {
  const g = {
    p: new Float64Array(CELLS * 5),
    T: new Float64Array(CELLS * 5),
    Q: new Float64Array(CELLS * 5),
    dT: new Float64Array(CELLS * 5),
    undu: new Float64Array(CELLS),
    Hs: new Float64Array(CELLS),
    ah: new Float64Array(CELLS * 5),
    aw: new Float64Array(CELLS * 5),
    la: new Float64Array(CELLS * 5),
    Tm: new Float64Array(CELLS * 5),
    Gn_h: new Float64Array(CELLS * 5),
    Ge_h: new Float64Array(CELLS * 5),
    Gn_w: new Float64Array(CELLS * 5),
    Ge_w: new Float64Array(CELLS * 5),
  };
  let i = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('%')) continue;
    const v = t.split(/\s+/).map(Number);
    if (v.length < 64 || v.some((x) => !Number.isFinite(x))) continue;
    if (i >= CELLS) break;
    let k = 2; // skip lat, lon
    const put5 = (a: Float64Array) => {
      for (let j = 0; j < 5; j++) a[i * 5 + j] = v[k++]!;
    };
    put5(g.p);
    put5(g.T);
    put5(g.Q);
    g.Q.subarray(i * 5, i * 5 + 5).forEach((x, j, arr) => (arr[j] = x / 1000));
    put5(g.dT);
    g.dT.subarray(i * 5, i * 5 + 5).forEach((x, j, arr) => (arr[j] = x / 1000));
    g.undu[i] = v[k++]!;
    g.Hs[i] = v[k++]!;
    put5(g.ah);
    g.ah.subarray(i * 5, i * 5 + 5).forEach((x, j, arr) => (arr[j] = x / 1000));
    put5(g.aw);
    g.aw.subarray(i * 5, i * 5 + 5).forEach((x, j, arr) => (arr[j] = x / 1000));
    put5(g.la);
    put5(g.Tm);
    for (const a of [g.Gn_h, g.Ge_h, g.Gn_w, g.Ge_w]) {
      put5(a);
      a.subarray(i * 5, i * 5 + 5).forEach((x, j, arr) => (arr[j] = x / 1e5));
    }
    i++;
  }
  if (i !== CELLS)
    throw new Error(`GPT3 grid: expected ${CELLS} cells, found ${i}.`);
  return g;
}

export interface Gpt3Result {
  /** Pressure (hPa), temperature (°C), lapse rate (K/km), water vapour
   *  pressure (hPa), mean temperature (K), water-vapour decrease factor. */
  p: number;
  T: number;
  dT: number;
  e: number;
  Tm: number;
  la: number;
  /** VMF3 a coefficients. */
  ah: number;
  aw: number;
  /** Geoid undulation (m). */
  undu: number;
  /** Hydrostatic / wet gradients north/east (m). */
  Gn_h: number;
  Ge_h: number;
  Gn_w: number;
  Ge_w: number;
}

/** Fractional day of year (as GPT3 counts it, 1 = 1 January 00:00 + 1). */
function doyOf(utcMs: number): number {
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  return (utcMs - Date.UTC(y, 0, 1)) / 86_400_000 + 1;
}

const GM = 9.80665;
const DMTR = 28.965e-3;
const RG = 8.3143;

/**
 * GPT3 at a station (latitude/longitude in radians, ellipsoidal height m)
 * and instant, with bilinear interpolation between the four nearest cells
 * (Landskron & Böhm 2018; TU Wien gpt3_5_fast).
 */
export function gpt3(
  grid: Gpt3Grid,
  utcMs: number,
  latRad: number,
  lonRad: number,
  hEll: number
): Gpt3Result {
  const doy = doyOf(utcMs);
  const cf = Math.cos((doy / 365.25) * 2 * Math.PI);
  const sf = Math.sin((doy / 365.25) * 2 * Math.PI);
  const ch = Math.cos((doy / 365.25) * 4 * Math.PI);
  const sh = Math.sin((doy / 365.25) * 4 * Math.PI);
  const at = (a: Float64Array, ix: number) =>
    a[ix * 5]! +
    a[ix * 5 + 1]! * cf +
    a[ix * 5 + 2]! * sf +
    a[ix * 5 + 3]! * ch +
    a[ix * 5 + 4]! * sh;

  const plon = ((lonRad * 180) / Math.PI + 360) % 360;
  const ppod = ((-latRad + Math.PI / 2) * 180) / Math.PI;
  let ipod = Math.floor((ppod + 5) / 5);
  let ilon = Math.floor((plon + 5) / 5);
  const diffpod = (ppod - (ipod * 5 - 2.5)) / 5;
  const difflon = (plon - (ilon * 5 - 2.5)) / 5;
  if (ipod === 37) ipod = 36;
  if (ilon === 73) ilon = 1;
  if (ilon === 0) ilon = 72;

  // One cell's values at the station height.
  const cell = (ix: number) => {
    const undu = grid.undu[ix]!;
    const redh = hEll - undu - grid.Hs[ix]!;
    const T0 = at(grid.T, ix);
    const p0 = at(grid.p, ix);
    const Q = at(grid.Q, ix);
    const dT = at(grid.dT, ix);
    const T = T0 + dT * redh - 273.15;
    const Tv = T0 * (1 + 0.6077 * Q);
    const c = (GM * DMTR) / (RG * Tv);
    const p = (p0 * Math.exp(-c * redh)) / 100;
    const la = at(grid.la, ix);
    const e0 = (Q * p0) / (0.622 + 0.378 * Q) / 100;
    const e = e0 * ((100 * p) / p0) ** (la + 1);
    return {
      p,
      T,
      dT: dT * 1000,
      e,
      Tm: at(grid.Tm, ix),
      la,
      ah: at(grid.ah, ix),
      aw: at(grid.aw, ix),
      undu,
      Gn_h: at(grid.Gn_h, ix),
      Ge_h: at(grid.Ge_h, ix),
      Gn_w: at(grid.Gn_w, ix),
      Ge_w: at(grid.Ge_w, ix),
    };
  };

  const i0 = (ipod - 1) * 72 + ilon - 1; // 0-based
  if (!(ppod > 2.5 && ppod < 177.5)) return cell(i0);
  const ipod1 = ipod + Math.sign(diffpod);
  let ilon1 = ilon + Math.sign(difflon);
  if (ilon1 === 73) ilon1 = 1;
  if (ilon1 === 0) ilon1 = 72;
  const c1 = cell(i0);
  const c2 = cell((ipod1 - 1) * 72 + ilon - 1); // same longitude
  const c3 = cell((ipod - 1) * 72 + ilon1 - 1); // same polar distance
  const c4 = cell((ipod1 - 1) * 72 + ilon1 - 1); // diagonal
  const dp1 = Math.abs(diffpod);
  const dp2 = 1 - dp1;
  const dl1 = Math.abs(difflon);
  const dl2 = 1 - dl1;
  const mix = (k: keyof Gpt3Result) =>
    dl2 * (dp2 * c1[k] + dp1 * c2[k]) + dl1 * (dp2 * c3[k] + dp1 * c4[k]);
  const out = {} as Gpt3Result;
  for (const k of Object.keys(c1) as (keyof Gpt3Result)[]) out[k] = mix(k);
  return out;
}

/** The VMF3 empirical b and c coefficients at a location and day. */
function vmf3bc(
  utcMs: number,
  latRad: number,
  lonRad: number
): { bh: number; bw: number; ch: number; cw: number } {
  const nmax = 12;
  const polDist = Math.PI / 2 - latRad;
  const x = Math.sin(polDist) * Math.cos(lonRad);
  const y = Math.sin(polDist) * Math.sin(lonRad);
  const z = Math.cos(polDist);
  // Legendre functions (V, W) to degree/order 12.
  const V = Array.from({ length: nmax + 2 }, () =>
    new Array<number>(nmax + 2).fill(0)
  );
  const W = Array.from({ length: nmax + 2 }, () =>
    new Array<number>(nmax + 2).fill(0)
  );
  V[0]![0] = 1;
  V[1]![0] = z;
  for (let n = 2; n <= nmax; n++)
    V[n]![0] = ((2 * n - 1) * z * V[n - 1]![0]! - (n - 1) * V[n - 2]![0]!) / n;
  for (let m = 1; m <= nmax; m++) {
    V[m]![m] = (2 * m - 1) * (x * V[m - 1]![m - 1]! - y * W[m - 1]![m - 1]!);
    W[m]![m] = (2 * m - 1) * (x * W[m - 1]![m - 1]! + y * V[m - 1]![m - 1]!);
    if (m < nmax) {
      V[m + 1]![m] = (2 * m + 1) * z * V[m]![m]!;
      W[m + 1]![m] = (2 * m + 1) * z * W[m]![m]!;
    }
    for (let n = m + 2; n <= nmax; n++) {
      V[n]![m] =
        ((2 * n - 1) * z * V[n - 1]![m]! - (n + m - 1) * V[n - 2]![m]!) /
        (n - m);
      W[n]![m] =
        ((2 * n - 1) * z * W[n - 1]![m]! - (n + m - 1) * W[n - 2]![m]!) /
        (n - m);
    }
  }
  const doy = doyOf(utcMs);
  const cf = Math.cos((doy / 365.25) * 2 * Math.PI);
  const sf = Math.sin((doy / 365.25) * 2 * Math.PI);
  const ch2 = Math.cos((doy / 365.25) * 4 * Math.PI);
  const sh2 = Math.sin((doy / 365.25) * 4 * Math.PI);
  const sum = (
    anm: readonly (readonly number[])[],
    bnm: readonly (readonly number[])[]
  ) => {
    const s = [0, 0, 0, 0, 0];
    let i = 0;
    for (let n = 0; n <= nmax; n++)
      for (let m = 0; m <= n; m++) {
        for (let k = 0; k < 5; k++)
          s[k] += anm[i]![k]! * V[n]![m]! + bnm[i]![k]! * W[n]![m]!;
        i++;
      }
    return s[0]! + s[1]! * cf + s[2]! * sf + s[3]! * ch2 + s[4]! * sh2;
  };
  return {
    bh: sum(ANM_BH, BNM_BH),
    bw: sum(ANM_BW, BNM_BW),
    ch: sum(ANM_CH, BNM_CH),
    cw: sum(ANM_CW, BNM_CW),
  };
}

const marini = (sinEl: number, a: number, b: number, c: number) =>
  (1 + a / (1 + b / (1 + c))) / (sinEl + a / (sinEl + b / (sinEl + c)));

/**
 * VMF3 hydrostatic and wet mapping functions at an elevation, from the
 * a coefficients (e.g. GPT3's) and the empirical b, c; the hydrostatic one
 * with the Niell height correction (TU Wien vmf3_ht).
 */
export function vmf3(
  ah: number,
  aw: number,
  utcMs: number,
  latRad: number,
  lonRad: number,
  hEll: number,
  elRad: number
): { mfh: number; mfw: number } {
  const { bh, bw, ch, cw } = vmf3bc(utcMs, latRad, lonRad);
  const sinEl = Math.sin(elRad);
  const mfh0 = marini(sinEl, ah, bh, ch);
  const mfw = marini(sinEl, aw, bw, cw);
  // Height correction (Niell 1996).
  const dm =
    (1 / sinEl - marini(sinEl, 2.53e-5, 5.49e-3, 1.14e-3)) * (hEll / 1000);
  return { mfh: mfh0 + dm, mfw };
}

/** Saastamoinen zenith hydrostatic delay (m) from pressure (hPa). */
export function saastamoinenZhd(
  pHpa: number,
  latRad: number,
  hEll: number
): number {
  return (
    (0.0022768 * pHpa) / (1 - 0.00266 * Math.cos(2 * latRad) - 0.28e-6 * hEll)
  );
}

/** What the PPP engine needs from a troposphere model at one satellite. */
export interface TroposphereModel {
  delays(
    utcMs: number,
    latRad: number,
    lonRad: number,
    hEll: number,
    elRad: number,
    azRad: number
  ): {
    /** A-priori zenith hydrostatic delay (m). */
    zhd: number;
    /** Hydrostatic / wet mapping factors. */
    mh: number;
    mw: number;
    /** A-priori slant delay from horizontal gradients (m). */
    gradient: number;
  };
}

/**
 * GPT3 + VMF3 troposphere for PPP. GPT3 is evaluated once per station-day
 * position and cached (it changes slowly).
 */
export function createGpt3Troposphere(
  grid: Gpt3Grid,
  opts: {
    /** Add GPT3's a-priori horizontal gradients. Default true. */
    gradients?: boolean;
  } = {}
): TroposphereModel {
  const withGradients = opts.gradients ?? true;
  let cacheKey = '';
  let cached: Gpt3Result | null = null;
  return {
    delays(utcMs, latRad, lonRad, hEll, elRad, azRad) {
      // GPT3 varies with the season: refresh hourly, or when the station
      // moves more than ~1 km / 10 m vertically.
      const key = `${Math.floor(utcMs / 3_600_000)}|${latRad.toFixed(4)}|${lonRad.toFixed(4)}|${Math.round(hEll / 10)}`;
      if (key !== cacheKey || !cached) {
        cached = gpt3(grid, utcMs, latRad, lonRad, hEll);
        cacheKey = key;
      }
      const g = cached;
      const { mfh, mfw } = vmf3(g.ah, g.aw, utcMs, latRad, lonRad, hEll, elRad);
      // Chen & Herring (1997) gradient mapping.
      const sinEl = Math.sin(elRad);
      const mg = 1 / (sinEl * Math.tan(elRad) + 0.0032);
      const gradient = !withGradients
        ? 0
        : mg *
          ((g.Gn_h + g.Gn_w) * Math.cos(azRad) +
            (g.Ge_h + g.Ge_w) * Math.sin(azRad));
      return {
        zhd: saastamoinenZhd(g.p, latRad, hEll),
        mh: mfh,
        mw: mfw,
        gradient,
      };
    },
  };
}
export * from './vmf3-grid';
