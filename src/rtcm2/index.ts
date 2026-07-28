/**
 * RTCM 2.x decoder (RTCM 10402.3). A wholly different wire format from RTCM3:
 * a stream of 30-bit GPS-style words (24 data + 6 parity bits), each carried in
 * the low 6 bits of successive bytes ("6-of-8" — every byte has its top two
 * bits set to 01, so 0x40–0x7F). Words are parity-checked and their D30* bit
 * inverts the following data, exactly like the GPS LNAV navigation message.
 *
 * Framing/parity are a faithful port of RTKLIB `input_rtcm2` + `decode_word`.
 * {@link Rtcm2Decoder.decode} strips the encoding, parity-checks, syncs on the
 * 0x66 preamble and returns the message frames (header + the packed 24-bit-word
 * body); the per-type body decoders (`rtcm2Station`, `rtcm2Observation`,
 * `rtcm2Dgps`, `rtcm2Time`, `rtcm2Text`) read that body.
 *
 * Nearly extinct in favour of RTCM3, but still broadcast by some legacy CORS.
 */

const RTCM2_PREAMBLE = 0x66;
const HAMMING = [
  0xbb1f3480, 0x5d8f9a40, 0xaec7cd00, 0x5763e680, 0x6bb1f340, 0x8b7a89c0,
];
/** MSB-first unsigned read from a byte-packed buffer. */
function getbitu(buff: Uint8Array, pos: number, len: number): number {
  let v = 0;
  for (let i = pos; i < pos + len; i++)
    v = v * 2 + ((buff[i >> 3]! >> (7 - (i & 7))) & 1);
  return v >>> 0;
}
/** MSB-first signed (two's complement) read. */
function getbits(buff: Uint8Array, pos: number, len: number): number {
  const v = getbitu(buff, pos, len);
  return v & (1 << (len - 1)) ? v - 2 ** len : v;
}

/**
 * Check the GPS parity of a 30-bit word (with the previous word's D29*,D30* in
 * bits 31–30) and unpack its 24 data bits into 3 bytes. Returns null on a
 * parity failure. Port of RTKLIB `decode_word` (IS-GPS-200 §20.3.5.2).
 */
function decodeWord(w: number): [number, number, number] | null {
  let word = w >>> 0;
  if (word & 0x40000000) word = (word ^ 0x3fffffc0) >>> 0; // D30* inverts data
  let parity = 0;
  for (let i = 0; i < 6; i++) {
    parity <<= 1;
    let x = (word & HAMMING[i]!) >>> 6;
    while (x) {
      parity ^= x & 1;
      x >>>= 1;
    }
  }
  if (parity >>> 0 !== (word & 0x3f)) return null;
  return [(word >>> 22) & 0xff, (word >>> 14) & 0xff, (word >>> 6) & 0xff];
}

/** One decoded RTCM 2.x message frame (header + packed 24-bit-word body). */
export interface Rtcm2Frame {
  messageType: number;
  stationId: number;
  /** Modified Z-count, seconds within the hour (0–3599.4). */
  zcountSec: number;
  sequenceNo: number;
  /** Station health (3-bit). */
  health: number;
  /** Number of 24-bit data words after the 2-word header. */
  lengthWords: number;
  /** The parity-stripped message: header + data words, 24 bits per word packed
   *  MSB-first into bytes (message type at bit 8, body from bit 48). */
  payload: Uint8Array;
}

/**
 * Streaming RTCM 2.x framer. Feed bytes; get back complete, parity-valid
 * message frames. Retains partial-word state across calls.
 */
export class Rtcm2Decoder {
  private word = 0;
  private nbyte = 0;
  private nbit = 0;
  private len = 0;
  private buff = new Uint8Array(256);

  /** Reset the framer (e.g. after a stream reconnect). */
  reset(): void {
    this.word = 0;
    this.nbyte = 0;
    this.nbit = 0;
    this.len = 0;
  }

  decode(bytes: Uint8Array): Rtcm2Frame[] {
    const frames: Rtcm2Frame[] = [];
    for (const raw of bytes) {
      if ((raw & 0xc0) !== 0x40) continue; // not 6-of-8
      let data = raw;
      for (let i = 0; i < 6; i++, data >>= 1) {
        this.word = ((this.word << 1) | (data & 1)) >>> 0;
        if (this.nbyte === 0) {
          let preamb = (this.word >>> 22) & 0xff;
          if (this.word & 0x40000000) preamb ^= 0xff;
          if (preamb !== RTCM2_PREAMBLE) continue;
          const d = decodeWord(this.word);
          if (!d) continue;
          this.buff[0] = d[0];
          this.buff[1] = d[1];
          this.buff[2] = d[2];
          this.nbyte = 3;
          this.nbit = 0;
          continue;
        }
        if (++this.nbit < 30) continue;
        this.nbit = 0;
        const d = decodeWord(this.word);
        if (!d) {
          this.nbyte = 0;
          this.word &= 0x3;
          continue;
        }
        this.buff[this.nbyte] = d[0];
        this.buff[this.nbyte + 1] = d[1];
        this.buff[this.nbyte + 2] = d[2];
        this.nbyte += 3;
        if (this.nbyte === 6) this.len = (this.buff[5]! >> 3) * 3 + 6;
        if (this.nbyte < this.len) continue;
        frames.push(this.readHeader(this.buff.slice(0, this.len)));
        this.nbyte = 0;
        this.word &= 0x3;
      }
    }
    return frames;
  }

