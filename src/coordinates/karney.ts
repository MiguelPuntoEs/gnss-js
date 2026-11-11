/**
 * Geodesics on the WGS84 ellipsoid after Karney — the inverse problem
 * (distance and azimuths between two points) and the direct problem (the
 * point at a distance along an azimuth), accurate to ~15 nm everywhere,
 * nearly antipodal points included, where Vincenty's iteration fails.
 *
 * A TypeScript port of the parts of GeographicLib's Geodesic.js and
 * GeodesicLine.js these two problems need (no area, no reduced length or
 * geodesic scale in the output), specialised to WGS84.
 *
 *   C. F. F. Karney, Algorithms for geodesics, J. Geodesy 87, 43–55 (2013),
 *   https://doi.org/10.1007/s00190-012-0578-z
 *
 * GeographicLib: Copyright (c) Charles Karney (2011-2022)
 * <karney@alum.mit.edu>, MIT/X11 License,
 * https://geographiclib.sourceforge.io/ — permission is hereby granted,
 * free of charge, to any person obtaining a copy of this software and
 * associated documentation files, to deal in the Software without
 * restriction, subject to including this copyright and permission notice;
 * the software is provided "as is", without warranty of any kind.
 */
import { WGS84_SEMI_MAJOR_AXIS, WGS84_FLATTENING } from '../constants/wgs84';

// ── Math helpers (GeographicLib Math.js) ─────────────────────────────

const DIGITS = 53;
const EPSILON = Math.pow(0.5, DIGITS - 1);
const DEGREE = Math.PI / 180;
const TINY = Math.sqrt(Number.MIN_VALUE / Number.EPSILON);

const sq = (x: number) => x * x;

function copysign(x: number, y: number): number {
  return Math.abs(x) * (y < 0 || (y === 0 && 1 / y < 0) ? -1 : 1);
}

/** Error-free sum: u + v = s + t exactly. */
function sum(u: number, v: number): { s: number; t: number } {
  const s = u + v;
  let up = s - v;
  let vpp = s - up;
  up -= u;
  vpp -= v;
  const t = s ? 0 - (up + vpp) : s;
  return { s, t };
}

function polyval(N: number, p: readonly number[], s: number, x: number) {
  let y = N < 0 ? 0 : p[s++]!;
  while (--N >= 0) y = y * x + p[s++]!;
  return y;
}

/** Round tiny angles so that near-singular cases are exactly singular. */
function angRound(x: number): number {
  const z = 1 / 16;
  let y = Math.abs(x);
  y = y < z ? z - (z - y) : y;
  return copysign(y, x);
}

function remainder(x: number, y: number): number {
  x %= y;
  return x < -y / 2 ? x + y : x < y / 2 ? x : x - y;
}

function angNormalize(x: number): number {
  const y = remainder(x, 360);
  return Math.abs(y) === 180 ? copysign(180, x) : y;
}

const latFix = (x: number) => (Math.abs(x) > 90 ? NaN : x);

/** y − x reduced to [−180, 180] accurately, with the rounding error. */
function angDiff(x: number, y: number): { d: number; e: number } {
  let r = sum(remainder(-x, 360), remainder(y, 360));
  r = sum(remainder(r.s, 360), r.t);
  let d = r.s;
  const e = r.t;
  if (d === 0 || Math.abs(d) === 180) d = copysign(d, e === 0 ? y - x : -e);
  return { d, e };
}

function quadrant(s: number, c: number, q: number): { s: number; c: number } {
  let sinx: number, cosx: number;
  switch (q & 3) {
    case 0:
      sinx = s;
      cosx = c;
      break;
    case 1:
      sinx = c;
      cosx = -s;
      break;
    case 2:
      sinx = -s;
      cosx = -c;
      break;
    default:
      sinx = -c;
      cosx = s;
      break;
  }
  return { s: sinx, c: cosx + 0 };
}

