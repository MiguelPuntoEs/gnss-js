/**
 * RINEX 3.04 / 4.01 observation file writer.
 *
 * The two formats share the same header layout and epoch record
 * encoding — only the version line and the provenance comment differ
 * (see obs-writer.test.ts, which pins this). RINEX 2.11 lives in
 * obs-writer-v2.ts (different header records and epoch layout).
 *
 * Streams text through gzip compression so we never hold the full
 * uncompressed output in memory. Returns a gzip-compressed Blob.
 */

import type { RinexHeader } from './parser';
import { padL, padR, fmtF, hdrLine } from './format';
import { createGzipLineSink, stationHeaderLines } from './obs-writer-common';

/* ================================================================== */
/*  Types                                                              */
/* ================================================================== */

/**
 * Compact epoch — stores observation values in Float64Arrays
 * indexed by a per-system obs code registry (NaN = missing).
 * ~10-15x less memory than Map-of-Maps.
 */
export interface CompactEpoch {
  time: number; // unix ms
  sats: Map<string, Float64Array>; // PRN → values indexed by obsTypes order
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
  for (const line of stationHeaderLines(header)) sink.push(line);

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

  const timeSys = systems.includes('R') && systems.length === 1 ? 'GLO' : 'GPS';
  const obsTimeLine = (d: Date) =>
    `  ${d.getUTCFullYear()}    ${String(d.getUTCMonth() + 1).padStart(2)}    ${String(d.getUTCDate()).padStart(2)}    ${String(d.getUTCHours()).padStart(2)}    ${String(d.getUTCMinutes()).padStart(2)}   ${(d.getUTCSeconds() + d.getUTCMilliseconds() / 1000).toFixed(7).padStart(10)}     ${timeSys}`;

  sink.push(
    hdrLine(obsTimeLine(new Date(epochs[0]!.time)), 'TIME OF FIRST OBS')
  );
  sink.push(
    hdrLine(
      obsTimeLine(new Date(epochs[epochs.length - 1]!.time)),
      'TIME OF LAST OBS'
    )
  );

  if (epochs.length >= 2) {
    const interval = (epochs[1]!.time - epochs[0]!.time) / 1000;
    if (interval > 0 && interval < 3600) {
      sink.push(hdrLine(fmtF(interval, 10, 3), 'INTERVAL'));
    }
  }

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

  sink.push(hdrLine('', 'END OF HEADER'));
  await sink.flush();

  // ── Epoch records (flushed in batches → compressed immediately) ──

  let epochCount = 0;
  for (const epoch of epochs) {
    const t = new Date(epoch.time);
    const sec = t.getUTCSeconds() + t.getUTCMilliseconds() / 1000;
    const prns = [...epoch.sats.keys()].sort();

    sink.push(
      `> ${t.getUTCFullYear()} ${String(t.getUTCMonth() + 1).padStart(2, '0')} ${String(t.getUTCDate()).padStart(2, '0')} ${String(t.getUTCHours()).padStart(2, '0')} ${String(t.getUTCMinutes()).padStart(2, '0')}${fmtF(sec, 11, 7)}  0${padR(String(prns.length), 3)}`
    );

    for (const prn of prns) {
      const sys = prn[0]!;
      const sysTypes = obsTypes.get(sys);
      if (!sysTypes) continue;

      const valArr = epoch.sats.get(prn)!;
      let line = prn;

      for (let i = 0; i < sysTypes.length; i++) {
        const val = i < valArr.length ? valArr[i]! : NaN;
        if (!isNaN(val)) {
          line += fmtF(val, 14, 3) + '  ';
        } else {
          line += ' '.repeat(16);
        }
      }
      sink.push(line);
    }

    epochCount++;
    if (epochCount % BATCH === 0) await sink.flush();
  }

  return sink.finish();
}
