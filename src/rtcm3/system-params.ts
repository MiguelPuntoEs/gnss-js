/**
 * RTCM3 System Parameters — message 1013 (RTCM 10403.2 §3.5.5). A reference
 * station's "table of contents": the reference epoch (Modified Julian Day +
 * seconds of day, UTC), the current **GPS−UTC leap seconds**, and the schedule
 * of message types the station transmits (each with a sync flag and its
 * broadcast interval). Useful for time handling and for telling, at a glance,
 * what a caster is configured to send.
 */
import { BitReader } from './decoder';
import type { Rtcm3Frame } from './decoder';

/** One announced message in the station's schedule (DF055/DF056/DF057). */
export interface SystemParamsMessage {
  /** RTCM message type the station broadcasts. */
  messageId: number;
  /** Synchronous flag. */
  sync: boolean;
  /** Transmission interval (seconds; 0.1 s resolution per DF057). */
  intervalS: number;
}

/** Decoded RTCM3 System Parameters (message 1013). */
export interface SystemParams {
  referenceStationId: number;
  /** Modified Julian Day number of the reference epoch. */
  mjd: number;
  /** Seconds of day (UTC) of the reference epoch. */
  secondsOfDay: number;
  /** Current GPS−UTC leap seconds. */
  leapSeconds: number;
  /** The message types this station announces it transmits. */
  messages: SystemParamsMessage[];
}

/**
 * Decode an RTCM3 System Parameters message (1013), or null for any other type
 * or a short/corrupt frame.
 */
export function decodeSystemParams(frame: Rtcm3Frame): SystemParams | null {
  if (frame.messageType !== 1013) return null;
  const r = new BitReader(frame.payload);
  r.readU(12); // DF002 message number
  const referenceStationId = r.readU(12); // DF003
  const mjd = r.readU(16); // DF051
  const secondsOfDay = r.readU(17); // DF052
  const nm = r.readU(5); // DF053 number of message announcements
  const leapSeconds = r.readU(8); // DF054
  const messages: SystemParamsMessage[] = [];
  for (let i = 0; i < nm; i++) {
    messages.push({
      messageId: r.readU(12), // DF055
      sync: r.readU(1) === 1, // DF056
      intervalS: r.readU(16) * 0.1, // DF057 (0.1 s)
    });
  }
  return { referenceStationId, mjd, secondsOfDay, leapSeconds, messages };
}
