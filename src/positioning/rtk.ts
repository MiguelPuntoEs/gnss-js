/**
 * RTK positioning, stage 1: epoch-wise double-differenced (DD)
 * processing of a base/rover receiver pair.
 *
 * Two solvers share the same DD construction:
 *
 * - `solveDgnss` — code-based DGNSS: between-receiver single
 *   differences on pseudoranges, double-differenced against a
 *   reference satellite (highest elevation per signal group), iterated
 *   weighted least squares for the rover position with the full DD
 *   covariance (DDs sharing a reference satellite are correlated).
 *
 * - `RtkFloatEngine` — a stateful extended Kalman filter over DD
 *   carrier phase + code with one float DD ambiguity state per
 *   satellite/signal. An EKF (rather than epoch-wise iterated least
 *   squares with appended ambiguity columns) was chosen because the
 *   float ambiguities must persist across epochs anyway, and stage 2
 *   (LAMBDA) needs the joint float ambiguity covariance — which the
 *   EKF maintains natively. This mirrors RTKLIB's float-filter
 *   structure (rtkpos.c), which the implementation was validated
 *   against; no integer fixing is attempted (`ratio` is reserved).
 *
 * Differencing model: for satellites s and reference r observed by
 * rover R and base B, the DD pseudorange/phase cancels satellite
 * clocks (single difference) and receiver clocks (double difference).
 * On short baselines the ionospheric and most of the tropospheric
 * delay cancel too; the residual troposphere is modelled by the same
 * simple elevation-mapped zenith model `solveSpp` uses, applied
 * differentially. DDs are formed per *signal group* (constellation
 * letter + RINEX code, e.g. `G1C`, `C2I`) so that only like signals
 * are differenced.
 *
 * GLONASS (FDMA): DD phase is formed in metres with per-satellite
 * wavelengths (λ_s·SDφ_s − λ_r·SDφ_r). The common receiver clock
 * term cancels exactly (λ·f = c on every channel); the per-channel
 * receiver phase bias (inter-frequency bias, IFB) does not, but it is
 * constant while lock holds and is absorbed into the float DD
 * ambiguity — the standard reason GLONASS float works while GLONASS
 * integer fixing is hard. DD *code* retains the differential
 * inter-channel code bias between the two receivers, which is small
 * (well below the code noise) for same-model receivers — IFB-safe
 * enough for stage 1, and documented as such.
 *
 * Time convention: `timeMs` is GPS-scale epoch milliseconds, exactly
 * as produced by `parseNovatelRange` / the RINEX and RTCM parsers —
 * the same convention `solveSpp` uses. No system clock is read.
 *
 * Adapting decoder output (see `toRtkEpoch`):
 * - NovAtel: `parseNovatelRange(bytes).epochs[i]` gives
 *   `{ timeMs, meas }`; `toRtkEpoch(meas)` picks each satellite's
 *   L1-band measurement. When a log carries both RANGE and RANGECMP
 *   the same epoch appears twice — keep one epoch per `timeMs`.
 * - RTCM MSM: for each satellite/signal cell build
 *   `{ code, pr: pseudorangeM, cp: phaserangeM / lambda, lockTimeMs }`
 *   (MSM phaseranges are metres; divide by the carrier wavelength to
 *   get cycles) and pass a `prn → measurement` map for the epoch.
 */

import type { Ephemeris, GlonassEphemeris } from '../rinex/nav';
import type { SatPosition } from '../orbit';
import { computeSatPosition, ecefToAzEl, selectEphemeris } from '../orbit';
import { C_LIGHT, OMEGA_E } from '../constants/gnss';
import { satClockCorrection } from './index';

/* ================================================================== */
/*  Measurement interface                                              */
/* ================================================================== */

/** One satellite's measurement on one signal, for one epoch. */
export interface RtkMeasurement {
  /** RINEX band+attribute, e.g. "1C", "2I". */
  code: string;
  /** Pseudorange (m). */
  pr: number | null;
  /** Carrier phase (cycles, RINEX sign), optional — DGNSS needs none. */
  cp?: number | null;
  /** Continuous lock time (ms) for cycle-slip detection, optional. */
  lockTimeMs?: number;
  /** GLONASS frequency channel k (−7…+6), for FDMA wavelengths. */
  gloChannel?: number | null;
}

/** One epoch of measurements: PRN → measurement (one signal per PRN). */
export type RtkEpochMeasurements = ReadonlyMap<string, RtkMeasurement>;

/** Decoder-shaped observation (structurally `NovatelMeasurement`). */
export interface RawObservation {
  prn: string;
  code: string;
  pr: number | null;
  cp?: number | null;
  lockTimeS?: number;
  gloChannel?: number | null;
}

/** Preferred L1-band code per system, in preference order. */
const L1_CODES: Record<string, string[]> = {
  G: ['1C'],
  E: ['1C'],
  R: ['1C'],
  J: ['1C'],
  C: ['2I', '1P'], // B1I first (classic B1), then B1C
};

/**
 * Adapt one epoch of decoder observations (e.g.
 * `parseNovatelRange(...).epochs[i].meas`) to the RTK input map:
 * keeps each satellite's preferred L1-band code measurement with a
 * valid pseudorange, drops unsupported systems (SBAS, NavIC).
 */
