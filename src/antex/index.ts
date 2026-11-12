/**
 * ANTEX (Antenna Exchange Format) parser, versions 1.4 and 2.0.
 *
 * Both versions are read into the same structure, so callers never need to
 * know which one a file was:
 *
 * - Receiver phase centre offsets are always North / East / Up (`pcoN`,
 *   `pcoE`, `pcoU`). ANTEX 1.4 writes them in that order ("NORTH / EAST /
 *   UP"); ANTEX 2.0 writes "X / Y / Z" in the antenna frame, where x is East
 *   and y is North for a north-oriented antenna — the reverse order.
 * - Satellite offsets are the body-frame X / Y / Z (`pcoN` = X, `pcoE` = Y,
 *   `pcoU` = Z) in both versions.
 * - A 2.0 frequency record shared by several bands (e.g. "G01 E01 C01") is
 *   expanded to one {@link FrequencyData} per band.
 * - 2.0 has no separate azimuth-averaged (NOAZI) pattern: for an
 *   azimuth-dependent pattern `pcvNoazi` is the azimuth mean of the grid
 *   (`pcvNoaziDerived`), for an azimuth-independent one (DAZI 360) it is the
 *   pattern and `dazi` is 0, as in 1.4.
 * - 2.0 satellite antennas are identified by SVN (`svnCode`), not PRN; use
 *   {@link antexWithPrns} with the IGS satellite metadata to look them up by
 *   PRN like a 1.4 file.
 *
 * Specs: Rothacher & Schmid (2010), ANTEX 1.4; Montenbruck, Steigenberger &
 * Villiger (2026), ANTEX 2.0, doi:10.57677/antex.
 */

/* ── Types ────────────────────────────────────────────────────────── */

export interface FrequencyData {
  /** Frequency band code, e.g. "G01", "E05" */
  frequency: string;
  /** Phase centre offset (mm): receiver North, satellite body X. For a CODE
   *  calibration, the code centre offset; 0 for GAIN. */
  pcoN: number;
  /** Phase centre offset (mm): receiver East, satellite body Y. */
  pcoE: number;
  /** Phase centre offset (mm): receiver Up, satellite body Z. */
  pcoU: number;
  /** Non-azimuth-dependent PCV values (mm), length = numZen. Missing values
   *  (ANTEX 2.0 blanks) are NaN. */
  pcvNoazi: number[];
  /**
   * Azimuth-dependent PCV grid (mm).
   * Rows = azimuths (0..360 step dazi), cols = zenith angles.
   * Empty when dazi === 0 (no azimuth dependence). Missing values are NaN.
   */
  pcv: number[][];
  /** ANTEX 2.0: every band this record applies to (this one included). */
  bands?: string[];
  /** ANTEX 2.0: `pcvNoazi` is the azimuth mean of `pcv`, not a file row. */
  pcvNoaziDerived?: boolean;
  /** GAIN calibrations: the common gain offset (dB); `pcv`/`pcvNoazi` then
   *  hold the gain pattern in dB. */
  gainOffsetDb?: number;
}

/** One ANTEX 2.0 calibration record (phase, code or gain patterns on one
 *  grid and validity interval). */
export interface AntexCalibration {
  kind: 'PHASE' | 'CODE' | 'GAIN';
  method: string;
  agency: string;
  numCalibrated: number;
  date: string;
  validFrom: string;
  validUntil: string;
  /** Azimuth increment (degrees). 0 = no azimuth dependence. */
  dazi: number;
  zen1: number;
  zen2: number;
  dzen: number;
  frequencies: FrequencyData[];
}