function exactSinCos(d: number): { s: number; c: number } {
  const r = d * DEGREE;
  let s = Math.sin(r);
  let c = Math.cos(r);
  if (Math.abs(d) === 45) {
    c = Math.sqrt(0.5);
    s = copysign(c, r);
  } else if (Math.abs(d) === 30) {
    c = Math.sqrt(0.75);
    s = copysign(0.5, r);
  }
  return { s, c };
}

/** sin and cos of x degrees, reduced exactly to [−45°, 45°] first. */
function sincosd(x: number): { s: number; c: number } {
  let d = x % 360;
  const q = Math.round(d / 90);
  d -= 90 * q;
  const { s, c } = exactSinCos(d);
  const out = quadrant(s, c, q);
  if (out.s === 0) out.s = copysign(out.s, x);
  return out;
}

/** sincosd of x + t, t being a small correction to x. */
function sincosde(x: number, t: number): { s: number; c: number } {
  let d = x % 360;
  const q = Math.round(d / 90);
  d = angRound(d - 90 * q + t);
  const { s, c } = exactSinCos(d);
  const out = quadrant(s, c, q);
  if (out.s === 0) out.s = copysign(out.s, x + t);
  return out;
}

/** atan2 in degrees, computed in [−45°, 45°] and mapped back. */
function atan2d(y: number, x: number): number {
  let q = 0;
  if (Math.abs(y) > Math.abs(x)) {
    [y, x] = [x, y];
    q = 2;
  }
  if (copysign(1, x) < 0) {
    x = -x;
    ++q;
  }
  let ang = Math.atan2(y, x) / DEGREE;
  switch (q) {
    case 1:
      ang = copysign(180, y) - ang;
      break;
    case 2:
      ang = 90 - ang;
      break;
    case 3:
      ang = -90 + ang;
      break;
  }
  return ang;
}

// ── Series (order 6) ─────────────────────────────────────────────────

const ORDER = 6;
const nA1 = ORDER;
const nC1 = ORDER;
const nC1p = ORDER;
const nA2 = ORDER;
const nC2 = ORDER;
const nA3 = ORDER;
const nC3 = ORDER;
const MAXIT1 = 20;
const MAXIT2 = MAXIT1 + DIGITS + 10;
const TOL0 = EPSILON;
const TOL1 = 200 * TOL0;
const TOL2 = Math.sqrt(TOL0);
const TOLB = TOL0;
const XTHRESH = 1000 * TOL2;

/** Clenshaw sum of a sine (sinp) or cosine series; c[0] unused for sines. */
function sinCosSeries(
  sinp: boolean,
  sinx: number,
  cosx: number,
  c: readonly number[]
): number {
  let k = c.length;
  let n = k - (sinp ? 1 : 0);
  const ar = 2 * (cosx - sinx) * (cosx + sinx);
  let y0 = n & 1 ? c[--k]! : 0;
  let y1 = 0;
  n = Math.floor(n / 2);
  while (n--) {
    y1 = ar * y0 - y1 + c[--k]!;
    y0 = ar * y1 - y0 + c[--k]!;
  }
  return sinp ? 2 * sinx * cosx * y0 : cosx * (y0 - y1);
}

/** Positive root k of k⁴+2k³−(x²+y²−1)k²−2y²k−y² = 0. */
function astroid(x: number, y: number): number {
  const p = sq(x);
  const q = sq(y);
  const r = (p + q - 1) / 6;
  if (q === 0 && r <= 0) return 0;
  const S = (p * q) / 4;
  const r2 = sq(r);
  const r3 = r * r2;
  const disc = S * (S + 2 * r3);
  let u = r;
  if (disc >= 0) {
    let T3 = S + r3;
    T3 += T3 < 0 ? -Math.sqrt(disc) : Math.sqrt(disc);
    const T = Math.cbrt(T3);
    u += T + (T !== 0 ? r2 / T : 0);
  } else {
    const ang = Math.atan2(Math.sqrt(-disc), -(S + r3));
    u += 2 * r * Math.cos(ang / 3);
  }
  const v = Math.sqrt(sq(u) + q);
  const uv = u < 0 ? q / (v - u) : u + v;
  const w = (uv - q) / (2 * v);
  return uv / (Math.sqrt(uv + sq(w)) + w);
}