export function toRtkEpoch(
  meas: readonly RawObservation[]
): Map<string, RtkMeasurement> {
  const out = new Map<string, RtkMeasurement>();
  const rank = new Map<string, number>();
  for (const m of meas) {
    const prefs = L1_CODES[m.prn[0]!];
    if (!prefs || m.pr === null || !Number.isFinite(m.pr)) continue;
    const r = prefs.indexOf(m.code);
    if (r < 0) continue;
    const prev = rank.get(m.prn);
    if (prev !== undefined && prev <= r) continue;
    rank.set(m.prn, r);
    out.set(m.prn, {
      code: m.code,
      pr: m.pr,
      cp: m.cp ?? null,
      lockTimeMs:
        m.lockTimeS !== undefined ? Math.round(m.lockTimeS * 1000) : undefined,
      gloChannel: m.gloChannel ?? null,
    });
  }
  return out;
}

/* ================================================================== */
/*  Shared helpers                                                     */
/* ================================================================== */

/** Carrier frequency (Hz) from system letter + RINEX band digit. */
function carrierFreqHz(
  sys: string,
  code: string,
  gloChannel: number | null
): number {
  const band = code[0]!;
  switch (sys) {
    case 'G':
    case 'J':
      return band === '1' ? 1575.42e6 : band === '2' ? 1227.6e6 : 1176.45e6;
    case 'E':
      return band === '1'
        ? 1575.42e6
        : band === '5'
          ? 1176.45e6
          : band === '7'
            ? 1207.14e6
            : band === '8'
              ? 1191.795e6
              : 1278.75e6;
    case 'C':
      return band === '1'
        ? 1575.42e6
        : band === '2'
          ? 1561.098e6
          : band === '5'
            ? 1176.45e6
            : band === '7'
              ? 1207.14e6
              : 1268.52e6;
    case 'R': {
      if (gloChannel === null) return 0;
      if (band === '1') return 1602e6 + gloChannel * 562500;
      if (band === '2') return 1246e6 + gloChannel * 437500;
      return 1202.025e6;
    }
    default:
      return 0;
  }
}

/** Rotate an ECEF position by the Earth rotation during signal travel. */
function sagnac(
  pos: { x: number; y: number; z: number },
  travelTimeS: number
): [number, number, number] {
  const theta = OMEGA_E * travelTimeS;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [pos.x * c + pos.y * s, -pos.x * s + pos.y * c, pos.z];
}

/** Simple tropospheric zenith-delay model mapped by elevation (m). */
function tropoDelay(elevationRad: number): number {
  const sinEl = Math.sin(elevationRad);
  return 2.47 / (sinEl + 0.0121);
}

/** Ephemeris source: a per-PRN map, or a list searched per epoch. */
export type EphemerisSource =
  ReadonlyMap<string, Ephemeris> | readonly Ephemeris[];

function resolveEphemeris(
  src: EphemerisSource,
  prn: string,
  timeMs: number
): Ephemeris | null {
  if (Array.isArray(src))
    return selectEphemeris(src as Ephemeris[], prn, timeMs);
  return (src as ReadonlyMap<string, Ephemeris>).get(prn) ?? null;
}

/** Per-satellite geometry shared by the DGNSS and float solvers. */
interface SatGeometry {
  prn: string;
  /** Signal group: system letter + code, e.g. "G1C", "C2I". */
  group: string;
  /** Carrier wavelength (m); 0 when the frequency is unknown. */
  lambda: number;
  /** Satellite position at the rover-side transmission time. */
  satR: SatPosition;
  /** Base geometric range (m), Sagnac applied — fixed per epoch. */
  rhoB: number;
  /** Elevation at the base (rad). */
  elB: number;
  /** Modelled tropospheric delay at the base (m), 0 when disabled. */
  tropoB: number;
  prR: number;
  prB: number;
  cpR: number | null;
  cpB: number | null;
  lockR: number | undefined;
  lockB: number | undefined;
}

/**
 * Build the per-satellite geometry for one epoch: satellites present
 * in both receivers on the same code, with a resolvable ephemeris and
 * above the elevation mask at the base. Satellite positions are
 * computed at each receiver's own transmission time (pseudorange
 * back-projection, satellite clock applied), mirroring `solveSpp`;
 * the satellite clock itself cancels in the single difference and is
 * not part of the DD model.
 */
function buildGeometry(
  rover: RtkEpochMeasurements,
  base: RtkEpochMeasurements,
  basePos: readonly [number, number, number],
  ephemerides: EphemerisSource,
  timeMs: number,
  maskRad: number,
  troposphere: boolean
): SatGeometry[] {
  const out: SatGeometry[] = [];
  for (const [prn, mR] of rover) {
    const sys = prn[0]!;
    if (!'GERCJ'.includes(sys)) continue;
    const mB = base.get(prn);
    if (!mB || mB.code !== mR.code) continue;
    if (
      mR.pr === null ||
      mB.pr === null ||
      !Number.isFinite(mR.pr) ||
      !Number.isFinite(mB.pr)
    )
      continue;
    const eph = resolveEphemeris(ephemerides, prn, timeMs);
    if (!eph) continue;

    const satAt = (pr: number): SatPosition | null => {
      const tTx = timeMs - (pr / C_LIGHT) * 1000;
      const dts = satClockCorrection(eph, tTx);
      const sat = computeSatPosition(eph, tTx - dts * 1000);
      return Number.isFinite(sat.x) ? sat : null;
    };
    const satB = satAt(mB.pr);
    const satR = satAt(mR.pr);
    if (!satB || !satR) continue;

    const travelB =
      Math.hypot(
        satB.x - basePos[0],
        satB.y - basePos[1],
        satB.z - basePos[2]
      ) / C_LIGHT;
    const [bx, by, bz] = sagnac(satB, travelB);
    const rhoB = Math.hypot(bx - basePos[0], by - basePos[1], bz - basePos[2]);
    const elB = ecefToAzEl(basePos[0], basePos[1], basePos[2], bx, by, bz).el;
    if (elB < maskRad) continue;

    const gloK =
      sys === 'R'
        ? (mR.gloChannel ??
          mB.gloChannel ??
          (eph as GlonassEphemeris).freqNum ??
          null)
        : null;
    const freq = carrierFreqHz(sys, mR.code, gloK);

    out.push({
      prn,
      group: sys + mR.code,
      lambda: freq > 0 ? C_LIGHT / freq : 0,
      satR,
      rhoB,
      elB,
      tropoB: troposphere ? tropoDelay(elB) : 0,
      prR: mR.pr,
      prB: mB.pr,
      cpR: mR.cp ?? null,
      cpB: mB.cp ?? null,
      lockR: mR.lockTimeMs,
      lockB: mB.lockTimeMs,
    });
  }
  return out;
}

