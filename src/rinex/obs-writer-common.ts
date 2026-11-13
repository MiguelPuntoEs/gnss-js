/**
 * Shared plumbing for the RINEX 2/3/4 observation writers.
 */

import type { RinexHeader } from './parser';
import { padL, padR, fmtF, hdrLine } from './format';

/**
 * Batched line sink that streams text through gzip compression so the
 * full uncompressed output is never held in memory.
 *
 * Callers decide when to `flush()` (the writers flush every N epochs);
 * `finish()` flushes, closes the stream, and returns the Blob.
 */
export function createGzipLineSink() {
  const encoder = new TextEncoder();
  const compressor = new CompressionStream('gzip');
  const writer = compressor.writable.getWriter();

  const compressedChunks: Uint8Array[] = [];
  const readerDone = (async () => {
    const reader = compressor.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      compressedChunks.push(value);
    }
  })();

  let batch: string[] = [];

  async function flush() {
    if (batch.length === 0) return;
    await writer.write(encoder.encode(batch.join('\n') + '\n'));
    batch = [];
  }

  return {
    push(line: string) {
      batch.push(line);
    },
    flush,
    async finish(): Promise<Blob> {
      await flush();
      await writer.close();
      await readerDone;
      return new Blob(compressedChunks as BlobPart[], {
        type: 'application/gzip',
      });
    },
  };
}

/**
 * Station / receiver / antenna header block, shared by RINEX 2.11, 3.04 and
 * 4.01. MARKER TYPE exists from RINEX 3 (`version` ≥ 3) and is written when
 * known (Table A2: required except for GEODETIC / NON_GEODETIC markers).
 */
export function stationHeaderLines(header: RinexHeader, version = 3): string[] {
  const pos = header.approxPosition ?? [0, 0, 0];
  const delta = header.antDelta ?? [0, 0, 0];
  return [
    hdrLine(header.markerName || 'UNKNOWN', 'MARKER NAME'),
    hdrLine(padL(header.markerNumber ?? '', 20), 'MARKER NUMBER'),
    ...(version >= 3 && header.markerType
      ? [hdrLine(padL(header.markerType, 20), 'MARKER TYPE')]
      : []),
    hdrLine(
      `${padL(header.observer || '', 20)}${padL(header.agency || '', 40)}`,
      'OBSERVER / AGENCY'
    ),
    hdrLine(
      `${padL(header.receiverNumber || '', 20)}${padL(header.receiverType || '', 20)}${padL(header.receiverVersion || '', 20)}`,
      'REC # / TYPE / VERS'
    ),
    hdrLine(
      `${padL(header.antNumber || '', 20)}${padL(header.antType || '', 20)}`,
      'ANT # / TYPE'
    ),
    hdrLine(
      `${fmtF(pos[0], 14, 4)}${fmtF(pos[1], 14, 4)}${fmtF(pos[2], 14, 4)}`,
      'APPROX POSITION XYZ'
    ),
    hdrLine(
      `${fmtF(delta[0], 14, 4)}${fmtF(delta[1], 14, 4)}${fmtF(delta[2], 14, 4)}`,
      'ANTENNA: DELTA H/E/N'
    ),
  ];
}

/**
 * One observation field: F14.3 value, then the loss-of-lock indicator
 * (I1, column 15) and the signal strength indicator (I1, column 16), blank
 * when 0 or absent — RINEX 2.11 Table A2, 3.04/4.01 Table A3. A missing
 * value is 16 blanks.
 */
/**
 * Optional header records after the time-of-observation block, in Table A2
 * order: RCV CLOCK OFFS APPL (required when epochs report clock offsets).
 */
export function clockOffsApplLine(
  header: RinexHeader,
  epochs: readonly { clockOffset?: number | null }[]
): string[] {
  const reported = epochs.some((e) => e.clockOffset != null);
  if (header.rcvClockOffsApplied === undefined && !reported) return [];
  return [
    hdrLine(
      padR(header.rcvClockOffsApplied ? '1' : '0', 6),
      'RCV CLOCK OFFS APPL'
    ),
  ];
}

/** LEAP SECONDS (current number, I6) when known. */
export function leapSecondsLine(header: RinexHeader): string[] {
  return header.leapSeconds === undefined
    ? []
    : [hdrLine(padR(String(header.leapSeconds), 6), 'LEAP SECONDS')];
}

/**
 * SYS / PHASE SHIFT records (RINEX 3.04 Table A2, mandatory from 3.01):
 * A1,1X,A3,1X,F8.5,2X,I2.2,10(1X,A3), continuation 18X,10(1X,A3). The
 * source's records for the codes written are kept; a system without any
 * gets the blank record that says "alignment unknown" (section 9.1).
 */
export function phaseShiftLines(
  header: RinexHeader,
  obsTypes: Map<string, string[]>
): string[] {
  const out: string[] = [];
  for (const [sys, codes] of obsTypes) {
    const recs = (header.phaseShifts ?? []).filter(
      (p) => p.sys === sys && p.code !== '' && codes.includes(p.code)
    );
    if (recs.length === 0) out.push(hdrLine(sys, 'SYS / PHASE SHIFT'));
    for (const p of recs) {
      let head = `${sys} ${padL(p.code, 3)} ${p.correction === null ? ' '.repeat(8) : fmtF(p.correction, 8, 5)}`;
      if (p.sats.length === 0) {
        out.push(hdrLine(head, 'SYS / PHASE SHIFT'));
        continue;
      }
      head += `  ${String(p.sats.length).padStart(2, '0')}`;
      for (let i = 0; i < p.sats.length; i += 10) {
        const list = p.sats
          .slice(i, i + 10)
          .map((s) => ` ${s}`)
          .join('');
        out.push(
          hdrLine((i === 0 ? head : ' '.repeat(18)) + list, 'SYS / PHASE SHIFT')
        );
      }
    }
  }
  return out;
}