const A1M1F_COEFF = [1, 4, 64, 0, 256];
function A1m1f(eps: number): number {
  const p = Math.floor(nA1 / 2);
  const t = polyval(p, A1M1F_COEFF, 0, sq(eps)) / A1M1F_COEFF[p + 1]!;
  return (t + eps) / (1 - eps);
}

const C1F_COEFF = [
  -1, 6, -16, 32, -9, 64, -128, 2048, 9, -16, 768, 3, -5, 512, -7, 1280, -7,
  2048,
];
const C1PF_COEFF = [
  205, -432, 768, 1536, 4005, -4736, 3840, 12288, -225, 116, 384, -7173, 2695,
  7680, 3467, 7680, 38081, 61440,
];
const C2F_COEFF = [
  1, 2, 16, 32, 35, 64, 384, 2048, 15, 80, 768, 7, 35, 512, 63, 1280, 77, 2048,
];

/** Fill c[1..n] with a Fourier series in eps from its coefficient table. */
function fourier(
  coeff: readonly number[],
  n: number,
  eps: number,
  c: number[]
) {
  const eps2 = sq(eps);
  let d = eps;
  let o = 0;
  for (let l = 1; l <= n; ++l) {
    const p = Math.floor((n - l) / 2);
    c[l] = (d * polyval(p, coeff, o, eps2)) / coeff[o + p + 1]!;
    o += p + 2;
    d *= eps;
  }
}
const C1f = (eps: number, c: number[]) => fourier(C1F_COEFF, nC1, eps, c);
const C1pf = (eps: number, c: number[]) => fourier(C1PF_COEFF, nC1p, eps, c);
const C2f = (eps: number, c: number[]) => fourier(C2F_COEFF, nC2, eps, c);

const A2M1F_COEFF = [-11, -28, -192, 0, 256];
function A2m1f(eps: number): number {
  const p = Math.floor(nA2 / 2);
  const t = polyval(p, A2M1F_COEFF, 0, sq(eps)) / A2M1F_COEFF[p + 1]!;
  return (t - eps) / (1 + eps);
}

const A3_COEFF = [
  -3, 128, -2, -3, 64, -1, -3, -1, 16, 3, -1, -2, 8, 1, -1, 2, 1, 1,
];
const C3_COEFF = [
  3, 128, 2, 5, 128, -1, 3, 3, 64, -1, 0, 1, 8, -1, 1, 4, 5, 256, 1, 3, 128, -3,
  -2, 3, 64, 1, -3, 2, 32, 7, 512, -10, 9, 384, 5, -9, 5, 192, 7, 512, -14, 7,
  512, 21, 2560,
];

// ── The WGS84 ellipsoid ─────────────────────────────────────────────

const a = WGS84_SEMI_MAJOR_AXIS;
const f = WGS84_FLATTENING;
const f1 = 1 - f;
const e2 = f * (2 - f);
const ep2 = e2 / sq(f1);
const n = f / (2 - f);
const b = a * f1;
const etol2 =
  (0.1 * TOL2) /
  Math.sqrt((Math.max(0.001, Math.abs(f)) * Math.min(1, 1 - f / 2)) / 2);

const A3x: number[] = [];
for (let j = nA3 - 1, o = 0; j >= 0; --j) {
  const p = Math.min(nA3 - j - 1, j);
  A3x.push(polyval(p, A3_COEFF, o, n) / A3_COEFF[o + p + 1]!);
  o += p + 2;
}
const C3x: number[] = [];
for (let l = 1, o = 0; l < nC3; ++l) {
  for (let j = nC3 - 1; j >= l; --j) {
    const p = Math.min(nC3 - j - 1, j);
    C3x.push(polyval(p, C3_COEFF, o, n) / C3_COEFF[o + p + 1]!);
    o += p + 2;
  }
}