  private readHeader(payload: Uint8Array): Rtcm2Frame {
    return {
      messageType: getbitu(payload, 8, 6),
      stationId: getbitu(payload, 14, 10),
      zcountSec: getbitu(payload, 24, 13) * 0.6,
      sequenceNo: getbitu(payload, 37, 3),
      lengthWords: payload[5]! >> 3,
      health: getbitu(payload, 45, 3),
      payload,
    };
  }
}

/** Reference-station coordinates from Type 3 (ARP) or Type 22 (extension). */
export interface Rtcm2Station {
  /** ECEF position (m) — Type 3. */
  position?: [number, number, number];
  /** L1 phase-centre → ARP offset (m) — Type 22. */
  l1Offset?: [number, number, number];
  /** Antenna height above the monument (m) — Type 22. */
  height?: number;
}

/** Decode Type 3 (reference station ARP) or Type 22 (extended parameters). */
export function rtcm2Station(frame: Rtcm2Frame): Rtcm2Station | null {
  const p = frame.payload;
  const nbit = frame.lengthWords * 24;
  if (frame.messageType === 3) {
    if (nbit < 96) return null;
    return {
      position: [
        getbits(p, 48, 32) * 0.01,
        getbits(p, 80, 32) * 0.01,
        getbits(p, 112, 32) * 0.01,
      ],
    };
  }
  if (frame.messageType === 22) {
    if (nbit < 24) return null;
    const l1: [number, number, number] = [
      getbits(p, 48, 8) / 25600,
      getbits(p, 56, 8) / 25600,
      getbits(p, 64, 8) / 25600,
    ];
    let height: number | undefined;
    if (nbit >= 48) {
      const noh = getbits(p, 48 + 24 + 5, 1);
      height = noh ? 0 : getbitu(p, 48 + 24 + 6, 18) / 25600;
    }
    return { l1Offset: l1, height };
  }
  return null;
}

/** One raw observation record from a Type 18/19 message. */
export interface Rtcm2ObsRecord {
  prn: string;
  system: 'G' | 'R';
  /** Frequency: 0 = L1, 1 = L2. */
  freq: number;
  code: 'C/A' | 'P';
  /** Carrier phase (cycles) — Type 18. */
  phaseCycles?: number;
  /** Pseudorange (m) — Type 19. */
  pseudorangeM?: number;
  /** Loss-of-lock indicator (Type 18). */
  lossOfLock?: number;
}

/** Decode a Type 18 (carrier phase) or Type 19 (pseudorange) message into its
 *  per-satellite records. Returns the frequency, the multiple-message sync flag
 *  and the records; the caller pairs 18+19 across an epoch to form observations.
 *  Returns null for other types or an L2-frequency variant we don't map. */
export function rtcm2Observation(frame: Rtcm2Frame): {
  freq: number;
  sync: boolean;
  microSec: number;
  records: Rtcm2ObsRecord[];
} | null {
  const t = frame.messageType;
  if (t !== 18 && t !== 19) return null;
  const p = frame.payload;
  const nbit = frame.lengthWords * 24 + 48;
  let i = 48;
  if (i + 24 > nbit) return null;
  const fRaw = getbitu(p, i, 2);
  i += 4;
  const microSec = getbitu(p, i, 20);
  i += 20;
  if (fRaw & 0x1) return null; // "L1/L2 not both" variant — not supported
  const freq = fRaw >> 1;
  let sync = false;
  const records: Rtcm2ObsRecord[] = [];
  // Per-satellite record (48 bits): sync(1) code(1) sys(1) prn(5) then, for
  // Type 18, 3 reserved + loss(5) + carrier phase(32); for Type 19, 8-bit
  // multipath + pseudorange(32).
  while (i + 48 <= nbit) {
    sync = getbitu(p, i, 1) === 1;
    i += 1;
    const code = getbitu(p, i, 1);
    i += 1;
    const sys = getbitu(p, i, 1);
    i += 1;
    let prn = getbitu(p, i, 5);
    i += 5;
    let loss: number | undefined;
    if (t === 18) {
      i += 3; // reserved / data quality
      loss = getbitu(p, i, 5);
      i += 5;
    } else {
      i += 8; // multipath error
    }
    const val = t === 18 ? getbits(p, i, 32) : getbitu(p, i, 32);
    i += 32;
    if (prn === 0) prn = 32;
    const system = sys ? 'R' : 'G';
    const rec: Rtcm2ObsRecord = {
      prn: `${system}${String(prn).padStart(2, '0')}`,
      system,
      freq,
      code: code ? 'P' : 'C/A',
      lossOfLock: loss,
    };
    if (t === 18)
      rec.phaseCycles = -val / 256; // DF: −cp/256 cycles
    else rec.pseudorangeM = val * 0.02;
    records.push(rec);
  }
  return { freq, sync, microSec, records };
}