/**
 * GLONASS COD/PHS/BIS (RINEX 3.04 Table A2, mandatory from 3.02):
 * 4(1X,A3,1X,F8.3) metres for C1C C1P C2C C2P — all blank when unknown.
 */
export function glonassCodPhsBisLine(header: RinexHeader): string {
  const bis = header.glonassCodPhsBis ?? {};
  const codes = ['C1C', 'C1P', 'C2C', 'C2P'];
  const known = codes.some((c) => bis[c] !== undefined);
  const content = known
    ? codes
        .map(
          (c) =>
            ` ${c} ${bis[c] === undefined ? ' '.repeat(8) : fmtF(bis[c], 8, 3)}`
        )
        .join('')
    : '';
  return hdrLine(content, 'GLONASS COD/PHS/BIS');
}

export function obsField(val: number, lli = 0, ssi = 0): string {
  if (Number.isNaN(val)) return ' '.repeat(16);
  return (
    fmtF(val, 14, 3) +
    (lli ? String(lli % 10) : ' ') +
    (ssi ? String(ssi % 10) : ' ')
  );
}

/** Calendar fields of an epoch (Unix ms; a sub-millisecond part is kept). */
function epochFields(time: number) {
  const minute = Math.floor(time / 60000) * 60000;
  const d = new Date(minute);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    sec: (time - minute) / 1000,
  };
}

const n2 = (v: number) => String(v).padStart(2, '0');

/**
 * RINEX 3/4 EPOCH record (Table A3): `> yyyy mm dd hh mm ss.sssssss  f nnn`,
 * then 6X and the receiver clock offset F15.12 when known. A NaN time is an
 * event without significant epoch (blank date fields).
 */
export function epochLine3(
  time: number,
  flag: number,
  n: number,
  clock?: number | null
): string {
  let head: string;
  if (Number.isNaN(time)) head = '>' + ' '.repeat(28);
  else {
    const f = epochFields(time);
    head = `> ${f.y} ${n2(f.mo)} ${n2(f.d)} ${n2(f.h)} ${n2(f.mi)}${fmtF(f.sec, 11, 7)}`;
  }
  const line = `${head}  ${flag}${padR(String(n), 3)}`;
  return clock == null ? line : `${line}      ${fmtF(clock, 15, 12)}`;
}

/**
 * RINEX 2.11 EPOCH/SAT record (Table A2): ` yy mm dd hh mm ss.sssssss  f nnn`
 * + 12(A1,I2) satellites (continuation lines 32X,12(A1,I2)) and the receiver
 * clock offset F12.9 in columns 69–80 of the first line.
 */
export function epochLines2(
  time: number,
  flag: number,
  n: number,
  sats: string[],
  clock?: number | null
): string[] {
  let head: string;
  if (Number.isNaN(time)) head = ' '.repeat(26);
  else {
    const f = epochFields(time);
    head =
      ' ' +
      [f.y % 100, f.mo, f.d, f.h, f.mi]
        .map((v) => padR(String(v), 2))
        .join(' ') +
      fmtF(f.sec, 11, 7);
  }
  const lines: string[] = [];
  for (let i = 0; i < Math.max(sats.length, 1); i += 12) {
    const list = sats.slice(i, i + 12).join('');
    lines.push(
      (i === 0 ? `${head}  ${flag}${padR(String(n), 3)}` : ' '.repeat(32)) +
        list
    );
  }
  if (clock != null) lines[0] = padL(lines[0]!, 68) + fmtF(clock, 12, 9);
  return lines;
}

/** Default time system of a single-system file (RINEX 3.04 Table A2). */
const DEFAULT_TIME_SYSTEM: Record<string, string> = {
  G: 'GPS',
  R: 'GLO',
  E: 'GAL',
  J: 'QZS',
  C: 'BDT',
  I: 'IRN',
};

/**
 * The time system the epochs are tagged in, for TIME OF FIRST / LAST OBS:
 * the header's own (as read from TIME OF FIRST OBS) when stated; a blank
 * source record means the default of the source file's system (RINEX 3.04
 * Table A2: GAL for pure Galileo, BDT for pure BeiDou, …). A header that
 * never came from a RINEX file (`timeSystem` undefined: receiver decoders,
 * RTCM) carries GPS-scale epochs — the library's convention — so GPS. The
 * writers relabel nothing: the epoch tags are written as given.
 */
export function obsTimeSystem(header: RinexHeader): string {
  if (header.timeSystem) return header.timeSystem;
  if (header.timeSystem === '')
    return DEFAULT_TIME_SYSTEM[header.satSystem] ?? 'GPS';
  return 'GPS';
}

/** TIME OF FIRST / LAST OBS content: 5I6,F13.7,5X,A3. */
export function timeOfObs(time: number, timeSystem: string): string {
  const f = epochFields(time);
  return (
    [f.y, f.mo, f.d, f.h, f.mi].map((v) => padR(String(v), 6)).join('') +
    fmtF(f.sec, 13, 7) +
    '     ' +
    timeSystem
  );
}