const A3f = (eps: number) => polyval(nA3 - 1, A3x, 0, eps);

function C3f(eps: number, c: number[]) {
  let mult = 1;
  let o = 0;
  for (let l = 1; l < nC3; ++l) {
    const p = nC3 - l - 1;
    mult *= eps;
    c[l] = mult * polyval(p, C3x, o, eps);
    o += p + 1;
  }
}

/** Distance s12b (in units of b) and reduced length m12b along a geodesic. */
function lengths(
  eps: number,
  sig12: number,
  ssig1: number,
  csig1: number,
  dn1: number,
  ssig2: number,
  csig2: number,
  dn2: number,
  wantDistance: boolean,
  C1a: number[],
  C2a: number[]
): { s12b: number; m12b: number; m0: number } {
  let A1 = A1m1f(eps);
  C1f(eps, C1a);
  let A2 = A2m1f(eps);
  C2f(eps, C2a);
  const m0 = A1 - A2;
  A2 = 1 + A2;
  A1 = 1 + A1;
  let s12b = NaN;
  let J12: number;
  if (wantDistance) {
    const B1 =
      sinCosSeries(true, ssig2, csig2, C1a) -
      sinCosSeries(true, ssig1, csig1, C1a);
    s12b = A1 * (sig12 + B1);
    const B2 =
      sinCosSeries(true, ssig2, csig2, C2a) -
      sinCosSeries(true, ssig1, csig1, C2a);
    J12 = m0 * sig12 + (A1 * B1 - A2 * B2);
  } else {
    for (let l = 1; l <= nC2; ++l) C2a[l] = A1 * C1a[l]! - A2 * C2a[l]!;
    J12 =
      m0 * sig12 +
      (sinCosSeries(true, ssig2, csig2, C2a) -
        sinCosSeries(true, ssig1, csig1, C2a));
  }
  const m12b =
    dn2 * (csig1 * ssig2) - dn1 * (ssig1 * csig2) - csig1 * csig2 * J12;
  return { s12b, m12b, m0 };
}

/** Starting point for Newton's method; sig12 ≥ 0 when it is already the answer. */
function inverseStart(
  sbet1: number,
  cbet1: number,
  sbet2: number,
  cbet2: number,
  lam12: number,
  slam12: number,
  clam12: number
) {
  const out = { sig12: -1, salp1: 0, calp1: 0, salp2: 0, calp2: 0, dnm: 0 };
  const sbet12 = sbet2 * cbet1 - cbet2 * sbet1;
  const cbet12 = cbet2 * cbet1 + sbet2 * sbet1;
  let sbet12a = sbet2 * cbet1;
  sbet12a += cbet2 * sbet1;
  const shortline = cbet12 >= 0 && sbet12 < 0.5 && cbet2 * lam12 < 0.5;
  let somg12: number, comg12: number;
  if (shortline) {
    let sbetm2 = sq(sbet1 + sbet2);
    sbetm2 /= sbetm2 + sq(cbet1 + cbet2);
    out.dnm = Math.sqrt(1 + ep2 * sbetm2);
    const omg12 = lam12 / (f1 * out.dnm);
    somg12 = Math.sin(omg12);
    comg12 = Math.cos(omg12);
  } else {
    somg12 = slam12;
    comg12 = clam12;
  }
  out.salp1 = cbet2 * somg12;
  out.calp1 =
    comg12 >= 0
      ? sbet12 + (cbet2 * sbet1 * sq(somg12)) / (1 + comg12)
      : sbet12a - (cbet2 * sbet1 * sq(somg12)) / (1 - comg12);
  const ssig12 = Math.hypot(out.salp1, out.calp1);
  const csig12 = sbet1 * sbet2 + cbet1 * cbet2 * comg12;
  if (shortline && ssig12 < etol2) {
    out.salp2 = cbet1 * somg12;
    out.calp2 =
      sbet12 -
      cbet1 * sbet2 * (comg12 >= 0 ? sq(somg12) / (1 + comg12) : 1 - comg12);
    const t = Math.hypot(out.salp2, out.calp2);
    out.salp2 /= t;
    out.calp2 /= t;
    out.sig12 = Math.atan2(ssig12, csig12);
  } else if (
    Math.abs(n) > 0.1 ||
    csig12 >= 0 ||
    ssig12 >= 6 * Math.abs(n) * Math.PI * sq(cbet1)
  ) {
    // The zeroth-order spherical approximation is good enough.
  } else {
    // Nearly antipodal: scale to the astroid problem (f > 0 for WGS84).
    const lam12x = Math.atan2(-slam12, -clam12);
    const k2 = sq(sbet1) * ep2;
    const eps = k2 / (2 * (1 + Math.sqrt(1 + k2)) + k2);
    const lamscale = f * cbet1 * A3f(eps) * Math.PI;
    const betscale = lamscale * cbet1;
    const x = lam12x / lamscale;
    const y = sbet12a / betscale;
    if (y > -TOL1 && x > -1 - XTHRESH) {
      out.salp1 = Math.min(1, -x);
      out.calp1 = -Math.sqrt(1 - sq(out.salp1));
    } else {
      const k = astroid(x, y);
      const omg12a = lamscale * ((-x * k) / (1 + k));
      somg12 = Math.sin(omg12a);
      comg12 = -Math.cos(omg12a);
      out.salp1 = cbet2 * somg12;
      out.calp1 = sbet12a - (cbet2 * sbet1 * sq(somg12)) / (1 - comg12);
    }
  }
  if (!(out.salp1 <= 0)) {
    const t = Math.hypot(out.salp1, out.calp1);
    out.salp1 /= t;
    out.calp1 /= t;
  } else {
    out.salp1 = 1;
    out.calp1 = 0;
  }
  return out;
}

