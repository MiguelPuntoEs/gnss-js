/**
 * Uncombined (raw-observation) PPP: every code and carrier of every
 * frequency enters the filter as itself, with the slant ionosphere of each
 * satellite as a state instead of being eliminated by the ionosphere-free
 * combination.
 *
 * Observation model, per satellite s and signal j (frequency f_j,
 * μ_j = f_ref² / f_j², f_ref = 1575.42 MHz for every system):
 *
 *   P_j = ρ + c·dt_r,grp − c·dt^s + T + μ_j·I + d_j + ΔP_j
 *   L_j = ρ + c·dt_r,grp − c·dt^s + T − μ_j·I + B_j (+ F_j) + ΔL_j
 *
 * - ρ, c·dt^s, T: geometry, product clock, troposphere (ZHD a priori, ZWD
 *   and gradients estimated) — as in the ionosphere-free engine.
 * - I: slant ionospheric delay at f_ref, one state per satellite. White
 *   noise by default (then two frequencies give exactly the information of
 *   the ionosphere-free combination plus the code–carrier ionosphere
 *   smoothing), or a random walk / a GIM pseudo-observation.
 * - B_j: carrier ambiguity in metres (λ_j·N_j plus the receiver and
 *   satellite phase biases), one per signal and arc.
 * - d_j: code bias. The satellite part is removed with observable-specific
 *   biases (Bias-SINEX OSB) when the source has them; the first two signals
 *   of a satellite define the clock / ionosphere datum (the product clock is
 *   the ionosphere-free clock of the analysis centre's reference pair, the
 *   receiver's differential bias of the pair goes into I). Any further
 *   signal carries a receiver code bias per clock group and tracking code,
 *   or — without a satellite OSB for it — a satellite-and-receiver code
 *   bias per satellite and signal.
 * - F_j: inter-frequency clock bias of the third GPS frequency (Block IIF
 *   and later L5, Montenbruck et al. 2012): a random-walk phase bias.
 * - ΔP_j, ΔL_j: per-band satellite and receiver antenna phase centres,
 *   phase wind-up × λ_j, higher-order ionosphere (PppCorrections
 *   `evaluateSignals`).
 *
 * Cycle slips are detected per frequency: the primary pair by the same
 * Melbourne–Wübbena and time-differenced ionosphere-free tests as the
 * ionosphere-free engine (any slip there resets every carrier of the
 * satellite), each further carrier by its geometry-free and
 * Melbourne–Wübbena combinations with the first, and loss-of-lock flags
 * per carrier.
 *
 * With two frequencies, white-noise ionosphere and matching weights, the
 * estimates equal the ionosphere-free engine's (the ionosphere-free code
 * and carrier are the only ionosphere-free information in two
 * frequencies, apart from the weak code–carrier "GRAPHIC" term) — the
 * equivalence the tests check on real data.
 */

import { C_LIGHT } from '../constants/gnss';
import { ecefToGeodetic, getEnuDifference, getAer } from '../coordinates/ecef';
import type { Sp3File } from '../rinex/sp3';
import type { IonexGrid } from '../rinex/ionex';
import { niellMapping } from './ppp-tropo';
import { gimSlantIonoDelayL1 } from './gim';
import { lambdaSearch } from './lambda';
import {
  ekfUpdateScalar,
  elevationVarianceFactor,
  gradientConfig,
  gradientMapping,
  satStateAtEmission,
  Sp3EphemerisSource,
  tdLsq,
  tdResidual,
  type PppEphemerisSource,
  type PppEpochResult,
  type PppOptions,
} from './ppp';
import type { PppMultiEpoch, PppSignal } from './ppp-signals';

/** Reference frequency of the slant ionosphere state (GPS L1, Hz). */
export const IONO_REF_FREQ = 1575.42e6;

export interface PppUncombinedOptions extends Omit<
  PppOptions,
  'codeSigma' | 'phaseSigma' | 'slipRepair' | 'ar' | 'exposeState' | 'osb'
> {
  /** Code σ of one signal at zenith (m). Default 0.5 — half the weight
   *  the ionosphere-free engine's 3 m gives its combination (≈ 1 m per
   *  signal): the float solution is about the same either way, and the
   *  wide lanes fix sooner (EPN stations, 2 h windows: 19–21 → 15–17 min
   *  median time to fix). */
  codeSigma?: number;
  /** Carrier σ of one signal at zenith (m). Default 0.003. */
  phaseSigma?: number;
  /** Per-signal σ factors on top of `systemSigmaScale` (e.g. a noisier
   *  third frequency). Default 1. */
  signalSigmaScale?: (
    prn: string,
    band: string,
    index: number
  ) => { code?: number; phase?: number } | undefined;
  /** Satellite observable-specific biases (Bias-SINEX OSB), as for
   *  {@link solvePpp}: code OSBs make every signal's code consistent with
   *  the product clock; phase OSBs make the ambiguities integer between
   *  satellites (needed for `ar`). */
  osb?: PppOptions['osb'];
  /**
   * The slant ionosphere state. 'white' (default): free every epoch.
   * 'random-walk': σ in m/√s at the reference frequency. `gim`: a global
   * ionosphere map as a pseudo-observation of every new and continuing
   * satellite's slant delay (σ `gimSigmaM`, default 1 m), with one
   * receiver differential code bias per clock group then estimated (the
   * map refers to the satellites' and the receiver's code biases removed).
   */
  ionosphere?: {
    model?: 'white' | 'random-walk';
    /** Random-walk σ (m/√s at 1575.42 MHz). Default 0.002. */
    sigmaMPerSqrtS?: number;
    gim?: IonexGrid;
    /** σ of the GIM slant delay (m at 1575.42 MHz). Default 1. */
    gimSigmaM?: number;
  };
  /**
   * The inter-frequency clock bias of the GPS L5 carrier (Block IIF and
   * later): a random-walk phase bias per satellite on band 5. σ in m/√s;
   * default 3e-4 (≈ 1.8 cm per √hour; the bias reaches 10–20 cm peak to
   * peak over half a day on Block IIF). `false`: none.
   */
  l5PhaseBias?: false | { sigmaMPerSqrtS?: number };
  /** Use at most this many signals per satellite (in their order).
   *  Default all. */
  maxSignals?: number;
  /** Max change of a further carrier's geometry-free phase with the first
   *  between consecutive epochs, beyond the ionospheric change the primary
   *  pair shows (m), before it is called a slip. Default 0.05. */
  gfSlipM?: number;
  /** Outlier gate on innovations (multiples of their σ). Default 4;
   *  0 disables (for exact comparisons). */
  gateK?: number;
  /**
   * Integer ambiguity resolution with satellite phase OSBs: extra-wide-
   * lane → wide-lane → narrow-lane cascade, LAMBDA with partial fixing,
   * between satellites of a clock group and tracking mode.
   */
  ar?:
    | boolean
    | {
        /** LAMBDA ratio threshold of the narrow lane. Default 3. */
        ratio?: number;
        /** Attempt interval (s). Default 30. */
        everyS?: number;
        /** Min arc age before an ambiguity is a candidate (s). Default 0. */
        minArcS?: number;
        /** Min between-satellite narrow-lane ambiguities. Default 5. */
        minFixed?: number;
        /** Max |float − integer| of a fixed extra-wide lane (cycles).
         *  Default 0.25. */
        maxFracWl?: number;
        /** Max |MW − integer| of a wide lane fixed from the between-
         *  satellite Melbourne–Wübbena average (cycles). Default 0.15. */
        wlThreshold?: number;
        /** Min epochs of Melbourne–Wübbena averaging. Default 10. */
        wlMinEpochs?: number;
        /** Min arc length of both satellites for a Melbourne–Wübbena wide
         *  lane (s). Default 600. */
        wlMinArcS?: number;
        /** Min bootstrapped success rate of the narrow-lane set. Default
         *  0.99. */
        successRate?: number;
        /** Max χ²/dof of the float vs fixed narrow lanes. Default 20. */
        maxChi2?: number;
      };
}