export interface AntennaEntry {
  /** Antenna type name (20 chars, e.g. "LEIAR20         LEIM") */
  type: string;
  /** Receiver: serial number (blank for the type mean). Satellite: PRN
   *  (e.g. "G05"); blank in an ANTEX 2.0 file until {@link antexWithPrns}. */
  serialNo: string;
  /** Satellite SVN (e.g. "G074"; optional in 1.4, the key in 2.0) */
  svnCode: string;
  /** COSPAR ID (satellites only, optional, 1.4) */
  cosparId: string;
  /** Whether this is a satellite antenna (vs receiver) */
  isSatellite: boolean;
  /** ANTEX 2.0 satellites: offsets refer to the centre of mass ('COM') or a
   *  body-frame antenna reference point ('ARP'). */
  origin?: string;
  /** Calibration method */
  method: string;
  /** Agency that performed calibration */
  agency: string;
  /** Number of individual antennas calibrated */
  numCalibrated: number;
  /** Calibration date string */
  date: string;
  /** Azimuth increment (degrees). 0 = no azimuth dependence. */
  dazi: number;
  /** Zenith/nadir start angle (degrees) */
  zen1: number;
  /** Zenith/nadir end angle (degrees) */
  zen2: number;
  /** Zenith/nadir increment (degrees) */
  dzen: number;
  /** SINEX code (optional, 1.4) */
  sinexCode: string;
  /** Valid-from date, "YYYY-MM-DD HH:MM" (optional) */
  validFrom: string;
  /** Valid-until date, "YYYY-MM-DD HH:MM" (optional) */
  validUntil: string;
  /** Per-frequency phase calibration data */
  frequencies: FrequencyData[];
  /** ANTEX 2.0: the antenna's group delay (code) calibrations. */
  codeCalibrations?: AntexCalibration[];
  /** ANTEX 2.0: the antenna's gain calibrations. */
  gainCalibrations?: AntexCalibration[];
}

export interface AntexFile {
  /** Format version (1.4 or 2.0) */
  version: number;
  /** Satellite system flag ('G','R','E','C','J','S','M'); 'M' for 2.0 */
  system: string;
  /** PCV type: 'A' (absolute) or 'R' (relative); 2.0 files are absolute */
  pcvType: string;
  /** Reference antenna type (for relative values) */
  refAntenna: string;
  /** ANTEX 2.0: 'SATELLITE', 'RECEIVER' or 'MIXED' */
  antennaTypes?: string;
  /** ANTEX 2.0: frame of the satellite PCO scale, e.g. 'IGS20' */
  referenceFrame?: string;
  /** ANTEX 2.0: release date, "YYYY:DDD" */
  release?: string;
  /** Header comments */
  comments: string[];
  /** All antenna entries in the file. In 2.0 one per phase calibration
   *  record (so per validity interval, as 1.4 repeats the antenna). */
  antennas: AntennaEntry[];
}

/* ── Helpers ──────────────────────────────────────────────────────── */

/** Read the label from columns 61–80 of an ANTEX line. */
function label(line: string): string {
  return (
    line.length >= 80 ? line.substring(60, 80) : line.substring(60)
  ).trim();
}

function num(s: string): number {
  return parseFloat(s) || 0;
}

