/**
 * SGP4/SDP4 orbit propagation for NORAD general-perturbation element sets
 * (TLE / OMM).
 *
 * A TypeScript port of the reference implementation in Vallado, Crawford,
 * Hujsak & Kelso, "Revisiting Spacetrack Report #3" (AIAA 2006-6753),
 * as revised through 2020: near-Earth SGP4 plus the deep-space SDP4
 * branch (lunar–solar periodics, 12 h and 24 h resonances). Every GNSS
 * satellite — MEO, IGSO and GEO — takes the deep-space branch.
 *
 * Validated against the report's verification set (SGP4-VER.TLE /
 * tcppver.out) in test/orbit-sgp4.test.ts.
 *
 * Positions come out in the TEME frame (km, km/s). Use `temeToEcef` (or
 * `tlePositionEcef`, which also does the time-scale bookkeeping) for
 * Earth-fixed coordinates.
 */

const TWO_PI = 2 * Math.PI;
const DEG2RAD = Math.PI / 180;
const X2O3 = 2 / 3;

/** Gravity model constants. SGP4 element sets are fitted with WGS-72. */
export interface Sgp4Gravity {
  /** km³/s² */
  mu: number;
  /** Earth equatorial radius, km */
  radiusEarthKm: number;
  /** sqrt(GM) in Earth radii^1.5 / min */
  xke: number;
  /** minutes per time unit */
  tumin: number;
  j2: number;
  j3: number;
  j4: number;
  j3oj2: number;
}

function gravity(
  mu: number,
  re: number,
  j2: number,
  j3: number,
  j4: number
): Sgp4Gravity {
  const xke = 60 / Math.sqrt((re * re * re) / mu);
  return {
    mu,
    radiusEarthKm: re,
    xke,
    tumin: 1 / xke,
    j2,
    j3,
    j4,
    j3oj2: j3 / j2,
  };
}

/** WGS-72 — the model element sets are produced with; use this. */
export const WGS72 = gravity(
  398600.8,
  6378.135,
  0.001082616,
  -0.00000253881,
  -0.00000165597
);
/** WGS-84 constants, for experiments only. */
export const WGS84_SGP4 = gravity(
  398600.5,
  6378.137,
  0.00108262998905,
  -0.00000253215306,
  -0.00000161098761
);

/** Mean elements of a general-perturbation set, in TLE units. */
export interface GpElements {
  /** NORAD catalogue number. */
  norad: number;
  /** Object name, when known (3-line TLE or OMM). */
  name?: string;
  /** International designator, e.g. "2000-040A" (OMM) or "00040A" (TLE). */
  intlDesignator?: string;
  /** Element epoch, Julian date (UTC), whole part. */
  epochJd: number;
  /** Fractional part of the epoch Julian date. */
  epochJdFrac: number;
  /** Mean motion, revolutions per day (Kozai). */
  meanMotion: number;
  eccentricity: number;
  /** Degrees. */
  inclination: number;
  /** Right ascension of the ascending node, degrees. */
  raan: number;
  /** Argument of perigee, degrees. */
  argPerigee: number;
  /** Mean anomaly, degrees. */
  meanAnomaly: number;
  /** Drag term, 1/Earth radii. */
  bstar: number;
  /** First derivative of mean motion / 2, rev/day². Informational. */
  meanMotionDot: number;
  /** Second derivative of mean motion / 6, rev/day³. Informational. */
  meanMotionDdot: number;
  /** Element set number, revolution number at epoch, classification. */
  elementSetNo?: number;
  revAtEpoch?: number;
  classification?: string;
}

/** Errors reported by the propagator (Vallado's codes). */
export const SGP4_ERRORS: Record<number, string> = {
  1: 'mean eccentricity out of range',
  2: 'mean motion below zero',
  3: 'perturbed eccentricity out of range',
  4: 'semi-latus rectum below zero',
  6: 'satellite has decayed',
};

export interface Sgp4Result {
  /** TEME position, km. */
  r: [number, number, number];
  /** TEME velocity, km/s. */
  v: [number, number, number];
  /** 0 = ok; 6 = decayed (position still returned). See SGP4_ERRORS. */
  error: number;
}

/**
 * Initialized propagator state. Opaque: build with `sgp4Init`, pass to
 * `sgp4`. The fields mirror Vallado's `elsetrec`.
 */
export interface Sgp4Satrec {
  readonly norad: number;
  readonly gravity: Sgp4Gravity;
  readonly opsmode: 'a' | 'i';
  /** Epoch, Julian date (UTC), whole + fraction. */
  readonly jdsatepoch: number;
  readonly jdsatepochF: number;
  /** 'n' near-Earth, 'd' deep space. */
  method: 'n' | 'd';
  error: number;
  /** Semi-major axis (Earth radii), apogee/perigee altitude (Earth radii). */
  a: number;
  alta: number;
  altp: number;
  /** Un-Kozai'd mean motion, rad/min. */
  no: number;
  /** Internal state. */
  s: Record<string, number>;
}

/* ------------------------------------------------------------------ */
/*  Time                                                               */
/* ------------------------------------------------------------------ */

/** Julian date of a calendar instant (UTC), split into whole and fraction. */
export function julianDate(
  year: number,
  mon: number,
  day: number,
  hr: number,
  minute: number,
  sec: number
): { jd: number; jdFrac: number } {
  const jd =
    367 * year -
    Math.floor((7 * (year + Math.floor((mon + 9) / 12))) / 4) +
    Math.floor((275 * mon) / 9) +
    day +
    1721013.5;
  let jdFrac = (sec + minute * 60 + hr * 3600) / 86400;
  let whole = jd;
  if (Math.abs(jdFrac) >= 1) {
    const d = Math.floor(jdFrac);
    whole += d;
    jdFrac -= d;
  }
  return { jd: whole, jdFrac };
}

/** Julian date (UTC) of a Unix-millisecond UTC instant. */
export function jdFromUnixMs(ms: number): number {
  return ms / 86400000 + 2440587.5;
}

/**
 * Greenwich mean sidereal time, IAU-1982 (radians, 0–2π). This is the
 * angle SGP4's TEME frame is defined against.
 * @param jdut1 Julian date, UT1 (UTC is fine at the SGP4 accuracy level)
 */
export function gstime(jdut1: number): number {
  const tut1 = (jdut1 - 2451545.0) / 36525.0;
  let temp =
    -6.2e-6 * tut1 * tut1 * tut1 +
    0.093104 * tut1 * tut1 +
    (876600.0 * 3600 + 8640184.812866) * tut1 +
    67310.54841;
  temp = ((temp * DEG2RAD) / 240.0) % TWO_PI;
  if (temp < 0) temp += TWO_PI;
  return temp;
}

/* ------------------------------------------------------------------ */
/*  Deep-space helpers                                                 */
/* ------------------------------------------------------------------ */

