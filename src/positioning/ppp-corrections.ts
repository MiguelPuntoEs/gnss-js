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
  /** Satellite ECEF velocity (m/s), when the ephemeris source gives one —
   *  the eclipse attitude models need the orbital plane. */
  satVel?: [number, number, number];
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
  /** Additional phase-only correction (wind-up, and the phase − code part
   *  of the higher-order ionosphere), metres. */
  phaseWindupM: number;
  /** Leave the satellite out at this epoch (attitude unknown, or no
   *  satellite antenna calibration at all). */
  exclude?: boolean;
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
import { solidEarthTideIers } from './solid-earth-tide';
import { interpolateEop, gpsMsToUtcMjd, type EopRecord } from './eop';
import {
  wobble,
  solidPoleTideEnu,
  oceanPoleTideEnu,
  type OceanPoleTideCoefficients,
} from './pole-tide';
import type { IonexGrid } from '../rinex/ionex';
import {
  higherOrderIonoFromGim,
  higherOrderIonoIonoFree,
} from './iono-higher-order';
import {
  atmosphericTideEnu,
  type AtmTideCoefficients,
} from './atmospheric-tide-loading';
import {
  oceanLoadingEnu,
  type OceanLoadingCoefficients,
} from './ocean-loading';
import { oceanLoadingEnuIers } from './ocean-loading-iers';
import {
  type PppAntennaModel,
  satBodyFrame,
  satPcoToEcef,
  enuToEcef,
  interpPcv,
  vdot,
  phaseWindup,
} from './ppp-antenna';
import type { SatAttitudeProvider } from './sat-attitude';

export interface PppCorrectionConfig {
  antenna: PppAntennaModel;
  /** Receiver antenna type (RINEX header "ANT # / TYPE"). */
  rcvAntType: string;
  /** Marker→ARP offset in local ENU (m). RINEX "ANTENNA: DELTA H/E/N"
   * is [Up, East, North] → pass as [E, N, U]. Applied whether or not the
   * antenna type is calibrated (as RTK's `deltaEnu`). */
  antDeltaEnu?: [number, number, number];
  satPco?: boolean;
  rcvPco?: boolean;
  tides?: boolean;
  windup?: boolean;
  /** The station's ocean tide loading coefficients (BLQ), when known. */
  oceanLoading?: OceanLoadingCoefficients;
  /** Satellite attitude for the PCO direction and the wind-up (eclipse
   *  models or the analysis centre's ORBEX quaternions — see
   *  `createSatAttitude`). Default: nominal yaw steering. */
  attitude?: SatAttitudeProvider;
  /** Ocean loading synthesis: the IERS 2010 way — nodal modulation plus
   *  the minor tides by admittance (default) — or the 11 BLQ constituents
   *  alone (the model before gnss-js 2.46). */
  oceanLoadingModel?: 'iers' | 'basic';
  /** Solid-earth tide model: the full IERS 2010 Steps 1 + 2 (default), or
   *  the degree-2 in-phase term alone (the model before gnss-js 2.46). */
  tideModel?: 'iers2010' | 'degree2';
  /** Polar motion for the pole tides (IERS 2010 7.1.4–7.1.5): an EOP
   *  series (`parseEopC04`, `parseFinals2000A`, IGS ERP rows) interpolated
   *  per epoch, or one fixed pole (arcsec). Without it no pole tide. */
  eop?: readonly EopRecord[] | { xp: number; yp: number };
  /** Apply the solid-earth pole tide when `eop` is given. Default true. */
  poleTide?: boolean;
  /** The station's Desai (2002) ocean pole tide coefficients; applied when
   *  `eop` is given. */
  oceanPoleTide?: OceanPoleTideCoefficients;
  /** The station's S1/S2 atmospheric tide loading coefficients. */
  atmosphericTides?: AtmTideCoefficients;
  /** Higher-order (2nd + 3rd) ionospheric delay left in the iono-free
   *  combination, from a GIM's slant TEC and IGRF-14 at the pierce point. */
  higherOrderIono?: { gim: IonexGrid; thirdOrder?: boolean };
}