/**
 * Rover-side range terms at the current position estimate: Sagnac
 * rotation, geometric range, line-of-sight unit vector (rover-minus-
 * satellite, as in `solveSpp`) and the differential troposphere.
 */
function roverTerms(
  g: SatGeometry,
  x: number,
  y: number,
  z: number,
  troposphere: boolean
): { rho: number; u: [number, number, number]; dTropo: number } {
  const travel = Math.hypot(g.satR.x - x, g.satR.y - y, g.satR.z - z) / C_LIGHT;
  const [sx, sy, sz] = sagnac(g.satR, travel);
  const rho = Math.hypot(sx - x, sy - y, sz - z);
  const u: [number, number, number] = [
    (x - sx) / rho,
    (y - sy) / rho,
    (z - sz) / rho,
  ];
  let dTropo = 0;
  if (troposphere) {
    const elR = ecefToAzEl(x, y, z, sx, sy, sz).el;
    dTropo = tropoDelay(Math.max(elR, 0.05)) - g.tropoB;
  }
  return { rho, u, dTropo };
}

/** Single-difference variance (m²), elevation-weighted, 2 receivers. */
function sdVariance(sigmaM: number, elRad: number): number {
  const sinEl = Math.max(Math.sin(elRad), 0.05);
  return 2 * sigmaM * sigmaM * (1 + 1 / (sinEl * sinEl));
}

/* ------------------------------------------------------------------ */
/*  Small dense linear algebra (state/measurement sizes ≤ ~100)        */
/* ------------------------------------------------------------------ */

function zeros(n: number, m: number): number[][] {
  return Array.from({ length: n }, () => new Array<number>(m).fill(0));
}

/** Invert a square matrix by Gauss-Jordan with partial pivoting. */
function matInv(A: readonly (readonly number[])[]): number[][] | null {
  const n = A.length;
  const M = A.map((row, i) => {
    const r = [...row, ...new Array<number>(n).fill(0)];
    r[n + i] = 1;
    return r;
  });
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(M[pivot]![col]!) < 1e-13) return null;
    [M[col], M[pivot]] = [M[pivot]!, M[col]!];
    const d = M[col]![col]!;
    for (let c = 0; c < 2 * n; c++) M[col]![c]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]!;
      if (f === 0) continue;
      for (let c = 0; c < 2 * n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  return M.map((row) => row.slice(n));
}

function matMul(
  A: readonly (readonly number[])[],
  B: readonly (readonly number[])[]
): number[][] {
  const n = A.length;
  const k = B.length;
  const m = B[0]?.length ?? 0;
  const C = zeros(n, m);
  for (let i = 0; i < n; i++) {
    for (let l = 0; l < k; l++) {
      const a = A[i]![l]!;
      if (a === 0) continue;
      for (let j = 0; j < m; j++) C[i]![j]! += a * B[l]![j]!;
    }
  }
  return C;
}

function transpose(A: readonly (readonly number[])[]): number[][] {
  const n = A.length;
  const m = A[0]?.length ?? 0;
  const T = zeros(m, n);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) T[j]![i] = A[i]![j]!;
  return T;
}

/* ================================================================== */
/*  DD row assembly (shared)                                           */
/* ================================================================== */

interface DdRow {
  /** The non-reference satellite. */
  g: SatGeometry;
  ref: SatGeometry;
  /** 'code' or 'phase'. */
  kind: 'code' | 'phase';
  /** Observed DD (m). */
  z: number;
}

/** Group geometry entries and pick the reference per group. */
function groupEntries(
  geom: readonly SatGeometry[]
): Map<string, SatGeometry[]> {
  const groups = new Map<string, SatGeometry[]>();
  for (const g of geom) {
    const list = groups.get(g.group);
    if (list) list.push(g);
    else groups.set(g.group, [g]);
  }
  return groups;
}

/**
 * Build the DD covariance for rows sharing per-row SD variances: DDs
 * against the same reference satellite are correlated through the
 * reference's SD noise (R_ij = var_ref for i≠j in the same group and
 * kind, var_i + var_ref on the diagonal).
 */
function ddCovariance(
  rows: readonly DdRow[],
  sigmaCode: number,
  sigmaPhase: number
): number[][] {
  const n = rows.length;
  const R = zeros(n, n);
  const sd = (r: DdRow, g: SatGeometry) =>
    sdVariance(r.kind === 'code' ? sigmaCode : sigmaPhase, g.elB);
  for (let i = 0; i < n; i++) {
    const ri = rows[i]!;
    R[i]![i] = sd(ri, ri.g) + sd(ri, ri.ref);
    for (let j = i + 1; j < n; j++) {
      const rj = rows[j]!;
      if (
        ri.ref.prn === rj.ref.prn &&
        ri.kind === rj.kind &&
        ri.g.group === rj.g.group
      ) {
        R[i]![j] = R[j]![i] = sd(ri, ri.ref);
      }
    }
  }
  return R;
}