type S = Record<string, number>;

/** Lunar–solar terms common to init and propagation (Vallado dscom). */
function dscom(
  epoch: number,
  ep: number,
  argpp: number,
  tc: number,
  inclp: number,
  nodep: number,
  np: number
): S {
  const zes = 0.01675;
  const zel = 0.0549;
  const c1ss = 2.9864797e-6;
  const c1l = 4.7968065e-7;
  const zsinis = 0.39785416;
  const zcosis = 0.91744867;
  const zcosgs = 0.1945905;
  const zsings = -0.98088458;

  const nm = np;
  const em = ep;
  const snodm = Math.sin(nodep);
  const cnodm = Math.cos(nodep);
  const sinomm = Math.sin(argpp);
  const cosomm = Math.cos(argpp);
  const sinim = Math.sin(inclp);
  const cosim = Math.cos(inclp);
  const emsq = em * em;
  const betasq = 1 - emsq;
  const rtemsq = Math.sqrt(betasq);

  const peo = 0;
  const pinco = 0;
  const plo = 0;
  const pgho = 0;
  const pho = 0;
  const day = epoch + 18261.5 + tc / 1440.0;
  const xnodce = (4.523602 - 9.2422029e-4 * day) % TWO_PI;
  const stem = Math.sin(xnodce);
  const ctem = Math.cos(xnodce);
  const zcosil = 0.91375164 - 0.03568096 * ctem;
  const zsinil = Math.sqrt(1 - zcosil * zcosil);
  const zsinhl = (0.089683511 * stem) / zsinil;
  const zcoshl = Math.sqrt(1 - zsinhl * zsinhl);
  const gam = 5.8351514 + 0.001944368 * day;
  let zx = (0.39785416 * stem) / zsinil;
  const zy = zcoshl * ctem + 0.91744867 * zsinhl * stem;
  zx = Math.atan2(zx, zy);
  zx = gam + zx - xnodce;
  const zcosgl = Math.cos(zx);
  const zsingl = Math.sin(zx);

  let zcosg = zcosgs;
  let zsing = zsings;
  let zcosi = zcosis;
  let zsini = zsinis;
  let zcosh = cnodm;
  let zsinh = snodm;
  let cc = c1ss;
  const xnoi = 1 / nm;

  let ss1 = 0,
    ss2 = 0,
    ss3 = 0,
    ss4 = 0,
    ss5 = 0,
    ss6 = 0,
    ss7 = 0;
  let sz1 = 0,
    sz2 = 0,
    sz3 = 0,
    sz11 = 0,
    sz12 = 0,
    sz13 = 0,
    sz21 = 0,
    sz22 = 0,
    sz23 = 0,
    sz31 = 0,
    sz32 = 0,
    sz33 = 0;
  let s1 = 0,
    s2 = 0,
    s3 = 0,
    s4 = 0,
    s5 = 0,
    s6 = 0,
    s7 = 0;
  let z1 = 0,
    z2 = 0,
    z3 = 0,
    z11 = 0,
    z12 = 0,
    z13 = 0,
    z21 = 0,
    z22 = 0,
    z23 = 0,
    z31 = 0,
    z32 = 0,
    z33 = 0;

  for (let lsflg = 1; lsflg <= 2; lsflg++) {
    const a1 = zcosg * zcosh + zsing * zcosi * zsinh;
    const a3 = -zsing * zcosh + zcosg * zcosi * zsinh;
    const a7 = -zcosg * zsinh + zsing * zcosi * zcosh;
    const a8 = zsing * zsini;
    const a9 = zsing * zsinh + zcosg * zcosi * zcosh;
    const a10 = zcosg * zsini;
    const a2 = cosim * a7 + sinim * a8;
    const a4 = cosim * a9 + sinim * a10;
    const a5 = -sinim * a7 + cosim * a8;
    const a6 = -sinim * a9 + cosim * a10;

    const x1 = a1 * cosomm + a2 * sinomm;
    const x2 = a3 * cosomm + a4 * sinomm;
    const x3 = -a1 * sinomm + a2 * cosomm;
    const x4 = -a3 * sinomm + a4 * cosomm;
    const x5 = a5 * sinomm;
    const x6 = a6 * sinomm;
    const x7 = a5 * cosomm;
    const x8 = a6 * cosomm;

    z31 = 12 * x1 * x1 - 3 * x3 * x3;
    z32 = 24 * x1 * x2 - 6 * x3 * x4;
    z33 = 12 * x2 * x2 - 3 * x4 * x4;
    z1 = 3 * (a1 * a1 + a2 * a2) + z31 * emsq;
    z2 = 6 * (a1 * a3 + a2 * a4) + z32 * emsq;
    z3 = 3 * (a3 * a3 + a4 * a4) + z33 * emsq;
    z11 = -6 * a1 * a5 + emsq * (-24 * x1 * x7 - 6 * x3 * x5);
    z12 =
      -6 * (a1 * a6 + a3 * a5) +
      emsq * (-24 * (x2 * x7 + x1 * x8) + -6 * (x3 * x6 + x4 * x5));
    z13 = -6 * a3 * a6 + emsq * (-24 * x2 * x8 - 6 * x4 * x6);
    z21 = 6 * a2 * a5 + emsq * (24 * x1 * x5 - 6 * x3 * x7);
    z22 =
      6 * (a4 * a5 + a2 * a6) +
      emsq * (24 * (x2 * x5 + x1 * x6) - 6 * (x4 * x7 + x3 * x8));
    z23 = 6 * a4 * a6 + emsq * (24 * x2 * x6 - 6 * x4 * x8);
    z1 = z1 + z1 + betasq * z31;
    z2 = z2 + z2 + betasq * z32;
    z3 = z3 + z3 + betasq * z33;
    s3 = cc * xnoi;
    s2 = (-0.5 * s3) / rtemsq;
    s4 = s3 * rtemsq;
    s1 = -15 * em * s4;
    s5 = x1 * x3 + x2 * x4;
    s6 = x2 * x3 + x1 * x4;
    s7 = x2 * x4 - x1 * x3;

    if (lsflg === 1) {
      ss1 = s1;
      ss2 = s2;
      ss3 = s3;
      ss4 = s4;
      ss5 = s5;
      ss6 = s6;
      ss7 = s7;
      sz1 = z1;
      sz2 = z2;
      sz3 = z3;
      sz11 = z11;
      sz12 = z12;
      sz13 = z13;
      sz21 = z21;
      sz22 = z22;
      sz23 = z23;
      sz31 = z31;
      sz32 = z32;
      sz33 = z33;
      zcosg = zcosgl;
      zsing = zsingl;
      zcosi = zcosil;
      zsini = zsinil;
      zcosh = zcoshl * cnodm + zsinhl * snodm;
      zsinh = snodm * zcoshl - cnodm * zsinhl;
      cc = c1l;
    }
  }

  const zmol = (4.7199672 + (0.2299715 * day - gam)) % TWO_PI;
  const zmos = (6.2565837 + 0.017201977 * day) % TWO_PI;

  return {
    snodm,
    cnodm,
    sinim,
    cosim,
    sinomm,
    cosomm,
    day,
    em,
    emsq,
    gam,
    rtemsq,
    nm,
    peo,
    pinco,
    plo,
    pgho,
    pho,
    s1,
    s2,
    s3,
    s4,
    s5,
    s6,
    s7,
    ss1,
    ss2,
    ss3,
    ss4,
    ss5,
    ss6,
    ss7,
    sz1,
    sz2,
    sz3,
    sz11,
    sz12,
    sz13,
    sz21,
    sz22,
    sz23,
    sz31,
    sz32,
    sz33,
    z1,
    z2,
    z3,
    z11,
    z12,
    z13,
    z21,
    z22,
    z23,
    z31,
    z32,
    z33,
    zmol,
    zmos,
    // solar terms
    se2: 2 * ss1 * ss6,
    se3: 2 * ss1 * ss7,
    si2: 2 * ss2 * sz12,
    si3: 2 * ss2 * (sz13 - sz11),
    sl2: -2 * ss3 * sz2,
    sl3: -2 * ss3 * (sz3 - sz1),
    sl4: -2 * ss3 * (-21 - 9 * emsq) * zes,
    sgh2: 2 * ss4 * sz32,
    sgh3: 2 * ss4 * (sz33 - sz31),
    sgh4: -18 * ss4 * zes,
    sh2: -2 * ss2 * sz22,
    sh3: -2 * ss2 * (sz23 - sz21),
    // lunar terms
    ee2: 2 * s1 * s6,
    e3: 2 * s1 * s7,
    xi2: 2 * s2 * z12,
    xi3: 2 * s2 * (z13 - z11),
    xl2: -2 * s3 * z2,
    xl3: -2 * s3 * (z3 - z1),
    xl4: -2 * s3 * (-21 - 9 * emsq) * zel,
    xgh2: 2 * s4 * z32,
    xgh3: 2 * s4 * (z33 - z31),
    xgh4: -18 * s4 * zel,
    xh2: -2 * s2 * z22,
    xh3: -2 * s2 * (z23 - z21),
  };
}

