/**
 * BLQ ocean-loading files (Onsala ocean loading service, H.-G. Scherneck &
 * M. S. Bos) read with everything a writer needs, and written back.
 *
 * Layout, as every Onsala header states it:
 *   - `$$` comment lines; the file header ends with `$$ END HEADER`;
 *   - per station: a name line (2X,A), `$$` comment lines (model, provider,
 *     `NAME, RADI TANG  lon/lat: lon lat height`), then 6 rows of the 11
 *     constituents M2 S2 N2 K2 K1 O1 P1 Q1 Mf Mm Ssa:
 *     amplitudes (m) radial, tangential EW, tangential NS (1X,11F7.5) and
 *     Greenwich phase lags (degrees, lag positive) in the same order
 *     (1X,11F7.1) — the formats HARDISP (IERS Conventions 2010 ch. 7) reads;
 *   - "Displacement is defined positive in upwards, South and West
 *     direction": row 2 is WEST, row 3 is SOUTH. `oceanLoadingEnu` turns
 *     them into East = −west, North = −south.
 *   - the file ends with `$$ END TABLE`.
 *
 * {@link parseBlq} (ocean-loading.ts) keeps only the coefficients;
 * {@link parseBlqFile} also keeps the header, the per-station comments and
 * the name as written, so {@link writeBlq} reproduces an Onsala file line
 * for line (trailing blanks aside).
 */
import {
  BLQ_CONSTITUENTS,
  type OceanLoadingCoefficients,
} from './ocean-loading';

export interface BlqStation {
  /** Station name as written (e.g. 'ONSA'). */
  name: string;
  /** `$$` lines between the name and the coefficient rows (whole lines). */
  comments: string[];
  /** Longitude (°E, as written: 0…360 or ±180), latitude (°), height (m)
   *  from the `lon/lat:` comment, when present. */
  lon?: number;
  lat?: number;
  height?: number;
  coefficients: OceanLoadingCoefficients;
}

export interface BlqFile {
  /** Header lines, `$$ END HEADER` included (whole lines). */
  header: string[];
  stations: BlqStation[];
}

const LONLAT = /lon\/lat:\s*(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?/;

/** Parse a BLQ file, keeping header and station comments. */
export function parseBlqFile(text: string): BlqFile {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  const header: string[] = [];
  let i = 0;
  const hasHeaderEnd = lines.some((l) => /^\$\$\s*END HEADER/.test(l));
  if (hasHeaderEnd)
    for (; i < lines.length; i++) {
      header.push(lines[i]!);
      if (/^\$\$\s*END HEADER/.test(lines[i]!)) {
        i++;
        break;
      }
    }
  const stations: BlqStation[] = [];
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim() || l.startsWith('$$')) continue;
    const comments: string[] = [];
    const rows: number[][] = [];
    let j = i + 1;
    for (; j < lines.length && rows.length < 6; j++) {
      const r = lines[j]!;
      if (r.startsWith('$$')) {
        if (rows.length === 0) comments.push(r);
        continue;
      }
      if (!r.trim()) continue;
      const v = r.trim().split(/\s+/).map(Number);
      if (v.length !== 11 || v.some((x) => !Number.isFinite(x))) break;
      rows.push(v);
    }
    if (rows.length !== 6) continue;
    const tuple = (a: number, k: number): [number, number, number] => [
      rows[a]![k]!,
      rows[a + 1]![k]!,
      rows[a + 2]![k]!,
    ];
    const s: BlqStation = {
      name: l.trim(),
      comments,
      coefficients: {
        amplitude: BLQ_CONSTITUENTS.map((_, k) => tuple(0, k)),
        phase: BLQ_CONSTITUENTS.map((_, k) => tuple(3, k)),
      },
    };
    for (const c of comments) {
      const m = LONLAT.exec(c);
      if (!m) continue;
      s.lon = +m[1]!;
      s.lat = +m[2]!;
      if (m[3] != null) s.height = +m[3];
    }
    stations.push(s);
    i = j - 1;
  }
  return { header, stations };
}

/** Fortran `Fw.d`; amplitudes drop the leading zero (`.00352`) as Onsala
 *  writes them, phases keep it (`0.7`); a parsed −0 stays `-0.0`. */
function f(v: number, w: number, d: number, dropZero: boolean): string {
  let s = Object.is(v, -0) ? '-' + (0).toFixed(d) : v.toFixed(d);
  if (dropZero) s = s.replace(/^(-?)0\./, '$1.');
  return s.padStart(w);
}

const AMP_ROWS = 3;

/**
 * Write a BLQ file. Pass a parsed {@link BlqFile} to reproduce it, or
 * a map of station name → coefficients (e.g. from {@link parseBlq} or the
 * gnsscalc OTL grid) for a file with a minimal Onsala-style header.
 */
export function writeBlq(
  input: BlqFile | ReadonlyMap<string, OceanLoadingCoefficients>
): string {
  const file: BlqFile =
    'stations' in input
      ? (input as BlqFile)
      : {
          header: [
            '$$ Ocean loading displacement',
            '$$',
            '$$ COLUMN ORDER:  M2  S2  N2  K2  K1  O1  P1  Q1  MF  MM SSA',
            '$$',
            '$$ ROW ORDER:',
            '$$ AMPLITUDES (m)',
            '$$   RADIAL',
            '$$   TANGENTL    EW',
            '$$   TANGENTL    NS',
            '$$ PHASES (degrees)',
            '$$   RADIAL',
            '$$   TANGENTL    EW',
            '$$   TANGENTL    NS',
            '$$',
            '$$ Displacement is defined positive in upwards, South and West direction.',
            '$$ The phase lag is relative to Greenwich and lags positive.',
            '$$',
            '$$ END HEADER',
          ],
          stations: [
            ...(input as ReadonlyMap<string, OceanLoadingCoefficients>),
          ].map(([name, coefficients]) => ({
            name,
            comments: [],
            coefficients,
          })),
        };
  const out: string[] = [...file.header];
  for (const s of file.stations) {
    out.push('$$');
    out.push('  ' + s.name);
    out.push(...s.comments);
    const { amplitude, phase } = s.coefficients;
    for (let r = 0; r < AMP_ROWS; r++)
      out.push(' ' + amplitude.map((a) => f(a[r]!, 7, 5, true)).join(''));
    for (let r = 0; r < AMP_ROWS; r++)
      out.push(' ' + phase.map((p) => f(p[r]!, 7, 1, false)).join(''));
  }
  out.push('$$ END TABLE');
  return out.join('\n') + '\n';
}