/* ================================================================== */
/*  DGNSS: code double differences, iterated least squares             */
/* ================================================================== */

export interface DgnssOptions {
  /** Elevation mask at the base, degrees. Default 10. */
  elevationMaskDeg?: number;
  /** Model the differential troposphere. Default true. */
  troposphere?: boolean;
  /** Maximum Gauss-Newton iterations. Default 15. */
  maxIterations?: number;
  /** Convergence threshold on the position update (m). Default 1e-4. */
  convergenceM?: number;
  /** Zenith code sigma per receiver (m). Default 0.3. */
  codeSigmaM?: number;
  /** Worst-first DD residual rejection threshold (m). Default 20. */
  rejectThresholdM?: number;
  /** Initial rover position; defaults to the base position. */
  initialPosition?: [number, number, number];
}

export interface DgnssSolution {
  /** Rover position, ECEF metres. */
  position: [number, number, number];
  /** Baseline rover − base, ECEF metres. */
  baseline: [number, number, number];
  /** Formal position sigmas from the LSQ covariance, ECEF metres. */
  sigmas: [number, number, number];
  /** Satellites used (including references). */
  usedSatellites: string[];
  /** Reference satellite per signal group. */
  refSatellites: Record<string, string>;
  /** Post-fit DD residual (m) per non-reference PRN. */
  residuals: Record<string, number>;
  /** Satellites rejected by the residual screen. */
  rejectedSatellites: string[];
  nSats: number;
  iterations: number;
  converged: boolean;
}

/**
 * Solve the rover position from one epoch of DD pseudoranges.
 *
 * @param rover Rover measurements (PRN → measurement).
 * @param base Base measurements (PRN → measurement, same codes).
 * @param basePos Known base position, ECEF metres.
 * @param ephemerides Broadcast ephemerides (per-PRN map, or a list
 *   searched by closest epoch — pass `parseNovatelNav(...).ephemerides`
 *   or `parseNavFile(...).ephemerides` directly).
 * @param timeMs Receiver epoch, GPS-scale milliseconds.
 */
export function solveDgnss(
  rover: RtkEpochMeasurements,
  base: RtkEpochMeasurements,
  basePos: readonly [number, number, number],
  ephemerides: EphemerisSource,
  timeMs: number,
  opts: DgnssOptions = {}
): DgnssSolution | null {
  const {
    elevationMaskDeg = 10,
    troposphere = true,
    maxIterations = 15,
    convergenceM = 1e-4,
    codeSigmaM = 0.3,
    rejectThresholdM = 20,
    initialPosition,
  } = opts;

  let geom = buildGeometry(
    rover,
    base,
    basePos,
    ephemerides,
    timeMs,
    (elevationMaskDeg * Math.PI) / 180,
    troposphere
  );

  const rejected: string[] = [];

  for (;;) {
    const groups = groupEntries(geom);
    const rows: DdRow[] = [];
    const refSatellites: Record<string, string> = {};
    for (const [group, list] of groups) {
      if (list.length < 2) continue;
      const ref = list.reduce((a, b) => (b.elB > a.elB ? b : a));
      refSatellites[group] = ref.prn;
      for (const g of list) {
        if (g === ref) continue;
        rows.push({
          g,
          ref,
          kind: 'code',
          z: g.prR - g.prB - (ref.prR - ref.prB),
        });
      }
    }
    if (rows.length < 3) return null;

    const W = matInv(ddCovariance(rows, codeSigmaM, codeSigmaM));
    if (!W) return null;

    let [x, y, z] = initialPosition ?? basePos;
    let iterations = 0;
    let converged = false;
    const residuals: Record<string, number> = {};
    let cov: number[][] | null = null;

    for (let iter = 0; iter < maxIterations; iter++) {
      iterations = iter + 1;
      const H: number[][] = [];
      const v: number[] = [];
      const terms = new Map<string, ReturnType<typeof roverTerms>>();
      const termOf = (g: SatGeometry) => {
        let t = terms.get(g.prn);
        if (!t) {
          t = roverTerms(g, x, y, z, troposphere);
          terms.set(g.prn, t);
        }
        return t;
      };
      for (const row of rows) {
        const ts = termOf(row.g);
        const tr = termOf(row.ref);
        const pred =
          ts.rho - row.g.rhoB + ts.dTropo - (tr.rho - row.ref.rhoB + tr.dTropo);
        v.push(row.z - pred);
        H.push([ts.u[0] - tr.u[0], ts.u[1] - tr.u[1], ts.u[2] - tr.u[2]]);
      }
      // Normal equations with the full DD weight matrix: N = HᵀWH.
      const Ht = transpose(H);
      const HtW = matMul(Ht, W);
      const N = matMul(HtW, H);
      const b = matMul(
        HtW,
        v.map((s) => [s])
      );
      const Ninv = matInv(N);
      if (!Ninv) return null;
      const dx = matMul(
        Ninv,
        b.map((r) => [r[0]!])
      );
      x += dx[0]![0]!;
      y += dx[1]![0]!;
      z += dx[2]![0]!;
      cov = Ninv;
      rows.forEach((row, i) => {
        residuals[row.g.prn] =
          v[i]! -
          (H[i]![0]! * dx[0]![0]! +
            H[i]![1]! * dx[1]![0]! +
            H[i]![2]! * dx[2]![0]!);
      });
      if (Math.hypot(dx[0]![0]!, dx[1]![0]!, dx[2]![0]!) < convergenceM) {
        converged = true;
        break;
      }
    }

    // Worst-first residual rejection: drop the single worst satellite
    // above the threshold and re-solve (same discipline as solveSpp).
    let worst: string | null = null;
    let worstAbs = rejectThresholdM;
    for (const [prn, r] of Object.entries(residuals)) {
      if (Math.abs(r) > worstAbs) {
        worstAbs = Math.abs(r);
        worst = prn;
      }
    }
    if (worst && geom.length > 4) {
      rejected.push(worst);
      geom = geom.filter((g) => g.prn !== worst);
      continue;
    }

    const usedSatellites = [
      ...new Set(rows.flatMap((r) => [r.g.prn, r.ref.prn])),
    ].sort();
    return {
      position: [x, y, z],
      baseline: [x - basePos[0], y - basePos[1], z - basePos[2]],
      sigmas: cov
        ? [
            Math.sqrt(Math.max(cov[0]![0]!, 0)),
            Math.sqrt(Math.max(cov[1]![1]!, 0)),
            Math.sqrt(Math.max(cov[2]![2]!, 0)),
          ]
        : [0, 0, 0],
      usedSatellites,
      refSatellites,
      residuals,
      rejectedSatellites: rejected,
      nSats: usedSatellites.length,
      iterations,
      converged,
    };
  }
}