/** Longitude difference reached from point 1 with azimuth alp1, and its derivative. */
function lambda12(
  sbet1: number,
  cbet1: number,
  dn1: number,
  sbet2: number,
  cbet2: number,
  dn2: number,
  salp1: number,
  calp1: number,
  slam120: number,
  clam120: number,
  diffp: boolean,
  C1a: number[],
  C2a: number[],
  C3a: number[]
) {
  if (sbet1 === 0 && calp1 === 0) calp1 = -TINY;
  const salp0 = salp1 * cbet1;
  const calp0 = Math.hypot(calp1, salp1 * sbet1);
  let ssig1 = sbet1;
  const somg1 = salp0 * sbet1;
  let csig1 = calp1 * cbet1;
  const comg1 = csig1;
  let t = Math.hypot(ssig1, csig1);
  ssig1 /= t;
  csig1 /= t;
  const salp2 = cbet2 !== cbet1 ? salp0 / cbet2 : salp1;
  const calp2 =
    cbet2 !== cbet1 || Math.abs(sbet2) !== -sbet1
      ? Math.sqrt(
          sq(calp1 * cbet1) +
            (cbet1 < -sbet1
              ? (cbet2 - cbet1) * (cbet1 + cbet2)
              : (sbet1 - sbet2) * (sbet1 + sbet2))
        ) / cbet2
      : Math.abs(calp1);
  let ssig2 = sbet2;
  const somg2 = salp0 * sbet2;
  let csig2 = calp2 * cbet2;
  const comg2 = csig2;
  t = Math.hypot(ssig2, csig2);
  ssig2 /= t;
  csig2 /= t;
  const sig12 = Math.atan2(
    Math.max(0, csig1 * ssig2 - ssig1 * csig2),
    csig1 * csig2 + ssig1 * ssig2
  );
  const somg12 = Math.max(0, comg1 * somg2 - somg1 * comg2);
  const comg12 = comg1 * comg2 + somg1 * somg2;
  const eta = Math.atan2(
    somg12 * clam120 - comg12 * slam120,
    comg12 * clam120 + somg12 * slam120
  );
  const k2 = sq(calp0) * ep2;
  const eps = k2 / (2 * (1 + Math.sqrt(1 + k2)) + k2);
  C3f(eps, C3a);
  const B312 =
    sinCosSeries(true, ssig2, csig2, C3a) -
    sinCosSeries(true, ssig1, csig1, C3a);
  const domg12 = -f * A3f(eps) * salp0 * (sig12 + B312);
  const lam12 = eta + domg12;
  let dlam12 = NaN;
  if (diffp) {
    if (calp2 === 0) dlam12 = (-2 * f1 * dn1) / sbet1;
    else {
      const { m12b } = lengths(
        eps,
        sig12,
        ssig1,
        csig1,
        dn1,
        ssig2,
        csig2,
        dn2,
        false,
        C1a,
        C2a
      );
      dlam12 = (m12b * f1) / (calp2 * cbet2);
    }
  }
  return {
    lam12,
    salp2,
    calp2,
    sig12,
    ssig1,
    csig1,
    ssig2,
    csig2,
    eps,
    dlam12,
  };
}

