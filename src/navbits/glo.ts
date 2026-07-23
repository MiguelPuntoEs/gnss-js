/**
 * GLONASS L1/L2 C/A navigation-string decoding: the 85-bit navigation
 * strings of the GLONASS ICD (L1/L2 edition 5.1, 2008), strings 1-4
 * of which carry the ephemeris.
 *
 * Receiver-independent, like the other decoders in this module:
 * Septentrio GLORawCA and u-blox RXM-SFRBX deliver the same strings,
 * so the Hamming (KX) check, the string decoder and the frame
 * assembler live here.
 *
 * `testGloString` and `decodeGloStrings` are ports of RTKLIB's
 * `test_glostr` and `decode_glostr` (demo5 / rtklibexplorer fork,
 * src/rcvraw.c), Copyright (c) 2009-2020 T. Takasu / 2014 T. Suzuki,
 * BSD-2-Clause, cross-checked against the GLONASS ICD §4.7 (Hamming
 * code) and Tables 4.5/4.9 (string contents). Output records mirror
 * `parseNavFile` for RINEX GLONASS records — the conventions settled
 * in src/novatel/nav.ts decodeGloEphemeris: UTC-based `tocDate` (the
 * toe), the RINEX sign for `tauN` (−τn), state vectors in km (PZ-90),
 * and `messageFrameTime` as seconds of the UTC week. String fields
 * with no RINEX slot (Δτn, En, P flags, FT, NT, M) are dropped.
 */

import type { GlonassEphemeris } from '../rinex/nav';
import { getUtcDate } from '../time/utc';
import { getBitU } from './index';

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const SEC_PER_WEEK = 7 * 86400;
const SEC_PER_DAY = 86400;

/** Bytes per stored string (80 bits: idle bit + 76 data bits, padded). */
export const GLO_STRING_BYTES = 10;

/** Sign-magnitude field of the GLONASS ICD (sign bit, then magnitude).
 * A set sign bit with zero magnitude yields +0, not −0 (the SIS does
 * broadcast that pattern; RINEX prints it as plain zero). */
function getBitG(b: Uint8Array, pos: number, len: number): number {
  const value = getBitU(b, pos + 1, len - 1);
  return getBitU(b, pos, 1) && value !== 0 ? -value : value;
}

/* ── Hamming (KX) check ────────────────────────────────────────── */

/**
 * Bit masks of the eight Hamming checksums C1-C7 and Σ (GLONASS ICD
 * §4.7) over the 85-bit string, bit 85 first (RTKLIB test_glostr).
 */
const HAMMING_MASKS: readonly (readonly number[])[] = [
  [0x55, 0x55, 0x5a, 0xaa, 0xaa, 0xaa, 0xb5, 0x55, 0x6a, 0xd8, 0x08],
  [0x66, 0x66, 0x6c, 0xcc, 0xcc, 0xcc, 0xd9, 0x99, 0xb3, 0x68, 0x10],
  [0x87, 0x87, 0x8f, 0x0f, 0x0f, 0x0f, 0x1e, 0x1e, 0x3c, 0x70, 0x20],
  [0x07, 0xf8, 0x0f, 0xf0, 0x0f, 0xf0, 0x1f, 0xe0, 0x3f, 0x80, 0x40],
  [0xf8, 0x00, 0x0f, 0xff, 0xf0, 0x00, 0x1f, 0xff, 0xc0, 0x00, 0x80],
  [0x00, 0x00, 0x0f, 0xff, 0xff, 0xff, 0xe0, 0x00, 0x00, 0x01, 0x00],
  [0xff, 0xff, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00],
  [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xf8],
];

/**
 * Test the Hamming (KX) code of one GLONASS navigation string
 * (GLONASS ICD §4.7; RTKLIB test_glostr): `buff[0]` holds string bits
 * 85-78 (bit 85, the idle bit, is the MSB and the first transmitted
 * bit), ..., `buff[10]` holds bits 5-1 in its upper 5 bits,
 * zero-padded. Accepts error-free strings and the correctable
 * single-bit-error signature (two failed checksums including Σ).
 */