/* ================================================================== */
/*  Float RTK: extended Kalman filter over DD phase + code             */
/* ================================================================== */

export interface RtkFloatOptions {
  /**
   * 'static': the rover position is a constant state (random walk
   * `processNoisePosM`·√s, default 0). 'kinematic': the position is
   * re-initialised each epoch with `kinematicSigmaM` uncertainty
   * (no velocity states at stage 1 — RTKLIB's default kinematic
   * handling without doppler). Default 'kinematic'.
   */
  mode?: 'static' | 'kinematic';
  /** Elevation mask at the base, degrees. Default 10. */
  elevationMaskDeg?: number;
  /** Model the differential troposphere. Default true. */
  troposphere?: boolean;
  /** Zenith code sigma per receiver (m). Default 0.3. */
  codeSigmaM?: number;
  /** Zenith phase sigma per receiver (m). Default 0.003. */
  phaseSigmaM?: number;
  /** Static-mode position random walk (m/√s). Default 0. */
  processNoisePosM?: number;
  /** Kinematic per-epoch position reset sigma (m). Default 30. */
  kinematicSigmaM?: number;
  /** Ambiguity random walk (cycles/√s). Default 1e-4. */
  ambProcessNoiseCycles?: number;
  /** New float ambiguity sigma (cycles). Default 30. */
  ambInitSigmaCycles?: number;
  /** Drop ambiguity states unseen for this long (ms). Default 10000. */
  maxGapMs?: number;
  /** DD code innovation gate (m): drop the satellite. Default 30. */
  codeGateM?: number;
  /**
   * Phase-minus-code innovation divergence gate (m): treat as an
   * undetected cycle slip and re-initialise the ambiguity. Default 5.
   */
  slipGateM?: number;
  /** Measurement-update relinearisations (IEKF). Default 2. */
  updateIterations?: number;
}

export interface RtkFloatSolution {
  /** Epoch, GPS-scale milliseconds. */
  timeMs: number;
  /** Rover position, ECEF metres. */
  position: [number, number, number];
  /** Float baseline rover − base, ECEF metres. */
  floatBaseline: [number, number, number];
  /** Satellites contributing DD rows this epoch (incl. references). */
  nSats: number;
  /** Ambiguity-validation ratio — undefined at stage 1 (no LAMBDA). */
  ratio?: number;
  /** Formal position sigmas (filter covariance), ECEF metres. */
  sigmas: [number, number, number];
  /** Float DD ambiguity (cycles) per non-reference PRN. */
  ambiguities: Record<string, number>;
  /** Reference satellite per signal group. */
  refSatellites: Record<string, string>;
}

interface AmbEntry {
  prn: string;
  group: string;
  lambda: number;
}

interface TrackRecord {
  lockR: number | undefined;
  lockB: number | undefined;
  lastMs: number;
}

/**
 * Epoch-by-epoch float RTK filter: EKF states = rover position
 * (static or kinematic) + one float DD ambiguity (cycles) per
 * satellite/signal. Cycle slips are handled via lock-time regressions
 * (LLI-style resets) and a phase/code divergence gate; reference-
 * satellite switches re-map the DD ambiguity states algebraically
 * (N_i' = N_i − N_r', old reference gains −N_r') so no information is
 * lost. Feed epochs in time order via `process`.
 */
export class RtkFloatEngine {
  private readonly basePos: readonly [number, number, number];
  private readonly ephemerides: EphemerisSource;
  private readonly o: Required<RtkFloatOptions>;

  /** State vector [x, y, z, N₁…] and covariance; null before init. */
  private x: number[] | null = null;
  private P: number[][] = [];
  private amb: AmbEntry[] = [];
  private refs = new Map<string, string>();
  private track = new Map<string, TrackRecord>();
  private lastMs: number | null = null;

