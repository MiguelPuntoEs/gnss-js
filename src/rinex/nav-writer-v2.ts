/**
 * RINEX 2.11 navigation file writer: one single-system file per call —
 * GPS ('N', Tables A3/A4), GLONASS ('G', Tables A10/A11) or SBAS GEO
 * ('H', Tables A15/A16) — in the CDDIS/IGS layout: 2-digit years,
 * Fortran D exponents with a 0.ddd mantissa, 3-space orbit indent.
 *
 * What RINEX 2 cannot hold: any other constellation, GLONASS orbit-4
 * status fields, the transmission time-mark / SV of iono parameters,
 * every TIME SYSTEM CORR but GPUT (GPS) and GLUT (GLONASS), the future
 * leap-second fields. The GLONASS message frame time is written as the
 * RINEX 2 seconds of the UTC day (the reader keeps seconds of the week).
 */

import { padL, padR, hdrLine } from './format';
import type { GlonassEphemeris, KeplerEphemeris, NavResult } from './nav';
import {
  isKepler,
  keplerOrbitRows,
  stateVectorRows,
  type NavWriterOptions,
} from './nav-format';

/**
 * Fortran D19.12 with a zero integer part, as RINEX 2 files print it:
 * " 0.347841065377D-03", "-0.295585778076D-11". `w` wide, `d` digits.
 */