/** One differential correction from a Type 1/9 (GPS) or Type 31 (GLONASS). */
export interface Rtcm2Correction {
  prn: string;
  /** Pseudorange correction (m). */
  prc: number;
  /** Range-rate correction (m/s). */
  rrc: number;
  /** Issue of data. */
  iod: number;
  /** UDRE scale index (0–3). */
  udre: number;
}

/** Decode differential corrections — Type 1/9 (GPS) or Type 31 (GLONASS). */
export function rtcm2Dgps(frame: Rtcm2Frame): {
  system: 'G' | 'R';
  corrections: Rtcm2Correction[];
} | null {
  const t = frame.messageType;
  if (t !== 1 && t !== 9 && t !== 31) return null;
  const system = t === 31 ? 'R' : 'G';
  const p = frame.payload;
  const nbit = frame.lengthWords * 24 + 48;
  let i = 48;
  const corrections: Rtcm2Correction[] = [];
  while (i + 40 <= nbit) {
    const fact = getbitu(p, i, 1);
    i += 1;
    const udre = getbitu(p, i, 2);
    i += 2;
    let prn = getbitu(p, i, 5);
    i += 5;
    const prc = getbits(p, i, 16);
    i += 16;
    const rrc = getbits(p, i, 8);
    i += 8;
    const iod = getbits(p, i, 8);
    i += 8;
    if (prn === 0) prn = 32;
    corrections.push({
      prn: `${system}${String(prn).padStart(2, '0')}`,
      prc: prc * (fact ? 0.32 : 0.02),
      rrc: rrc * (fact ? 0.032 : 0.002),
      iod,
      udre,
    });
  }
  return { system, corrections };
}

/** Decode Type 14 — GPS time of week (week/hour + leap seconds). */
export function rtcm2Time(frame: Rtcm2Frame): {
  week: number;
  hour: number;
  zcountSec: number;
  leapSeconds: number;
} | null {
  if (frame.messageType !== 14) return null;
  const p = frame.payload;
  if (frame.lengthWords * 24 < 24) return null;
  return {
    zcountSec: getbitu(p, 24, 13) * 0.6,
    week: getbitu(p, 48, 10),
    hour: getbitu(p, 58, 8),
    leapSeconds: getbitu(p, 66, 6),
  };
}

/** Decode Type 16 — GPS special (ASCII text) message. */
export function rtcm2Text(frame: Rtcm2Frame): string | null {
  if (frame.messageType !== 16) return null;
  const p = frame.payload;
  const nbit = frame.lengthWords * 24 + 48;
  let s = '';
  for (let i = 48; i + 8 <= nbit; i += 8) {
    const c = getbitu(p, i, 8);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** RTCM 2.x message-type names for the census/inspector. */
export const RTCM2_MESSAGE_NAMES: Record<number, string> = {
  1: 'GPS differential corrections',
  3: 'Reference station parameters (ARP)',
  9: 'GPS partial correction set',
  14: 'GPS time of week',
  16: 'GPS special message (text)',
  17: 'GPS ephemerides',
  18: 'RTK uncorrected carrier phase',
  19: 'RTK uncorrected pseudorange',
  22: 'Extended reference station parameters',
  23: 'Antenna type definition',
  24: 'Antenna reference point (ARP)',
  31: 'GLONASS differential corrections',
  32: 'GLONASS reference station parameters',
  34: 'GLONASS partial correction set',
  36: 'GLONASS special message',
};

/**
 * Heuristic: does this buffer look like an RTCM 2.x stream? Every byte must be
 * 6-of-8 (top two bits 01), and the framer must extract at least two
 * parity-valid frames from the head.
 */
export function looksLikeRtcm2(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  if (n < 12) return false;
  for (let i = 0; i < n; i++) if ((bytes[i]! & 0xc0) !== 0x40) return false;
  return new Rtcm2Decoder().decode(bytes.subarray(0, n)).length >= 2;
}
