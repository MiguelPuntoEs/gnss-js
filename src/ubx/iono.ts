/**
 * u-blox UBX ionosphere / UTC decoding: the GPS LNAV subframe 4
 * page 18 broadcast (Klobuchar coefficients + GPS-UTC parameters)
 * from RXM-SFRBX.
 *
 * Ported from RTKLIB demo5 (rtklibexplorer fork, src/rcvraw.c:
 * decode_frame_ion / decode_frame_utc, Copyright (c) 2007-2020
 * T. Takasu, BSD-2-Clause); frame extraction is shared with
 * `parseUbxNav` through `readLnavSubframe` (./nav.ts).
 *
 * Scope is GPS satellites (gnssId 0) only: QZSS also broadcasts
 * page-18-format iono parameters, but those are the separate
 * wide-area/Japan-area QZSS coefficient set, not the GPS one a RINEX
 * `GPSA`/`GPSB` header carries. Scale factors follow IS-GPS-200
 * §20.3.3.5.1 (alpha_n in s/semicircle^n, beta_n in s/semicircle^n) —
 * the same semicircle-based units the RINEX nav header prints, so the
 * output matches `parseNavFile` on a converted header. Like
 * `parseUbxNav`, the decoder never consults the system clock (nothing
 * here needs a week reference).
 */

import { getBitS, getBitU } from '../navbits';
import { ubxFrames } from './frame';
import { readLnavSubframe } from './nav';

export interface UbxIonoUtcResult {
  /**
   * Iono coefficient sets keyed like `NavHeader.ionoCorrections`:
   * `GPSA` (alpha_0..3) and `GPSB` (beta_0..3). The page repeats
   * (nominally every 12.5 min per satellite); the last broadcast in
   * the stream wins.
   */
  ionoCorrections: Record<string, number[]>;
  /** GPS-UTC ΔtLS from the last page-18 broadcast, if any. */
  leapSeconds: number | null;
}

/**
 * Decode every GPS LNAV subframe 4 page 18 (data ID 1, SV ID 56) in a
 * UBX byte stream (RXM-SFRBX) into Klobuchar iono coefficients and the
 * current leap-second count.
 */
export function parseUbxIonoUtc(data: Uint8Array): UbxIonoUtcResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ionoCorrections: Record<string, number[]> = {};
  let leapSeconds: number | null = null;

  for (const f of ubxFrames(data)) {
    if (f.msgClass !== 0x02 || f.msgId !== 0x13) continue;
    const sf = readLnavSubframe(view, f);
    if (!sf || sf.gnssId !== 0 || sf.id !== 4) continue;

    // Word 3: data ID (2 bits) + SV ID; page 18 carries SV ID 56.
    const b = sf.buff;
    if (getBitU(b, 48, 2) !== 1 || getBitU(b, 50, 6) !== 56) continue;

    // Iono coefficients, bits 56..119 (RTKLIB decode_frame_ion).
    ionoCorrections['GPSA'] = [
      getBitS(b, 56, 8) * 2 ** -30,
      getBitS(b, 64, 8) * 2 ** -27,
      getBitS(b, 72, 8) * 2 ** -24,
      getBitS(b, 80, 8) * 2 ** -24,
    ];
    ionoCorrections['GPSB'] = [
      getBitS(b, 88, 8) * 2 ** 11,
      getBitS(b, 96, 8) * 2 ** 14,
      getBitS(b, 104, 8) * 2 ** 16,
      getBitS(b, 112, 8) * 2 ** 16,
    ];

    // UTC parameters follow: A1 (24), A0 (32), t_ot (8), WN_t (8),
    // then ΔtLS at bit 192 (RTKLIB decode_frame_utc).
    leapSeconds = getBitS(b, 192, 8);
  }

  return { ionoCorrections, leapSeconds };
}
