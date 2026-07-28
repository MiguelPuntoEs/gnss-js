/**
 * Legacy (pre-MSM) RTCM3 observation messages — RTCM 10403.2 §3.5.1 / §3.5.4:
 *   GPS:      1001 (L1 basic), 1002 (L1 extended), 1003 (L1/L2 basic), 1004 (L1/L2 extended)
 *   GLONASS:  1009, 1010, 1011, 1012 (same four variants)
 *
 * These carry code+phase(+C/N0) exactly like MSM but in the older fixed layout,
 * and are still broadcast by many national CORS networks. Decoded into the same
 * {@link ObsEpoch} shape as {@link decodeMsmFull} so every consumer (RINEX
 * writer, SPP, QC) works unchanged.
 *
 * Reconstruction (RTCM 10403.2 data-field notes):
 *   L1 pseudorange (m) = DF011·0.02 + DF014·PRUNIT           (basic: DF014 = 0 → modulo only)
 *   L1 phaserange (m)  = L1 pseudorange + DF012·0.0005
 *   L2 pseudorange (m) = L1 pseudorange + DF017·0.02
 *   L2 phaserange (m)  = L1 pseudorange + DF018·0.0005
 * Phase (cycles) = phaserange / wavelength. PRUNIT = 299 792.458 m (GPS) /
 * 599 584.916 m (GLONASS). GLONASS wavelength uses the inline channel (DF040).
 *
 * Note: basic types (1001/1003/1009/1011) omit the integer pseudorange-modulus
 * ambiguity, so their pseudorange is modulo one (GPS) / two (GLONASS) light-ms
 * only — usable for RINEX but not a standalone SPP fix. The extended types
 * (1002/1004/1010/1012), which almost every network broadcasts, are complete.
 */
import { BitReader } from './decoder';
import type { Rtcm3Frame } from './decoder';
import { decodeMsmFull } from './msm';
import {
  C_LIGHT,
  GLO_F1_BASE,
  GLO_F1_STEP,
  GLO_F2_BASE,
  GLO_F2_STEP,
} from '../constants/gnss';
import type { ObsEpoch, ObsSatObs, ObsSignal } from './msm';

const PRUNIT_GPS = 299792.458;
const PRUNIT_GLO = 599584.916;
const LAM_GPS_L1 = C_LIGHT / 1575.42e6;
const LAM_GPS_L2 = C_LIGHT / 1227.6e6;

// int20 / int14 "invalid" sentinels (two's-complement minima).
const PPR_INVALID = -(2 ** 19); // -524288
const PR21_INVALID = -(2 ** 13); // -8192

/** RTCM lock-time indicator (7-bit, Table 3.4-2) → seconds of continuous lock. */
function legacyLockSec(i: number): number {
  if (i < 24) return i;
  if (i < 48) return 2 * i - 24;
  if (i < 72) return 4 * i - 120;
  if (i < 96) return 8 * i - 408;
  if (i < 120) return 16 * i - 1176;
  if (i < 127) return 32 * i - 3096;
  return 937;
}

const two = (n: number) => n.toString().padStart(2, '0');

/**
 * Decode a legacy RTCM3 observation frame (1001–1004 GPS, 1009–1012 GLONASS)
 * into an {@link ObsEpoch}, or null for any other message type.
 */
