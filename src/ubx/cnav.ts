/**
 * u-blox UBX raw CNAV decoding: GPS L2C CNAV messages from RXM-SFRBX
 * (class 0x02, id 0x13), gnssId 0 with sigId 3 (L2 CL) or 4 (L2 CM).
 *
 * Word packing: the u-blox interface description delivers the 300-bit
 * CNAV message as 10 32-bit `dwrd` words (little-endian in the
 * stream) with the message bits left-justified MSB-first — message
 * bit 0 is bit 31 of dwrd[0], and the low 20 bits of dwrd[9] are
 * padding. Verified empirically on a ZED-F9P capture: this unpacking
 * yields a valid CRC-24Q (and the 0x8B preamble in the top byte of
 * dwrd[0], the same property `readLnavSubframe` in ./nav uses to skip
 * CNAV frames) on effectively every message. RTKLIB demo5 does not
 * decode CNAV from u-blox receivers; the field decoding lives in
 * `src/navbits/cnav.ts`, working from IS-GPS-200 directly.
 */

import { CnavAssembler, cnavCrcOk, type CnavEphemeris } from '../navbits/cnav';
import { ubxFrames } from './frame';

export type { CnavEphemeris } from '../navbits/cnav';

export interface UbxCnavResult {
  /** Assembled CNAV ephemerides in stream order, repeats suppressed. */
  ephemerides: CnavEphemeris[];
  /** Raw messages whose CRC-24Q check failed (dropped). */
  badCrc: number;
  /** Total GPS L2C RXM-SFRBX messages seen (checksum-valid frames). */
  messages: number;
}

/**
 * Decode every GPS L2C CNAV message in a UBX byte stream (RXM-SFRBX,
 * gnssId 0, sigId 3/4) and assemble them into ephemerides.
 */
export function parseUbxCnav(data: Uint8Array): UbxCnavResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const assembler = new CnavAssembler();
  const ephemerides: CnavEphemeris[] = [];
  let badCrc = 0;
  let messages = 0;

  for (const f of ubxFrames(data)) {
    if (f.msgClass !== 0x02 || f.msgId !== 0x13) continue;
    const p = f.payload;
    // gnssId, svId, sigId, freqId, numWords, chn, version, reserved0
    if (p.length < 8 + 40) continue;
    if (p[0] !== 0 || (p[2] !== 3 && p[2] !== 4)) continue;
    const svId = p[1]!;
    if (svId < 1 || svId > 32) continue;
    messages++;

    // 10 dwrds, message bits left-justified MSB-first per word.
    const msg = new Uint8Array(40);
    const base = f.payloadStart + 8;
    for (let k = 0; k < 10; k++) {
      const w = view.getUint32(base + 4 * k, true);
      msg[4 * k] = w >>> 24;
      msg[4 * k + 1] = (w >>> 16) & 0xff;
      msg[4 * k + 2] = (w >>> 8) & 0xff;
      msg[4 * k + 3] = w & 0xff;
    }

    if (!cnavCrcOk(msg)) {
      badCrc++;
      continue;
    }
    const eph = assembler.push(msg);
    if (eph) ephemerides.push(eph);
  }

  return { ephemerides, badCrc, messages };
}
