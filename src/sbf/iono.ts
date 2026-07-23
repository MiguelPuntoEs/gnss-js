/**
 * Septentrio SBF decoded ionosphere / UTC blocks.
 *
 * GPSIon (5893) and BDSIon (4120) carry the eight Klobuchar vertical
 * delay coefficients, GALIon (4030) the three NeQuick-G effective
 * ionisation level coefficients, and GPSUtc (5894) the GPS-UTC
 * parameters from LNAV subframe 4 page 18 (only ΔtLS, the current
 * leap-second count, is extracted here).
 *
 * Units: SBF stores the coefficients as f4 floats already in the
 * semicircle-based SI units of the broadcast messages — alpha_n in
 * s/semicircle^n, beta_n in s/semicircle^n, ai_n in sfu/deg^n — which
 * are exactly the units a RINEX nav header prints. Values are passed
 * through unscaled, so the output matches what `parseNavFile` reads
 * from a converted nav header to float32 precision.
 *
 * Ported from RTKLIB demo5 (rtklibexplorer), src/rcv/septentrio.c
 * (decode_gpsion / decode_galion / decode_cmpion / decode_gpsutc),
 * BSD-2-Clause, and cross-checked against the Septentrio mosaic-X5
 * reference guide (which documents all four block layouts, including
 * the do-not-use markers RTKLIB does not check).
 */

import { scanSbfFrames } from './frame';

const F4_DNU = -2e10; // do-not-use value for f4 fields

export interface SbfIonoUtcResult {
  /**
   * Iono coefficient sets keyed like `NavHeader.ionoCorrections`:
   * `GPSA`/`GPSB` (Klobuchar alpha/beta), `GAL` ([ai0, ai1, ai2],
   * RINEX GAL header convention), `BDSA`/`BDSB`. The blocks repeat;
   * the last valid block of each type in the stream wins.
   */
  ionoCorrections: Record<string, number[]>;
  /** GPS-UTC ΔtLS from the last GPSUtc block, if any. */
  leapSeconds: number | null;
}

/**
 * Decode every GPSIon/GALIon/BDSIon/GPSUtc block in an SBF byte
 * stream. Blocks with do-not-use coefficients are skipped; other block
 * types are skipped silently.
 */
export function parseSbfIonoUtc(data: Uint8Array): SbfIonoUtcResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ionoCorrections: Record<string, number[]> = {};
  let leapSeconds: number | null = null;

  /** Read `n` consecutive f4 fields, or null when any is do-not-use. */
  const f4s = (b: number, n: number): number[] | null => {
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      const v = view.getFloat32(b + 4 * k, true);
      if (v === F4_DNU) return null;
      out.push(v);
    }
    return out;
  };

  scanSbfFrames(data, view, (id, b, len) => {
    if ((id === 5893 || id === 4120) && len >= 48) {
      // GPSIon / BDSIon: alpha_0..3 then beta_0..3, f4 each
      const alpha = f4s(b + 16, 4);
      const beta = f4s(b + 32, 4);
      if (!alpha || !beta) return;
      const sys = id === 5893 ? 'GPS' : 'BDS';
      ionoCorrections[`${sys}A`] = alpha;
      ionoCorrections[`${sys}B`] = beta;
    } else if (id === 4030 && len >= 28) {
      // GALIon: ai0, ai1, ai2 (the storm flags at b+28 are not decoded)
      const ai = f4s(b + 16, 3);
      if (ai) ionoCorrections['GAL'] = ai;
    } else if (id === 5894 && len >= 37) {
      // GPSUtc: A1 f4, A0 f8, t_ot u4, WN_t u1, then DEL_t_LS i1
      leapSeconds = view.getInt8(b + 33);
    }
  });

  return { ionoCorrections, leapSeconds };
}
