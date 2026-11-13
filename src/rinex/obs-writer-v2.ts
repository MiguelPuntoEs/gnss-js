/**
 * RINEX 2.11 observation file writer.
 *
 * Converts RINEX 3 obs codes to RINEX 2 format (see obs-codes.ts) and
 * writes a valid RINEX 2.11 observation file.
 */

import type { RinexHeader } from './parser';
import type { CompactEpoch } from './obs-writer';
import { padL, padR, fmtF, hdrLine } from './format';
import { modalIntervalS } from './obs-writer';
import { RINEX2_CODE_ORDER, RINEX2_SYSTEMS, v2CodeColumns } from './obs-codes';
import {
  clockOffsApplLine,
  createGzipLineSink,
  epochLines2,
  leapSecondsLine,
  obsField,
  obsTimeSystem,
  timeOfObs,
  stationHeaderLines,
} from './obs-writer-common';

/**
 * Write RINEX 2.11 obs file from compact observations.
 *
 * Codes map per {@link v2CodeColumns} (RINEX 2.11 section 10.1.1): one v3
 * signal per system and v2 code, chosen by a fixed priority. Only the
 * systems RINEX 2.11 defines are written — GPS, GLONASS, Galileo, SBAS;
 * BeiDou, QZSS and NavIC have no RINEX 2.11 codes. Code lists already in
 * v2 form (from a RINEX 2 source) pass through.
 */
export async function writeRinex2ObsBlob(
  header: RinexHeader,
  epochs: CompactEpoch[],
  obsTypes: Map<string, string[]>
): Promise<Blob> {
  if (epochs.length === 0) return new Blob([], { type: 'application/gzip' });

  // Per system: v2 code → column of its values
  const columns = new Map<string, Map<string, number>>();
  for (const sys of RINEX2_SYSTEMS) {
    const codes = obsTypes.get(sys);
    if (!codes) continue;
    const cols = v2CodeColumns(sys, codes);
    if (cols.size > 0) columns.set(sys, cols);
  }
  // The shared # / TYPES OF OBSERV list: every v2 code some system fills,
  // in canonical order (a v2 source's own order is kept).
  const passthrough = [...columns.keys()].flatMap((sys) =>
    obsTypes.get(sys)!.every((c) => c.length === 2) ? obsTypes.get(sys)! : []
  );
  const used = new Set([...columns.values()].flatMap((m) => [...m.keys()]));
  const v2Codes = [
    ...new Set([
      ...passthrough,
      ...RINEX2_CODE_ORDER.filter((c) => used.has(c)),
      ...used,
    ]),
  ];

  const sink = createGzipLineSink();
  const BATCH = 200;

  // Satellite system character
  const hasSystems = new Set<string>();
  for (const epoch of epochs)
    for (const prn of epoch.sats.keys())
      if (columns.has(prn[0]!)) hasSystems.add(prn[0]!);
  const sysChar = hasSystems.size === 1 ? [...hasSystems][0]! : 'M';

  // ── Header ──
  sink.push(
    hdrLine(
      `     2.11           OBSERVATION DATA    ${sysChar}`,
      'RINEX VERSION / TYPE'
    )
  );

  const now = new Date();
  const dateStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}:${String(now.getUTCSeconds()).padStart(2, '0')}`;
  sink.push(
    hdrLine(
      `${padL('GNSSCalc', 20)}${padL('', 20)}${dateStr}`,
      'PGM / RUN BY / DATE'
    )
  );

  sink.push(hdrLine('Converted from RINEX 3 by GNSSCalc', 'COMMENT'));
  for (const line of stationHeaderLines(header, 2)) sink.push(line);

  sink.push(hdrLine('     1     1', 'WAVELENGTH FACT L1/2'));

  // # / TYPES OF OBSERV
  for (let i = 0; i < v2Codes.length; i += 9) {
    const chunk = v2Codes.slice(i, i + 9);
    let content: string;
    if (i === 0) {
      content = padR(String(v2Codes.length), 6);
    } else {
      content = '      ';
    }
    content += chunk.map((c) => padR(c, 6)).join('');
    sink.push(hdrLine(content, '# / TYPES OF OBSERV'));
  }

  const tagged = epochs.filter(
    (e) => !Number.isNaN(e.time) && (e.flag ?? 0) < 2
  );
  const timeSys = obsTimeSystem(header);
  const interval = modalIntervalS(tagged);
  if (interval !== null && interval < 3600)
    sink.push(hdrLine(fmtF(interval, 10, 3), 'INTERVAL'));
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
  for (const l of clockOffsApplLine(header, tagged)) sink.push(l);
  for (const l of leapSecondsLine(header)) sink.push(l);

  sink.push(hdrLine('', 'END OF HEADER'));
  await sink.flush();

  // ── Epoch records ──
  let epochCount = 0;
  for (const epoch of epochs) {
    const flag = epoch.flag ?? 0;
    if (flag >= 2) {
      // Event: its special records (header lines) follow verbatim.
      const recs = epoch.records ?? [];
      for (const l of epochLines2(epoch.time, flag, recs.length, []))
        sink.push(l.trimEnd());
      for (const r of recs) sink.push(r);
      continue;
    }

    // Only the systems RINEX 2.11 defines
    const prns = [...epoch.sats.keys()]
      .filter((p) => columns.has(p[0]!))
      .sort();
    if (prns.length === 0) continue;

    for (const l of epochLines2(
      epoch.time,
      flag,
      prns.length,
      prns,
      epoch.clockOffset
    ))
      sink.push(l);

    // Observation lines (max 5 obs per line, 16 chars each)
    for (const prn of prns) {
      const sys = prn[0]!;
      const cols = columns.get(sys)!;
      const valArr = epoch.sats.get(prn)!;
      const lli = epoch.lli?.get(prn);
      const ssi = epoch.ssi?.get(prn);

      const v2Vals: number[] = new Array<number>(v2Codes.length).fill(NaN);
      const v2Lli: number[] = new Array<number>(v2Codes.length).fill(0);
      const v2Ssi: number[] = new Array<number>(v2Codes.length).fill(0);
      for (let k = 0; k < v2Codes.length; k++) {
        const j = cols.get(v2Codes[k]!);
        if (j === undefined || j >= valArr.length) continue;
        v2Vals[k] = valArr[j]!;
        v2Lli[k] = lli?.[j] ?? 0;
        v2Ssi[k] = ssi?.[j] ?? 0;
      }

      // Write in groups of 5
      let line = '';
      for (let j = 0; j < v2Codes.length; j++) {
        line += obsField(v2Vals[j]!, v2Lli[j], v2Ssi[j]);
        if ((j + 1) % 5 === 0 || j === v2Codes.length - 1) {
          sink.push(line.trimEnd());
          line = '';
        }
      }
    }

    epochCount++;
    if (epochCount % BATCH === 0) await sink.flush();
  }

  return sink.finish();
}
