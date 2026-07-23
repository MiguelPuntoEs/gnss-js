/**
 * Septentrio SBF raw CNAV navigation-bit blocks: GPSRawL2C (4018) and
 * GPSRawL5 (4019) each carry one 300-bit GPS CNAV message.
 *
 * Block layout (mosaic-X5 reference guide §4): after the 8-byte SBF
 * header, TOW u4 + WNc u2, SVID u1, CRCPassed u1, ViterbiCnt u1,
 * Source u1, FreqNr u1, RxChannel u1, then NAVBits as u4[10] — the
 * first received bit is the MSB of NAVBits[0] (each u4 little-endian
 * in the stream, message bits MSB-first within the word), the unused
 * 20 bits of NAVBits[9] to be ignored. RTKLIB demo5's
 * decode_gpsrawcnav (src/rcv/septentrio.c) reads the same header but
 * leaves the message body undecoded (a TODO stub); the field decoding
 * here is `src/navbits/cnav.ts` working from IS-GPS-200 directly.
 *
 * The receiver's own CRCPassed flag is ignored in favor of re-running
 * CRC-24Q on the transported bits, so `badCrc` counts exactly the
 * messages this library rejected.
 */

import { CnavAssembler, cnavCrcOk, type CnavEphemeris } from '../navbits/cnav';
import { scanSbfFrames } from './frame';

export type { CnavEphemeris } from '../navbits/cnav';

/** A CNAV ephemeris tagged with the SBF block (signal) it came from. */
export interface SbfCnavEphemeris extends CnavEphemeris {
  signal: 'L2C' | 'L5';
}

export interface SbfCnavResult {
  /** Assembled CNAV ephemerides in stream order, repeats suppressed. */
  ephemerides: SbfCnavEphemeris[];
  /** Raw messages whose CRC-24Q check failed (dropped). */
  badCrc: number;
  /** Total GPSRawL2C/GPSRawL5 blocks seen (with valid SBF framing). */
  messages: number;
}

/** SBF signal-type numbers (mosaic-X5 refguide §4.1.10) → label. */
const SIGNAL_OF_BLOCK: Record<number, 'L2C' | 'L5'> = {
  4018: 'L2C',
  4019: 'L5',
};

/**
 * Decode every GPSRawL2C/GPSRawL5 block in an SBF byte stream and
 * assemble the carried CNAV messages into ephemerides. L2C and L5 are
 * assembled independently (one `CnavAssembler` per signal), so a data
 * set complete on both signals yields one record per signal; each
 * record's `signal` property names its source.
 */
export function parseSbfCnav(data: Uint8Array): SbfCnavResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ephemerides: SbfCnavEphemeris[] = [];
  const assemblers: Record<'L2C' | 'L5', CnavAssembler> = {
    L2C: new CnavAssembler(),
    L5: new CnavAssembler(),
  };
  let badCrc = 0;
  let messages = 0;

  scanSbfFrames(data, view, (id, b, len) => {
    const signal = SIGNAL_OF_BLOCK[id];
    if (!signal || len < 60) return;
    messages++;

    // NAVBits u4[10] at +20: first received bit = MSB of NAVBits[0].
    const msg = new Uint8Array(40);
    for (let k = 0; k < 10; k++) {
      const w = view.getUint32(b + 20 + 4 * k, true);
      msg[4 * k] = w >>> 24;
      msg[4 * k + 1] = (w >>> 16) & 0xff;
      msg[4 * k + 2] = (w >>> 8) & 0xff;
      msg[4 * k + 3] = w & 0xff;
    }

    if (!cnavCrcOk(msg)) {
      badCrc++;
      return;
    }
    const eph = assemblers[signal].push(msg);
    if (eph) ephemerides.push({ ...eph, signal });
  });

  return { ephemerides, badCrc, messages };
}