export function testGloString(buff: Uint8Array): boolean {
  if (buff.length < 11) return false;
  let n = 0;
  let cs = 0;
  for (const mask of HAMMING_MASKS) {
    cs = 0;
    for (let j = 0; j < 11; j++) {
      let x = buff[j]! & mask[j]!;
      x ^= x >> 4;
      x ^= x >> 2;
      x ^= x >> 1;
      cs ^= x & 1;
    }
    if (cs) n++;
  }
  return n === 0 || (n === 2 && cs === 1);
}

/* ── Strings 1-4 → ephemeris ───────────────────────────────────── */

export interface DecodeGloOptions {
  /** Frequency channel number (−7…+6) for the output record; the
   * strings do not carry it. Defaults to 0, like RTKLIB. */
  freqNum?: number;
}

/**
 * Decode GLONASS strings 1-4 into a `GlonassEphemeris` (RTKLIB
 * decode_glostr). Input: strings at 10-byte strides — bytes 0-9
 * string 1, ..., 30-39 string 4 — each holding the string from the
 * idle bit (bit 0 of the buffer = string bit 85), Hamming bits and
 * time mark not needed (only the first 77 bits are read).
 *
 * `refDate` is a GPS-scale Date within half a day of the frame
 * (e.g. the receiver time stamp of string 4); it resolves the day
 * that tb and tk count into, exactly like RTKLIB's geph->tof input.
 *
 * Returns `null` when the string numbers are not 1/2/3/4 or the
 * string-4 slot number is out of range (0 or > 27).
 */
export function decodeGloStrings(
  strings: Uint8Array,
  refDate: Date,
  opts: DecodeGloOptions = {}
): GlonassEphemeris | null {
  if (strings.length < 4 * GLO_STRING_BYTES) return null;
  const b = strings;

  /* string 1 (bit 1 of each stride = string bit 84, the string number) */
  let i = 1;
  const frn1 = getBitU(b, i, 4);
  i += 4 + 2; // + reserved
  i += 2; // P1
  const tkH = getBitU(b, i, 5);
  i += 5;
  const tkM = getBitU(b, i, 6);
  i += 6;
  const tkS = getBitU(b, i, 1) * 30;
  i += 1;
  const xDot = getBitG(b, i, 24) * 2 ** -20; // km/s
  i += 24;
  const xAcc = getBitG(b, i, 5) * 2 ** -30; // km/s²
  i += 5;
  const x = getBitG(b, i, 27) * 2 ** -11; // km

  /* string 2 */
  i = 80 + 1;
  const frn2 = getBitU(b, i, 4);
  i += 4;
  const bn = getBitU(b, i, 1); // MSB of the 3-bit Bn word
  i += 1 + 2;
  i += 1; // P2
  const tb = getBitU(b, i, 7);
  i += 7 + 5;
  const yDot = getBitG(b, i, 24) * 2 ** -20;
  i += 24;
  const yAcc = getBitG(b, i, 5) * 2 ** -30;
  i += 5;
  const y = getBitG(b, i, 27) * 2 ** -11;

  /* string 3 */
  i = 160 + 1;
  const frn3 = getBitU(b, i, 4);
  i += 4;
  i += 1; // P3
  const gammaN = getBitG(b, i, 11) * 2 ** -40;
  i += 11 + 1;
  i += 2; // P
  i += 1; // ln
  const zDot = getBitG(b, i, 24) * 2 ** -20;
  i += 24;
  const zAcc = getBitG(b, i, 5) * 2 ** -30;
  i += 5;
  const z = getBitG(b, i, 27) * 2 ** -11;

  /* string 4 */
  i = 240 + 1;
  const frn4 = getBitU(b, i, 4);
  i += 4;
  const tauN = getBitG(b, i, 22) * 2 ** -30;
  i += 22;
  i += 5; // Δτn
  i += 5; // En (age)
  i += 14; // reserved
  i += 1; // P4
  i += 4; // FT
  i += 3; // reserved
  i += 11; // NT
  const slot = getBitU(b, i, 5);
  // i+5, 2 bits: M (satellite type) — not part of the emitted record

  if (frn1 !== 1 || frn2 !== 2 || frn3 !== 3 || frn4 !== 4) return null;
  if (slot < 1 || slot > 27) return null;

  /* Resolve tk/tb into the UTC day of refDate (RTKLIB decode_glostr:
   * tow of the UTC-converted reference time, tk/tb are Moscow time). */
  const utcSec = (getUtcDate(refDate).getTime() - GPS_EPOCH_MS) / 1000;
  const week = Math.floor(utcSec / SEC_PER_WEEK);
  let tow = utcSec - week * SEC_PER_WEEK;
  const tod = tow % SEC_PER_DAY;
  tow -= tod;

  let tof = tkH * 3600 + tkM * 60 + tkS - 10800; // MT → UTC
  if (tof < tod - 43200) tof += SEC_PER_DAY;
  else if (tof > tod + 43200) tof -= SEC_PER_DAY;

  let toe = tb * 900 - 10800; // MT → UTC
  if (toe < tod - 43200) toe += SEC_PER_DAY;
  else if (toe > tod + 43200) toe -= SEC_PER_DAY;

  return {
    system: 'R',
    prn: `R${String(slot).padStart(2, '0')}`,
    // RINEX GLONASS epochs are UTC: build the UTC toe Date directly.
    tocDate: new Date(GPS_EPOCH_MS + (week * SEC_PER_WEEK + tow + toe) * 1000),
    tauN: -tauN, // RINEX stores −τn; the SIS carries τn (ICD sign)
    gammaN,
    // v3 message frame time: seconds of the UTC week (RTKLIB tof).
    messageFrameTime:
      (((tow + tof) % SEC_PER_WEEK) + SEC_PER_WEEK) % SEC_PER_WEEK,
    x,
    xDot,
    xAcc,
    y,
    yDot,
    yAcc,
    z,
    zDot,
    zAcc,
    // MSB of the 3-bit Bn word — the unhealthy flag RINEX carries
    health: bn,
    freqNum: opts.freqNum ?? 0,
  };
}

