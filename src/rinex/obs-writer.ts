/**
 * RINEX 3.04 / 4.01 observation file writer.
 *
 * The two formats share the same header layout and epoch record
 * encoding — only the version line, the provenance comment and the two
 * records RINEX 4 deprecates (SYS / PHASE SHIFT, GLONASS COD/PHS/BIS,
 * mandatory in 3.04) differ (see obs-writer.test.ts, which pins this). RINEX 2.11 lives in
 * obs-writer-v2.ts (different header records and epoch layout).
 *
 * Streams text through gzip compression so we never hold the full
 * uncompressed output in memory. Returns a gzip-compressed Blob.
 */

import type { RinexHeader } from './parser';
import type { SatValues } from './epoch-sats';
import { padL, padR, fmtF, hdrLine } from './format';
import {
  clockOffsApplLine,
  createGzipLineSink,
  epochLine3,
  glonassCodPhsBisLine,
  leapSecondsLine,
  obsField,
  obsTimeSystem,
  phaseShiftLines,
  timeOfObs,
  stationHeaderLines,
} from './obs-writer-common';

/* ================================================================== */
/*  Types                                                              */
/* ================================================================== */

/**
 * Compact epoch — stores observation values in Float64Arrays
 * indexed by a per-system obs code registry (NaN = missing).
 * ~10-15x less memory than Map-of-Maps; an {@link EpochSats} for `sats`
 * halves it again on large files.
 */
export interface CompactEpoch {
  time: number; // unix ms
  /** PRN → values indexed by obsTypes order: a Map or an EpochSats. */
  sats: SatValues;
  /** PRN → loss-of-lock indicator per value (0 = blank), same order. */
  lli?: Map<string, Uint8Array>;
  /** PRN → signal strength indicator 1–9 per value (0 = blank), same order. */
  ssi?: Map<string, Uint8Array>;
  /**
   * Epoch flag: 0 OK (default), 1 power failure since the previous epoch,
   * 2–5 an event whose special records are `records` (no `sats`).
   */
  flag?: number;
  /** Receiver clock offset (s) reported in the epoch record. */
  clockOffset?: number | null;
  /** Event special records (flags 2–5): header lines, written verbatim. */
  records?: string[];
}

/* ================================================================== */
/*  Writer                                                             */
/* ================================================================== */

/**
 * Write RINEX 3.04 obs file from compact observations.
 *
 * The `obsTypes` map defines both the RINEX header declaration order and
 * the Float64Array index order for each system.
 */
export function writeRinexObsBlob(
  header: RinexHeader,
  epochs: CompactEpoch[],
  obsTypes: Map<string, string[]>
): Promise<Blob> {
  return writeModernObsBlob(header, epochs, obsTypes, {
    version: '3.04',
    comment: 'Merged from multiple RINEX files',
  });
}

/**
 * The nominal observation interval (s): the most common spacing between
 * consecutive epochs. The first difference alone mis-states it whenever the
 * file opens with an irregular gap (a late second epoch, a burst). Null with
 * fewer than two epochs.
 */