interface Angles {
  ep: number;
  inclp: number;
  nodep: number;
  argpp: number;
  mp: number;
}

/** Lunar–solar long-period periodics (Vallado dpper). */
function dpper(
  s: S,
  t: number,
  init: boolean,
  opsmode: 'a' | 'i',
  a: Angles
): Angles {
  const zns = 1.19459e-5;
  const zes = 0.01675;
  const znl = 1.5835218e-4;
  const zel = 0.0549;

  let zm = init ? s.zmos! : s.zmos! + zns * t;
  let zf = zm + 2 * zes * Math.sin(zm);
  let sinzf = Math.sin(zf);
  let f2 = 0.5 * sinzf * sinzf - 0.25;
  let f3 = -0.5 * sinzf * Math.cos(zf);
  const ses = s.se2! * f2 + s.se3! * f3;
  const sis = s.si2! * f2 + s.si3! * f3;
  const sls = s.sl2! * f2 + s.sl3! * f3 + s.sl4! * sinzf;
  const sghs = s.sgh2! * f2 + s.sgh3! * f3 + s.sgh4! * sinzf;
  const shs = s.sh2! * f2 + s.sh3! * f3;

  zm = init ? s.zmol! : s.zmol! + znl * t;
  zf = zm + 2 * zel * Math.sin(zm);
  sinzf = Math.sin(zf);
  f2 = 0.5 * sinzf * sinzf - 0.25;
  f3 = -0.5 * sinzf * Math.cos(zf);
  const sel = s.ee2! * f2 + s.e3! * f3;
  const sil = s.xi2! * f2 + s.xi3! * f3;
  const sll = s.xl2! * f2 + s.xl3! * f3 + s.xl4! * sinzf;
  const sghl = s.xgh2! * f2 + s.xgh3! * f3 + s.xgh4! * sinzf;
  const shll = s.xh2! * f2 + s.xh3! * f3;

  let pe = ses + sel;
  let pinc = sis + sil;
  let pl = sls + sll;
  let pgh = sghs + sghl;
  let ph = shs + shll;

  let { ep, inclp, nodep, argpp, mp } = a;
  if (!init) {
    pe -= s.peo!;
    pinc -= s.pinco!;
    pl -= s.plo!;
    pgh -= s.pgho!;
    ph -= s.pho!;
    inclp += pinc;
    ep += pe;
    const sinip = Math.sin(inclp);
    const cosip = Math.cos(inclp);

    // Lyddane modification for low inclinations
    if (inclp >= 0.2) {
      ph /= sinip;
      pgh -= cosip * ph;
      argpp += pgh;
      nodep += ph;
      mp += pl;
    } else {
      const sinop = Math.sin(nodep);
      const cosop = Math.cos(nodep);
      let alfdp = sinip * sinop;
      let betdp = sinip * cosop;
      const dalf = ph * cosop + pinc * cosip * sinop;
      const dbet = -ph * sinop + pinc * cosip * cosop;
      alfdp += dalf;
      betdp += dbet;
      nodep %= TWO_PI;
      if (nodep < 0 && opsmode === 'a') nodep += TWO_PI;
      let xls = mp + argpp + cosip * nodep;
      const dls = pl + pgh - pinc * nodep * sinip;
      xls += dls;
      const xnoh = nodep;
      nodep = Math.atan2(alfdp, betdp);
      if (nodep < 0 && opsmode === 'a') nodep += TWO_PI;
      if (Math.abs(xnoh - nodep) > Math.PI) {
        if (nodep < xnoh) nodep += TWO_PI;
        else nodep -= TWO_PI;
      }
      mp += pl;
      argpp = xls - mp - cosip * nodep;
    }
  }
  return { ep, inclp, nodep, argpp, mp };
}