export function fmtD2(val: number, w = 19, d = 12): string {
  if (val === 0)
    return `${Object.is(val, -0) ? '-' : ''}0.${'0'.repeat(d)}D+00`.padStart(w);
  const sign = val < 0 ? '-' : '';
  const abs = Math.abs(val);
  let e = Math.floor(Math.log10(abs)) + 1;
  let m = (abs / 10 ** e).toFixed(d);
  if (m.startsWith('1')) {
    // Rounding pushed the mantissa to 1.000…: renormalise
    e += 1;
    m = (abs / 10 ** e).toFixed(d);
  }
  const es = `${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  return `${sign}${m}D${es}`.padStart(w);
}

/** Epoch: I2.2 year, 4(1X,I2), F5.1 seconds (after the I2 PRN). */
function epoch2(d: Date): string {
  const p = (v: number) => String(v).padStart(3);
  return (
    ' ' +
    String(d.getUTCFullYear() % 100).padStart(2, '0') +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    (d.getUTCSeconds() + d.getUTCMilliseconds() / 1000).toFixed(1).padStart(5)
  );
}

/** A broadcast-orbit line: 3X,4D19.12 (blank slots written as zero). */
const orbit2 = (values: (number | null)[]) =>
  '   ' + values.map((v) => fmtD2(v ?? 0)).join('');

const MONTHS = 'JANFEBMARAPRMAYJUNJULAUGSEPOCTNOVDEC';

/** RINEX 2 PGM / RUN BY / DATE date: "dd-mmm-yy hh:mm". */
function runDate2(d: Date): string {
  const p2 = (v: number) => String(v).padStart(2, '0');
  const mon = MONTHS.slice(d.getUTCMonth() * 3, d.getUTCMonth() * 3 + 3);
  return `${p2(d.getUTCDate())}-${mon}-${p2(d.getUTCFullYear() % 100)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

/** Options for {@link writeRinexNav2}. */
export interface RinexNav2Options extends NavWriterOptions {
  /** Which single-system file to write: 'G' GPS (default), 'R' GLONASS,
   *  'S' SBAS GEO. */
  system?: 'G' | 'R' | 'S';
}

const TYPE_LINE: Record<string, string> = {
  G: 'N: GPS NAV DATA',
  R: 'G: GLONASS NAV DATA',
  S: 'H: GEO NAV MSG DATA',
};

/**
 * Write a RINEX 2.11 navigation file holding the `system` ephemerides
 * of `nav` (from any RINEX version or a receiver decoder), sorted by
 * PRN then epoch. Header: ION ALPHA/BETA and DELTA-UTC (GPS, from
 * GPSA/GPSB and GPUT), CORR TO SYSTEM TIME (GLONASS, from GLUT),
 * LEAP SECONDS.
 */
export function writeRinexNav2(
  nav: NavResult,
  opts: RinexNav2Options = {}
): string {
  const sys = opts.system ?? 'G';
  const h = nav.header;
  const lines: string[] = [];
  lines.push(
    hdrLine(
      '     2.11' + ' '.repeat(11) + padL(TYPE_LINE[sys]!, 40),
      'RINEX VERSION / TYPE'
    )
  );
  lines.push(
    hdrLine(
      padL(opts.program ?? 'GNSSCalc', 20) +
        padL(opts.runBy ?? '', 20) +
        padL(runDate2(opts.date ?? new Date()), 20),
      'PGM / RUN BY / DATE'
    )
  );

  const ephs = nav.ephemerides
    .filter((e) => e.system === sys)
    .sort(
      (a, b) =>
        a.prn.localeCompare(b.prn) || a.tocDate.getTime() - b.tocDate.getTime()
    );

  if (sys === 'G') {
    // 2X,4D12.4
    for (const [key, label] of [
      ['GPSA', 'ION ALPHA'],
      ['GPSB', 'ION BETA'],
    ] as const) {
      const v = h.ionoCorrections[key];
      if (v)
        lines.push(
          hdrLine('  ' + v.map((x) => fmtD2(x, 12, 4)).join(''), label)
        );
    }
    // 3X,2D19.12,2I9
    const utc = h.timeSystemCorr?.find((c) => c.type === 'GPUT');
    if (utc)
      lines.push(
        hdrLine(
          '   ' +
            fmtD2(utc.a0) +
            fmtD2(utc.a1) +
            padR(String(utc.refTime), 9) +
            padR(String(utc.refWeek), 9),
          'DELTA-UTC: A0,A1,T,W'
        )
      );
  } else if (sys === 'R') {
    // 3I6,3X,D19.12: reference date and −τc
    const glut = h.timeSystemCorr?.find((c) => c.type === 'GLUT');
    const ref = glut?.refDate ?? ephs[0]?.tocDate;
    if (glut && ref)
      lines.push(
        hdrLine(
          padR(String(ref.getUTCFullYear()), 6) +
            padR(String(ref.getUTCMonth() + 1), 6) +
            padR(String(ref.getUTCDate()), 6) +
            '   ' +
            fmtD2(glut.a0),
          'CORR TO SYSTEM TIME'
        )
      );
  }
  if (h.leapSeconds != null)
    lines.push(hdrLine(padR(String(h.leapSeconds), 6), 'LEAP SECONDS'));
  lines.push(hdrLine('', 'END OF HEADER'));

  const records = ephs.map((eph) => {
    const prn = padR(String(parseInt(eph.prn.slice(1), 10)), 2);
    if (isKepler(eph)) {
      const k = eph as KeplerEphemeris;
      const rows = keplerOrbitRows(k);
      // RINEX 2 orbit-7: t_tm, fit interval, spare, spare (Table A4).
      rows[6] = [rows[6]![0]!, k.fitInterval ?? 0, 0, 0];
      return [
        prn +
          epoch2(k.tocDate) +
          [k.af0, k.af1, k.af2].map((v) => fmtD2(v)).join(''),
        ...rows.map(orbit2),
      ].join('\n');
    }
    const g = eph as GlonassEphemeris;
    // GLONASS t_k: seconds of the UTC day (Table A11); SBAS: seconds of
    // the GPS week (Table A16), as kept.
    const tk = sys === 'R' ? g.messageFrameTime % 86400 : g.messageFrameTime;
    return [
      prn +
        epoch2(g.tocDate) +
        [g.tauN, g.gammaN, tk].map((v) => fmtD2(v)).join(''),
      ...stateVectorRows(g, false).map(orbit2),
    ].join('\n');
  });

  return lines.join('\n') + '\n' + records.map((r) => r + '\n').join('');
}