  constructor(
    basePos: readonly [number, number, number],
    ephemerides: EphemerisSource,
    opts: RtkFloatOptions = {}
  ) {
    this.basePos = basePos;
    this.ephemerides = ephemerides;
    this.o = {
      mode: opts.mode ?? 'kinematic',
      elevationMaskDeg: opts.elevationMaskDeg ?? 10,
      troposphere: opts.troposphere ?? true,
      codeSigmaM: opts.codeSigmaM ?? 0.3,
      phaseSigmaM: opts.phaseSigmaM ?? 0.003,
      processNoisePosM: opts.processNoisePosM ?? 0,
      kinematicSigmaM: opts.kinematicSigmaM ?? 30,
      ambProcessNoiseCycles: opts.ambProcessNoiseCycles ?? 1e-4,
      ambInitSigmaCycles: opts.ambInitSigmaCycles ?? 30,
      maxGapMs: opts.maxGapMs ?? 10000,
      codeGateM: opts.codeGateM ?? 30,
      slipGateM: opts.slipGateM ?? 5,
      updateIterations: opts.updateIterations ?? 2,
    };
  }

  /** Clear all filter state (position, ambiguities, lock history). */
  reset(): void {
    this.x = null;
    this.P = [];
    this.amb = [];
    this.refs.clear();
    this.track.clear();
    this.lastMs = null;
  }

  private ambIndex(prn: string): number {
    return this.amb.findIndex((a) => a.prn === prn);
  }

  /** Remove one ambiguity state (row/col) from x and P. */
  private dropAmb(idx: number): void {
    const s = 3 + idx;
    this.amb.splice(idx, 1);
    this.x!.splice(s, 1);
    this.P.splice(s, 1);
    for (const row of this.P) row.splice(s, 1);
  }

  /** Append an ambiguity state with the given value and variance. */
  private addAmb(entry: AmbEntry, value: number, variance: number): void {
    this.amb.push(entry);
    this.x!.push(value);
    const n = this.x!.length;
    for (const row of this.P) row.push(0);
    const newRow = new Array<number>(n).fill(0);
    newRow[n - 1] = variance;
    this.P.push(newRow);
  }

  /**
   * Re-map a group's DD ambiguities from the old reference r to the
   * new reference r' (which must hold a state): N_i' = N_i − N_r' and
   * the old reference's slot becomes N_r = −N_r'. Exact linear
   * transform of state and covariance (P' = T P Tᵀ).
   */
  private retarget(group: string, oldRef: string, newRefIdx: number): void {
    const n = this.x!.length;
    const j = 3 + newRefIdx;
    const T = zeros(n, n);
    for (let i = 0; i < n; i++) T[i]![i] = 1;
    for (let k = 0; k < this.amb.length; k++) {
      if (this.amb[k]!.group !== group) continue;
      const s = 3 + k;
      if (s === j) T[s]![s] = -1;
      else T[s]![j]! -= 1;
    }
    this.x = matMul(
      T,
      this.x!.map((v) => [v])
    ).map((r) => r[0]!);
    this.P = matMul(matMul(T, this.P), transpose(T));
    // The transformed slot now holds the old reference's DD ambiguity.
    const entry = this.amb[newRefIdx]!;
    entry.prn = oldRef;
    // λ of the old reference (FDMA): fixed up when the row is next
    // measured; keep the previous λ as a placeholder meanwhile.
  }