/** What one ambiguity-resolution attempt fixed. */
export interface ArAttemptStats {
  /** Extra-wide lanes fixed (rounding). */
  ewl: number;
  /** Wide lanes (and shorter extra lanes) fixed. */
  wl: number;
  /** Narrow lanes fixed (0: no fix). */
  nl: number;
  /** Narrow-lane candidates. */
  nlCandidates: number;
  /** LAMBDA ratio of the accepted (or first tried) narrow-lane set. */
  ratio: number;
}

/** Result of an uncombined session. */
export interface PppUncombinedSolution {
  position: [number, number, number];
  llh: [number, number, number];
  series: PppEpochResult[];
  ztdWet: number;
  ztdHydrostatic: number;
  epochsUsed: number;
  convergenceSec: number | null;
  finalError3d: number | null;
  /** States in the filter at the end (for cost accounting). */
  nStates: number;
  /** Signals left out for want of a satellite antenna calibration. */
  signalsWithoutSatAntenna: number;
  /** Carrier re-initialisations of continuing arcs (slips, loss of lock,
   *  short gaps), by constellation and band ('G5', 'E7' …). */
  resets: Record<string, number>;
  ar?: {
    /** Seconds to the first accepted fix (null: none). */
    firstFixSec: number | null;
    /** Share of epochs with an accepted fix. */
    fixedEpochShare: number;
    /** The fixed position at the end, or the last accepted one. */
    position: [number, number, number] | null;
    /** Narrow-lane ambiguities fixed at the end. */
    nFixedEnd: number;
    /** The last attempt's counts. */
    lastAttempt: ArAttemptStats | null;
  };
}

/** One signal of a satellite in view this epoch. */
interface SigVis {
  /** Band digit (unique per satellite). */
  band: string;
  /** Tracking code of the code and of the carrier. */
  code: string;
  phaseCode: string;
  freq: number;
  lam: number;
  mu: number;
  /** OSB-corrected pseudorange (m) and carrier (m). */
  P: number;
  L: number;
  /** Carrier in cycles (OSB-corrected), for the slip tests. */
  cyc: number;
  codeCorr: number;
  phaseCorr: number;
  /** Code-bias state key, if this code carries one. */
  biasKey: string | null;
  /** Carrier inter-frequency bias state key, if any. */
  ifcbKey: string | null;
  slip: boolean;
  /** Use the code (false: a code without any bias handling). */
  useCode: boolean;
  /** The satellite phase bias was removed: the ambiguity is an integer
   *  between satellites. */
  fixable: boolean;
}

interface Vis {
  prn: string;
  grp: string;
  e: [number, number, number];
  elRad: number;
  azRad: number;
  satClkM: number;
  range: number;
  /** ZHD·m_h + a-priori gradient + common corrections (m). */
  tropoFixed: number;
  mw: number;
  mgN: number;
  mgE: number;
  sat: [number, number, number];
  sigs: SigVis[];
  /** Ionosphere-free code / carrier of the first two signals (m), the
   *  carrier's model terms, and their GF / MW, for the pair slip tests. */
  pIf: number;
  lIf: number;
  ifCodeCorr: number;
  ifPhaseCorr: number;
  gfPair: number;
  mwPair: number;
  pairSlip: boolean;
  /** GIM slant delay at f_ref (m), when constrained. */
  gimM: number | null;
}

const IDX_X = 0;
const IDX_Y = 1;
const IDX_Z = 2;
const IDX_ZWD = 3;
const IDX_GN = 4;
const IDX_GE = 5;
const NBASE = 6;
const CLK_VAR = 1e10;
const POS_VAR = 60 * 60;
const AMB_VAR = 100 * 100;
const IONO_WHITE_VAR = 1000 * 1000;
const IONO_INIT_VAR = 100 * 100;
const CODE_BIAS_VAR = 30 * 30;
const TD_SLIP_M = 0.08;
const TD_SURE_M = 0.3;
const GF_CONFIRM_M = 0.03;
const CODE_GATE_M = 15;

const wetSlant = (
  x: readonly number[],
  v: { mw: number; mgN: number; mgE: number }
) => x[IDX_ZWD]! * v.mw + x[IDX_GN]! * v.mgN + x[IDX_GE]! * v.mgE;

/**
 * Streaming uncombined PPP — the same epoch-by-epoch EKF interface as
 * {@link PppEngine}, on multi-signal epochs.
 */
export class PppUncombinedEngine {
  private readonly source: PppEphemerisSource;
  private readonly opts: PppUncombinedOptions;
  private readonly elevMask: number;
  private readonly kinematic: boolean;
  private readonly truth?: [number, number, number];
  private readonly gateK: number;
  private readonly ionoModel: 'white' | 'random-walk';
  private readonly ionoQ: number;

  private x: number[] = [];
  private P: number[][] = [];
  /** State index by key ('clk:G', 'I:G05', 'N:G05:1', 'D:G:5Q', …). */
  private idx = new Map<string, number>();
  private clockSeeded = new Set<string>();
  /** Melbourne–Wübbena running means of the primary pair, per satellite. */
  private mwState = new Map<
    string,
    { mean: number; n: number; lastEi: number }
  >();
  /** Per satellite and further band: MW running mean with the first. */
  private mwExtra = new Map<
    string,
    { mean: number; n: number; lastEi: number }
  >();
  private tdPrev = new Map<
    string,
    {
      ei: number;
      lIf: number;
      sat: [number, number, number];
      model: number;
      gf: number;
      mw: number;
      /** Geometry-free phase of each further band with the first (m). */
      gfx: Map<string, number>;
    }
  >();
  private phaseRejects = new Map<string, number>();
  private lastSeen = new Map<string, number>();
  /** Start of each ambiguity's arc (ms), for AR. */
  private arcStart = new Map<string, number>();
  private series: PppEpochResult[] = [];
  private ei = 0;
  private t0 = 0;
  private lastEpochMs: number | null = null;
  private convergenceSec: number | null = null;
  private convergedStreak = 0;
  private signalsWithoutSatAntenna = 0;
  private resets: Record<string, number> = {};
  // AR bookkeeping.
  private lastFix: {
    position: [number, number, number];
    nFixed: number;
  } | null = null;
  private lastAccepted: [number, number, number] | null = null;
  private lastArMs = -Infinity;
  private firstFixMs: number | null = null;
  private fixedEpochs = 0;
  private lastAttempt: ArAttemptStats | null = null;

