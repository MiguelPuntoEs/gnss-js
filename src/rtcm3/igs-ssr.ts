/**
 * IGS State Space Representation (SSR) — RTCM proprietary message 4076,
 * "IGS SSR Format v1.00". The multi-GNSS successor to the RTCM-SSR messages
 * (1057–1068): the same orbit/clock/code-bias/URA corrections plus **phase
 * biases** (for PPP-AR) and ionosphere VTEC, carried for GPS/GLONASS/Galileo/
 * QZSS/BDS/SBAS under one message. Broadcast by the IGS real-time streams
 * (BKG `products.igs-ip.net`, e.g. SSRA/SSRC mountpoints).
 *
 * A 4076 message begins with the IGS version + an "IGS Message Number" (IM)
 * subtype that selects the GNSS and correction type; the body then mirrors the
 * RTCM-SSR layout with IGS-specific bit widths. This module decodes the fields
 * (SI units); applying them to a solve is a separate step.
 */
import { BitReader } from './decoder';
import type { Rtcm3Frame } from './decoder';
import type {
  SsrKind,
  SsrSatCorrection,
  SsrCodeBias,
  SsrPhaseBias,
} from './ssr';
import {
  UPDATE_INTERVAL_S,
  ssrUraMm,
  readSsrOrbit,
  readSsrClock,
} from './ssr-common';

/** IGS Message Number → GNSS system letter (by the 20-wide block). */
const SYSTEM_BY_BASE: Record<number, 'G' | 'R' | 'E' | 'J' | 'C' | 'S'> = {
  20: 'G',
  40: 'R',
  60: 'E',
  80: 'J',
  100: 'C',
  120: 'S',
};
/** Offset within a GNSS block (IM − base) → correction kind. */
const KIND_BY_OFFSET: Record<number, SsrKind | 'phaseBias'> = {
  1: 'orbit',
  2: 'clock',
  3: 'combined',
  4: 'highRateClock',
  5: 'codeBias',
  6: 'phaseBias',
  7: 'ura',
};

/** A decoded IGS-SSR (4076) message. */
export interface IgsSsrMessage {
  messageType: 4076;
  /** IGS SSR format version (IDF001). */
  version: number;
  /** IGS Message Number / subtype (IDF002). */
  igsMessageNumber: number;
  /** System letter, or 'I' for the ionosphere (VTEC) message. */
  system: 'G' | 'R' | 'E' | 'J' | 'C' | 'S' | 'I';
  kind: SsrKind | 'phaseBias' | 'ionosphere';
  epochS: number;
  updateIntervalS: number;
  multipleMessage: boolean;
  referenceDatum?: number;
  iodSsr: number;
  providerId: number;
  solutionId: number;
  /** Phase-bias header consistency indicators (phaseBias only). */
  dispersiveConsistency?: boolean;
  mwConsistency?: boolean;
  satellites: SsrSatCorrection[];
  /** Ionosphere summary (IM201 only). */
  iono?: { qualityTecu: number; layers: IgsSsrIonoLayer[] };
}

/** One ionospheric layer header (IM201). */
export interface IgsSsrIonoLayer {
  heightKm: number;
  degree: number;
  order: number;
  coefficientCount: number;
}

const two = (n: number) => n.toString().padStart(2, '0');

/** IDF011 satellite-ID value → RINEX PRN for the given system. */
function prnFor(system: string, id: number): string {
  if (system === 'J') return `J${two(id)}`; // QZSS id 1 → PRN 193 (J01)
  if (system === 'S') return `S${two(19 + id)}`; // SBAS id 1 → PRN 120 (S20)
  return `${system}${two(id)}`;
}

/**
 * Decode an RTCM3 IGS-SSR message (4076) into an {@link IgsSsrMessage}, or null
 * if the frame is not 4076 or carries an unrecognised subtype.
 */