export function modalIntervalS(
  epochs: readonly { time: number }[]
): number | null {
  const counts = new Map<number, number>();
  for (let i = 1; i < epochs.length; i++) {
    const d = Math.round(epochs[i]!.time - epochs[i - 1]!.time);
    if (d > 0) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestN = 0;
  for (const [d, n] of counts)
    if (n > bestN || (n === bestN && best !== null && d < best)) {
      best = d;
      bestN = n;
    }
  return best === null ? null : best / 1000;
}

/** Shared RINEX 3/4 implementation (also used by obs-writer-v4.ts). */
export async function writeModernObsBlob(
  header: RinexHeader,
  epochs: CompactEpoch[],
  obsTypes: Map<string, string[]>,
  opts: { version: string; comment: string }
): Promise<Blob> {
  if (epochs.length === 0) return new Blob([], { type: 'application/gzip' });

  const sink = createGzipLineSink();
  const BATCH = 200;

  const systems = [...obsTypes.keys()];
  const sysChar = systems.length === 1 ? systems[0]! : 'M';

  // ── Header ──

  sink.push(
    hdrLine(
      `     ${opts.version}           OBSERVATION DATA    ${sysChar}`,
      'RINEX VERSION / TYPE'
    )
  );

  const now = new Date();
  const dateStr = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')} ${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}${String(now.getUTCSeconds()).padStart(2, '0')} UTC`;
  sink.push(
    hdrLine(
      `${padL('GNSSCalc', 20)}${padL('', 20)}${dateStr}`,
      'PGM / RUN BY / DATE'
    )
  );

  sink.push(hdrLine(opts.comment, 'COMMENT'));
  for (const line of stationHeaderLines(header, 3)) sink.push(line);

  for (const [sys, types] of obsTypes) {
    for (let i = 0; i < types.length; i += 13) {
      const chunk = types.slice(i, i + 13);
      let content: string;
      if (i === 0) {
        content = `${sys}  ${padR(String(types.length), 3)}`;
      } else {
        content = '      ';
      }
      content += chunk.map((t) => ` ${padL(t, 3)}`).join('');
      sink.push(hdrLine(content, 'SYS / # / OBS TYPES'));
    }
  }

  if (header.signalStrengthUnit)
    sink.push(
      hdrLine(padL(header.signalStrengthUnit, 20), 'SIGNAL STRENGTH UNIT')
    );

  const timeSys = obsTimeSystem(header, systems);
  const tagged = epochs.filter(
    (e) => !Number.isNaN(e.time) && (e.flag ?? 0) < 2
  );
  if (tagged.length > 0) {
    sink.push(
      hdrLine(timeOfObs(tagged[0]!.time, timeSys), 'TIME OF FIRST OBS')
    );
    sink.push(
      hdrLine(
        timeOfObs(tagged[tagged.length - 1]!.time, timeSys),
        'TIME OF LAST OBS'
      )
    );
  }

  const interval = modalIntervalS(tagged);
  if (interval !== null && interval < 3600) {
    sink.push(hdrLine(fmtF(interval, 10, 3), 'INTERVAL'));
  }
  for (const l of clockOffsApplLine(header, tagged)) sink.push(l);

  // Mandatory in RINEX 3.01–3.05 (GLONASS COD/PHS/BIS from 3.02, for
  // GLONASS data); RINEX 4 deprecates both: "should be ignored by RINEX
  // decoders and encoders" (4.01 Table A2).
  const v3 = parseFloat(opts.version) < 4;
  if (v3) for (const l of phaseShiftLines(header, obsTypes)) sink.push(l);

  if (header.glonassSlots && Object.keys(header.glonassSlots).length > 0) {
    const entries = Object.entries(header.glonassSlots).sort(
      ([a], [b]) => Number(a) - Number(b)
    );
    for (let i = 0; i < entries.length; i += 8) {
      const chunk = entries.slice(i, i + 8);
      let content = i === 0 ? padR(String(entries.length), 3) + ' ' : '    ';
      for (const [slot, freq] of chunk) {
        content += `R${padR(slot, 2)} ${padR(String(freq), 2)} `;
      }
      sink.push(hdrLine(content, 'GLONASS SLOT / FRQ #'));
    }
  }
  if (v3 && obsTypes.has('R')) sink.push(glonassCodPhsBisLine(header));

  for (const l of leapSecondsLine(header)) sink.push(l);
  sink.push(hdrLine('', 'END OF HEADER'));
  await sink.flush();

  // ── Epoch records (flushed in batches → compressed immediately) ──

  let epochCount = 0;
  for (const epoch of epochs) {
    const flag = epoch.flag ?? 0;
    if (flag >= 2) {
      // Event: its special records (header lines) follow verbatim.
      const recs = epoch.records ?? [];
      sink.push(epochLine3(epoch.time, flag, recs.length));
      for (const r of recs) sink.push(r);
      continue;
    }
    // Only satellites of a declared system: the count must match the records.
    const prns = [...epoch.sats.keys()]
      .filter((p) => obsTypes.has(p[0]!))
      .sort();

    sink.push(epochLine3(epoch.time, flag, prns.length, epoch.clockOffset));

    for (const prn of prns) {
      const sys = prn[0]!;
      const sysTypes = obsTypes.get(sys);
      if (!sysTypes) continue;

      const valArr = epoch.sats.get(prn)!;
      const lli = epoch.lli?.get(prn);
      const ssi = epoch.ssi?.get(prn);
      let line = prn;

      for (let i = 0; i < sysTypes.length; i++) {
        const val = i < valArr.length ? valArr[i]! : NaN;
        line += obsField(val, lli?.[i], ssi?.[i]);
      }
      sink.push(line.trimEnd());
    }

    epochCount++;
    if (epochCount % BATCH === 0) await sink.flush();
  }

  return sink.finish();
}
