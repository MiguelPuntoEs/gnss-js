/**
 * RTCM3 station messages for a reference station: antenna reference point
 * (1005/1006), receiver and antenna descriptors (1033) and GLONASS
 * code-phase biases (1230, with its decoder).
 *
 * Reference: RTCM 10403.3 §3.5.3, §3.5.6, §3.5.11.
 */

import { BitReader, reportDecodeError } from './decoder';
import type { Rtcm3Frame } from './decoder';
import { BitWriter, frameRtcm3 } from './writer';

/* ================================================================== */
/*  1005 / 1006 — antenna reference point                              */
/* ================================================================== */

export interface StationArp {
  /** DF003 reference station ID, 0–4095. */
  stationId: number;
  /** ECEF antenna reference point [x, y, z], metres (0.1 mm resolution). */
  position: [number, number, number];
  /** Antenna height above the marker, metres — present → 1006, absent → 1005. */
  antennaHeight?: number;
  /** DF021 ITRF realization year (reserved, default 0). */
  itrf?: number;
  /** DF022–DF024 systems served (default GPS, GLONASS and Galileo). */
  gps?: boolean;
  glonass?: boolean;
  galileo?: boolean;
  /** DF141: true for a non-physical (computed/VRS) station (default false). */
  nonPhysical?: boolean;
  /** DF142: all raw data from one receiver oscillator (default true). */
  singleOscillator?: boolean;
  /** DF364 quarter-cycle indicator, 0–3 (default 0). */
  quarterCycle?: number;
}

/** Encode a framed 1005 (or 1006 when `antennaHeight` is given). */
export function encodeStationArp(arp: StationArp): Uint8Array {
  const w = new BitWriter();
  const is1006 = arp.antennaHeight !== undefined;
  w.writeU(is1006 ? 1006 : 1005, 12);
  w.writeU(arp.stationId, 12);
  w.writeU(arp.itrf ?? 0, 6);
  w.writeU(arp.gps === false ? 0 : 1, 1);
  w.writeU(arp.glonass === false ? 0 : 1, 1);
  w.writeU(arp.galileo === false ? 0 : 1, 1);
  w.writeU(arp.nonPhysical ? 1 : 0, 1);
  const [x, y, z] = arp.position;
  w.writeS(Math.round(x / 0.0001), 38);
  w.writeU(arp.singleOscillator === false ? 0 : 1, 1);
  w.zeros(1);
  w.writeS(Math.round(y / 0.0001), 38);
  w.writeU(arp.quarterCycle ?? 0, 2);
  w.writeS(Math.round(z / 0.0001), 38);
  if (is1006) w.writeU(Math.round(arp.antennaHeight! / 0.0001), 16);
  return frameRtcm3(w.toBytes());
}

/* ================================================================== */
/*  1033 — receiver and antenna descriptors                            */
/* ================================================================== */

export interface StationDescriptors {
  stationId: number;
  /** IGS antenna + radome name, e.g. `TRM59800.00     SCIS` (≤ 31 chars). */
  antennaType?: string;
  /** DF031 antenna setup ID (default 0). */
  antennaSetupId?: number;
  antennaSerial?: string;
  receiverType?: string;
  receiverFirmware?: string;
  receiverSerial?: string;
}

function writeString(w: BitWriter, s: string | undefined): void {
  const bytes = new TextEncoder().encode(s ?? '');
  if (bytes.length > 31) {
    throw new RangeError(`"${s}" exceeds the 31-character descriptor limit`);
  }
  w.writeU(bytes.length, 8);
  for (const b of bytes) w.writeU(b, 8);
}

/** Encode a framed 1033 receiver and antenna descriptor. */
export function encodeStationDescriptors(d: StationDescriptors): Uint8Array {
  const w = new BitWriter();
  w.writeU(1033, 12);
  w.writeU(d.stationId, 12);
  writeString(w, d.antennaType);
  w.writeU(d.antennaSetupId ?? 0, 8);
  writeString(w, d.antennaSerial);
  writeString(w, d.receiverType);
  writeString(w, d.receiverFirmware);
  writeString(w, d.receiverSerial);
  return frameRtcm3(w.toBytes());
}

/* ================================================================== */
/*  1007 / 1008 — antenna descriptor                                   */
/* ================================================================== */

/**
 * Encode a framed 1007 antenna descriptor, or 1008 when `antennaSerial` is
 * given. Older rovers read the antenna (for its phase-centre model) from
 * these rather than from 1033.
 */
export function encodeAntennaDescriptor(
  d: Pick<
    StationDescriptors,
    'stationId' | 'antennaType' | 'antennaSetupId' | 'antennaSerial'
  >
): Uint8Array {
  const w = new BitWriter();
  w.writeU(d.antennaSerial !== undefined ? 1008 : 1007, 12);
  w.writeU(d.stationId, 12);
  writeString(w, d.antennaType);
  w.writeU(d.antennaSetupId ?? 0, 8);
  if (d.antennaSerial !== undefined) writeString(w, d.antennaSerial);
  return frameRtcm3(w.toBytes());
}

/* ================================================================== */
/*  1230 — GLONASS L1/L2 code-phase biases                             */
/* ================================================================== */

export interface GloCodePhaseBiases {
  stationId: number;
  /** DF421: true when code and phase are aligned (biases already applied). */
  aligned: boolean;
  /** Biases in metres (0.02 m resolution); absent = not transmitted. */
  l1ca?: number;
  l1p?: number;
  l2ca?: number;
  l2p?: number;
}

const BIAS_KEYS = ['l1ca', 'l1p', 'l2ca', 'l2p'] as const;

/** Encode a framed 1230 GLONASS code-phase bias message. */
export function encodeGloBiases(b: GloCodePhaseBiases): Uint8Array {
  const w = new BitWriter();
  w.writeU(1230, 12);
  w.writeU(b.stationId, 12);
  w.writeU(b.aligned ? 1 : 0, 1);
  w.zeros(3);
  for (const k of BIAS_KEYS) w.writeU(b[k] !== undefined ? 1 : 0, 1);
  for (const k of BIAS_KEYS) {
    if (b[k] !== undefined) w.writeS(Math.round(b[k] / 0.02), 16);
  }
  return frameRtcm3(w.toBytes());
}

/** Decode a 1230 GLONASS code-phase bias message; null for other types. */
export function decodeGloBiases(frame: Rtcm3Frame): GloCodePhaseBiases | null {
  if (frame.messageType !== 1230 || frame.payload.length < 4) return null;
  try {
    const r = new BitReader(frame.payload);
    r.skip(12);
    const out: GloCodePhaseBiases = {
      stationId: r.readU(12),
      aligned: r.readU(1) === 1,
    };
    r.skip(3);
    const mask = BIAS_KEYS.map(() => r.readU(1) === 1);
    BIAS_KEYS.forEach((k, i) => {
      if (mask[i]) out[k] = r.readS(16) * 0.02;
    });
    return out;
  } catch (err) {
    reportDecodeError('1230', err);
    return null;
  }
}
