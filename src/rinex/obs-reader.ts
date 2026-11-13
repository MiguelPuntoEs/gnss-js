/**
 * RINEX / Compact RINEX observation file → {@link CompactEpoch}s, keeping
 * everything a conversion must carry: values, LLI, signal strength, the
 * epoch flag, the receiver clock offset and event records — the input the
 * RINEX 2/3/4 writers take, so any version converts to any other.
 */

import { parseRinexStream } from './parser';
import type { RinexHeader } from './parser';
import type { CompactEpoch } from './obs-writer';

export interface RinexObsData {
  header: RinexHeader;
  /** Observation epochs and events, in file order. */
  epochs: CompactEpoch[];
  /**
   * System → obs codes, the index order of every epoch's values. A RINEX 2
   * file's shared `# / TYPES OF OBSERV` list is repeated per system seen.
   */
  obsTypes: Map<string, string[]>;
}

/** Read a whole observation file (RINEX 2/3/4 or CRINEX, gz/Z too). */
export async function readRinexObs(file: Blob): Promise<RinexObsData> {
  const epochs: CompactEpoch[] = [];
  const obsTypes = new Map<string, string[]>();
  let cur: CompactEpoch | null = null;
  const result = await parseRinexStream(
    file instanceof File ? file : new File([file], 'obs'),
    undefined,
    undefined,
    (_time, prn, codes, values, lli, ssi) => {
      if (!cur) return;
      const sys = prn[0]!;
      if (!obsTypes.has(sys)) obsTypes.set(sys, codes);
      cur.sats.set(
        prn,
        Float64Array.from(values, (v) => v ?? NaN)
      );
      if (lli?.some((f) => f))
        (cur.lli ??= new Map()).set(
          prn,
          Uint8Array.from(lli, (f) => f ?? 0)
        );
      if (ssi?.some((f) => f))
        (cur.ssi ??= new Map()).set(
          prn,
          Uint8Array.from(ssi, (f) => f ?? 0)
        );
    },
    true,
    (rec) => {
      cur = { time: rec.time, sats: new Map() };
      if (rec.flag) cur.flag = rec.flag;
      if (rec.clockOffset !== null) cur.clockOffset = rec.clockOffset;
      if (rec.records) cur.records = rec.records;
      epochs.push(cur);
    }
  );
  // Header order (RINEX 3: every declared system, observed or not); a
  // RINEX 2 file's shared list goes to each system seen, in first-seen order.
  const h = result.header;
  const ordered = new Map<string, string[]>();
  if (h.version >= 3)
    for (const [sys, codes] of Object.entries(h.obsTypes))
      if (sys !== '_v2') ordered.set(sys, codes);
  for (const [sys, codes] of obsTypes)
    if (!ordered.has(sys)) ordered.set(sys, codes);
  return { header: h, epochs, obsTypes: ordered };
}