/** Deep-space secular and resonance initialisation (Vallado dsinit). */
function dsinit(
  s: S,
  xke: number,
  d: S,
  t: number,
  tc: number,
  gsto: number,
  mo: number,
  mdot: number,
  no: number,
  nodeo: number,
  nodedot: number,
  xpidot: number,
  argpo: number,
  ecco: number,
  eccsq: number,
  inclm0: number
): {
  em: number;
  argpm: number;
  inclm: number;
  mm: number;
  nm: number;
  nodem: number;
} {
  const q22 = 1.7891679e-6;
  const q31 = 2.1460748e-6;
  const q33 = 2.2123015e-7;
  const root22 = 1.7891679e-6;
  const root44 = 7.3636953e-9;
  const root54 = 2.1765803e-9;
  // eslint-disable-next-line no-loss-of-precision -- Vallado's literal, verbatim
  const rptim = 4.37526908801129966e-3;
  const root32 = 3.7393792e-7;
  const root52 = 1.1428639e-7;
  const znl = 1.5835218e-4;
  const zns = 1.19459e-5;

  const { cosim, sinim } = d as { cosim: number; sinim: number };
  let em = d.em!;
  let emsq = d.emsq!;
  let nm = d.nm!;
  let inclm = inclm0;
  let argpm = 0;
  let nodem = 0;
  let mm = 0;

  let irez = 0;
  if (nm < 0.0052359877 && nm > 0.0034906585) irez = 1;
  if (nm >= 8.26e-3 && nm <= 9.24e-3 && em >= 0.5) irez = 2;

  // solar terms
  const ses = d.ss1! * zns * d.ss5!;
  const sis = d.ss2! * zns * (d.sz11! + d.sz13!);
  const sls = -zns * d.ss3! * (d.sz1! + d.sz3! - 14 - 6 * emsq);
  const sghs = d.ss4! * zns * (d.sz31! + d.sz33! - 6);
  let shs = -zns * d.ss2! * (d.sz21! + d.sz23!);
  if (inclm < 5.2359877e-2 || inclm > Math.PI - 5.2359877e-2) shs = 0;
  if (sinim !== 0) shs /= sinim;
  const sgs = sghs - cosim * shs;

  // lunar terms
  const dedt = ses + d.s1! * znl * d.s5!;
  const didt = sis + d.s2! * znl * (d.z11! + d.z13!);
  const dmdt = sls - znl * d.s3! * (d.z1! + d.z3! - 14 - 6 * emsq);
  const sghl = d.s4! * znl * (d.z31! + d.z33! - 6);
  let shll = -znl * d.s2! * (d.z21! + d.z23!);
  if (inclm < 5.2359877e-2 || inclm > Math.PI - 5.2359877e-2) shll = 0;
  let domdt = sgs + sghl;
  let dnodt = shs;
  if (sinim !== 0) {
    domdt -= (cosim / sinim) * shll;
    dnodt += shll / sinim;
  }

  // deep-space resonance effects
  const dndt = 0;
  const theta = (gsto + tc * rptim) % TWO_PI;
  em += dedt * t;
  inclm += didt * t;
  argpm += domdt * t;
  nodem += dnodt * t;
  mm += dmdt * t;

  s.irez = irez;
  s.dedt = dedt;
  s.didt = didt;
  s.dmdt = dmdt;
  s.domdt = domdt;
  s.dnodt = dnodt;
  for (const k of [
    'd2201',
    'd2211',
    'd3210',
    'd3222',
    'd4410',
    'd4422',
    'd5220',
    'd5232',
    'd5421',
    'd5433',
    'del1',
    'del2',
    'del3',
    'xfact',
    'xlamo',
    'xli',
    'xni',
    'atime',
  ])
    s[k] = 0;

  if (irez !== 0) {
    const aonv = Math.pow(nm / xke, X2O3);

    // geopotential resonance for 12-hour orbits
    if (irez === 2) {
      const cosisq = cosim * cosim;
      const emo = em;
      em = ecco;
      const emsqo = emsq;
      emsq = eccsq;
      const eoc = em * emsq;
      const g201 = -0.306 - (em - 0.64) * 0.44;
      let g211, g310, g322, g410, g422, g520;
      if (em <= 0.65) {
        g211 = 3.616 - 13.247 * em + 16.29 * emsq;
        g310 = -19.302 + 117.39 * em - 228.419 * emsq + 156.591 * eoc;
        g322 = -18.9068 + 109.7927 * em - 214.6334 * emsq + 146.5816 * eoc;
        g410 = -41.122 + 242.694 * em - 471.094 * emsq + 313.953 * eoc;
        g422 = -146.407 + 841.88 * em - 1629.014 * emsq + 1083.435 * eoc;
        g520 = -532.114 + 3017.977 * em - 5740.032 * emsq + 3708.276 * eoc;
      } else {
        g211 = -72.099 + 331.819 * em - 508.738 * emsq + 266.724 * eoc;
        g310 = -346.844 + 1582.851 * em - 2415.925 * emsq + 1246.113 * eoc;
        g322 = -342.585 + 1554.908 * em - 2366.899 * emsq + 1215.972 * eoc;
        g410 = -1052.797 + 4758.686 * em - 7193.992 * emsq + 3651.957 * eoc;
        g422 = -3581.69 + 16178.11 * em - 24462.77 * emsq + 12422.52 * eoc;
        if (em > 0.715)
          g520 = -5149.66 + 29936.92 * em - 54087.36 * emsq + 31324.56 * eoc;
        else g520 = 1464.74 - 4664.75 * em + 3763.64 * emsq;
      }
      let g533, g521, g532;
      if (em < 0.7) {
        g533 = -919.2277 + 4988.61 * em - 9064.77 * emsq + 5542.21 * eoc;
        g521 = -822.71072 + 4568.6173 * em - 8491.4146 * emsq + 5337.524 * eoc;
        g532 = -853.666 + 4690.25 * em - 8624.77 * emsq + 5341.4 * eoc;
      } else {
        g533 = -37995.78 + 161616.52 * em - 229838.2 * emsq + 109377.94 * eoc;
        g521 = -51752.104 + 218913.95 * em - 309468.16 * emsq + 146349.42 * eoc;
        g532 = -40023.88 + 170470.89 * em - 242699.48 * emsq + 115605.82 * eoc;
      }

      const sini2 = sinim * sinim;
      const f220 = 0.75 * (1 + 2 * cosim + cosisq);
      const f221 = 1.5 * sini2;
      const f321 = 1.875 * sinim * (1 - 2 * cosim - 3 * cosisq);
      const f322 = -1.875 * sinim * (1 + 2 * cosim - 3 * cosisq);
      const f441 = 35 * sini2 * f220;
      const f442 = 39.375 * sini2 * sini2;
      const f522 =
        9.84375 *
        sinim *
        (sini2 * (1 - 2 * cosim - 5 * cosisq) +
          0.33333333 * (-2 + 4 * cosim + 6 * cosisq));
      const f523 =
        sinim *
        (4.92187512 * sini2 * (-2 - 4 * cosim + 10 * cosisq) +
          6.56250012 * (1 + 2 * cosim - 3 * cosisq));
      const f542 =
        29.53125 *
        sinim *
        (2 - 8 * cosim + cosisq * (-12 + 8 * cosim + 10 * cosisq));
      const f543 =
        29.53125 *
        sinim *
        (-2 - 8 * cosim + cosisq * (12 + 8 * cosim - 10 * cosisq));
      const xno2 = nm * nm;
      const ainv2 = aonv * aonv;
      let temp1 = 3 * xno2 * ainv2;
      let temp = temp1 * root22;
      s.d2201 = temp * f220 * g201;
      s.d2211 = temp * f221 * g211;
      temp1 *= aonv;
      temp = temp1 * root32;
      s.d3210 = temp * f321 * g310;
      s.d3222 = temp * f322 * g322;
      temp1 *= aonv;
      temp = 2 * temp1 * root44;
      s.d4410 = temp * f441 * g410;
      s.d4422 = temp * f442 * g422;
      temp1 *= aonv;
      temp = temp1 * root52;
      s.d5220 = temp * f522 * g520;
      s.d5232 = temp * f523 * g532;
      temp = 2 * temp1 * root54;
      s.d5421 = temp * f542 * g521;
      s.d5433 = temp * f543 * g533;
      s.xlamo = (mo + nodeo + nodeo - (theta + theta)) % TWO_PI;
      s.xfact = mdot + dmdt + 2 * (nodedot + dnodt - rptim) - no;
      em = emo;
      emsq = emsqo;
    }

    // synchronous resonance terms
    if (irez === 1) {
      const g200 = 1 + emsq * (-2.5 + 0.8125 * emsq);
      const g310 = 1 + 2 * emsq;
      const g300 = 1 + emsq * (-6 + 6.60937 * emsq);
      const f220 = 0.75 * (1 + cosim) * (1 + cosim);
      const f311 =
        0.9375 * sinim * sinim * (1 + 3 * cosim) - 0.75 * (1 + cosim);
      let f330 = 1 + cosim;
      f330 = 1.875 * f330 * f330 * f330;
      const del1 = 3 * nm * nm * aonv * aonv;
      s.del2 = 2 * del1 * f220 * g200 * q22;
      s.del3 = 3 * del1 * f330 * g300 * q33 * aonv;
      s.del1 = del1 * f311 * g310 * q31 * aonv;
      s.xlamo = (mo + nodeo + argpo - theta) % TWO_PI;
      s.xfact = mdot + xpidot - rptim + dmdt + domdt + dnodt - no;
    }

    s.xli = s.xlamo!;
    s.xni = no;
    s.atime = 0;
    nm = no + dndt;
  }

  return { em, argpm, inclm, mm, nm, nodem };
}