  /**
   * Process one synchronized epoch (same nominal `timeMs` for both
   * receivers). Returns null until a first position can be
   * initialised (via an internal DGNSS solve) or when the epoch has
   * fewer than 3 usable DD rows.
   */
  process(
    rover: RtkEpochMeasurements,
    base: RtkEpochMeasurements,
    timeMs: number
  ): RtkFloatSolution | null {
    const o = this.o;
    const geom = buildGeometry(
      rover,
      base,
      this.basePos,
      this.ephemerides,
      timeMs,
      (o.elevationMaskDeg * Math.PI) / 180,
      o.troposphere
    );
    const byPrn = new Map(geom.map((g) => [g.prn, g]));
    const dtS = this.lastMs !== null ? (timeMs - this.lastMs) / 1000 : 0;

    /* -- 1: drop states unseen for too long ------------------------ */
    if (this.x) {
      for (let i = this.amb.length - 1; i >= 0; i--) {
        const prn = this.amb[i]!.prn;
        const tr = this.track.get(prn);
        const seen = byPrn.get(prn);
        const hasPhase = seen && seen.cpR !== null && seen.cpB !== null;
        const staleMs = tr ? timeMs - tr.lastMs : Infinity;
        if (!hasPhase && staleMs > o.maxGapMs) this.dropAmb(i);
      }
    }

    /* -- 2: cycle-slip flags (lock-time regression / long gap) ----- */
    const slipped = new Set<string>();
    for (const g of geom) {
      if (g.cpR === null || g.cpB === null) continue;
      const tr = this.track.get(g.prn);
      if (!tr) continue;
      if (timeMs - tr.lastMs > o.maxGapMs) slipped.add(g.prn);
      else if (
        (g.lockR !== undefined &&
          tr.lockR !== undefined &&
          g.lockR < tr.lockR) ||
        (g.lockB !== undefined && tr.lockB !== undefined && g.lockB < tr.lockB)
      )
        slipped.add(g.prn);
    }

    /* -- 3: position init / time update ---------------------------- */
    if (!this.x) {
      const dg = solveDgnss(
        rover,
        base,
        this.basePos,
        this.ephemerides,
        timeMs,
        {
          elevationMaskDeg: o.elevationMaskDeg,
          troposphere: o.troposphere,
          codeSigmaM: o.codeSigmaM,
        }
      );
      if (!dg) return null;
      this.x = [...dg.position];
      this.P = zeros(3, 3);
      for (let i = 0; i < 3; i++) {
        const s = Math.max(dg.sigmas[i]!, 1);
        this.P[i]![i] = 25 * s * s;
      }
      this.amb = [];
    } else if (o.mode === 'kinematic') {
      // Re-initialise the position: keep the value as the
      // linearisation point, decorrelate and inflate the covariance.
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < this.x.length; j++) {
          this.P[i]![j] = 0;
          this.P[j]![i] = 0;
        }
        this.P[i]![i] = o.kinematicSigmaM * o.kinematicSigmaM;
      }
    } else {
      const q = o.processNoisePosM * o.processNoisePosM * dtS;
      for (let i = 0; i < 3; i++) this.P[i]![i]! += q;
    }
    const qAmb = o.ambProcessNoiseCycles * o.ambProcessNoiseCycles * dtS;
    for (let k = 0; k < this.amb.length; k++) this.P[3 + k]![3 + k]! += qAmb;

    /* -- 4: reference selection + retargeting ---------------------- */
    const groups = groupEntries(geom);
    const newRefs = new Map<string, SatGeometry>();
    for (const [group, list] of groups) {
      if (list.length < 2) continue;
      const phase = list.filter(
        (g) => g.cpR !== null && g.cpB !== null && !slipped.has(g.prn)
      );
      const pool = phase.length >= 2 ? phase : list;
      const prevRef = this.refs.get(group);
      const best = pool.reduce((a, b) => (b.elB > a.elB ? b : a));
      let ref = best;
      if (best.prn !== prevRef) {
        const anyState = this.amb.some((a) => a.group === group);
        if (anyState) {
          if (this.ambIndex(best.prn) >= 0) {
            // Transform the group's states onto the new reference.
            this.retarget(group, prevRef ?? best.prn, this.ambIndex(best.prn));
          } else if (prevRef && pool.some((g) => g.prn === prevRef)) {
            // New best has no state yet — keep the old reference for
            // this epoch; the newcomer gets a state below and can take
            // over next epoch.
            ref = pool.find((g) => g.prn === prevRef)!;
          } else {
            // Reference lost and the new one is stateless: the old
            // DDs cannot be re-mapped — reset the group.
            for (let i = this.amb.length - 1; i >= 0; i--)
              if (this.amb[i]!.group === group) this.dropAmb(i);
          }
        }
      }
      newRefs.set(group, ref);
      this.refs.set(group, ref.prn);
    }
    for (const group of [...this.refs.keys()])
      if (!newRefs.has(group)) this.refs.delete(group);

    /* -- 5: slip resets --------------------------------------------- */
    for (const prn of slipped) {
      const i = this.ambIndex(prn);
      if (i >= 0) this.dropAmb(i);
    }

    /* -- 6: new ambiguity states (geometry-free init: (φ−P)/λ) ------ */
    const initAmb = (g: SatGeometry, ref: SatGeometry): void => {
      if (g.lambda <= 0 || ref.lambda <= 0) return;
      const zPhi =
        g.lambda * (g.cpR! - g.cpB!) - ref.lambda * (ref.cpR! - ref.cpB!);
      const zP = g.prR - g.prB - (ref.prR - ref.prB);
      const n0 = (zPhi - zP) / g.lambda;
      this.addAmb(
        { prn: g.prn, group: g.group, lambda: g.lambda },
        n0,
        o.ambInitSigmaCycles * o.ambInitSigmaCycles
      );
    };
    for (const [group, ref] of newRefs) {
      for (const g of groups.get(group)!) {
        if (g === ref || g.cpR === null || g.cpB === null) continue;
        if (ref.cpR === null || ref.cpB === null) continue;
        const i = this.ambIndex(g.prn);
        if (i >= 0) {
          this.amb[i]!.lambda = g.lambda; // refresh (retarget placeholder)
          this.amb[i]!.group = g.group;
          continue;
        }
        initAmb(g, ref);
      }
    }
    // Drop any state whose satellite is its group's current reference
    // (it carries no DD information this epoch and would alias).
    for (let i = this.amb.length - 1; i >= 0; i--) {
      const a = this.amb[i]!;
      if (newRefs.get(a.group)?.prn === a.prn) this.dropAmb(i);
    }

    /* -- 7: measurement rows ---------------------------------------- */
    interface Row extends DdRow {
      ambIdx: number; // −1 for code rows
    }
    let rows: Row[] = [];
    for (const [group, ref] of newRefs) {
      for (const g of groups.get(group)!) {
        if (g === ref) continue;
        rows.push({
          g,
          ref,
          kind: 'code',
          z: g.prR - g.prB - (ref.prR - ref.prB),
          ambIdx: -1,
        });
        const i = this.ambIndex(g.prn);
        if (
          i >= 0 &&
          g.cpR !== null &&
          g.cpB !== null &&
          ref.cpR !== null &&
          ref.cpB !== null &&
          g.lambda > 0 &&
          ref.lambda > 0
        ) {
          rows.push({
            g,
            ref,
            kind: 'phase',
            z: g.lambda * (g.cpR - g.cpB) - ref.lambda * (ref.cpR - ref.cpB),
            ambIdx: i,
          });
        }
      }
    }
    if (rows.length < 3) {
      this.lastMs = timeMs;
      return null;
    }

    /* -- 8: innovation gating at the prior -------------------------- */
    const predict = (
      row: Row,
      xs: readonly number[]
    ): { pred: number; h: number[] } => {
      const ts = roverTerms(row.g, xs[0]!, xs[1]!, xs[2]!, o.troposphere);
      const tr = roverTerms(row.ref, xs[0]!, xs[1]!, xs[2]!, o.troposphere);
      let pred =
        ts.rho - row.g.rhoB + ts.dTropo - (tr.rho - row.ref.rhoB + tr.dTropo);
      const h = new Array<number>(this.x!.length).fill(0);
      h[0] = ts.u[0] - tr.u[0];
      h[1] = ts.u[1] - tr.u[1];
      h[2] = ts.u[2] - tr.u[2];
      if (row.ambIdx >= 0) {
        pred += this.amb[row.ambIdx]!.lambda * this.x![3 + row.ambIdx]!;
        h[3 + row.ambIdx] = this.amb[row.ambIdx]!.lambda;
      }
      return { pred, h };
    };

    const dropPrns = new Set<string>();
    const codeInn = new Map<string, number>();
    for (const row of rows) {
      if (row.kind !== 'code') continue;
      const v = row.z - predict(row, this.x!).pred;
      codeInn.set(row.g.prn, v);
      if (Math.abs(v) > o.codeGateM) dropPrns.add(row.g.prn);
    }
    for (const row of rows) {
      if (row.kind !== 'phase' || dropPrns.has(row.g.prn)) continue;
      const v = row.z - predict(row, this.x!).pred;
      const vc = codeInn.get(row.g.prn) ?? 0;
      if (Math.abs(v - vc) > o.slipGateM) {
        // Undetected slip: re-initialise the ambiguity geometry-free.
        const zP = row.g.prR - row.g.prB - (row.ref.prR - row.ref.prB);
        const lam = this.amb[row.ambIdx]!.lambda;
        this.x![3 + row.ambIdx] = (row.z - zP) / lam;
        const s = 3 + row.ambIdx;
        for (let j = 0; j < this.x!.length; j++) {
          this.P[s]![j] = 0;
          this.P[j]![s] = 0;
        }
        this.P[s]![s] = o.ambInitSigmaCycles * o.ambInitSigmaCycles;
      }
    }
    if (dropPrns.size) rows = rows.filter((r) => !dropPrns.has(r.g.prn));
    if (rows.length < 3) {
      this.lastMs = timeMs;
      return null;
    }

    /* -- 9: iterated EKF measurement update ------------------------- */
    const n = this.x.length;
    const R = ddCovariance(rows, o.codeSigmaM, o.phaseSigmaM);
    const xPrior = [...this.x];
    const PPrior = this.P;
    let xi = [...this.x];
    let K: number[][] = [];
    let H: number[][] = [];
    for (let it = 0; it < Math.max(o.updateIterations, 1); it++) {
      H = [];
      const v: number[] = [];
      for (const row of rows) {
        const { pred, h } = predict(row, xi);
        // IEKF: v = z − h(xi) − H·(x⁻ − xi)
        let corr = 0;
        for (let j = 0; j < n; j++) corr += h[j]! * (xPrior[j]! - xi[j]!);
        v.push(row.z - pred - corr);
        H.push(h);
      }
      const Ht = transpose(H);
      const S = matMul(matMul(H, PPrior), Ht);
      for (let i = 0; i < rows.length; i++)
        for (let j = 0; j < rows.length; j++) S[i]![j]! += R[i]![j]!;
      const Sinv = matInv(S);
      if (!Sinv) {
        this.lastMs = timeMs;
        return null;
      }
      K = matMul(matMul(PPrior, Ht), Sinv);
      const dx = matMul(
        K,
        v.map((s) => [s])
      );
      xi = xPrior.map((s, i) => s + dx[i]![0]!);
    }
    this.x = xi;
    // P = (I − K H) P⁻, then symmetrise.
    const KH = matMul(K, H);
    const IKH = zeros(n, n);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) IKH[i]![j] = (i === j ? 1 : 0) - KH[i]![j]!;
    const Pnew = matMul(IKH, PPrior);
    for (let i = 0; i < n; i++)
      for (let j = i; j < n; j++) {
        const s = (Pnew[i]![j]! + Pnew[j]![i]!) / 2;
        Pnew[i]![j] = s;
        Pnew[j]![i] = s;
      }
    this.P = Pnew;

    /* -- 10: bookkeeping + solution --------------------------------- */
    for (const g of geom) {
      if (g.cpR === null || g.cpB === null) continue;
      this.track.set(g.prn, { lockR: g.lockR, lockB: g.lockB, lastMs: timeMs });
    }
    this.lastMs = timeMs;

    const ambiguities: Record<string, number> = {};
    for (let k = 0; k < this.amb.length; k++)
      ambiguities[this.amb[k]!.prn] = this.x[3 + k]!;
    const refSatellites: Record<string, string> = {};
    for (const [group, ref] of newRefs) refSatellites[group] = ref.prn;
    const nSats = new Set(rows.flatMap((r) => [r.g.prn, r.ref.prn])).size;

    return {
      timeMs,
      position: [this.x[0]!, this.x[1]!, this.x[2]!],
      floatBaseline: [
        this.x[0]! - this.basePos[0],
        this.x[1]! - this.basePos[1],
        this.x[2]! - this.basePos[2],
      ],
      nSats,
      ratio: undefined,
      sigmas: [
        Math.sqrt(Math.max(this.P[0]![0]!, 0)),
        Math.sqrt(Math.max(this.P[1]![1]!, 0)),
        Math.sqrt(Math.max(this.P[2]![2]!, 0)),
      ],
      ambiguities,
      refSatellites,
    };
  }
}