/** Wire satellite/receiver antenna + tides + wind-up into a PppCorrections. */
export function createPppCorrections(cfg: PppCorrectionConfig): PppCorrections {
  // Satellite antenna PCO defaults ON: it is part of the rigorous model that
  // the precise orbit/clock products (SP3 = centre of mass, clocks referenced
  // to the ionosphere-free antenna phase centre) are consistent with. The
  // ~2 m body-frame offset is mostly absorbed by the float ambiguities; the
  // slowly-varying remainder is real and, on the ABMF validation, slightly
  // reduces the post-fit phase residual — confirming the offset is applied
  // consistently. (The products' ANTEX must match this one — igs20.atx here.)
  const useSat = cfg.satPco ?? true;
  const useRcv = cfg.rcvPco ?? true;
  const useTides = cfg.tides ?? true;
  const useWindup = cfg.windup ?? true;
  const iersTide = (cfg.tideModel ?? 'iers2010') === 'iers2010';
  const usePoleTide = cfg.poleTide ?? true;
  const eop = cfg.eop;
  const poleAt = (timeMs: number) =>
    !eop
      ? null
      : 'xp' in eop
        ? eop
        : interpolateEop(eop as readonly EopRecord[], timeMs);
  const antDelta = cfg.antDeltaEnu ?? [0, 0, 0];
  // Phase wind-up accumulator per satellite (unwrapped, cycles).
  const windupState = new Map<string, number>();

  return {
    epochContext(timeMs, rcvEcef) {
      const sun = sunEcef(timeMs);
      const moon = moonEcef(timeMs);
      const tideDisp = useTides
        ? iersTide
          ? solidEarthTideIers(rcvEcef, sun, moon, timeMs)
          : solidEarthTide(rcvEcef, sun, moon)
        : ([0, 0, 0] as [number, number, number]);
      // Site displacements given in local East/North/Up.
      const enu: [number, number, number] = [0, 0, 0];
      const addEnu = (d: [number, number, number]) => {
        enu[0] += d[0];
        enu[1] += d[1];
        enu[2] += d[2];
      };
      const pole = poleAt(timeMs);
      if (pole) {
        const { m1, m2 } = wobble(pole.xp, pole.yp, gpsMsToUtcMjd(timeMs));
        const [lat, lon] = ecefToGeodetic(rcvEcef[0], rcvEcef[1], rcvEcef[2]);
        if (usePoleTide) addEnu(solidPoleTideEnu(lat, lon, m1, m2));
        if (cfg.oceanPoleTide)
          addEnu(oceanPoleTideEnu(cfg.oceanPoleTide, m1, m2));
      }
      if (cfg.atmosphericTides)
        addEnu(atmosphericTideEnu(cfg.atmosphericTides, timeMs));
      if (enu[0] || enu[1] || enu[2]) {
        const [lat, lon] = ecefToGeodetic(rcvEcef[0], rcvEcef[1], rcvEcef[2]);
        const d = enuToEcef(enu, lat, lon);
        tideDisp[0] += d[0];
        tideDisp[1] += d[1];
        tideDisp[2] += d[2];
      }
      if (cfg.oceanLoading) {
        // Ocean loading ENU → ECEF, added to the receiver displacement.
        const [e, n, u] =
          cfg.oceanLoadingModel === 'basic'
            ? oceanLoadingEnu(cfg.oceanLoading, timeMs)
            : oceanLoadingEnuIers(cfg.oceanLoading, timeMs);
        const [lat, lon] = ecefToGeodetic(rcvEcef[0], rcvEcef[1], rcvEcef[2]);
        const d = enuToEcef([e, n, u], lat, lon);
        tideDisp[0] += d[0];
        tideDisp[1] += d[1];
        tideDisp[2] += d[2];
      }
      return { timeMs, sun, moon, tideDisp };
    },
    evaluate(geom, ctx) {
      let rangeM = 0;
      let phaseWindupM = 0;
      const e = geom.los; // rcv → sat
      // ecefToGeodetic returns radians.
      const [latRad, lonRad] = ecefToGeodetic(
        geom.rcvEcef[0],
        geom.rcvEcef[1],
        geom.rcvEcef[2]
      );

      // Satellite body frame (needed for PCO + wind-up).
      const att = cfg.attitude;
      if (att && ctx && geom.satVel) {
        if (
          att.exclude(geom.prn, ctx.timeMs, geom.satEcef, geom.satVel, ctx.sun)
        )
          return { rangeM: 0, phaseWindupM: 0, exclude: true };
      }
      const frame = !ctx
        ? null
        : att && geom.satVel
          ? att.frame(geom.prn, ctx.timeMs, geom.satEcef, geom.satVel, ctx.sun)
          : satBodyFrame(geom.satEcef, ctx.sun);

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
        // No calibration at all for this satellite (a new launch before the
        // ANTEX has it): its clock refers to an antenna phase centre ~0.5–2 m
        // from the centre of mass we would range to — drop it, don't use it
        // uncorrected.
        if (!off) return { rangeM: 0, phaseWindupM: 0, exclude: true };
        {
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
      // The marker→ARP delta is geometry, not calibration: it applies even
      // when the antenna type has no calibration (or rcvPco is off) — else
      // an uncalibrated antenna's height silently lands in the coordinate.
      const off =
        useRcv && geom.band1 && geom.band2
          ? cfg.antenna.rcvOffset(
              cfg.rcvAntType,
              geom.band1,
              geom.band2,
              geom.f1,
              geom.f2
            )
          : null;
      const total: [number, number, number] = [
        // PCO is ANTEX North/East/Up; the delta and enuToEcef are ENU.
        (off ? off.pco[1] : 0) + antDelta[0],
        (off ? off.pco[0] : 0) + antDelta[1],
        (off ? off.pco[2] : 0) + antDelta[2],
      ];
      if (total[0] !== 0 || total[1] !== 0 || total[2] !== 0) {
        const ecef = enuToEcef(total, latRad, lonRad);
        // APC = marker + offset ⇒ range loses e·offset.
        rangeM -= vdot(e, ecef);
      }
      if (off) {
        const zenithDeg = 90 - (geom.elRad * 180) / Math.PI;
        rangeM += interpPcv(off, zenithDeg, (geom.azRad * 180) / Math.PI);
      }

      // ── Solid-earth tides (receiver displacement projected on LOS) ──
      if (ctx) {
        rangeM -= vdot(e, ctx.tideDisp);
      }

      // ── Higher-order ionosphere: different on code and phase, so the
      // code part goes in the common range and the difference phase-only ──
      const hoi = cfg.higherOrderIono;
      if (hoi && ctx) {
        const t = higherOrderIonoFromGim(
          hoi.gim,
          ctx.timeMs,
          latRad,
          lonRad,
          geom.azRad,
          geom.elRad,
          e
        );
        if (t) {
          const d = higherOrderIonoIonoFree(
            t,
            geom.f1,
            geom.f2,
            hoi.thirdOrder ?? true
          );
          rangeM += d.code;
          phaseWindupM += d.phase - d.code;
        }
      }

      // ── Phase wind-up (phase only) ──
      if (useWindup && frame) {
        const wu = phaseWindup(geom.prn, e, frame, latRad, lonRad, windupState);
        // cycles → metres via the iono-free wavelength ≈ c/(f1+f2).
        const lambdaIf = 299792458 / (geom.f1 + geom.f2);
        phaseWindupM += wu * lambdaIf;
      }

      return { rangeM, phaseWindupM };
    },
  };
}