/** Deep-space secular effects and resonance integration (Vallado dspace). */
function dspace(
  s: S,
  t: number,
  tc: number,
  em0: number,
  argpm0: number,
  inclm0: number,
  mm0: number,
  nodem0: number
): {
  em: number;
  argpm: number;
  inclm: number;
  mm: number;
  nodem: number;
  nm: number;
} {
  const fasx2 = 0.13130908;
  const fasx4 = 2.8843198;
  const fasx6 = 0.37448087;
  const g22 = 5.7686396;
  const g32 = 0.95240898;
  const g44 = 1.8014998;
  const g52 = 1.050833;
  const g54 = 4.4108898;
  // eslint-disable-next-line no-loss-of-precision -- Vallado's literal, verbatim
  const rptim = 4.37526908801129966e-3;
  const stepp = 720.0;
  const stepn = -720.0;
  const step2 = 259200.0;

  const no = s.no!;
  const theta = (s.gsto! + tc * rptim) % TWO_PI;
  const em = em0 + s.dedt! * t;
  const inclm = inclm0 + s.didt! * t;
  const argpm = argpm0 + s.domdt! * t;
  const nodem = nodem0 + s.dnodt! * t;
  let mm = mm0 + s.dmdt! * t;
  let nm = no;

  if (s.irez !== 0) {
    if (
      s.atime === 0 ||
      t * s.atime! <= 0 ||
      Math.abs(t) < Math.abs(s.atime!)
    ) {
      s.atime = 0;
      s.xni = no;
      s.xli = s.xlamo!;
    }
    const delt = t > 0 ? stepp : stepn;

    let xndt: number;
    let xldot: number;
    let xnddt: number;
    let ft: number;
    for (;;) {
      const xli = s.xli!;
      if (s.irez !== 2) {
        // near-synchronous resonance
        xndt =
          s.del1! * Math.sin(xli - fasx2) +
          s.del2! * Math.sin(2 * (xli - fasx4)) +
          s.del3! * Math.sin(3 * (xli - fasx6));
        xldot = s.xni! + s.xfact!;
        xnddt =
          s.del1! * Math.cos(xli - fasx2) +
          2 * s.del2! * Math.cos(2 * (xli - fasx4)) +
          3 * s.del3! * Math.cos(3 * (xli - fasx6));
        xnddt *= xldot;
      } else {
        // near half-day resonance
        const xomi = s.argpo! + s.argpdot! * s.atime!;
        const x2omi = xomi + xomi;
        const x2li = xli + xli;
        xndt =
          s.d2201! * Math.sin(x2omi + xli - g22) +
          s.d2211! * Math.sin(xli - g22) +
          s.d3210! * Math.sin(xomi + xli - g32) +
          s.d3222! * Math.sin(-xomi + xli - g32) +
          s.d4410! * Math.sin(x2omi + x2li - g44) +
          s.d4422! * Math.sin(x2li - g44) +
          s.d5220! * Math.sin(xomi + xli - g52) +
          s.d5232! * Math.sin(-xomi + xli - g52) +
          s.d5421! * Math.sin(xomi + x2li - g54) +
          s.d5433! * Math.sin(-xomi + x2li - g54);
        xldot = s.xni! + s.xfact!;
        xnddt =
          s.d2201! * Math.cos(x2omi + xli - g22) +
          s.d2211! * Math.cos(xli - g22) +
          s.d3210! * Math.cos(xomi + xli - g32) +
          s.d3222! * Math.cos(-xomi + xli - g32) +
          s.d5220! * Math.cos(xomi + xli - g52) +
          s.d5232! * Math.cos(-xomi + xli - g52) +
          2 *
            (s.d4410! * Math.cos(x2omi + x2li - g44) +
              s.d4422! * Math.cos(x2li - g44) +
              s.d5421! * Math.cos(xomi + x2li - g54) +
              s.d5433! * Math.cos(-xomi + x2li - g54));
        xnddt *= xldot;
      }

      if (Math.abs(t - s.atime!) < stepp) {
        ft = t - s.atime!;
        break;
      }
      s.xli = xli + xldot * delt + xndt * step2;
      s.xni = s.xni! + xndt * delt + xnddt * step2;
      s.atime = s.atime! + delt;
    }

    nm = s.xni! + xndt * ft + xnddt * ft * ft * 0.5;
    const xl = s.xli! + xldot * ft + xndt * ft * ft * 0.5;
    if (s.irez !== 1) {
      mm = xl - 2 * nodem + 2 * theta;
    } else {
      mm = xl - nodem - argpm + theta;
    }
    const dndt = nm - no;
    nm = no + dndt;
  }

  return { em, argpm, inclm, mm, nodem, nm };
}