/**
 * Inverse geodesic problem on WGS84: the shortest distance between two
 * points and the azimuths at both ends (degrees clockwise from north;
 * azi2 is the forward azimuth on arrival).
 */
export function geodesicInverse(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): { s12: number; azi1: number; azi2: number } {
  lat1 = angRound(latFix(lat1));
  lat2 = angRound(latFix(lat2));
  const diff = angDiff(lon1, lon2);
  let lon12 = diff.d;
  let lon12s = diff.e;
  let lonsign = copysign(1, lon12);
  lon12 *= lonsign;
  lon12s *= lonsign;
  const lam12 = lon12 * DEGREE;
  let t = sincosde(lon12, lon12s);
  const slam12 = t.s;
  const clam12 = t.c;
  lon12s = 180 - lon12 - lon12s;

  const swapp = Math.abs(lat1) < Math.abs(lat2) || isNaN(lat2) ? -1 : 1;
  if (swapp < 0) {
    lonsign *= -1;
    [lat2, lat1] = [lat1, lat2];
  }
  const latsign = copysign(1, -lat1);
  lat1 *= latsign;
  lat2 *= latsign;

  t = sincosd(lat1);
  let sbet1 = f1 * t.s;
  let cbet1 = t.c;
  let h = Math.hypot(sbet1, cbet1);
  sbet1 /= h;
  cbet1 /= h;
  cbet1 = Math.max(TINY, cbet1);

  t = sincosd(lat2);
  let sbet2 = f1 * t.s;
  let cbet2 = t.c;
  h = Math.hypot(sbet2, cbet2);
  sbet2 /= h;
  cbet2 /= h;
  cbet2 = Math.max(TINY, cbet2);

  if (cbet1 < -sbet1) {
    if (cbet2 === cbet1) sbet2 = copysign(sbet1, sbet2);
  } else if (Math.abs(sbet2) === -sbet1) cbet2 = cbet1;

  const dn1 = Math.sqrt(1 + ep2 * sq(sbet1));
  const dn2 = Math.sqrt(1 + ep2 * sq(sbet2));
  const C1a = new Array<number>(nC1 + 1).fill(0);
  const C2a = new Array<number>(nC2 + 1).fill(0);
  const C3a = new Array<number>(nC3).fill(0);

  let s12x = 0;
  let salp1 = 0;
  let calp1 = 0;
  let salp2 = 0;
  let calp2 = 0;
  let sig12: number;

  let meridian = lat1 === -90 || slam12 === 0;
  if (meridian) {
    calp1 = clam12;
    salp1 = slam12;
    calp2 = 1;
    salp2 = 0;
    const ssig1 = sbet1;
    const csig1 = calp1 * cbet1;
    const ssig2 = sbet2;
    const csig2 = calp2 * cbet2;
    sig12 = Math.atan2(
      Math.max(0, csig1 * ssig2 - ssig1 * csig2),
      csig1 * csig2 + ssig1 * ssig2
    );
    const L = lengths(
      n,
      sig12,
      ssig1,
      csig1,
      dn1,
      ssig2,
      csig2,
      dn2,
      true,
      C1a,
      C2a
    );
    s12x = L.s12b;
    const m12x = L.m12b;
    if (sig12 < TOL2 || m12x >= 0) {
      // Zero-length (or rounding-negative) lines are exactly zero.
      if (sig12 < 3 * TINY || (sig12 < TOL0 && (s12x < 0 || m12x < 0)))
        s12x = 0;
      s12x *= b;
    } else meridian = false;
  }

  if (!meridian && sbet1 === 0 && (f <= 0 || lon12s >= f * 180)) {
    // Along the equator.
    calp1 = calp2 = 0;
    salp1 = salp2 = 1;
    s12x = a * lam12;
  } else if (!meridian) {
    const start = inverseStart(
      sbet1,
      cbet1,
      sbet2,
      cbet2,
      lam12,
      slam12,
      clam12
    );
    sig12 = start.sig12;
    salp1 = start.salp1;
    calp1 = start.calp1;
    if (sig12 >= 0) {
      // Short line, solved on the auxiliary sphere.
      salp2 = start.salp2;
      calp2 = start.calp2;
      s12x = sig12 * b * start.dnm;
    } else {
      // Newton's method on lambda12(alp1) − lam12, kept inside a bracket.
      let salp1a = TINY;
      let calp1a = 1;
      let salp1b = TINY;
      let calp1b = -1;
      let tripn = false;
      let tripb = false;
      let r: ReturnType<typeof lambda12>;
      for (let numit = 0; ; ++numit) {
        r = lambda12(
          sbet1,
          cbet1,
          dn1,
          sbet2,
          cbet2,
          dn2,
          salp1,
          calp1,
          slam12,
          clam12,
          numit < MAXIT1,
          C1a,
          C2a,
          C3a
        );
        const v = r.lam12;
        const dv = r.dlam12;
        if (
          tripb ||
          !(Math.abs(v) >= (tripn ? 8 : 1) * TOL0) ||
          numit === MAXIT2
        )
          break;
        if (v > 0 && (numit < MAXIT1 || calp1 / salp1 > calp1b / salp1b)) {
          salp1b = salp1;
          calp1b = calp1;
        } else if (
          v < 0 &&
          (numit < MAXIT1 || calp1 / salp1 < calp1a / salp1a)
        ) {
          salp1a = salp1;
          calp1a = calp1;
        }
        if (numit < MAXIT1 && dv > 0) {
          const dalp1 = -v / dv;
          if (Math.abs(dalp1) < Math.PI) {
            const sdalp1 = Math.sin(dalp1);
            const cdalp1 = Math.cos(dalp1);
            const nsalp1 = salp1 * cdalp1 + calp1 * sdalp1;
            if (nsalp1 > 0) {
              calp1 = calp1 * cdalp1 - salp1 * sdalp1;
              salp1 = nsalp1;
              const tt = Math.hypot(salp1, calp1);
              salp1 /= tt;
              calp1 /= tt;
              tripn = Math.abs(v) <= 16 * TOL0;
              continue;
            }
          }
        }
        salp1 = (salp1a + salp1b) / 2;
        calp1 = (calp1a + calp1b) / 2;
        const tt = Math.hypot(salp1, calp1);
        salp1 /= tt;
        calp1 /= tt;
        tripn = false;
        tripb =
          Math.abs(salp1a - salp1) + (calp1a - calp1) < TOLB ||
          Math.abs(salp1 - salp1b) + (calp1 - calp1b) < TOLB;
      }
      salp2 = r.salp2;
      calp2 = r.calp2;
      const L = lengths(
        r.eps,
        r.sig12,
        r.ssig1,
        r.csig1,
        dn1,
        r.ssig2,
        r.csig2,
        dn2,
        true,
        C1a,
        C2a
      );
      s12x = L.s12b * b;
    }
  }

  if (swapp < 0) {
    [salp2, salp1] = [salp1, salp2];
    [calp2, calp1] = [calp1, calp2];
  }
  salp1 *= swapp * lonsign;
  calp1 *= swapp * latsign;
  salp2 *= swapp * lonsign;
  calp2 *= swapp * latsign;

  return {
    s12: 0 + s12x,
    azi1: atan2d(salp1, calp1),
    azi2: atan2d(salp2, calp2),
  };
}

