/**
 * RTCM3 State Space Representation (SSR) correction messages — RTCM 10403.2
 * §3.5.12, message types 1057–1068:
 *   GPS:     1057 orbit · 1058 clock · 1059 code bias · 1060 combined orbit+clock
 *            · 1061 URA · 1062 high-rate clock
 *   GLONASS: 1063 · 1064 · 1065 · 1066 · 1067 · 1068 (same six)
 *
 * These carry the corrections to the broadcast ephemeris (orbit in the
 * radial/along/cross frame, a clock polynomial, per-signal code biases, URA and
 * a high-rate clock term) that real-time PPP services broadcast — e.g. the IGS
 * real-time streams on BKG's `products.igs-ip.net`. This module decodes the
 * fields; applying them to a solve is a separate step.
 *
 * All delta/dot/clock/code-bias fields are signed two's complement; the decoder
 * returns SI units (metres, m/s, m/s²). Scale factors per RTCM 10403.2 §3.5.13.
 */
import { BitReader } from './decoder';
import type { Rtcm3Frame } from './decoder';
import {
  UPDATE_INTERVAL_S,
  ssrUraMm,
  readSsrOrbit,
  readSsrClock,
} from './ssr-common';

/** One code bias for a specific signal (DF380/DF381 + DF383). */
export interface SsrCodeBias {
  /** Signal & tracking-mode indicator (DF380 GPS / DF381 GLONASS). */
  signal: number;
  /** Human-readable signal name. */
  signalName: string;
  /** Code bias (metres). */
  biasM: number;
}

/** One phase bias for a signal — IGS-SSR (4076 IGM06) only. */
export interface SsrPhaseBias {
  signal: number;
  /** Bias is a fixable integer number of cycles. */
  integer: boolean;
  /** Wide-lane integer group indicator (0–3). */
  wideLaneGroup: number;
  /** Discontinuity counter — increments on a phase-bias reset/slip. */
  discontinuity: number;
  /** Phase bias (metres). */
  biasM: number;
}

/** Per-satellite SSR correction (fields present depend on the message kind). */
export interface SsrSatCorrection {
  prn: string;
  /** Issue of data ephemeris this correction refers to (orbit/combined msgs). */
  iode?: number;
  /** Orbit correction in the radial/along/cross frame (metres). */
  deltaRadial?: number;
  deltaAlongTrack?: number;
  deltaCrossTrack?: number;
  /** Orbit correction rate (m/s). */
  dotRadial?: number;
  dotAlongTrack?: number;
  dotCrossTrack?: number;
  /** Clock correction polynomial: c0 (m), c1 (m/s), c2 (m/s²). */
  c0?: number;
  c1?: number;
  c2?: number;
  /** High-rate clock correction (metres), added to the c0/c1/c2 polynomial. */
  highRateClock?: number;
  /** User range accuracy, 1σ (mm); null when undefined/unknown. */
  uraMm?: number | null;
  /** Per-signal code biases. */
  codeBiases?: SsrCodeBias[];
  /** Per-signal phase biases (IGS-SSR 4076 only). */
  phaseBiases?: SsrPhaseBias[];
}

export type SsrKind =
  'orbit' | 'clock' | 'codeBias' | 'combined' | 'ura' | 'highRateClock';

/** A decoded SSR message (one of 1057–1068). */
export interface SsrMessage {
  messageType: number;
  /** System letter: 'G' (GPS) or 'R' (GLONASS). */
  system: 'G' | 'R';
  kind: SsrKind;
  /** Epoch time: seconds of GPS week (GPS) or seconds of GLONASS day (GLONASS). */
  epochS: number;
  /** SSR update interval (seconds) decoded from DF391. */
  updateIntervalS: number;
  /** True when more SSR messages for this epoch follow (DF388). */
  multipleMessage: boolean;
  /** Satellite reference datum (orbit/combined only): 0 = ITRF, 1 = regional. */
  referenceDatum?: number;
  iodSsr: number;
  providerId: number;
  solutionId: number;
  satellites: SsrSatCorrection[];
}