/* ------------------------------------------------------------------ */
/*  Initialisation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Initialise the propagator from a GP element set.
 * @param el Mean elements (TLE units: degrees, rev/day)
 * @param opts.gravity Gravity constants (default WGS-72, as the sets are fitted)
 * @param opts.opsmode 'i' improved (default) or 'a' the historical AFSPC mode
 */
export function sgp4Init(
  el: GpElements,
  opts: { gravity?: Sgp4Gravity; opsmode?: 'a' | 'i' } = {}
): Sgp4Satrec {
  const grav = opts.gravity ?? WGS72;
  const opsmode = opts.opsmode ?? 'i';
  const { xke, j2, j3oj2, j4, radiusEarthKm, tumin } = grav;
  const xpdotp = 1440.0 / TWO_PI;

  const ecco = el.eccentricity;
  const inclo = el.inclination * DEG2RAD;
  const nodeo = el.raan * DEG2RAD;
  const argpo = el.argPerigee * DEG2RAD;
  const mo = el.meanAnomaly * DEG2RAD;
  const noKozai = el.meanMotion / xpdotp; // rad/min
  const bstar = el.bstar;
  // days since 1949 Dec 31 00:00 UT
  const epoch = el.epochJd + el.epochJdFrac - 2433281.5;

  const s: S = {
    bstar,
    ecco,
    inclo,
    nodeo,
    argpo,
    mo,
    isimp: 0,
    aycof: 0,
    con41: 0,
    cc1: 0,
    cc4: 0,
    cc5: 0,
    d2: 0,
    d3: 0,
    d4: 0,
    delmo: 0,
    eta: 0,
    argpdot: 0,
    omgcof: 0,
    sinmao: 0,
    t2cof: 0,
    t3cof: 0,
    t4cof: 0,
    t5cof: 0,
    x1mth2: 0,
    x7thm1: 0,
    mdot: 0,
    nodedot: 0,
    xlcof: 0,
    xmcof: 0,
    nodecf: 0,
    irez: 0,
  };

  const ss = 78.0 / radiusEarthKm + 1.0;
  const qzms2ttemp = (120.0 - 78.0) / radiusEarthKm;
  const qzms2t = qzms2ttemp * qzms2ttemp * qzms2ttemp * qzms2ttemp;
  const temp4 = 1.5e-12;

  /* ---- initl ---- */
  const eccsq = ecco * ecco;
  const omeosq = 1.0 - eccsq;
  const rteosq = Math.sqrt(omeosq);
  const cosio = Math.cos(inclo);
  const cosio2 = cosio * cosio;
  const ak = Math.pow(xke / noKozai, X2O3);
  const d1 = (0.75 * j2 * (3.0 * cosio2 - 1.0)) / (rteosq * omeosq);
  let delPrime = d1 / (ak * ak);
  const adel =
    ak *
    (1.0 -
      delPrime * delPrime -
      delPrime * (1.0 / 3.0 + (134.0 * delPrime * delPrime) / 81.0));
  delPrime = d1 / (adel * adel);
  const no = noKozai / (1.0 + delPrime);
  const ao = Math.pow(xke / no, X2O3);
  const sinio = Math.sin(inclo);
  const po = ao * omeosq;
  const con42 = 1.0 - 5.0 * cosio2;
  const con41 = -con42 - cosio2 - cosio2;
  const posq = po * po;
  const rp = ao * (1.0 - ecco);

  let gsto: number;
  if (opsmode === 'a') {
    // AFSPC sidereal time, as the operational code computes it
    const ts70 = epoch - 7305.0;
    const ds70 = Math.floor(ts70 + 1.0e-8);
    const tfrac = ts70 - ds70;
    // eslint-disable-next-line no-loss-of-precision -- Vallado's literal, verbatim
    const c1 = 1.72027916940703639e-2;
    // eslint-disable-next-line no-loss-of-precision -- Vallado's literal, verbatim
    const thgr70 = 1.7321343856509374;
    // eslint-disable-next-line no-loss-of-precision -- Vallado's literal, verbatim
    const fk5r = 5.07551419432269442e-15;
    const c1p2p = c1 + TWO_PI;
    gsto = (thgr70 + c1 * ds70 + c1p2p * tfrac + ts70 * ts70 * fk5r) % TWO_PI;
    if (gsto < 0) gsto += TWO_PI;
  } else {
    gsto = gstime(epoch + 2433281.5);
  }

  s.no = no;
  s.con41 = con41;
  s.gsto = gsto;

  const satrec: Sgp4Satrec = {
    norad: el.norad,
    gravity: grav,
    opsmode,
    jdsatepoch: el.epochJd,
    jdsatepochF: el.epochJdFrac,
    method: 'n',
    error: 0,
    a: Math.pow(no * tumin, -X2O3),
    alta: 0,
    altp: 0,
    no,
    s,
  };
  satrec.alta = satrec.a * (1.0 + ecco) - 1.0;
  satrec.altp = satrec.a * (1.0 - ecco) - 1.0;

  if (omeosq >= 0.0 || no >= 0.0) {
    if (rp < 220.0 / radiusEarthKm + 1.0) s.isimp = 1;
    let sfour = ss;
    let qzms24 = qzms2t;
    const perige = (rp - 1.0) * radiusEarthKm;

    // for perigees below 156 km, s and qoms2t are altered
    if (perige < 156.0) {
      sfour = perige - 78.0;
      if (perige < 98.0) sfour = 20.0;
      const qzms24temp = (120.0 - sfour) / radiusEarthKm;
      qzms24 = qzms24temp * qzms24temp * qzms24temp * qzms24temp;
      sfour = sfour / radiusEarthKm + 1.0;
    }
    const pinvsq = 1.0 / posq;

    const tsi = 1.0 / (ao - sfour);
    const eta = ao * ecco * tsi;
    s.eta = eta;
    const etasq = eta * eta;
    const eeta = ecco * eta;
    const psisq = Math.abs(1.0 - etasq);
    const coef = qzms24 * Math.pow(tsi, 4.0);
    const coef1 = coef / Math.pow(psisq, 3.5);
    const cc2 =
      coef1 *
      no *
      (ao * (1.0 + 1.5 * etasq + eeta * (4.0 + etasq)) +
        ((0.375 * j2 * tsi) / psisq) *
          con41 *
          (8.0 + 3.0 * etasq * (8.0 + etasq)));
    const cc1 = bstar * cc2;
    s.cc1 = cc1;
    let cc3 = 0.0;
    if (ecco > 1.0e-4) cc3 = (-2.0 * coef * tsi * j3oj2 * no * sinio) / ecco;
    const x1mth2 = 1.0 - cosio2;
    s.x1mth2 = x1mth2;
    s.cc4 =
      2.0 *
      no *
      coef1 *
      ao *
      omeosq *
      (eta * (2.0 + 0.5 * etasq) +
        ecco * (0.5 + 2.0 * etasq) -
        ((j2 * tsi) / (ao * psisq)) *
          (-3.0 * con41 * (1.0 - 2.0 * eeta + etasq * (1.5 - 0.5 * eeta)) +
            0.75 *
              x1mth2 *
              (2.0 * etasq - eeta * (1.0 + etasq)) *
              Math.cos(2.0 * argpo)));
    s.cc5 =
      2.0 * coef1 * ao * omeosq * (1.0 + 2.75 * (etasq + eeta) + eeta * etasq);
    const cosio4 = cosio2 * cosio2;
    const temp1 = 1.5 * j2 * pinvsq * no;
    const temp2 = 0.5 * temp1 * j2 * pinvsq;
    const temp3 = -0.46875 * j4 * pinvsq * pinvsq * no;
    s.mdot =
      no +
      0.5 * temp1 * rteosq * con41 +
      0.0625 * temp2 * rteosq * (13.0 - 78.0 * cosio2 + 137.0 * cosio4);
    s.argpdot =
      -0.5 * temp1 * con42 +
      0.0625 * temp2 * (7.0 - 114.0 * cosio2 + 395.0 * cosio4) +
      temp3 * (3.0 - 36.0 * cosio2 + 49.0 * cosio4);
    const xhdot1 = -temp1 * cosio;
    s.nodedot =
      xhdot1 +
      (0.5 * temp2 * (4.0 - 19.0 * cosio2) +
        2.0 * temp3 * (3.0 - 7.0 * cosio2)) *
        cosio;
    const xpidot = s.argpdot + s.nodedot;
    s.omgcof = bstar * cc3 * Math.cos(argpo);
    s.xmcof = 0.0;
    if (ecco > 1.0e-4) s.xmcof = (-X2O3 * coef * bstar) / eeta;
    s.nodecf = 3.5 * omeosq * xhdot1 * cc1;
    s.t2cof = 1.5 * cc1;
    // division by zero at i = 180° avoided
    if (Math.abs(cosio + 1.0) > 1.5e-12)
      s.xlcof = (-0.25 * j3oj2 * sinio * (3.0 + 5.0 * cosio)) / (1.0 + cosio);
    else s.xlcof = (-0.25 * j3oj2 * sinio * (3.0 + 5.0 * cosio)) / temp4;
    s.aycof = -0.5 * j3oj2 * sinio;
    const delmotemp = 1.0 + eta * Math.cos(mo);
    s.delmo = delmotemp * delmotemp * delmotemp;
    s.sinmao = Math.sin(mo);
    s.x7thm1 = 7.0 * cosio2 - 1.0;

    /* deep-space initialisation */
    if (TWO_PI / no >= 225.0) {
      satrec.method = 'd';
      s.isimp = 1;
      const tc = 0.0;
      const inclm = inclo;

      const d = dscom(epoch, ecco, argpo, tc, inclo, nodeo, no);
      for (const k of [
        'e3',
        'ee2',
        'peo',
        'pgho',
        'pho',
        'pinco',
        'plo',
        'se2',
        'se3',
        'sgh2',
        'sgh3',
        'sgh4',
        'sh2',
        'sh3',
        'si2',
        'si3',
        'sl2',
        'sl3',
        'sl4',
        'xgh2',
        'xgh3',
        'xgh4',
        'xh2',
        'xh3',
        'xi2',
        'xi3',
        'xl2',
        'xl3',
        'xl4',
        'zmol',
        'zmos',
      ])
        s[k] = d[k]!;

      // init = 'y': dpper leaves the elements untouched
      dsinit(
        s,
        xke,
        d,
        0,
        tc,
        gsto,
        mo,
        s.mdot,
        no,
        nodeo,
        s.nodedot,
        xpidot,
        argpo,
        ecco,
        eccsq,
        inclm
      );
    }

    /* set variables if not deep space */
    if (s.isimp !== 1) {
      const cc1sq = cc1 * cc1;
      s.d2 = 4.0 * ao * tsi * cc1sq;
      const temp = (s.d2 * tsi * cc1) / 3.0;
      s.d3 = (17.0 * ao + sfour) * temp;
      s.d4 = 0.5 * temp * ao * tsi * (221.0 * ao + 31.0 * sfour) * cc1;
      s.t3cof = s.d2 + 2.0 * cc1sq;
      s.t4cof = 0.25 * (3.0 * s.d3 + cc1 * (12.0 * s.d2 + 10.0 * cc1sq));
      s.t5cof =
        0.2 *
        (3.0 * s.d4 +
          12.0 * cc1 * s.d3 +
          6.0 * s.d2 * s.d2 +
          15.0 * cc1sq * (2.0 * s.d2 + cc1sq));
    }
  }

  // propagate to zero epoch to initialise all the remaining state
  const r0 = sgp4(satrec, 0);
  satrec.error = r0 ? r0.error : satrec.error;
  return satrec;
}