/** Parse a validity date line (5I6,F13.7) into "YYYY-MM-DD HH:MM". */
function parseValidityDate(line: string): string {
  const year = parseInt(line.substring(0, 6), 10);
  const month = parseInt(line.substring(6, 12), 10);
  const day = parseInt(line.substring(12, 18), 10);
  const hour = parseInt(line.substring(18, 24), 10) || 0;
  const min = parseInt(line.substring(24, 30), 10) || 0;
  if (isNaN(year)) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** A row of 8-character pattern values after `offset`; a blank cell is
 *  `blank` (1.4: 0, 2.0: NaN — the spec's "missing"). */
function parsePcvRow(
  line: string,
  offset: number,
  count: number,
  blank = 0
): number[] {
  const vals: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = parseFloat(line.substring(offset + i * 8, offset + i * 8 + 8));
    vals.push(Number.isNaN(v) ? blank : v);
  }
  return vals;
}

const zenCount = (zen1: number, zen2: number, dzen: number) =>
  dzen > 0 ? Math.round((zen2 - zen1) / dzen) + 1 : 0;

/* ── Main parser ─────────────────────────────────────────────────── */

/** Parse an ANTEX 1.4 or 2.0 file (the version is read from its first
 *  record). */
export function parseAntex(text: string): AntexFile {
  const lines = text.split(/\r?\n/);
  const first = lines.find((l) => l.trim() !== '') ?? '';
  return label(first) === 'ANTEX VERSION'
    ? parseAntex2(lines)
    : parseAntex14(lines);
}

/* ── ANTEX 1.4 ───────────────────────────────────────────────────── */

function parseFrequencyBlock14(
  lines: string[],
  numZen: number,
  hasAzimuth: boolean
): FrequencyData {
  let frequency = '';
  let pcoN = 0,
    pcoE = 0,
    pcoU = 0;
  const pcvNoazi: number[] = [];
  const pcv: number[][] = [];

  for (const line of lines) {
    const lbl = label(line);

    if (lbl === 'START OF FREQUENCY') {
      frequency = line.substring(3, 6).trim();
    } else if (lbl === 'NORTH / EAST / UP') {
      // Receiver: North, East, Up. Satellite: body X, Y, Z.
      pcoN = num(line.substring(0, 10));
      pcoE = num(line.substring(10, 20));
      pcoU = num(line.substring(20, 30));
    } else if (line.substring(3, 8) === 'NOAZI') {
      pcvNoazi.push(...parsePcvRow(line, 8, numZen));
    } else if (lbl !== 'END OF FREQUENCY') {
      // Azimuth-dependent row: F8.1 azimuth + mF8.2 values
      if (hasAzimuth && line.trim().length > 8) {
        pcv.push(parsePcvRow(line, 8, numZen));
      }
    }
  }

  return { frequency, pcoN, pcoE, pcoU, pcvNoazi, pcv };
}

function parseAntex14(allLines: string[]): AntexFile {
  let version = 0;
  let system = '';
  let pcvType = '';
  let refAntenna = '';
  const comments: string[] = [];
  const antennas: AntennaEntry[] = [];

  let inHeader = true;
  let inAntenna = false;
  let inFreq = false;
  let inRms = false;
  let freqLines: string[] = [];

  let entry: AntennaEntry = blankEntry();

  for (const rawLine of allLines) {
    // Pad line to 80 chars for consistent column access
    const line = rawLine.length < 80 ? rawLine.padEnd(80) : rawLine;
    const lbl = label(line);

    if (inHeader) {
      if (lbl === 'ANTEX VERSION / SYST') {
        version = parseFloat(line.substring(0, 8)) || 0;
        system = line.substring(20, 21).trim();
      } else if (lbl === 'PCV TYPE / REFANT') {
        pcvType = line.substring(0, 1).trim();
        refAntenna = line.substring(20, 40).trim();
      } else if (lbl === 'COMMENT') {
        comments.push(line.substring(0, 60).trim());
      } else if (lbl === 'END OF HEADER') {
        inHeader = false;
      }
      continue;
    }

    if (lbl === 'START OF ANTENNA') {
      inAntenna = true;
      entry = blankEntry();
      continue;
    }

    if (!inAntenna) continue;

    if (lbl === 'END OF ANTENNA') {
      antennas.push(entry);
      inAntenna = false;
      continue;
    }

    // RMS sections repeat the frequency layout; skipped.
    if (lbl === 'START OF FREQ RMS') {
      inRms = true;
      continue;
    }
    if (inRms) {
      if (lbl === 'END OF FREQ RMS') inRms = false;
      continue;
    }

    if (lbl === 'TYPE / SERIAL NO') {
      entry.type = line.substring(0, 20).trim();
      entry.serialNo = line.substring(20, 40).trim();
      entry.svnCode = line.substring(40, 50).trim();
      entry.cosparId = line.substring(50, 60).trim();
      // Satellite antennas carry a satellite code ("G05") and/or an SVN.
      entry.isSatellite =
        /^[GRECIJS]\d{2,3}$/.test(entry.serialNo) ||
        /^[GRECIJS]\d{3}$/.test(entry.svnCode);
    } else if (lbl === 'METH / BY / # / DATE') {
      entry.method = line.substring(0, 20).trim();
      entry.agency = line.substring(20, 40).trim();
      entry.numCalibrated = parseInt(line.substring(40, 46), 10) || 0;
      entry.date = line.substring(50, 60).trim();
    } else if (lbl === 'DAZI') {
      entry.dazi = num(line.substring(2, 8));
    } else if (lbl === 'ZEN1 / ZEN2 / DZEN') {
      entry.zen1 = num(line.substring(2, 8));
      entry.zen2 = num(line.substring(8, 14));
      entry.dzen = num(line.substring(14, 20));
    } else if (lbl === 'SINEX CODE') {
      entry.sinexCode = line.substring(0, 10).trim();
    } else if (lbl === 'VALID FROM') {
      entry.validFrom = parseValidityDate(line);
    } else if (lbl === 'VALID UNTIL') {
      entry.validUntil = parseValidityDate(line);
    } else if (lbl === 'START OF FREQUENCY') {
      inFreq = true;
      freqLines = [line];
    } else if (lbl === 'END OF FREQUENCY') {
      freqLines.push(line);
      inFreq = false;
      entry.frequencies.push(
        parseFrequencyBlock14(
          freqLines,
          zenCount(entry.zen1, entry.zen2, entry.dzen),
          entry.dazi > 0
        )
      );
    } else if (inFreq) {
      freqLines.push(line);
    }
  }

  return { version, system, pcvType, refAntenna, comments, antennas };
}

function blankEntry(): AntennaEntry {
  return {
    type: '',
    serialNo: '',
    svnCode: '',
    cosparId: '',
    isSatellite: false,
    method: '',
    agency: '',
    numCalibrated: 0,
    date: '',
    dazi: 0,
    zen1: 0,
    zen2: 0,
    dzen: 0,
    sinexCode: '',
    validFrom: '',
    validUntil: '',
    frequencies: [],
  };
}

/* ── ANTEX 2.0 ───────────────────────────────────────────────────── */

/** Column mean of the azimuth rows 0…n−1 (the 360° row repeats 0°),
 *  ignoring missing values. */
function azimuthMean(rows: number[][], numZen: number): number[] {
  const n = Math.max(1, rows.length - 1);
  const out: number[] = [];
  for (let j = 0; j < numZen; j++) {
    let sum = 0;
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      const v = rows[i]?.[j];
      if (v !== undefined && Number.isFinite(v)) {
        sum += v;
        cnt++;
      }
    }
    out.push(cnt ? sum / cnt : NaN);
  }
  return out;
}