/**
 * Direct geodesic problem on WGS84: the point s12 metres from (lat1, lon1)
 * along azimuth azi1 (degrees), and the forward azimuth there.
 */
export function geodesicDirect(
  lat1: number,
  lon1: number,
  azi1: number,
  s12: number
): { lat2: number; lon2: number; azi2: number } {
  lat1 = latFix(lat1);
  azi1 = angNormalize(azi1);
  let t = sincosd(angRound(azi1));
  const salp1 = t.s;
  const calp1 = t.c;
  t = sincosd(angRound(lat1));
  let sbet1 = f1 * t.s;
  let cbet1 = t.c;
  const h = Math.hypot(sbet1, cbet1);
  sbet1 /= h;
  cbet1 /= h;
  cbet1 = Math.max(TINY, cbet1);

  const salp0 = salp1 * cbet1;
  const calp0 = Math.hypot(calp1, salp1 * sbet1);
  let ssig1 = sbet1;
  const somg1 = salp0 * sbet1;
  let csig1 = sbet1 !== 0 || calp1 !== 0 ? cbet1 * calp1 : 1;
  const comg1 = csig1;
  const hs = Math.hypot(ssig1, csig1);
  ssig1 /= hs;
  csig1 /= hs;

  const k2 = sq(calp0) * ep2;
  const eps = k2 / (2 * (1 + Math.sqrt(1 + k2)) + k2);
  const A1m1 = A1m1f(eps);
  const C1a = new Array<number>(nC1 + 1).fill(0);
  C1f(eps, C1a);
  const B11 = sinCosSeries(true, ssig1, csig1, C1a);
  let s = Math.sin(B11);
  let c = Math.cos(B11);
  const stau1 = ssig1 * c + csig1 * s;
  const ctau1 = csig1 * c - ssig1 * s;
  const C1pa = new Array<number>(nC1p + 1).fill(0);
  C1pf(eps, C1pa);
  const C3a = new Array<number>(nC3).fill(0);
  C3f(eps, C3a);
  const A3c = -f * salp0 * A3f(eps);
  const B31 = sinCosSeries(true, ssig1, csig1, C3a);

  const tau12 = s12 / (b * (1 + A1m1));
  s = Math.sin(tau12);
  c = Math.cos(tau12);
  const B12 = -sinCosSeries(
    true,
    stau1 * c + ctau1 * s,
    ctau1 * c - stau1 * s,
    C1pa
  );
  const sig12 = tau12 - (B12 - B11);
  const ssig12 = Math.sin(sig12);
  const csig12 = Math.cos(sig12);
  const ssig2 = ssig1 * csig12 + csig1 * ssig12;
  let csig2 = csig1 * csig12 - ssig1 * ssig12;
  const sbet2 = calp0 * ssig2;
  let cbet2 = Math.hypot(salp0, calp0 * csig2);
  if (cbet2 === 0) cbet2 = csig2 = TINY;
  const salp2 = salp0;
  const calp2 = calp0 * csig2;
  const somg2 = salp0 * ssig2;
  const comg2 = csig2;
  const omg12 = Math.atan2(
    somg2 * comg1 - comg2 * somg1,
    comg2 * comg1 + somg2 * somg1
  );
  const lam12 =
    omg12 + A3c * (sig12 + (sinCosSeries(true, ssig2, csig2, C3a) - B31));
  const lon12 = lam12 / DEGREE;
  return {
    lat2: atan2d(sbet2, f1 * cbet2),
    lon2: angNormalize(angNormalize(lon1) + angNormalize(lon12)),
    azi2: atan2d(salp2, calp2),
  };
}