/* ------------------------------------------------------------------ */
/*  Propagation                                                        */
/* ------------------------------------------------------------------ */

/**
 * Propagate to `tsince` minutes from the element epoch.
 * @returns TEME position/velocity, or null when the propagator fails
 *   (satrec.error then holds the code; decayed sets return a position
 *   with error 6).
 */
export function sgp4(satrec: Sgp4Satrec, tsince: number): Sgp4Result | null {
  const s = satrec.s;
  const { xke, j2, j3oj2, radiusEarthKm } = satrec.gravity;
  const temp4 = 1.5e-12;
  const vkmpersec = (radiusEarthKm * xke) / 60.0;
  const t = tsince;
  satrec.error = 0;

  /* update for secular gravity and atmospheric drag */
  const xmdf = s.mo! + s.mdot! * t;
  const argpdf = s.argpo! + s.argpdot! * t;
  const nodedf = s.nodeo! + s.nodedot! * t;
  let argpm = argpdf;
  let mm = xmdf;
  const t2 = t * t;
  let nodem = nodedf + s.nodecf! * t2;
  let tempa = 1.0 - s.cc1! * t;
  let tempe = s.bstar! * s.cc4! * t;
  let templ = s.t2cof! * t2;

  if (s.isimp !== 1) {
    const delomg = s.omgcof! * t;
    const delmtemp = 1.0 + s.eta! * Math.cos(xmdf);
    const delm = s.xmcof! * (delmtemp * delmtemp * delmtemp - s.delmo!);
    const temp = delomg + delm;
    mm = xmdf + temp;
    argpm = argpdf - temp;
    const t3 = t2 * t;
    const t4 = t3 * t;
    tempa = tempa - s.d2! * t2 - s.d3! * t3 - s.d4! * t4;
    tempe += s.bstar! * s.cc5! * (Math.sin(mm) - s.sinmao!);
    templ = templ + s.t3cof! * t3 + t4 * (s.t4cof! + t * s.t5cof!);
  }

  let nm = s.no!;
  let em = s.ecco!;
  let inclm = s.inclo!;
  if (satrec.method === 'd') {
    const r = dspace(s, t, t, em, argpm, inclm, mm, nodem);
    em = r.em;
    argpm = r.argpm;
    inclm = r.inclm;
    mm = r.mm;
    nodem = r.nodem;
    nm = r.nm;
  }

  if (nm <= 0.0) {
    satrec.error = 2;
    return null;
  }
  const am = Math.pow(xke / nm, X2O3) * tempa * tempa;
  nm = xke / Math.pow(am, 1.5);
  em -= tempe;

  if (em >= 1.0 || em < -0.001) {
    satrec.error = 1;
    return null;
  }
  if (em < 1.0e-6) em = 1.0e-6;
  mm += s.no! * templ;
  let xlm = mm + argpm + nodem;
  nodem %= TWO_PI;
  argpm %= TWO_PI;
  xlm %= TWO_PI;
  mm = (xlm - argpm - nodem) % TWO_PI;

  /* compute extra mean quantities */
  const sinim = Math.sin(inclm);
  const cosim = Math.cos(inclm);

  /* add lunar-solar periodics */
  let ep = em;
  let xincp = inclm;
  let argpp = argpm;
  let nodep = nodem;
  let mp = mm;
  let sinip = sinim;
  let cosip = cosim;
  if (satrec.method === 'd') {
    const p = dpper(s, t, false, satrec.opsmode, {
      ep,
      inclp: xincp,
      nodep,
      argpp,
      mp,
    });
    ep = p.ep;
    xincp = p.inclp;
    nodep = p.nodep;
    argpp = p.argpp;
    mp = p.mp;
    if (xincp < 0.0) {
      xincp = -xincp;
      nodep += Math.PI;
      argpp -= Math.PI;
    }
    if (ep < 0.0 || ep > 1.0) {
      satrec.error = 3;
      return null;
    }
  }

  /* long period periodics */
  if (satrec.method === 'd') {
    sinip = Math.sin(xincp);
    cosip = Math.cos(xincp);
    s.aycof = -0.5 * j3oj2 * sinip;
    if (Math.abs(cosip + 1.0) > 1.5e-12)
      s.xlcof = (-0.25 * j3oj2 * sinip * (3.0 + 5.0 * cosip)) / (1.0 + cosip);
    else s.xlcof = (-0.25 * j3oj2 * sinip * (3.0 + 5.0 * cosip)) / temp4;
  }
  const axnl = ep * Math.cos(argpp);
  let temp = 1.0 / (am * (1.0 - ep * ep));
  const aynl = ep * Math.sin(argpp) + temp * s.aycof!;
  const xl = mp + argpp + nodep + temp * s.xlcof! * axnl;

  /* solve Kepler's equation */
  const u = (xl - nodep) % TWO_PI;
  let eo1 = u;
  let tem5 = 9999.9;
  let ktr = 1;
  let sineo1 = 0;
  let coseo1 = 0;
  while (Math.abs(tem5) >= 1.0e-12 && ktr <= 10) {
    sineo1 = Math.sin(eo1);
    coseo1 = Math.cos(eo1);
    tem5 = 1.0 - coseo1 * axnl - sineo1 * aynl;
    tem5 = (u - aynl * coseo1 + axnl * sineo1 - eo1) / tem5;
    if (Math.abs(tem5) >= 0.95) tem5 = tem5 > 0.0 ? 0.95 : -0.95;
    eo1 += tem5;
    ktr++;
  }

  /* short period preliminary quantities */
  const ecose = axnl * coseo1 + aynl * sineo1;
  const esine = axnl * sineo1 - aynl * coseo1;
  const el2 = axnl * axnl + aynl * aynl;
  const pl = am * (1.0 - el2);
  if (pl < 0.0) {
    satrec.error = 4;
    return null;
  }

  const rl = am * (1.0 - ecose);
  const rdotl = (Math.sqrt(am) * esine) / rl;
  const rvdotl = Math.sqrt(pl) / rl;
  const betal = Math.sqrt(1.0 - el2);
  temp = esine / (1.0 + betal);
  const sinu = (am / rl) * (sineo1 - aynl - axnl * temp);
  const cosu = (am / rl) * (coseo1 - axnl + aynl * temp);
  let su = Math.atan2(sinu, cosu);
  const sin2u = (cosu + cosu) * sinu;
  const cos2u = 1.0 - 2.0 * sinu * sinu;
  temp = 1.0 / pl;
  const temp1 = 0.5 * j2 * temp;
  const temp2 = temp1 * temp;

  /* update for short period periodics */
  if (satrec.method === 'd') {
    const cosisq = cosip * cosip;
    s.con41 = 3.0 * cosisq - 1.0;
    s.x1mth2 = 1.0 - cosisq;
    s.x7thm1 = 7.0 * cosisq - 1.0;
  }
  const mrt =
    rl * (1.0 - 1.5 * temp2 * betal * s.con41!) +
    0.5 * temp1 * s.x1mth2! * cos2u;
  su -= 0.25 * temp2 * s.x7thm1! * sin2u;
  const xnode = nodep + 1.5 * temp2 * cosip * sin2u;
  const xinc = xincp + 1.5 * temp2 * cosip * sinip * cos2u;
  const mvt = rdotl - (nm * temp1 * s.x1mth2! * sin2u) / xke;
  const rvdot =
    rvdotl + (nm * temp1 * (s.x1mth2! * cos2u + 1.5 * s.con41!)) / xke;

  /* orientation vectors */
  const sinsu = Math.sin(su);
  const cossu = Math.cos(su);
  const snod = Math.sin(xnode);
  const cnod = Math.cos(xnode);
  const sini = Math.sin(xinc);
  const cosi = Math.cos(xinc);
  const xmx = -snod * cosi;
  const xmy = cnod * cosi;
  const ux = xmx * sinsu + cnod * cossu;
  const uy = xmy * sinsu + snod * cossu;
  const uz = sini * sinsu;
  const vx = xmx * cossu - cnod * sinsu;
  const vy = xmy * cossu - snod * sinsu;
  const vz = sini * cossu;

  const r: [number, number, number] = [
    mrt * ux * radiusEarthKm,
    mrt * uy * radiusEarthKm,
    mrt * uz * radiusEarthKm,
  ];
  const v: [number, number, number] = [
    (mvt * ux + rvdot * vx) * vkmpersec,
    (mvt * uy + rvdot * vy) * vkmpersec,
    (mvt * uz + rvdot * vz) * vkmpersec,
  ];

  // sgp4fix: the satellite has decayed below the Earth's surface
  if (mrt < 1.0) satrec.error = 6;

  return { r, v, error: satrec.error };
}