interface Calib2 extends AntexCalibration {
  /** DAZI as written (360 = no azimuth dependence). */
  fileDazi: number;
}

function parseAntex2(allLines: string[]): AntexFile {
  const file: AntexFile = {
    version: 0,
    system: 'M',
    pcvType: 'A',
    refAntenna: '',
    comments: [],
    antennas: [],
  };

  let inHeader = true;
  let ant: AntennaEntry | null = null;
  let calibs: Calib2[] = [];
  let calib: Calib2 | null = null;
  // The frequency record being read.
  let rec: {
    kind: string;
    bands: string[];
    x: number;
    y: number;
    z: number;
    gainDb?: number;
    rows: number[][];
  } | null = null;

  const closeRecord = () => {
    if (!ant || !calib || !rec) return;
    const numZen = zenCount(calib.zen1, calib.zen2, calib.dzen);
    const azimuthDependent = calib.fileDazi > 0 && calib.fileDazi < 360;
    // Receiver: x = East, y = North. Satellite: body X, Y, Z as in 1.4.
    const [pcoN, pcoE, pcoU] = ant.isSatellite
      ? [rec.x, rec.y, rec.z]
      : [rec.y, rec.x, rec.z];
    const pcv = azimuthDependent ? rec.rows : [];
    const pcvNoazi = azimuthDependent
      ? azimuthMean(rec.rows, numZen)
      : (rec.rows[0] ?? []);
    for (const band of rec.bands)
      calib.frequencies.push({
        frequency: band,
        pcoN,
        pcoE,
        pcoU,
        pcvNoazi,
        pcv,
        bands: rec.bands,
        ...(azimuthDependent ? { pcvNoaziDerived: true } : {}),
        ...(rec.gainDb !== undefined ? { gainOffsetDb: rec.gainDb } : {}),
      });
    rec = null;
  };

  const closeAntenna = () => {
    if (!ant) return;
    const strip = ({ fileDazi: _, ...c }: Calib2): AntexCalibration => c;
    const code = calibs.filter((c) => c.kind === 'CODE').map(strip);
    const gain = calibs.filter((c) => c.kind === 'GAIN').map(strip);
    const extra = {
      ...(code.length ? { codeCalibrations: code } : {}),
      ...(gain.length ? { gainCalibrations: gain } : {}),
    };
    const phase = calibs.filter((c) => c.kind === 'PHASE');
    if (!phase.length) file.antennas.push({ ...ant, ...extra });
    for (const c of phase)
      file.antennas.push({
        ...ant,
        method: c.method,
        agency: c.agency,
        numCalibrated: c.numCalibrated,
        date: c.date,
        validFrom: c.validFrom,
        validUntil: c.validUntil,
        dazi: c.dazi,
        zen1: c.zen1,
        zen2: c.zen2,
        dzen: c.dzen,
        frequencies: c.frequencies,
        ...extra,
      });
    ant = null;
  };

  for (const rawLine of allLines) {
    const line = rawLine.length < 80 ? rawLine.padEnd(80) : rawLine;

    // Pattern rows may run past column 60, so inside a frequency record
    // only its END line is a label.
    if (rec) {
      const tail = line.substring(60).trim();
      if (tail === `END OF ${rec.kind}`) closeRecord();
      else if (label(line) === 'X / Y / Z') {
        rec.x = num(line.substring(0, 10));
        rec.y = num(line.substring(10, 20));
        rec.z = num(line.substring(20, 30));
      } else if (label(line) === 'OFFSET') {
        rec.gainDb = num(line.substring(0, 10));
      } else if (line.trim() !== '' && calib) {
        rec.rows.push(
          parsePcvRow(
            line,
            8,
            zenCount(calib.zen1, calib.zen2, calib.dzen),
            NaN
          )
        );
      }
      continue;
    }

    const lbl = label(line);

    if (inHeader) {
      if (lbl === 'ANTEX VERSION') {
        file.version = parseFloat(line.substring(0, 8)) || 0;
      } else if (lbl === 'ANTENNA TYPES') {
        file.antennaTypes = line.substring(0, 10).trim();
      } else if (lbl === 'REFERENCE FRAME') {
        file.referenceFrame = line.substring(0, 10).trim();
      } else if (lbl === 'RELEASE') {
        const yd = line.substring(0, 7);
        file.release = `${yd.substring(0, 4)}:${yd.substring(4, 7)}`;
      } else if (lbl === 'COMMENT') {
        file.comments.push(line.substring(0, 60).trim());
      } else if (lbl === 'END OF HEADER') {
        inHeader = false;
      }
      continue;
    }

    if (lbl === 'START OF ANTENNA') {
      ant = blankEntry();
      calibs = [];
      calib = null;
    } else if (!ant) {
      continue;
    } else if (lbl === 'END OF ANTENNA') {
      closeAntenna();
    } else if (lbl === 'TYPE / SVN') {
      ant.type = line.substring(0, 20).trim();
      ant.svnCode = line.substring(40, 44).trim();
      ant.isSatellite = true;
    } else if (lbl === 'TYPE / SN') {
      ant.type = line.substring(0, 20).trim();
      ant.serialNo = line.substring(20, 40).trim();
    } else if (lbl === 'ORIGIN') {
      ant.origin = line.substring(0, 3).trim();
    } else if (lbl === 'START OF CALIB') {
      calib = {
        kind: 'PHASE',
        method: '',
        agency: '',
        numCalibrated: 0,
        date: '',
        validFrom: '',
        validUntil: '',
        dazi: 0,
        fileDazi: 0,
        zen1: 0,
        zen2: 0,
        dzen: 0,
        frequencies: [],
      };
    } else if (!calib) {
      continue;
    } else if (lbl === 'END OF CALIB') {
      calibs.push(calib);
      calib = null;
    } else if (lbl === 'TYPE / # OF FREQS') {
      const kind = line.substring(0, 10).trim();
      if (kind === 'PHASE' || kind === 'CODE' || kind === 'GAIN')
        calib.kind = kind;
    } else if (lbl === 'METH / BY / # / DATE') {
      calib.method = line.substring(0, 20).trim();
      calib.agency = line.substring(20, 40).trim();
      calib.numCalibrated = parseInt(line.substring(40, 46), 10) || 0;
      calib.date = line.substring(50, 60).trim();
    } else if (lbl === 'VALID FROM') {
      calib.validFrom = parseValidityDate(line);
    } else if (lbl === 'VALID UNTIL') {
      calib.validUntil = parseValidityDate(line);
    } else if (lbl === 'DAZI') {
      calib.fileDazi = num(line.substring(2, 8));
      // 360° = one pattern for all azimuths: 0, as in 1.4.
      calib.dazi = calib.fileDazi >= 360 ? 0 : calib.fileDazi;
    } else if (lbl === 'ZEN1 / ZEN2 / DZEN') {
      calib.zen1 = num(line.substring(2, 8));
      calib.zen2 = num(line.substring(8, 14));
      calib.dzen = num(line.substring(14, 20));
    } else if (/^START OF (PHASE|CODE|GAIN)$/.test(lbl)) {
      const bands: string[] = [];
      for (let i = 0; i < 10; i++) {
        const b = line.substring(i * 6 + 3, i * 6 + 6).trim();
        if (b) bands.push(b);
      }
      rec = {
        kind: lbl.substring(9),
        bands,
        x: 0,
        y: 0,
        z: 0,
        rows: [],
      };
    }
  }

  return file;
}