/* ── Streaming assembler ───────────────────────────────────────── */

interface GloSatState {
  buf: Uint8Array;
  /** Time stamp (integer s) of the first string of the current batch. */
  batchSec: number;
  lastKey?: string;
}

/**
 * Streaming assembler for GLONASS ephemerides: feed 85-bit strings
 * (Hamming-checked — see `testGloString`) in received order; a
 * `GlonassEphemeris` is returned whenever a satellite's buffered
 * strings 1-4 first form a consistent frame, with unchanged repeats
 * of the same tb/health suppressed — the same flow as RTKLIB's
 * decode_glorawcanav (src/rcv/septentrio.c), including its > 30 s
 * batch-gap buffer reset. L1 C/A and L2 C/A carry identical strings
 * and may share one assembler, as in RTKLIB.
 */
export class GloStringAssembler {
  private sats = new Map<string, GloSatState>();

  /**
   * Push one navigation string (10+ bytes, bit 0 = string bit 85) for
   * the satellite `prn` ("R09"), received at the GPS-scale `time`.
   * Returns the newly completed ephemeris, or null. The decoded
   * string-4 slot number must match `prn`, or nothing is emitted.
   */
  push(
    prn: string,
    str: Uint8Array,
    time: Date,
    freqNum = 0
  ): GlonassEphemeris | null {
    if (str.length < GLO_STRING_BYTES) return null;
    const m = getBitU(str, 1, 4);
    if (m < 1) return null;

    const sec = Math.floor(time.getTime() / 1000);
    let sat = this.sats.get(prn);
    if (!sat) {
      sat = { buf: new Uint8Array(4 * GLO_STRING_BYTES), batchSec: sec };
      this.sats.set(prn, sat);
    } else if (Math.abs(sec - sat.batchSec) > 30) {
      sat.buf.fill(0);
      sat.batchSec = sec;
    }

    if (m > 4) return null; // strings 5-15: almanac/UTC, not buffered
    sat.buf.set(str.subarray(0, GLO_STRING_BYTES), (m - 1) * 10);
    if (m !== 4) return null;

    const eph = decodeGloStrings(sat.buf, time, { freqNum });
    if (!eph || eph.prn !== prn) return null;

    /* suppress unchanged rebroadcasts (RTKLIB dedups on tb/svh/toe) */
    const key = `${eph.tocDate.getTime()}:${eph.health}`;
    if (key === sat.lastKey) return null;
    sat.lastKey = key;
    return eph;
  }
}
