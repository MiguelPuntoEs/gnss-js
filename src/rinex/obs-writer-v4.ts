/**
 * RINEX 4.01 observation file writer.
 *
 * RINEX 4 is structurally identical to RINEX 3 for our output — same
 * header layout, same epoch record format. Only the version line, the
 * provenance comment and the deprecated SYS / PHASE SHIFT and GLONASS
 * COD/PHS/BIS records differ, so this delegates to the shared
 * implementation in obs-writer.ts.
 */

import type { RinexHeader } from './parser';
import type { CompactEpoch } from './obs-writer';
import { writeModernObsBlob } from './obs-writer';

/** Write RINEX 4.01 obs file from compact observations. */
export function writeRinex4ObsBlob(
  header: RinexHeader,
  epochs: CompactEpoch[],
  obsTypes: Map<string, string[]>
): Promise<Blob> {
  return writeModernObsBlob(header, epochs, obsTypes, {
    version: '4.01',
    comment: 'Converted to RINEX 4 by GNSSCalc',
  });
}