/* ── SVN → PRN (ANTEX 2.0 satellites) ────────────────────────────── */

/** One line of the SATELLITE/PRN block of the IGS satellite metadata SINEX:
 *  the PRN (or GLONASS slot) an SVN used over a time interval. */
export interface SatellitePrnAssignment {
  svn: string;
  prn: string;
  /** UTC ms (SINEX epochs, GPS-time days at 1-day resolution in practice) */
  fromMs: number;
  /** Infinity when open-ended */
  untilMs: number;
}

/** SINEX "YYYY:DDD:SSSSS" (2- or 4-digit year) → ms; 0000:000:00000 → null. */
function sinexEpochMs(s: string): number | null {
  const [y, d, sec] = s.split(':').map(Number);
  if (y === undefined || d === undefined || sec === undefined) return null;
  if (y === 0 && d === 0 && sec === 0) return null;
  const year = y < 100 ? (y < 50 ? 2000 + y : 1900 + y) : y;
  return Date.UTC(year, 0, 1) + (d - 1) * 86_400_000 + sec * 1000;
}

/** Parse the SATELLITE/PRN block of the IGS satellite metadata SINEX
 *  (igs_satellite_metadata.snx). */
export function parseSatellitePrns(text: string): SatellitePrnAssignment[] {
  const out: SatellitePrnAssignment[] = [];
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('+SATELLITE/PRN')) inBlock = true;
    else if (line.startsWith('-SATELLITE/PRN')) break;
    else if (inBlock && line.startsWith(' ')) {
      const svn = line.substring(1, 5).trim();
      const from = sinexEpochMs(line.substring(6, 20).trim());
      const until = sinexEpochMs(line.substring(21, 35).trim());
      const prn = line.substring(36, 39).trim();
      if (svn && prn && from !== null)
        out.push({ svn, prn, fromMs: from, untilMs: until ?? Infinity });
    }
  }
  return out;
}