  constructor(opts: PppUncombinedOptions, source: PppEphemerisSource) {
    this.opts = opts;
    this.source = source;
    this.elevMask = ((opts.elevationMaskDeg ?? 10) * Math.PI) / 180;
    this.kinematic = opts.mode === 'kinematic';
    this.truth = opts.groundTruth;
    this.gateK = opts.gateK ?? 4;
    this.ionoModel = opts.ionosphere?.model ?? 'white';
    this.ionoQ = (opts.ionosphere?.sigmaMPerSqrtS ?? 0.002) ** 2;
    this.x = [
      opts.aprioriPos[0],
      opts.aprioriPos[1],
      opts.aprioriPos[2],
      0.1,
      0,
      0,
    ];
    for (let i = 0; i < NBASE; i++)
      this.P.push(new Array<number>(NBASE).fill(0));
    const s0 = (opts.aprioriSigmaM ?? 100) ** 2;
    this.P[IDX_X]![IDX_X] = s0;
    this.P[IDX_Y]![IDX_Y] = s0;
    this.P[IDX_Z]![IDX_Z] = s0;
    this.P[IDX_ZWD]![IDX_ZWD] = 0.25;
    const grad = gradientConfig(opts);
    if (grad) {
      this.P[IDX_GN]![IDX_GN] = grad.sigmaM ** 2;
      this.P[IDX_GE]![IDX_GE] = grad.sigmaM ** 2;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  State bookkeeping                                                */
  /* ---------------------------------------------------------------- */

  private grow(key: string, value: number, variance: number): number {
    const i = this.x.length;
    this.x.push(value);
    for (const row of this.P) row.push(0);
    this.P.push(new Array<number>(this.x.length).fill(0));
    this.P[i]![i] = variance;
    this.idx.set(key, i);
    return i;
  }

  /** Reset a state: new value, variance, no correlation. */
  private resetState(i: number, value: number, variance: number): void {
    const { P } = this;
    this.x[i] = value;
    for (let j = 0; j < P.length; j++) {
      P[i]![j] = 0;
      P[j]![i] = 0;
    }
    P[i]![i] = variance;
  }

  private drop(keys: string[]): void {
    const rm = keys
      .map((k) => this.idx.get(k))
      .filter((i): i is number => i !== undefined)
      .sort((a, b) => b - a);
    if (!rm.length) return;
    const gone = new Set(rm);
    const keep: number[] = [];
    for (let i = 0; i < this.x.length; i++) if (!gone.has(i)) keep.push(i);
    const map = new Map<number, number>();
    keep.forEach((old, k) => map.set(old, k));
    this.x = keep.map((i) => this.x[i]!);
    this.P = keep.map((i) => {
      const row = this.P[i]!;
      return keep.map((j) => row[j]!);
    });
    for (const k of keys) this.idx.delete(k);
    for (const [k, i] of this.idx) this.idx.set(k, map.get(i)!);
  }

  private clockOf(grp: string): number {
    return this.idx.get(`clk:${grp}`) ?? this.grow(`clk:${grp}`, 0, CLK_VAR);
  }

  /* ---------------------------------------------------------------- */
  /*  One epoch                                                        */
  /* ---------------------------------------------------------------- */

  process(epoch: PppMultiEpoch): PppEpochResult {
    const { opts, source, kinematic } = this;
    const clockGroup = opts.clockGroup ?? ((prn: string) => prn[0]!);
    const ei = this.ei;
    if (ei === 0) this.t0 = epoch.timeMs;
    const dtS =
      this.lastEpochMs === null
        ? 0
        : Math.max(0, epoch.timeMs - this.lastEpochMs) / 1000;

    // ── Time update ──
    const holding =
      ei > 0 &&
      (opts.initialStaticSec ?? 0) > 0 &&
      epoch.timeMs - this.t0 < (opts.initialStaticSec ?? 0) * 1000;
    if (kinematic && ei > 0 && !holding)
      for (const p of [IDX_X, IDX_Y, IDX_Z])
        this.resetState(p, this.x[p]!, POS_VAR);
    for (const [k, i] of this.idx) {
      if (k.startsWith('clk:')) this.P[i]![i] = CLK_VAR;
      else if (k.startsWith('I:')) {
        if (this.ionoModel === 'white')
          this.resetState(i, this.x[i]!, IONO_WHITE_VAR);
        else this.P[i]![i]! += this.ionoQ * dtS;
      } else if (k.startsWith('F:')) {
        const s =
          opts.l5PhaseBias === false
            ? 0
            : (opts.l5PhaseBias?.sigmaMPerSqrtS ?? 3e-4);
        this.P[i]![i]! += s * s * dtS;
      }
    }
    this.P[IDX_ZWD]![IDX_ZWD]! +=
      (opts.ztdProcessNoise ?? 1e-8) * (ei > 0 ? 1 : 0);
    const grad = gradientConfig(opts);
    if (grad && this.lastEpochMs !== null) {
      const q = grad.randomWalkMPerSqrtH ** 2 * (dtS / 3600);
      this.P[IDX_GN]![IDX_GN]! += q;
      this.P[IDX_GE]![IDX_GE]! += q;
    }
    this.lastEpochMs = epoch.timeMs;

    const x0 = this.x;
    const rcv: [number, number, number] = [x0[IDX_X]!, x0[IDX_Y]!, x0[IDX_Z]!];
    this.rcvRef = rcv;
    const [latRad, lonRad, heightM] = ecefToGeodetic(rcv[0], rcv[1], rcv[2]);
    const corrections = opts.corrections;
    const epochCtx = corrections?.epochContext?.(epoch.timeMs, rcv) ?? null;
    const gim = opts.ionosphere?.gim;
    const minSignals = gim ? 1 : 2;
    const maxSignals = opts.maxSignals ?? Infinity;

    // ── Pass 1: geometry and the per-signal observations ──
    const vis: Vis[] = [];
    let epochZhd = 0;
    for (const raw of epoch.obs) {
      const prn = raw.prn;
      const grp = clockGroup(prn);
      const sigs0 = raw.signals
        .filter(
          (s) => s.pr && s.cp && Number.isFinite(s.pr) && Number.isFinite(s.cp)
        )
        .slice(0, maxSignals);
      if (sigs0.length < minSignals) continue;
      // Satellite biases per signal.
      const biased: {
        s: PppSignal;
        P: number;
        cyc: number;
        codeOsb: boolean;
        phaseOsb: boolean;
      }[] = [];
      for (const s of sigs0) {
        const cb = source.codeBias?.(prn, s.code, epoch.timeMs) ?? null;
        let cyc = s.cp;
        // A carrier without a satellite phase bias stays in the float
        // solution; only its ambiguity is not integer.
        const pb = this.phaseBiasOf(prn, s, epoch.timeMs);
        if (pb !== null) cyc -= pb / (C_LIGHT / s.freq);
        biased.push({
          s,
          P: s.pr - (cb ?? 0),
          cyc,
          codeOsb: cb != null,
          phaseOsb: pb !== null,
        });
      }
      if (biased.length < minSignals) continue;
      // The primary pair must stay the satellite's first two signals.
      if (
        biased[0]!.s !== sigs0[0] ||
        (minSignals === 2 && biased[1]!.s !== sigs0[1])
      )
        continue;
      // Melbourne–Wübbena of the primary pair — for every satellite with
      // data, in view or not (as the ionosphere-free engine).
      const mwSlip =
        biased.length >= 2
          ? this.pairMw(prn, biased[0]!, biased[1]!, ei)
          : false;
      const sat = satStateAtEmission(
        source,
        prn,
        epoch.timeMs,
        rcv,
        biased[0]!.P
      );
      if (!sat) continue;
      const [elRad, azRad] = getAer(
        sat.state.x,
        sat.state.y,
        sat.state.z,
        rcv[0],
        rcv[1],
        rcv[2]
      );
      if (elRad < this.elevMask) continue;
      const dx = sat.state.x - rcv[0];
      const dy = sat.state.y - rcv[1];
      const dz = sat.state.z - rcv[2];
      const range = Math.hypot(dx, dy, dz);
      const e: [number, number, number] = [dx / range, dy / range, dz / range];
      const trop =
        (opts.troposphere ?? true)
          ? opts.troposphereModel
            ? opts.troposphereModel.delays(
                epoch.timeMs,
                latRad,
                lonRad,
                heightM,
                elRad,
                azRad
              )
            : {
                ...niellMapping(elRad, latRad, heightM, epoch.timeMs),
                gradient: 0,
              }
          : { zhd: 0, mh: 0, mw: 0, gradient: 0 };
      epochZhd = trop.zhd;
      const corr = corrections?.evaluateSignals
        ? corrections.evaluateSignals(
            {
              prn,
              satEcef: [sat.state.x, sat.state.y, sat.state.z],
              ...(sat.state.vel ? { satVel: sat.state.vel } : {}),
              rcvEcef: rcv,
              los: e,
              elRad,
              azRad,
              signals: biased.map((b) => ({
                band: b.s.antexBand,
                freq: b.s.freq,
              })),
            },
            epochCtx
          )
        : null;
      if (corr?.exclude) continue;
      const sigs: SigVis[] = [];
      biased.forEach((b, k) => {
        if (corr?.missing[k]) {
          this.signalsWithoutSatAntenna++;
          return;
        }
        const lam = C_LIGHT / b.s.freq;
        sigs.push({
          band: b.s.band,
          code: b.s.code,
          phaseCode: b.s.phaseCode ?? b.s.code,
          freq: b.s.freq,
          lam,
          mu: (IONO_REF_FREQ / b.s.freq) ** 2,
          P: b.P,
          L: b.cyc * lam,
          cyc: b.cyc,
          codeCorr: corr ? corr.codeM[k]! : 0,
          phaseCorr: corr ? corr.phaseM[k]! : 0,
          biasKey: null,
          ifcbKey: null,
          slip: !!b.s.lli,
          useCode: true,
          fixable: b.phaseOsb,
        });
      });
      if (sigs.length < minSignals) continue;
      if (
        minSignals === 2 &&
        (sigs[0]!.band !== biased[0]!.s.band ||
          sigs[1]!.band !== biased[1]!.s.band)
      )
        continue;
      // Code biases of further signals.
      sigs.forEach((s, k) => {
        if (k < 2) return;
        const osb = biased.find((b) => b.s.band === s.band)!.codeOsb;
        s.biasKey = osb ? `D:${grp}:${s.code}` : `S:${prn}:${s.code}`;
        if (prn[0] === 'G' && s.band === '5' && opts.l5PhaseBias !== false)
          s.ifcbKey = `F:${prn}:5`;
      });
      const a = sigs[0]!;
      const b = sigs[1];
      let pIf = 0;
      let lIf = 0;
      let ifCodeCorr = 0;
      let ifPhaseCorr = 0;
      let gfPair = 0;
      let mwPair = 0;
      if (b) {
        const g = (a.freq * a.freq) / (a.freq * a.freq - b.freq * b.freq);
        pIf = g * a.P - (g - 1) * b.P;
        lIf = g * a.L - (g - 1) * b.L;
        ifCodeCorr = g * a.codeCorr - (g - 1) * b.codeCorr;
        ifPhaseCorr = g * a.phaseCorr - (g - 1) * b.phaseCorr;
        gfPair = a.L - b.L;
        const lamW = C_LIGHT / (a.freq - b.freq);
        mwPair =
          a.cyc -
          b.cyc -
          (a.freq * a.P + b.freq * b.P) / (a.freq + b.freq) / lamW;
      }
      const gimL1 = gim
        ? gimSlantIonoDelayL1(gim, latRad, lonRad, azRad, elRad, epoch.timeMs)
        : null;
      if (gim && gimL1 === null && sigs.length < 2) continue;
      vis.push({
        prn,
        grp,
        e,
        elRad,
        azRad,
        satClkM: sat.state.clkM,
        range,
        tropoFixed: trop.zhd * trop.mh + trop.gradient + (corr?.rangeM ?? 0),
        mw: trop.mw,
        mgN: grad ? gradientMapping(elRad) * Math.cos(azRad) : 0,
        mgE: grad ? gradientMapping(elRad) * Math.sin(azRad) : 0,
        sat: [sat.state.x, sat.state.y, sat.state.z],
        sigs,
        pIf,
        lIf,
        ifCodeCorr,
        ifPhaseCorr,
        gfPair,
        mwPair,
        pairSlip: mwSlip,
        gimM: gimL1,
      });
    }
    if (!vis.length && (opts.troposphere ?? true))
      epochZhd = opts.troposphereModel
        ? opts.troposphereModel.delays(
            epoch.timeMs,
            latRad,
            lonRad,
            heightM,
            Math.PI / 2,
            0
          ).zhd
        : niellMapping(Math.PI / 2, latRad, heightM, epoch.timeMs).zhd;

    // ── Slip detection ──
    this.detectSlips(vis, ei, rcv);

    // ── Clock seeds and gross code screening (ionosphere-free code of the
    // primary pair, as the ionosphere-free engine) ──
    const x = this.x;
    const P = this.P;
    const bySys = new Map<string, number[]>();
    const codeRes = (v: Vis) =>
      v.sigs.length >= 2
        ? v.pIf -
          v.ifCodeCorr -
          (v.range - v.satClkM + v.tropoFixed + wetSlant(x, v))
        : v.sigs[0]!.P -
          v.sigs[0]!.codeCorr -
          (v.gimM ?? 0) * v.sigs[0]!.mu -
          (v.range - v.satClkM + v.tropoFixed + wetSlant(x, v));
    for (const v of vis) {
      const r = codeRes(v);
      const arr = bySys.get(v.grp);
      if (arr) arr.push(r);
      else bySys.set(v.grp, [r]);
    }
    const posSigma = Math.sqrt(
      P[IDX_X]![IDX_X]! + P[IDX_Y]![IDX_Y]! + P[IDX_Z]![IDX_Z]!
    );
    const codeGate = CODE_GATE_M + 3 * posSigma;
    const screened = new Set<string>();
    for (const [grp, res] of bySys) {
      if (res.length < 4) continue;
      const med = [...res].sort((p, q) => p - q)[Math.floor(res.length / 2)]!;
      for (const v of vis)
        if (v.grp === grp && Math.abs(codeRes(v) - med) > codeGate)
          screened.add(v.prn);
    }
    for (const [grp, res] of bySys) {
      const ci = this.clockOf(grp);
      if (!this.clockSeeded.has(grp)) {
        res.sort((p, q) => p - q);
        this.x[ci] = res[Math.floor(res.length / 2)]!;
        this.clockSeeded.add(grp);
      }
      this.P[ci]![ci] = CLK_VAR;
    }

    // ── Pass 2: measurement updates ──
    const live = vis.filter((v) => !screened.has(v.prn));
    for (const v of live) this.prepStates(v, epoch.timeMs);
    if (kinematic) {
      for (const v of live) this.codeUpdates(v, rcv);
      for (const v of live) this.phaseUpdates(v, rcv);
    } else
      for (const v of live) {
        this.codeUpdates(v, rcv);
        this.phaseUpdates(v, rcv);
      }
    let nSats = 0;
    for (const v of live) {
      this.lastSeen.set(v.prn, ei);
      nSats++;
    }

    // Post-fit carrier residuals (per clock group, mean removed).
    let sumSq = 0;
    let nRes = 0;
    {
      const byGrp = new Map<string, number[]>();
      for (const v of live)
        for (const s of v.sigs) {
          const r = this.phaseInnovation(v, s, rcv);
          if (r === null || Math.abs(r) >= 0.15) continue;
          const arr = byGrp.get(v.grp);
          if (arr) arr.push(r);
          else byGrp.set(v.grp, [r]);
        }
      for (const res of byGrp.values()) {
        const m = res.reduce((p, q) => p + q, 0) / res.length;
        for (const r of res) {
          sumSq += (r - m) ** 2;
          nRes++;
        }
      }
    }

    // Satellites unseen for > 20 epochs: drop their states.
    for (const [prn, seen] of [...this.lastSeen]) {
      if (ei - seen <= 20) continue;
      this.lastSeen.delete(prn);
      const keys = [...this.idx.keys()].filter(
        (k) =>
          k.split(':')[1] === prn &&
          !k.startsWith('D:') &&
          !k.startsWith('clk:')
      );
      for (const k of keys) this.arcStart.delete(k);
      this.drop(keys);
      this.tdPrev.delete(prn);
    }

    this.tryFix(epoch.timeMs, live);
    if (this.lastFix) this.fixedEpochs++;

    const X = this.x;
    const pos: [number, number, number] = [X[IDX_X]!, X[IDX_Y]!, X[IDX_Z]!];
    const truth = this.truth;
    let enu: [number, number, number] | null = null;
    let error3d: number | null = null;
    if (truth) {
      enu = getEnuDifference(
        pos[0],
        pos[1],
        pos[2],
        truth[0],
        truth[1],
        truth[2]
      );
      error3d = Math.hypot(
        pos[0] - truth[0],
        pos[1] - truth[1],
        pos[2] - truth[2]
      );
      if (error3d < 0.1) {
        this.convergedStreak++;
        if (this.convergedStreak >= 10 && this.convergenceSec == null)
          this.convergenceSec = (epoch.timeMs - this.t0) / 1000;
      } else {
        this.convergedStreak = 0;
        this.convergenceSec = null;
      }
    }
    const PP = this.P;
    const result: PppEpochResult = {
      timeMs: epoch.timeMs,
      enu,
      error3d,
      position: pos,
      nSats,
      ztdWet: X[IDX_ZWD]!,
      ztdHydrostatic: epochZhd,
      ztdSigma: Math.sqrt(PP[IDX_ZWD]![IDX_ZWD]!),
      ...(opts.estimateGradients
        ? {
            gradients: {
              n: X[IDX_GN]!,
              e: X[IDX_GE]!,
              sigmaN: Math.sqrt(PP[IDX_GN]![IDX_GN]!),
              sigmaE: Math.sqrt(PP[IDX_GE]![IDX_GE]!),
            },
          }
        : {}),
      phaseResRms: nRes ? Math.sqrt(sumSq / nRes) : 0,
      posSigma3d: Math.sqrt(
        PP[IDX_X]![IDX_X]! + PP[IDX_Y]![IDX_Y]! + PP[IDX_Z]![IDX_Z]!
      ),
      nFixed: this.lastFix?.nFixed ?? 0,
      fixedPosition: this.lastFix?.position ?? null,
    };
    this.series.push(result);
    this.ei = ei + 1;
    return result;
  }

  /* ---------------------------------------------------------------- */
  /*  Cycle slips                                                      */
  /* ---------------------------------------------------------------- */

  /** Satellite phase bias (m) of a carrier: its own tracking mode, else
   *  another of the same band (a constant offset between tracking modes is
   *  common to all satellites and cancels between them). */
  private phaseBiasOf(prn: string, s: PppSignal, tMs: number): number | null {
    const pb = this.source.phaseBias;
    if (!pb) return null;
    const own = pb(prn, s.phaseCode ?? s.code, tMs);
    if (own !== null) return own;
    for (const a of 'CIQXWLSPDZB') {
      const v = pb(prn, s.band + a, tMs);
      if (v !== null) return v;
    }
    return null;
  }

  /** Melbourne–Wübbena slip test of a satellite's primary pair; true on a
   *  slip, a new arc or a loss-of-lock flag. */
  private pairMw(
    prn: string,
    a: { s: PppSignal; P: number; cyc: number },
    b: { s: PppSignal; P: number; cyc: number },
    ei: number
  ): boolean {
    const lamW = C_LIGHT / (a.s.freq - b.s.freq);
    const mw =
      a.cyc -
      b.cyc -
      (a.s.freq * a.P + b.s.freq * b.P) / (a.s.freq + b.s.freq) / lamW;
    const st = this.mwState.get(prn);
    let slip = !!(a.s.lli || b.s.lli);
    if (!st || ei - st.lastEi > 2) slip = true;
    else if (Math.abs(mw - st.mean) > 4) slip = true;
    if (slip) this.mwState.set(prn, { mean: mw, n: 1, lastEi: ei });
    else {
      const n = st!.n + 1;
      this.mwState.set(prn, {
        mean: st!.mean + (mw - st!.mean) / Math.min(n, 100),
        n,
        lastEi: ei,
      });
    }
    return slip;
  }

  private detectSlips(
    vis: Vis[],
    ei: number,
    rcv: [number, number, number]
  ): void {
    const gfSlip = this.opts.gfSlipM ?? 0.05;
    // Time-differenced ionosphere-free carrier of the primary pair, a
    // candidate confirmed by a geometry-free jump (as the ionosphere-free
    // engine does in effect: its Melbourne–Wübbena confirmation compares
    // the wet mapping function, which never jumps).
    const dq: { v: Vis; d: number; gfJump: number }[] = [];
    const gfx = new Map<string, Map<string, number>>();
    for (const v of vis) {
      if (v.sigs.length < 2) continue;
      const prev = this.tdPrev.get(v.prn);
      const model = -v.satClkM + v.tropoFixed + v.ifPhaseCorr;
      const a = v.sigs[0]!;
      const gfNow = new Map<string, number>();
      for (const s of v.sigs.slice(2)) gfNow.set(s.band, a.L - s.L);
      gfx.set(v.prn, gfNow);
      if (prev && prev.ei === ei - 1 && !v.pairSlip) {
        const r0 = Math.hypot(
          prev.sat[0] - rcv[0],
          prev.sat[1] - rcv[1],
          prev.sat[2] - rcv[2]
        );
        dq.push({
          v,
          d: v.lIf - prev.lIf - (v.range - r0) - (model - prev.model),
          gfJump: Math.abs(v.gfPair - prev.gf),
        });
      }
      // Further carriers against the first: geometry-free jump, MW jump.
      for (const s of v.sigs.slice(2)) {
        const key = `${v.prn}:${s.band}`;
        const lamW = C_LIGHT / Math.abs(a.freq - s.freq);
        const mw =
          (a.cyc - s.cyc) * Math.sign(a.freq - s.freq) -
          (a.freq * a.P + s.freq * s.P) / (a.freq + s.freq) / lamW;
        const st = this.mwExtra.get(key);
        const pg = prev?.gfx.get(s.band);
        let slip =
          s.slip ||
          v.pairSlip ||
          !prev ||
          prev.ei !== ei - 1 ||
          pg === undefined;
        // The pair's own geometry-free change measures the ionosphere's:
        // scaled to this band it leaves the slip (and noise) alone.
        const k = (s.mu - a.mu) / (v.sigs[1]!.mu - a.mu);
        if (
          !slip &&
          Math.abs(gfNow.get(s.band)! - pg! - k * (v.gfPair - prev!.gf)) >
            gfSlip
        )
          slip = true;
        if (!st || ei - st.lastEi > 2 || (st && Math.abs(mw - st.mean) > 4))
          slip = true;
        if (slip) this.mwExtra.set(key, { mean: mw, n: 1, lastEi: ei });
        else {
          const n = st!.n + 1;
          this.mwExtra.set(key, {
            mean: st!.mean + (mw - st!.mean) / Math.min(n, 100),
            n,
            lastEi: ei,
          });
        }
        s.slip = slip;
      }
      this.tdPrev.set(v.prn, {
        ei,
        lIf: v.lIf,
        sat: v.sat,
        model,
        gf: v.gfPair,
        mw: v.mwPair,
        gfx: gfNow,
      });
    }
    if (!this.kinematic) {
      if (dq.length >= 4) {
        const med = dq.map((q) => q.d).sort((p, q) => p - q)[
          Math.floor(dq.length / 2)
        ]!;
        for (const q of dq) {
          const r = Math.abs(q.d - med);
          if (r > TD_SLIP_M && (r > TD_SURE_M || q.gfJump > GF_CONFIRM_M))
            q.v.pairSlip = true;
        }
      }
    } else if (dq.length >= 6) {
      let use = dq;
      for (let iter = 0; iter < 6; iter++) {
        const sol = use.length >= 6 ? tdLsq(use) : null;
        if (!sol) {
          for (const q of dq) q.v.pairSlip = true;
          break;
        }
        let worst = -1;
        let worstR = 0;
        use.forEach((q, k) => {
          const r = Math.abs(tdResidual(q, sol));
          if (r > worstR) {
            worstR = r;
            worst = k;
          }
        });
        if (worstR <= TD_SLIP_M || iter === 5) {
          for (const q of dq)
            if (Math.abs(tdResidual(q, sol)) > TD_SLIP_M) q.v.pairSlip = true;
          break;
        }
        use = use.filter((_, k) => k !== worst);
      }
    } else for (const q of dq) q.v.pairSlip = true;
    // A pair slip resets every carrier of the satellite.
    for (const v of vis) {
      if (v.pairSlip) for (const s of v.sigs) s.slip = true;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Measurement model                                                */
  /* ---------------------------------------------------------------- */

  /** Range at the current position estimate (linearised about it). */
  private rangeNow(v: Vis, rcv: [number, number, number]): number {
    const x = this.x;
    return (
      v.range -
      (v.e[0] * (x[IDX_X]! - rcv[0]) +
        v.e[1] * (x[IDX_Y]! - rcv[1]) +
        v.e[2] * (x[IDX_Z]! - rcv[2]))
    );
  }

  private common(v: Vis, rcv: [number, number, number]): number {
    const x = this.x;
    return (
      this.rangeNow(v, rcv) +
      x[this.clockOf(v.grp)]! -
      v.satClkM +
      v.tropoFixed +
      wetSlant(x, v)
    );
  }

  /** Create the satellite's states on first sight; reset slipped carriers. */
  private prepStates(v: Vis, tMs: number): void {
    const { x } = this;
    const prn = v.prn;
    const ionoKey = `I:${prn}`;
    let ii = this.idx.get(ionoKey);
    // A-priori ionosphere: the GIM, else the code geometry-free of the pair.
    const a = v.sigs[0]!;
    const b = v.sigs[1];
    const iCode = b
      ? (b.P - b.codeCorr - (a.P - a.codeCorr)) / (b.mu - a.mu)
      : (v.gimM ?? 0);
    if (ii === undefined) {
      ii = this.grow(
        ionoKey,
        iCode,
        this.ionoModel === 'white' ? IONO_WHITE_VAR : IONO_INIT_VAR
      );
    }
    const gimSigma = this.opts.ionosphere?.gimSigmaM ?? 1;
    if (v.gimM !== null) {
      // Receiver differential code bias of the clock group (the GIM is
      // free of it; the pair's code geometry-free carries it).
      const dKey = `DCB:${v.grp}`;
      const di = this.idx.get(dKey) ?? this.grow(dKey, 0, 30 * 30);
      const h = new Array<number>(x.length).fill(0);
      h[ii] = 1;
      h[di] = -1;
      ekfUpdateScalar(
        this.x,
        this.P,
        h,
        v.gimM - (this.x[ii]! - this.x[di]!),
        gimSigma * gimSigma,
        0
      );
    }
    const common = this.common(v, this.lastRcv());
    for (const s of v.sigs) {
      const key = `N:${prn}:${s.band}`;
      const ai = this.idx.get(key);
      const init = s.L - (common + s.phaseCorr - s.mu * this.x[ii]!);
      if (ai === undefined) {
        this.grow(key, init, AMB_VAR);
        this.arcStart.set(key, tMs);
      } else if (s.slip) {
        this.resetState(ai, init, AMB_VAR);
        this.arcStart.set(key, tMs);
        const k = prn[0]! + s.band;
        this.resets[k] = (this.resets[k] ?? 0) + 1;
      }
      if (s.biasKey && !this.idx.has(s.biasKey)) {
        const rcv = this.lastRcv();
        const bInit =
          s.P - (this.common(v, rcv) + s.codeCorr + s.mu * this.x[ii]!);
        this.grow(
          s.biasKey,
          s.biasKey.startsWith('S:') ? bInit : 0,
          CODE_BIAS_VAR
        );
      }
      if (s.ifcbKey && !this.idx.has(s.ifcbKey)) this.grow(s.ifcbKey, 0, 0);
    }
  }

  /** The receiver position the epoch's geometry was computed at. */
  private rcvRef: [number, number, number] = [0, 0, 0];
  private lastRcv(): [number, number, number] {
    return this.rcvRef;
  }

  private sigma(v: Vis, s: SigVis, k: number): { rc: number; rp: number } {
    const o = this.opts;
    const sys = v.prn[0]!;
    const sc = o.systemSigmaScale?.[sys];
    const ss = o.signalSigmaScale?.(v.prn, s.band, k);
    const w = elevationVarianceFactor(v.elRad, o.elevationWeighting);
    const c = (o.codeSigma ?? 0.5) * (sc?.code ?? 1) * (ss?.code ?? 1);
    const p = (o.phaseSigma ?? 0.003) * (sc?.phase ?? 1) * (ss?.phase ?? 1);
    return { rc: c * c * w, rp: p * p * w };
  }

  private baseH(v: Vis): number[] {
    const h = new Array<number>(this.x.length).fill(0);
    h[IDX_X] = -v.e[0];
    h[IDX_Y] = -v.e[1];
    h[IDX_Z] = -v.e[2];
    h[this.clockOf(v.grp)] = 1;
    h[IDX_ZWD] = v.mw;
    h[IDX_GN] = v.mgN;
    h[IDX_GE] = v.mgE;
    return h;
  }

  private codeUpdates(v: Vis, rcv: [number, number, number]): void {
    const ii = this.idx.get(`I:${v.prn}`)!;
    v.sigs.forEach((s, k) => {
      if (!s.useCode) return;
      const bi = s.biasKey ? this.idx.get(s.biasKey) : undefined;
      const x = this.x;
      const model =
        this.common(v, rcv) +
        s.codeCorr +
        s.mu * x[ii]! +
        (bi !== undefined ? x[bi]! : 0);
      const h = this.baseH(v);
      h[ii] = s.mu;
      if (bi !== undefined) h[bi] = 1;
      const innov = s.P - model;
      if (Math.abs(innov) < 1e6)
        ekfUpdateScalar(
          this.x,
          this.P,
          h,
          innov,
          this.sigma(v, s, k).rc,
          this.gateK
        );
    });
  }

  private phaseInnovation(
    v: Vis,
    s: SigVis,
    rcv: [number, number, number]
  ): number | null {
    const ii = this.idx.get(`I:${v.prn}`);
    const ai = this.idx.get(`N:${v.prn}:${s.band}`);
    if (ii === undefined || ai === undefined) return null;
    const fi = s.ifcbKey ? this.idx.get(s.ifcbKey) : undefined;
    const x = this.x;
    return (
      s.L -
      (this.common(v, rcv) +
        s.phaseCorr -
        s.mu * x[ii]! +
        x[ai]! +
        (fi !== undefined ? x[fi]! : 0))
    );
  }

  private phaseUpdates(v: Vis, rcv: [number, number, number]): void {
    const ii = this.idx.get(`I:${v.prn}`)!;
    v.sigs.forEach((s, k) => {
      const key = `N:${v.prn}:${s.band}`;
      const ai = this.idx.get(key)!;
      const fi = s.ifcbKey ? this.idx.get(s.ifcbKey) : undefined;
      const innov = this.phaseInnovation(v, s, rcv)!;
      const rejects = this.phaseRejects.get(key) ?? 0;
      if (rejects >= 3) {
        // A run of gated-out carriers: the ambiguity itself is wrong.
        const x = this.x;
        this.resetState(ai, x[ai]! + innov, AMB_VAR);
        this.arcStart.set(key, this.lastEpochMs ?? 0);
        this.phaseRejects.delete(key);
        return;
      }
      const h = this.baseH(v);
      h[ii] = -s.mu;
      h[ai] = 1;
      if (fi !== undefined) h[fi] = 1;
      const used = ekfUpdateScalar(
        this.x,
        this.P,
        h,
        innov,
        this.sigma(v, s, k).rp,
        this.gateK
      );
      if (used) this.phaseRejects.delete(key);
      else this.phaseRejects.set(key, rejects + 1);
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Ambiguity resolution                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Integer ambiguity resolution on a copy of the filter (the float filter
   * itself is never constrained). Between-satellite (SD) ambiguities in
   * cycles, per clock group and carrier tracking mode, are taken through
   * the cascade per satellite — extra-wide lanes (second signal minus each
   * further one), the wide lane (first minus second), the narrow lane (the
   * first signal itself) — each step fixed and then imposed as a constraint
   * before the next, so the shorter lanes are resolved on an already
   * sharpened float solution.
   */
  private tryFix(tMs: number, vis: readonly Vis[]): void {
    const ar = this.opts.ar;
    if (!ar || !this.source.phaseBias) return;
    const cfg = ar === true ? {} : ar;
    if (tMs - this.lastArMs < (cfg.everyS ?? 30) * 1000) {
      if (this.kinematic) this.lastFix = null;
      return;
    }
    this.lastArMs = tMs;
    this.lastFix = null;
    // The filter-based wide lanes are fast but trust the code weights; if
    // the narrow lanes then fail, retry with the Melbourne–Wübbena ones
    // alone.
    let res = this.resolve(tMs, vis, cfg, true);
    if (!res.fixed) res = this.resolve(tMs, vis, cfg, false);
    this.lastAttempt = res.stats;
    if (!res.fixed) return;
    this.lastFix = { position: res.position, nFixed: res.nFixed };
    this.lastAccepted = res.position;
    this.firstFixMs ??= tMs;
  }

  private resolve(
    tMs: number,
    vis: readonly Vis[],
    cfg: Exclude<NonNullable<PppUncombinedOptions['ar']>, boolean>,
    wlLambda: boolean
  ): {
    fixed: boolean;
    position: [number, number, number];
    nFixed: number;
    stats: ArAttemptStats;
  } {
    const minArcMs = (cfg.minArcS ?? 0) * 1000;
    const maxFrac = cfg.maxFracWl ?? 0.25;
    const stats: ArAttemptStats = {
      ewl: 0,
      wl: 0,
      nl: 0,
      nlCandidates: 0,
      ratio: 0,
    };
    // Fixable ambiguities of the satellites in view.
    interface Amb {
      prn: string;
      el: number;
      band: string;
      lam: number;
      idx: number;
      order: number;
    }
    const groups = new Map<string, Amb[]>();
    const bySat = new Map<string, Amb[]>();
    for (const v of vis) {
      v.sigs.forEach((sg, order) => {
        if (!sg.fixable) return;
        const key = `N:${v.prn}:${sg.band}`;
        const idx = this.idx.get(key);
        const start = this.arcStart.get(key);
        if (idx === undefined || start === undefined) return;
        if (tMs - start < minArcMs) return;
        const a: Amb = {
          prn: v.prn,
          el: v.elRad,
          band: sg.band,
          lam: sg.lam,
          idx,
          order,
        };
        const g = `${v.grp}:${sg.band}:${sg.phaseCode}`;
        const list = groups.get(g) ?? [];
        list.push(a);
        groups.set(g, list);
        const ls = bySat.get(v.prn) ?? [];
        ls.push(a);
        bySat.set(v.prn, ls);
      });
    }
    // SD ambiguity (cycles) of each candidate as a sparse row on the state;
    // the group's reference satellite has the zero row.
    type Row = Map<number, number>;
    const sd = new Map<Amb, Row>();
    const refOf = new Map<Amb, Amb>();
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const ref = list.reduce((p, q) => (q.el > p.el ? q : p));
      for (const a of list) refOf.set(a, ref);
      for (const a of list)
        sd.set(
          a,
          a === ref
            ? new Map()
            : new Map([
                [a.idx, 1 / a.lam],
                [ref.idx, -1 / a.lam],
              ])
        );
    }
    const comb = (terms: [Row | undefined, number][]): Row | null => {
      const out: Row = new Map();
      for (const [r, c] of terms) {
        if (!r) return null;
        for (const [i, v] of r) out.set(i, (out.get(i) ?? 0) + c * v);
      }
      for (const [i, v] of out) if (Math.abs(v) < 1e-12) out.delete(i);
      return out.size ? out : null;
    };
    interface Lane {
      prn: string;
      el: number;
      row: Row;
      /** Wavelength of the combination (m). */
      lamM: number;
      /** Between-satellite Melbourne–Wübbena average (cycles) and its
       *  shorter arc's length (epochs), for the primary wide lane. */
      mw?: { v: number; n: number; ageS: number };
    }
    const ewl: Lane[] = [];
    const wl: Lane[] = [];
    const nl: Lane[] = [];
    for (const [prn, ambs] of bySat) {
      const a0 = ambs.find((q) => q.order === 0);
      const a1 = ambs.find((q) => q.order === 1);
      const fOf = (q: Amb) => C_LIGHT / q.lam;
      const el = ambs[0]!.el;
      if (a0 && a1) {
        const r = comb([
          [sd.get(a0), 1],
          [sd.get(a1), -1],
        ]);
        const r0 = refOf.get(a0);
        const r1 = refOf.get(a1);
        const ms = this.mwState.get(prn);
        const mr = r0 ? this.mwState.get(r0.prn) : undefined;
        if (r)
          wl.push({
            prn,
            el,
            row: r,
            lamM: C_LIGHT / Math.abs(fOf(a0) - fOf(a1)),
            ...(r0 && r1 && r0.prn === r1.prn && ms && mr
              ? {
                  mw: {
                    v: ms.mean - mr.mean,
                    n: Math.min(ms.n, mr.n),
                    ageS:
                      (tMs -
                        Math.max(
                          this.arcStart.get(`N:${prn}:${a0.band}`) ?? tMs,
                          this.arcStart.get(`N:${r0.prn}:${a0.band}`) ?? tMs
                        )) /
                      1000,
                  },
                }
              : {}),
          });
      }
      const base = a1 ?? a0;
      for (const q of ambs) {
        if (q.order < 2 || !base) continue;
        const r = comb([
          [sd.get(base), 1],
          [sd.get(q), -1],
        ]);
        if (!r) continue;
        const lamM = C_LIGHT / Math.abs(fOf(base) - fOf(q));
        (lamM >= 2.5 ? ewl : wl).push({ prn, el, row: r, lamM });
      }
      if (a0) {
        const r = sd.get(a0);
        if (r && r.size) nl.push({ prn, el, row: r, lamM: a0.lam });
      }
    }
    // Work on a copy of the filter.
    const x = this.x.slice();
    const P = this.P.map((row) => row.slice());
    const n = x.length;
    const val = (r: Row) => {
      let v = 0;
      for (const [i, c] of r) v += c * x[i]!;
      return v;
    };
    const cov = (r: Row, q: Row) => {
      let v = 0;
      for (const [i, a] of r) for (const [j, b] of q) v += a * b * P[i]![j]!;
      return v;
    };
    const impose = (r: Row, int: number) => {
      const h = new Array<number>(n).fill(0);
      for (const [i, c] of r) h[i] = c;
      ekfUpdateScalar(x, P, h, int - val(r), 1e-8, 0);
    };
    // 1. Extra-wide lanes: rounding (metres of wavelength, decimetre σ).
    for (const l of ewl) {
      const f = val(l.row);
      const sig = Math.sqrt(Math.max(cov(l.row, l.row), 0));
      const k = Math.round(f);
      if (sig < 0.15 && Math.abs(f - k) < maxFrac) {
        impose(l.row, k);
        stats.ewl++;
      }
    }
    // 2. Wide lanes, then 3. narrow lanes: LAMBDA with partial fixing
    // (the least precise ambiguity dropped until the set passes).
    const lambdaStep = (
      lanes: Lane[],
      ratioMin: number,
      srMin: number,
      minN: number
    ): { n: number; ratio: number; chi2: number } => {
      let set = lanes
        .map((l) => ({ l, v: cov(l.row, l.row) }))
        .filter((q) => q.v < 0.5 * 0.5)
        .sort((p, q) => p.v - q.v)
        .map((q) => q.l);
      let firstRatio = 0;
      while (set.length >= Math.max(1, minN)) {
        const m = set.length;
        const a = new Float64Array(m);
        const Q = new Float64Array(m * m);
        for (let i = 0; i < m; i++) {
          a[i] = val(set[i]!.row);
          for (let j = 0; j < m; j++)
            Q[i * m + j] = cov(set[i]!.row, set[j]!.row);
        }
        const r = lambdaSearch(a, Q, m, 2);
        const ratio = r ? Math.min(r.ratio, 999) : 0;
        if (!firstRatio) firstRatio = ratio;
        if (r && ratio >= ratioMin && r.successRate >= srMin) {
          const chi2 = r.residuals[0]! / m;
          set.forEach((l, i) => impose(l.row, r.candidates[0]![i]!));
          return { n: m, ratio, chi2 };
        }
        set = set.slice(0, -1);
      }
      return { n: 0, ratio: firstRatio, chi2: 0 };
    };
    // Wide lanes: first by the between-satellite Melbourne–Wübbena average
    // (its own scatter, not the filter's code weight, sets its precision),
    // when the filter agrees; the rest by LAMBDA on the filter.
    const mwMin = cfg.wlMinEpochs ?? 10;
    const mwAge = cfg.wlMinArcS ?? 600;
    const wlThr = cfg.wlThreshold ?? 0.15;
    const rest: Lane[] = [];
    for (const l of wl) {
      const k = l.mw ? Math.round(l.mw.v) : NaN;
      const f = val(l.row);
      const sig = Math.sqrt(Math.max(cov(l.row, l.row), 0));
      if (
        l.mw &&
        l.mw.n >= mwMin &&
        l.mw.ageS >= mwAge &&
        Math.abs(l.mw.v - k) <= wlThr &&
        Math.abs(f - k) <= Math.min(0.35, Math.max(0.15, 3 * sig))
      ) {
        impose(l.row, k);
        stats.wl++;
      } else rest.push(l);
    }
    if (wlLambda) stats.wl += lambdaStep(rest, 3, 0.999, 1).n;
    stats.nlCandidates = nl.length;
    const minFixed = cfg.minFixed ?? 5;
    const res = lambdaStep(
      nl,
      cfg.ratio ?? 3,
      cfg.successRate ?? 0.99,
      minFixed
    );
    stats.nl = res.n;
    stats.ratio = res.ratio;
    return {
      fixed: res.n >= minFixed && res.chi2 <= (cfg.maxChi2 ?? 20),
      position: [x[IDX_X]!, x[IDX_Y]!, x[IDX_Z]!],
      nFixed: res.n,
      stats,
    };
  }

  /* ---------------------------------------------------------------- */
  /*  Session result                                                   */
  /* ---------------------------------------------------------------- */

  solution(): PppUncombinedSolution {
    const x = this.x;
    const pos: [number, number, number] = [x[IDX_X]!, x[IDX_Y]!, x[IDX_Z]!];
    const geo = ecefToGeodetic(pos[0], pos[1], pos[2]);
    const truth = this.truth;
    const series = this.series;
    return {
      position: pos,
      llh: [(geo[0] * 180) / Math.PI, (geo[1] * 180) / Math.PI, geo[2]],
      series,
      ztdWet: x[IDX_ZWD]!,
      ztdHydrostatic: series.length
        ? series[series.length - 1]!.ztdHydrostatic
        : 0,
      epochsUsed: series.length,
      convergenceSec: this.convergenceSec,
      finalError3d: truth
        ? Math.hypot(pos[0] - truth[0], pos[1] - truth[1], pos[2] - truth[2])
        : null,
      nStates: x.length,
      signalsWithoutSatAntenna: this.signalsWithoutSatAntenna,
      resets: { ...this.resets },
      ...(this.opts.ar && this.source.phaseBias
        ? {
            ar: {
              firstFixSec:
                this.firstFixMs === null
                  ? null
                  : (this.firstFixMs - this.t0) / 1000,
              fixedEpochShare: series.length
                ? this.fixedEpochs / series.length
                : 0,
              position:
                this.lastFix?.position ??
                (this.kinematic ? null : this.lastAccepted),
              nFixedEnd: this.lastFix?.nFixed ?? 0,
              lastAttempt: this.lastAttempt,
            },
          }
        : {}),
    };
  }
}

/**
 * Static/kinematic uncombined PPP over a session (batch wrapper of
 * {@link PppUncombinedEngine}).
 */
export function solvePppUncombined(
  epochs: readonly PppMultiEpoch[],
  sp3OrSource: Sp3File | PppEphemerisSource,
  opts: PppUncombinedOptions
): PppUncombinedSolution {
  const source: PppEphemerisSource =
    'satState' in sp3OrSource
      ? sp3OrSource
      : new Sp3EphemerisSource(sp3OrSource, opts.clk, opts.osb);
  const eng = new PppUncombinedEngine(opts, source);
  for (const e of epochs) eng.process(e);
  return eng.solution();
}