export function decodeIgsSsr(frame: Rtcm3Frame): IgsSsrMessage | null {
  if (frame.messageType !== 4076) return null;
  const r = new BitReader(frame.payload);
  r.readU(12); // DF002 = 4076
  const version = r.readU(3); // IDF001
  const im = r.readU(8); // IDF002 IGS message number

  // Ionosphere VTEC (IM201) — decode a summary (header + per-layer metadata).
  if (im === 201) return decodeIono(r, version, im);

  const base = Math.floor(im / 20) * 20;
  const system = SYSTEM_BY_BASE[base];
  const kind = KIND_BY_OFFSET[im - base];
  if (!system || !kind) return null;

  const epochS = r.readU(20); // IDF003
  const updateIntervalS = UPDATE_INTERVAL_S[r.readU(4)]!; // IDF004
  const multipleMessage = r.readU(1) === 1; // IDF005
  const iodSsr = r.readU(4); // IDF007
  const providerId = r.readU(16); // IDF008
  const solutionId = r.readU(4); // IDF009
  const hasDatum = kind === 'orbit' || kind === 'combined';
  const referenceDatum = hasDatum ? r.readU(1) : undefined; // IDF006
  let dispersiveConsistency: boolean | undefined;
  let mwConsistency: boolean | undefined;
  if (kind === 'phaseBias') {
    dispersiveConsistency = r.readU(1) === 1; // IDF032
    mwConsistency = r.readU(1) === 1; // IDF033
  }
  const nsat = r.readU(6); // IDF010

  const satellites: SsrSatCorrection[] = [];
  for (let i = 0; i < nsat; i++) {
    const id = r.readU(6); // IDF011
    const sat: SsrSatCorrection = { prn: prnFor(system, id) };
    if (kind === 'orbit' || kind === 'combined') readSsrOrbit(r, sat);
    if (kind === 'clock' || kind === 'combined') readSsrClock(r, sat);
    else if (kind === 'ura')
      sat.uraMm = ssrUraMm(r.readU(6)); // IDF034
    else if (kind === 'highRateClock')
      sat.highRateClock = r.readS(22) * 0.0001; // IDF022
    else if (kind === 'codeBias') {
      const n = r.readU(5); // IDF023
      const biases: SsrCodeBias[] = [];
      for (let b = 0; b < n; b++) {
        const signal = r.readU(5); // IDF024
        biases.push({
          signal,
          signalName: `#${signal}`,
          biasM: r.readS(14) * 0.01, // IDF025 0.01 m
        });
      }
      sat.codeBiases = biases;
    } else if (kind === 'phaseBias') {
      const n = r.readU(5); // IDF023
      r.readU(9); // IDF026 yaw angle (1/256 semicircle) — not surfaced
      r.readS(8); // IDF027 yaw rate — not surfaced
      const biases: SsrPhaseBias[] = [];
      for (let b = 0; b < n; b++) {
        const signal = r.readU(5); // IDF024
        const integer = r.readU(1) === 1; // IDF029
        const wideLaneGroup = r.readU(2); // IDF030
        const discontinuity = r.readU(4); // IDF031
        const biasM = r.readS(20) * 0.0001; // IDF028 0.1 mm
        biases.push({ signal, integer, wideLaneGroup, discontinuity, biasM });
      }
      sat.phaseBiases = biases;
    }
    satellites.push(sat);
  }

  return {
    messageType: 4076,
    version,
    igsMessageNumber: im,
    system,
    kind,
    epochS,
    updateIntervalS,
    multipleMessage,
    referenceDatum,
    iodSsr,
    providerId,
    solutionId,
    dispersiveConsistency,
    mwConsistency,
    satellites,
  };
}

/** IM201 — ionosphere VTEC (spherical harmonics). Decodes the header + per-layer
 *  metadata (height/degree/order + coefficient count); the coefficient arrays
 *  themselves are consumed but not surfaced. */
function decodeIono(r: BitReader, version: number, im: number): IgsSsrMessage {
  const epochS = r.readU(20); // IDF003
  const updateIntervalS = UPDATE_INTERVAL_S[r.readU(4)]!; // IDF004
  const multipleMessage = r.readU(1) === 1; // IDF005
  const iodSsr = r.readU(4); // IDF007
  const providerId = r.readU(16); // IDF008
  const solutionId = r.readU(4); // IDF009
  const qualityTecu = r.readU(9) * 0.05; // IDF041
  const nLayers = r.readU(2) + 1; // IDF035 (encodes NIL−1)

  const layers: IgsSsrIonoLayer[] = [];
  for (let l = 0; l < nLayers; l++) {
    const heightKm = r.readU(8) * 10; // IDF036
    const degree = r.readU(4) + 1; // IDF037 (N−1)
    const order = r.readU(4) + 1; // IDF038 (M−1)
    const N = degree;
    const M = order;
    const nCoef = (N + 1) * (N + 1) - (N - M) * (N - M + 1);
    // Cosine (nCoef) + Sine (nCoef − (N+1), i.e. m=1..M) — consume both.
    const nCos = nCoef;
    let nSin = 0;
    for (let m = 1; m <= M; m++) nSin += N - m + 1;
    for (let i = 0; i < nCos + nSin; i++) r.readS(16); // IDF039 / IDF040
    layers.push({ heightKm, degree, order, coefficientCount: nCos + nSin });
  }

  return {
    messageType: 4076,
    version,
    igsMessageNumber: im,
    system: 'I',
    kind: 'ionosphere',
    epochS,
    updateIntervalS,
    multipleMessage,
    iodSsr,
    providerId,
    solutionId,
    satellites: [],
    iono: { qualityTecu, layers },
  };
}