export function decodeLegacyObs(frame: Rtcm3Frame): ObsEpoch | null {
  const type = frame.messageType;
  const gps = type >= 1001 && type <= 1004;
  const glo = type >= 1009 && type <= 1012;
  if (!gps && !glo) return null;

  const ext = type === 1002 || type === 1004 || type === 1010 || type === 1012;
  const dual = type === 1003 || type === 1004 || type === 1011 || type === 1012;
  const system = gps ? 'G' : 'R';

  const r = new BitReader(frame.payload);
  r.readU(12); // DF002 message number
  r.readU(12); // DF003 reference station ID
  let epochMs: number;
  let nsat: number;
  if (gps) {
    epochMs = r.readU(30); // DF004 GPS epoch time (TOW, ms of week)
    r.readU(1); // DF005 synchronous flag
    nsat = r.readU(5); // DF006
    r.readU(1); // DF007 divergence-free smoothing
    r.readU(3); // DF008 smoothing interval
  } else {
    const tk = r.readU(27); // DF034 GLONASS epoch time (ms of day)
    r.readU(1); // DF005
    nsat = r.readU(5); // DF035
    r.readU(1); // DF036
    r.readU(3); // DF037
    // MSM-compatible packing for obsEpochToDate: high bits carry the day of
    // week. Legacy frames don't include it, so derive it from the wall clock
    // (GLONASS = UTC+3h) — correct for a live stream; for offline replay of an
    // old capture the day may be off (the ms-of-day is always exact).
    const gloDow = new Date(Date.now() + 3 * 3600_000).getUTCDay();
    epochMs = ((gloDow << 27) | tk) >>> 0;
  }

  const observations: ObsSatObs[] = [];
  for (let s = 0; s < nsat; s++) {
    const satId = r.readU(6); // DF009 / DF038
    const code1 = r.readU(1); // DF010 / DF039
    const freqCh = glo ? r.readU(5) : 0; // DF040 (GLONASS only)
    const pr1raw = r.readU(gps ? 24 : 25); // DF011 / DF041
    const ppr1 = r.readS(20); // DF012 / DF042
    const lock1 = r.readU(7); // DF013 / DF043
    let amb = 0;
    let cnr1 = 0;
    if (ext) {
      amb = r.readU(gps ? 8 : 7); // DF014 / DF044
      cnr1 = r.readU(8); // DF015 / DF045
    }
    let code2 = 0;
    let pr21 = 0;
    let ppr2 = 0;
    let lock2 = 0;
    let cnr2 = 0;
    if (dual) {
      code2 = r.readU(2); // DF016 / DF046
      pr21 = r.readS(14); // DF017 / DF047
      ppr2 = r.readS(20); // DF018 / DF048
      lock2 = r.readU(7); // DF019 / DF049
      if (ext) cnr2 = r.readU(8); // DF020 / DF050
    }

    // GPS 1–32 only (SBAS 40–58 in legacy GPS obs is essentially never seen);
    // GLONASS slots 1–24.
    if (gps && (satId < 1 || satId > 32)) continue;
    if (glo && (satId < 1 || satId > 24)) continue;

    const prunit = gps ? PRUNIT_GPS : PRUNIT_GLO;
    const pr1 = pr1raw * 0.02 + amb * prunit;
    const k = freqCh - 7; // GLONASS FDMA channel (−7..+13)
    const lamL1 = gps ? LAM_GPS_L1 : C_LIGHT / (GLO_F1_BASE + k * GLO_F1_STEP);
    const lamL2 = gps ? LAM_GPS_L2 : C_LIGHT / (GLO_F2_BASE + k * GLO_F2_STEP);

    const signals: ObsSignal[] = [];
    // L1
    {
      const sig: ObsSignal = {
        rinexCode: gps ? (code1 ? '1W' : '1C') : code1 ? '1P' : '1C',
        pseudorange: pr1,
        wavelength: lamL1,
        lockTime: legacyLockSec(lock1),
      };
      if (ppr1 !== PPR_INVALID) sig.phase = (pr1 + ppr1 * 0.0005) / lamL1;
      if (ext && cnr1 > 0) sig.cn0 = cnr1 * 0.25;
      signals.push(sig);
    }
    // L2 (dual-frequency types only)
    if (dual) {
      const sig: ObsSignal = {
        rinexCode: gps
          ? code2 === 0
            ? '2X'
            : '2W'
          : code2 === 0
            ? '2C'
            : '2P',
        wavelength: lamL2,
        lockTime: legacyLockSec(lock2),
      };
      if (pr21 !== PR21_INVALID) sig.pseudorange = pr1 + pr21 * 0.02;
      if (ppr2 !== PPR_INVALID) sig.phase = (pr1 + ppr2 * 0.0005) / lamL2;
      if (ext && cnr2 > 0) sig.cn0 = cnr2 * 0.25;
      signals.push(sig);
    }

    observations.push({
      prn: `${system}${two(satId)}`,
      system,
      signals,
    });
  }

  return { messageType: type, epochMs, system, observations };
}

/**
 * Decode any RTCM3 observation frame into an {@link ObsEpoch}: MSM4–7 first
 * ({@link decodeMsmFull}), then the legacy fixed-layout obs (1001–1004 GPS,
 * 1009–1012 GLONASS) via {@link decodeLegacyObs}. Returns null for any
 * non-observation message. This is the single obs entry point every consumer
 * (stream stats, live SPP/QC/RTK, station monitor) should call, so a new obs
 * source is added here once rather than at every call site.
 */
export function decodeObs(frame: Rtcm3Frame): ObsEpoch | null {
  return decodeMsmFull(frame) ?? decodeLegacyObs(frame);
}
