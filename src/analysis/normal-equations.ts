/**
 * Normal equations as a first-class object — the currency of network
 * adjustment (SINEX SOLUTION/NORMAL_EQUATION_*): every
 * daily solution reduces to N·Δx = b with Δx the correction to the
 * a-priori values, plus the statistics needed to recover σ₀ after
 * stacking. Shared by the stacking / datum code and the network solver.
 *
 * Conventions (match SINEX 2.02):
 *  - N is the full symmetric n×n matrix, row-major (Float64Array n*n).
 *  - b is the right-hand side (SOLUTION/NORMAL_EQUATION_VECTOR).
 *  - ltpl = lᵀPl, the weighted square sum of the reduced observations
 *    before the adjustment (so vᵀPv = ltpl − Δxᵀb after solving).
 *  - Units: metres, metres/year, seconds — SI as in SINEX.
 *  - No constraints are included: a NEQ is free of datum information;
 *    datum and other constraints are added when solving.
 */

/** SINEX parameter types used here; others pass through as strings. */
export type NeqParameterType =
  | 'STAX'
  | 'STAY'
  | 'STAZ'
  | 'VELX'
  | 'VELY'
  | 'VELZ'
  | 'TROTOT'
  | 'TROWET'
  | 'TGNTOT'
  | 'TGETOT'
  | 'SATCLK'
  | 'RCVCLK'
  | (string & {});

export interface NeqParameter {
  type: NeqParameterType;
  /** 4-character site code (stations) or PRN (satellites). */
  site: string;
  /** SINEX point code, default "A". */
  pointCode?: string;
  /** SINEX solution id: station segments between discontinuities ("1", "2", …). */
  solnId?: string;
  /** Reference epoch of the parameter (ms, GPS-scale epoch convention). */
  refEpochMs: number;
  /** A-priori value (SOLUTION/APRIORI) in SI units. */
  apriori: number;
  /** SINEX unit string: "m", "m/y", "s", … */
  unit: string;
  /** Validity interval for piecewise parameters (troposphere, clocks). */
  startMs?: number;
  endMs?: number;
}

export interface NormalEquations {
  params: NeqParameter[];
  /** n×n, row-major, symmetric. */
  N: Float64Array;
  /** Length n. */
  b: Float64Array;
  /** lᵀPl. */
  ltpl: number;
  nObs: number;
  /** Unknowns reduced (pre-eliminated) before these NEQs were formed —
   *  ambiguities, clocks…; counted for the degrees of freedom. */
  nPreEliminated: number;
  /** A-priori σ₀ of unit weight used to build P (m). */
  sigma0Apriori: number;
  dataStartMs: number;
  dataEndMs: number;
}
