/**
 * RINEX 3.04 / 3.05 mixed navigation file writer.
 *
 * Produces a standards-compliant RINEX 3 nav file from parsed NavResult
 * data (RINEX 3.05 Tables A5-A18): every field the reader keeps is
 * written back to its slot, so write → parse is lossless for files read
 * from RINEX 2, 3 or 4.
 *
 * What RINEX 3 cannot hold, from a RINEX 4 source: CNAV / CNV1-3
 * ephemerides, EOP records, the A2 term and t_tm of STO records, ION
 * records other than Klobuchar / NeQuick-G, and all but the first ION
 * record of each kind (BDS keeps one per broadcasting satellite, the
 * header's time mark + SV ID). STO records become TIME SYSTEM CORR lines
 * (first per type).
 */

import { padL, padR, hdrLine } from './format';
import type { NavResult } from './nav';
import {
  fmtEpoch,
  fmtSci,
  ionoLines,
  isKepler,
  keplerOrbitRows,
  leapLine,
  orbitLine,
  runDate,
  stateVectorRows,
  timeCorrs,
  type NavWriterOptions,
} from './nav-format';

export type { NavWriterOptions } from './nav-format';

/**
 * Format a number in RINEX "D19.12" scientific notation.
 *
 * 19 characters wide, 12 decimal digits, explicit exponent sign.
 * Examples:
 *   0.0       → " 0.000000000000E+00"
 *  -1.5e-8    → "-1.500000000000E-08"
 *   5153.71875→ " 5.153718750000E+03"
 */
export function fmtD(val: number): string {
  return fmtSci(val, 19, 12, 'E');
}

function writeHeader(
  nav: NavResult,
  version: string,
  opts: NavWriterOptions
): string {
  const lines: string[] = [];
  lines.push(
    hdrLine(
      padR(version, 9) +
        '           ' +
        padL('N: GNSS NAV DATA', 20) +
        padL('M: MIXED', 20),
      'RINEX VERSION / TYPE'
    )
  );
  lines.push(
    hdrLine(
      padL(opts.program ?? 'GNSSCalc', 20) +
        padL(opts.runBy ?? '', 20) +
        padL(runDate(opts.date ?? new Date()), 20),
      'PGM / RUN BY / DATE'
    )
  );

  // A4,1X,4D12.4,1X,A1,1X,I2 — GAL writes ai0-ai2 and a blank.
  for (const l of ionoLines(nav.header, nav.ion)) {
    const vals = [0, 1, 2, 3]
      .map((k) =>
        l.values[k] == null ? ' '.repeat(12) : fmtSci(l.values[k]!, 12, 4)
      )
      .join('');
    let s = padL(l.type, 5) + vals;
    if (l.timeMark || l.sv)
      s +=
        ' ' +
        (l.timeMark ?? ' ') +
        ' ' +
        (l.sv ? padR(l.sv.slice(1), 2) : '  ');
    lines.push(hdrLine(s, 'IONOSPHERIC CORR'));
  }

  // A4,1X,D17.10,D16.9,1X,I6,1X,I4,1X,A5,1X,I2
  for (const c of timeCorrs(nav.header, nav.sto)) {
    let s =
      padL(c.type, 5) +
      fmtSci(c.a0, 17, 10) +
      fmtSci(c.a1, 16, 9) +
      ' ' +
      padR(String(c.refTime), 6) +
      ' ' +
      padR(String(c.refWeek), 4);
    if (c.sv || c.utcId != null)
      s += ' ' + padL(c.sv ?? '', 5) + ' ' + padR(String(c.utcId ?? ''), 2);
    lines.push(hdrLine(s, 'TIME SYSTEM CORR'));
  }

  const leap = leapLine(nav.header);
  if (leap) lines.push(leap);
  lines.push(hdrLine('', 'END OF HEADER'));
  return lines.join('\n') + '\n';
}

/* ================================================================== */
/*  Public API                                                         */
/* ================================================================== */

/** Options for {@link writeRinexNav}. */
export interface RinexNavOptions extends NavWriterOptions {
  /** 3.04 (default) or 3.05 — 3.05 adds the fourth GLONASS orbit line. */
  version?: '3.04' | '3.05';
}

/**
 * Write a RINEX 3.04 (or 3.05) mixed navigation file from parsed
 * navigation data — RINEX 2, 3 or 4, or receiver-decoded ephemerides.
 *
 * Ephemerides are sorted by PRN then by tocDate. Header IONOSPHERIC CORR
 * and TIME SYSTEM CORR lines come from the header, or from RINEX 4 ION /
 * STO records (see the module header for what RINEX 3 cannot express).
 */
export function writeRinexNav(
  nav: NavResult,
  opts: RinexNavOptions = {}
): string {
  const version = opts.version ?? '3.04';
  const header = writeHeader(nav, version, opts);

  const sorted = [...nav.ephemerides].sort((a, b) => {
    const prnCmp = a.prn.localeCompare(b.prn);
    if (prnCmp !== 0) return prnCmp;
    return a.tocDate.getTime() - b.tocDate.getTime();
  });

  const records = sorted.map((eph) => {
    const clock = isKepler(eph)
      ? [eph.af0, eph.af1, eph.af2]
      : // `tauN` already holds the raw RINEX field (= −τ_n, the repo-wide
        // convention — see positioning/index.ts), so it is written verbatim.
        [eph.tauN, eph.gammaN, eph.messageFrameTime];
    const rows = isKepler(eph)
      ? keplerOrbitRows(eph)
      : stateVectorRows(eph, version === '3.05');
    return [
      `${padL(eph.prn, 3)} ${fmtEpoch(eph.tocDate)}${clock.map(fmtD).join('')}`,
      ...rows.map(orbitLine),
    ].join('\n');
  });

  return header + records.join('\n') + (records.length ? '\n' : '');
}