const fmtValidity = (ms: number) =>
  Number.isFinite(ms)
    ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
    : '';

const validityMs = (s: string, open: number) => {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!) : open;
};

/**
 * An ANTEX file whose SVN-keyed satellite antennas (ANTEX 2.0) are repeated
 * per PRN they used, each with its validity cut to that assignment — the
 * shape of a 1.4 file, where satellites are looked up by PRN. Receivers and
 * satellites that already carry a PRN are passed through.
 */
export function antexWithPrns(
  antex: AntexFile,
  assignments: readonly SatellitePrnAssignment[]
): AntexFile {
  const bySvn = new Map<string, SatellitePrnAssignment[]>();
  for (const a of assignments) {
    const list = bySvn.get(a.svn) ?? [];
    list.push(a);
    bySvn.set(a.svn, list);
  }
  const antennas: AntennaEntry[] = [];
  for (const e of antex.antennas) {
    if (!e.isSatellite || e.serialNo || !e.svnCode) {
      antennas.push(e);
      continue;
    }
    const from = validityMs(e.validFrom, -Infinity);
    const until = validityMs(e.validUntil, Infinity);
    for (const a of bySvn.get(e.svnCode) ?? []) {
      const f = Math.max(from, a.fromMs);
      const u = Math.min(until, a.untilMs);
      if (f >= u) continue;
      antennas.push({
        ...e,
        serialNo: a.prn,
        validFrom: fmtValidity(f),
        validUntil: fmtValidity(u),
      });
    }
  }
  return { ...antex, antennas };
}

/* ── Frequency label mapping ─────────────────────────────────────── */

const FREQ_LABELS: Record<string, string> = {
  G01: 'GPS L1',
  G02: 'GPS L2',
  G05: 'GPS L5',
  R01: 'GLO G1',
  R02: 'GLO G2',
  R03: 'GLO G3',
  R04: 'GLO G1a',
  R06: 'GLO G2a',
  E01: 'GAL E1',
  E05: 'GAL E5a',
  E06: 'GAL E6',
  E07: 'GAL E5b',
  E08: 'GAL E5',
  C01: 'BDS B1',
  C02: 'BDS B1-2',
  C05: 'BDS B2a',
  C06: 'BDS B3',
  C07: 'BDS B2b',
  C08: 'BDS B2',
  J01: 'QZS L1',
  J02: 'QZS L2',
  J05: 'QZS L5',
  J06: 'QZS LEX',
  S01: 'SBS L1',
  S05: 'SBS L5',
  I01: 'NIC L1',
  I05: 'NIC L5',
  I09: 'NIC S',
};

export function frequencyLabel(code: string): string {
  return FREQ_LABELS[code] ?? code;
}
