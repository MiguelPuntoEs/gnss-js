/**
 * Optional PPP range corrections: satellite & receiver antenna phase-centre
 * offsets, phase wind-up, and solid-earth tides. These take a converged
 * float PPP solution from ~decimetre toward centimetre.
 *
 * Everything here is opt-in via `PppOptions.corrections`; the core solver
 * runs without it. Corrections needing Sun/Moon geometry are computed once
 * per epoch in `epochContext` and reused across satellites.
 */

/** Per-satellite geometry handed to the correction models. */
export interface SatGeom {
  prn: string;
  satEcef: [number, number, number];
  rcvEcef: [number, number, number];
  /** Unit line of sight, receiver → satellite. */
  los: [number, number, number];
  elRad: number;
  azRad: number;
  f1: number;
  f2: number;
  /** ANTEX frequency codes for the two bands (e.g. 'G01','G02'). */
  band1?: string;
  band2?: string;
  /** Iono-free coefficient g = f1²/(f1²−f2²). */
  g: number;
}

/** Epoch-level context (Sun/Moon positions, tide displacement). */
export interface PppEpochContext {
  timeMs: number;
  /** Sun position, ECEF (m). */
  sun: [number, number, number];
  /** Moon position, ECEF (m). */
  moon: [number, number, number];
  /** Solid-earth-tide receiver displacement, ECEF (m). */
  tideDisp: [number, number, number];
}

export interface CorrectionResult {
  /** Additive range correction applied to BOTH code and phase (m). */
  rangeM: number;
  /** Additional phase-only correction (wind-up), metres. */
  phaseWindupM: number;
}

/** Correction configuration + hooks. Supplied by the caller. */
export interface PppCorrections {
  /** Build the per-epoch Sun/Moon/tide context. */
  epochContext?: (
    timeMs: number,
    rcvEcef: [number, number, number]
  ) => PppEpochContext;
  /** Per-satellite correction evaluator. */
  evaluate?: (geom: SatGeom, ctx: PppEpochContext | null) => CorrectionResult;
}

/** Apply the configured corrections for one satellite. */
export function applyCorrections(
  corrections: PppCorrections,
  geom: SatGeom,
  ctx: PppEpochContext | null
): CorrectionResult {
  if (corrections.evaluate) return corrections.evaluate(geom, ctx);
  return { rangeM: 0, phaseWindupM: 0 };
}

/* ================================================================== */
/*  Correction factory (ANTEX + Sun/Moon)                              */
/* ================================================================== */

import { ecefToGeodetic } from '../coordinates/ecef';
import { sunEcef, moonEcef, solidEarthTide } from './ppp-astro';
import {
  type PppAntennaModel,
  satBodyFrame,
  satPcoToEcef,
  enuToEcef,
  interpPcv,
  vdot,
  phaseWindup,
} from './ppp-antenna';

export interface PppCorrectionConfig {
  antenna: PppAntennaModel;
  /** Receiver antenna type (RINEX header "ANT # / TYPE"). */
  rcvAntType: string;
  /** Marker→ARP offset in local ENU (m). RINEX "ANTENNA: DELTA H/E/N"
   * is [Up, East, North] → pass as [E, N, U]. */
  antDeltaEnu?: [number, number, number];
  satPco?: boolean;
  rcvPco?: boolean;
  tides?: boolean;
  windup?: boolean;
}

/** Wire satellite/receiver antenna + tides + wind-up into a PppCorrections. */
export function createPppCorrections(cfg: PppCorrectionConfig): PppCorrections {
  // Satellite antenna PCO defaults OFF: for float PPP its slowly-varying
  // per-satellite offset is largely absorbed by the float ambiguities, and
  // applying the full body-frame offset can degrade a decimetre-level float
  // solution. Opt in with satPco:true for the rigorous model.
  const useSat = cfg.satPco ?? false;
  const useRcv = cfg.rcvPco ?? true;
  const useTides = cfg.tides ?? true;
  const useWindup = cfg.windup ?? true;
  const antDelta = cfg.antDeltaEnu ?? [0, 0, 0];
  // Phase wind-up accumulator per satellite (unwrapped, cycles).
  const windupState = new Map<string, number>();

  return {
    epochContext(timeMs, rcvEcef) {
      const sun = sunEcef(timeMs);
      const moon = moonEcef(timeMs);
      const tideDisp = useTides
        ? solidEarthTide(rcvEcef, sun, moon)
        : ([0, 0, 0] as [number, number, number]);
      return { timeMs, sun, moon, tideDisp };
    },
    evaluate(geom, ctx) {
      let rangeM = 0;
      let phaseWindupM = 0;
      const e = geom.los; // rcv → sat
      const [latDeg, lonDeg] = ecefToGeodetic(
        geom.rcvEcef[0],
        geom.rcvEcef[1],
        geom.rcvEcef[2]
      );
      const latRad = (latDeg * Math.PI) / 180;
      const lonRad = (lonDeg * Math.PI) / 180;

      // Satellite body frame (needed for PCO + wind-up).
      const frame = ctx ? satBodyFrame(geom.satEcef, ctx.sun) : null;

      // ── Satellite antenna PCO + PCV ──
      if (useSat && frame && geom.band1 && geom.band2) {
        const off = cfg.antenna.satOffset(
          geom.prn,
          ctx!.timeMs,
          geom.band1,
          geom.band2,
          geom.f1,
          geom.f2
        );
        if (off) {
          const pcoEcef = satPcoToEcef(off.pco, frame);
          // APC = CoM + PCO ⇒ range gains e·PCO.
          rangeM += vdot(e, pcoEcef);
          // Nadir angle (deg): satellite boresight is nadir (−z_body ≈ toward
          // Earth); angle off it toward the receiver.
          const satR = Math.hypot(
            geom.satEcef[0],
            geom.satEcef[1],
            geom.satEcef[2]
          );
          const cosNadir =
            (e[0] * geom.satEcef[0] +
              e[1] * geom.satEcef[1] +
              e[2] * geom.satEcef[2]) /
            satR;
          const nadirDeg =
            (Math.acos(Math.max(-1, Math.min(1, cosNadir))) * 180) / Math.PI;
          rangeM += interpPcv(off, nadirDeg);
        }
      }

      // ── Receiver antenna PCO + PCV + antenna delta ──
      if (useRcv && geom.band1 && geom.band2) {
        const off = cfg.antenna.rcvOffset(
          cfg.rcvAntType,
          geom.band1,
          geom.band2,
          geom.f1,
          geom.f2
        );
        if (off) {
          const total: [number, number, number] = [
            off.pco[0] + antDelta[0],
            off.pco[1] + antDelta[1],
            off.pco[2] + antDelta[2],
          ];
          const ecef = enuToEcef(total, latRad, lonRad);
          // APC = marker + offset ⇒ range loses e·offset.
          rangeM -= vdot(e, ecef);
          const zenithDeg = 90 - (geom.elRad * 180) / Math.PI;
          rangeM += interpPcv(off, zenithDeg);
        }
      }

      // ── Solid-earth tides (receiver displacement projected on LOS) ──
      if (useTides && ctx) {
        rangeM -= vdot(e, ctx.tideDisp);
      }

      // ── Phase wind-up (phase only) ──
      if (useWindup && frame) {
        const wu = phaseWindup(geom.prn, e, frame, latRad, lonRad, windupState);
        // cycles → metres via the iono-free wavelength ≈ c/(f1+f2).
        const lambdaIf = 299792458 / (geom.f1 + geom.f2);
        phaseWindupM = wu * lambdaIf;
      }

      return { rangeM, phaseWindupM };
    },
  };
}