/** DF380 — GPS signal & tracking-mode indicator names. */
const GPS_SIGNAL: Record<number, string> = {
  0: 'L1 C/A',
  1: 'L1 P',
  2: 'L1 Z-tracking',
  5: 'L2 C/A',
  6: 'L2 semi-codeless',
  7: 'L2C(M)',
  8: 'L2C(L)',
  9: 'L2C(M+L)',
  10: 'L2 P',
  11: 'L2 Z-tracking',
  14: 'L5 I',
  15: 'L5 Q',
};
/** DF381 — GLONASS signal & tracking-mode indicator names. */
const GLO_SIGNAL: Record<number, string> = {
  0: 'G1 C/A',
  1: 'G1 P',
  2: 'G2 C/A',
  3: 'G2 P',
};

const SSR_KIND: Record<number, { system: 'G' | 'R'; kind: SsrKind }> = {
  1057: { system: 'G', kind: 'orbit' },
  1058: { system: 'G', kind: 'clock' },
  1059: { system: 'G', kind: 'codeBias' },
  1060: { system: 'G', kind: 'combined' },
  1061: { system: 'G', kind: 'ura' },
  1062: { system: 'G', kind: 'highRateClock' },
  1063: { system: 'R', kind: 'orbit' },
  1064: { system: 'R', kind: 'clock' },
  1065: { system: 'R', kind: 'codeBias' },
  1066: { system: 'R', kind: 'combined' },
  1067: { system: 'R', kind: 'ura' },
  1068: { system: 'R', kind: 'highRateClock' },
};

const two = (n: number) => n.toString().padStart(2, '0');

/**
 * Decode an RTCM3 SSR message (1057–1068) into an {@link SsrMessage}, or null
 * for any other message type.
 */
export function decodeSsr(frame: Rtcm3Frame): SsrMessage | null {
  const spec = SSR_KIND[frame.messageType];
  if (!spec) return null;
  const { system, kind } = spec;
  const gps = system === 'G';

  const r = new BitReader(frame.payload);
  r.readU(12); // DF002 message number
  const epochS = r.readU(gps ? 20 : 17); // DF385 / DF386
  const updateIntervalS = UPDATE_INTERVAL_S[r.readU(4)]!; // DF391
  const multipleMessage = r.readU(1) === 1; // DF388
  const hasDatum = kind === 'orbit' || kind === 'combined';
  const referenceDatum = hasDatum ? r.readU(1) : undefined; // DF375
  const iodSsr = r.readU(4); // DF413
  const providerId = r.readU(16); // DF414
  const solutionId = r.readU(4); // DF415
  const nsat = r.readU(6); // DF387

  const sigName = gps ? GPS_SIGNAL : GLO_SIGNAL;
  const satellites: SsrSatCorrection[] = [];

  for (let i = 0; i < nsat; i++) {
    const satId = gps ? r.readU(6) : r.readU(5); // DF068 / DF384
    const sat: SsrSatCorrection = { prn: `${system}${two(satId)}` };

    if (kind === 'orbit' || kind === 'combined') readSsrOrbit(r, sat);
    if (kind === 'combined') readSsrClock(r, sat);
    else if (kind === 'clock') readSsrClock(r, sat);
    else if (kind === 'ura')
      sat.uraMm = ssrUraMm(r.readU(6)); // DF389
    else if (kind === 'highRateClock')
      sat.highRateClock = r.readS(22) * 0.0001; // DF390 0.1 mm
    else if (kind === 'codeBias') {
      const ncb = r.readU(5); // DF379
      const biases: SsrCodeBias[] = [];
      for (let c = 0; c < ncb; c++) {
        const signal = r.readU(5); // DF380 / DF381
        const biasM = r.readS(14) * 0.01; // DF383 0.01 m
        biases.push({
          signal,
          signalName: sigName[signal] ?? `#${signal}`,
          biasM,
        });
      }
      sat.codeBiases = biases;
    }

    satellites.push(sat);
  }

  return {
    messageType: frame.messageType,
    system,
    kind,
    epochS,
    updateIntervalS,
    multipleMessage,
    referenceDatum,
    iodSsr,
    providerId,
    solutionId,
    satellites,
  };
}

/** True if the message type is an RTCM3 SSR correction (1057–1068). */
export function isSsrMessage(messageType: number): boolean {
  return messageType in SSR_KIND;
}
