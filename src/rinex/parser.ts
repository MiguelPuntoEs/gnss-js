/**
 * Streaming RINEX / CRX observation file parser.
 * Supports RINEX 2.x, 3.x/4.x and Compact RINEX (Hatanaka) 1.0/3.0.
 */

import { isUnixCompress, uncompressLzw } from './unlzw';
import { crxRepair, parseCrxDataLine, crxDecompress } from './crx';
import type { DiffState } from './crx';
import { SYSTEM_NAMES } from '../constants/gnss';

const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB per chunk

/** Yield to the browser so the UI stays responsive during long parses. */
const yieldToMain = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** No-op yield for Web Worker context (no UI to keep responsive). */
const noYield = (): Promise<void> => Promise.resolve();

/* ================================================================== */
/*  Public types                                                       */
/* ================================================================== */

export interface RinexHeader {
  version: number;
  type: string;
  satSystem: string;
  markerName: string;
  markerType: string;
  observer: string;
  agency: string;
  receiverNumber: string;
  receiverType: string;
  receiverVersion: string;
  antNumber: string;
  antType: string;
  approxPosition: [number, number, number] | null;
  /** "ANTENNA: DELTA H/E/N" (m) in RINEX order: [Up (height), East, North]
   *  of the ARP above the marker. NOT the [E, N, U] the positioning APIs take
   *  — convert with {@link antDeltaToEnu}. */
  antDelta: [number, number, number] | null;
  interval: number | null;
  timeOfFirstObs: Date | null;
  timeOfLastObs: Date | null;
  obsTypes: Record<string, string[]>; // system letter → obs codes
  /** GLONASS frequency channel numbers. Key = slot (1-24), value = channel k (−7…+6). */
  glonassSlots: Record<number, number>;
  isCrx: boolean;
  crxVersion: number;
  /** MARKER NUMBER (A20); absent or '' when the file has none. */
  markerNumber?: string;
  /**
   * Time system of every epoch in the file, from TIME OF FIRST OBS cols
   * 49–51 (GPS, GLO = UTC(SU), GAL, QZS, BDT, IRN). '' when the record leaves
   * it blank: the single-system default applies (RINEX 3.04 Table A2).
   */
  timeSystem?: string;
  /** SIGNAL STRENGTH UNIT (RINEX 3), e.g. 'DBHZ'. */
  signalStrengthUnit?: string;
  /** LEAP SECONDS: the current number of leap seconds (first I6). */
  leapSeconds?: number;
  /** RCV CLOCK OFFS APPL: epoch, code and phase corrected by the receiver clock offset. */
  rcvClockOffsApplied?: boolean;
  /** SYS / PHASE SHIFT records, in file order (RINEX 3.01+). */
  phaseShifts?: PhaseShift[];
  /**
   * GLONASS COD/PHS/BIS (RINEX 3.02+): signal (C1C, C1P, C2C, C2P) → code-
   * phase bias in metres. An empty object is the blank record ("unknown").
   */
  glonassCodPhsBis?: Record<string, number>;
  /**
   * SYS / SCALE FACTOR (RINEX 3): system → obs code → factor. The parser
   * divides the stored values by it, so callbacks see physical values.
   */
  scaleFactors?: Record<string, Record<string, number>>;
}

/**
 * One SYS / PHASE SHIFT record. `code` '' is the blank record (alignment
 * unknown); `correction` null is a reference signal (nothing applied);
 * `sats` empty means every satellite of the system.
 */
export interface PhaseShift {
  sys: string;
  code: string;
  correction: number | null;
  sats: string[];
}

export interface EpochSummary {
  time: number; // unix ms
  totalSats: number;
  satsPerSystem: Record<string, number>;
  meanSnr: number | null;
  snrPerSystem: Record<string, number>;
  snrPerSat: Record<string, number>; // PRN (e.g. "G01") → mean SNR
  /** Per-satellite per-band SNR.  Key = "PRN:band" e.g. "G01:1" → dB-Hz */
  snrPerSatBand?: Record<string, number>;
}

export interface RinexStats {
  totalEpochs: number;
  validEpochs: number;
  duration: number | null;
  startTime: Date | null;
  endTime: Date | null;
  interval: number | null;
  uniqueSatellites: number;
  uniqueSatsPerSystem: Record<string, number>;
  systems: string[];
  meanSatellites: number;
  meanSnr: number | null;
}

export interface RinexResult {
  header: RinexHeader;
  epochs: EpochSummary[];
  stats: RinexStats;
}

/* ================================================================== */
/*  System labels                                                      */
/* ================================================================== */

// SYSTEM_NAMES imported from gnss-constants.ts

/** Canonical constellation display order: GPS → GLONASS → Galileo → BeiDou → QZSS → NavIC → SBAS */
export const SYSTEM_ORDER = ['G', 'R', 'E', 'C', 'J', 'I', 'S'] as const;

const SYSTEM_RANK: Record<string, number> = Object.fromEntries(
  SYSTEM_ORDER.map((s, i) => [s, i])
);

/**
 * RINEX "ANTENNA: DELTA H/E/N" ([Up, East, North], RINEX 3.04 Table A2) →
 * the local [East, North, Up] marker→ARP vector that `antDeltaEnu` (PPP) and
 * `deltaEnu` (RTK) take. A missing delta is [0, 0, 0].
 */
export function antDeltaToEnu(
  hen: readonly [number, number, number] | null | undefined
): [number, number, number] {
  return hen ? [hen[1], hen[2], hen[0]] : [0, 0, 0];
}

/** Compare two system codes (or PRNs) in canonical constellation order. */
export function systemCmp(a: string, b: string): number {
  const ra = SYSTEM_RANK[a.charAt(0)] ?? 99;
  const rb = SYSTEM_RANK[b.charAt(0)] ?? 99;
  if (ra !== rb) return ra - rb;
  return a.localeCompare(b);
}

export function systemName(code: string): string {
  return SYSTEM_NAMES[code] ?? code;
}

/* ================================================================== */
/*  Header parser                                                      */
/* ================================================================== */

/**
 * The header of a RINEX observation file (2/3/4, Hatanaka too) from its
 * leading text — enough to review an occupation (marker, antenna, height,
 * receiver, first epoch) without reading the observations. Null when the
 * text holds no complete header.
 */
export function parseRinexHeaderText(text: string): RinexHeader | null {
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((l) => l.includes('END OF HEADER'));
  if (end < 0) return null;
  const h = parseHeader(lines.slice(0, end + 1));
  if (/COMPACT RINEX|CRINEX/.test(lines[0] ?? '')) h.isCrx = true;
  return h;
}

function parseHeader(lines: string[]): RinexHeader {
  const h: RinexHeader = {
    version: 0,
    type: '',
    satSystem: '',
    markerName: '',
    markerType: '',
    observer: '',
    agency: '',
    receiverNumber: '',
    receiverType: '',
    receiverVersion: '',
    antNumber: '',
    antType: '',
    approxPosition: null,
    antDelta: null,
    interval: null,
    timeOfFirstObs: null,
    timeOfLastObs: null,
    obsTypes: {},
    glonassSlots: {},
    isCrx: false,
    crxVersion: 0,
  };

  let currentObsSys = '';
  let lastScale: { sys: string; factor: number } | null = null;

  for (const raw of lines) {
    const label = raw.substring(60).trim();
    const data = raw.substring(0, 60);

    switch (label) {
      case 'CRINEX VERS   / TYPE': {
        h.isCrx = true;
        h.crxVersion = parseFloat(data.substring(0, 9)) || 0;
        break;
      }
      case 'RINEX VERSION / TYPE': {
        h.version = parseFloat(data.substring(0, 9));
        h.type = data.substring(20, 21).trim();
        h.satSystem = data.substring(40, 41).trim();
        break;
      }
      case 'MARKER NAME':
        h.markerName = data.trim();
        break;
      case 'MARKER TYPE':
        h.markerType = data.trim();
        break;
      case 'MARKER NUMBER':
        h.markerNumber = data.substring(0, 20).trim();
        break;
      case 'SIGNAL STRENGTH UNIT':
        h.signalStrengthUnit = data.substring(0, 20).trim();
        break;
      case 'LEAP SECONDS': {
        const n = parseInt(data.substring(0, 6));
        if (!isNaN(n)) h.leapSeconds = n;
        break;
      }
      case 'RCV CLOCK OFFS APPL':
        h.rcvClockOffsApplied = parseInt(data.substring(0, 6)) === 1;
        break;
      case 'SYS / PHASE SHIFT': {
        // A1,1X,A3,1X,F8.5,2X,I2.2,10(1X,A3); continuation: 18X,10(1X,A3)
        const sys = data[0]?.trim() ?? '';
        const list = (from: number) =>
          data
            .substring(from)
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map(normalizePrn);
        if (sys) {
          const corr = data.substring(6, 14).trim();
          (h.phaseShifts ??= []).push({
            sys,
            code: data.substring(2, 5).trim(),
            correction: corr ? parseFloat(corr) : null,
            sats: list(18),
          });
        } else if (h.phaseShifts?.length) {
          h.phaseShifts[h.phaseShifts.length - 1]!.sats.push(...list(18));
        }
        break;
      }
      case 'GLONASS COD/PHS/BIS': {
        // 4(1X,A3,1X,F8.3); all blank = unknown
        const bis = (h.glonassCodPhsBis ??= {});
        for (let i = 0; i < 4; i++) {
          const code = data.substring(1 + 13 * i, 4 + 13 * i).trim();
          const v = parseFloat(data.substring(5 + 13 * i, 13 + 13 * i));
          if (code && !isNaN(v)) bis[code] = v;
        }
        break;
      }
      case 'SYS / SCALE FACTOR': {
        // A1,1X,I4,2X,I2,12(1X,A3); continuation 10X,12(1X,A3)
        const sys = data[0]?.trim();
        if (sys) {
          const factor = parseInt(data.substring(2, 6));
          const codes = data.substring(10).trim().split(/\s+/).filter(Boolean);
          const all = codes.length === 0 ? (h.obsTypes[sys] ?? []) : codes;
          const m = ((h.scaleFactors ??= {})[sys] ??= {});
          for (const c of all) m[c] = factor;
          lastScale = { sys, factor };
        } else if (lastScale) {
          const m = h.scaleFactors![lastScale.sys]!;
          for (const c of data
            .substring(10)
            .trim()
            .split(/\s+/)
            .filter(Boolean))
            m[c] = lastScale.factor;
        }
        break;
      }
      case 'OBSERVER / AGENCY':
        h.observer = data.substring(0, 20).trim();
        h.agency = data.substring(20).trim();
        break;
      case 'REC # / TYPE / VERS':
        h.receiverNumber = data.substring(0, 20).trim();
        h.receiverType = data.substring(20, 40).trim();
        h.receiverVersion = data.substring(40, 60).trim();
        break;
      case 'ANT # / TYPE':
        h.antNumber = data.substring(0, 20).trim();
        h.antType = data.substring(20).trim();
        break;
      case 'ANTENNA: DELTA H/E/N': {
        const d = data.trim().split(/\s+/).map(Number);
        if (d.length >= 3 && !d.slice(0, 3).some(isNaN)) {
          h.antDelta = [d[0]!, d[1]!, d[2]!];
        }
        break;
      }
      case 'APPROX POSITION XYZ': {
        const p = data.trim().split(/\s+/).map(Number);
        if (
          p.length >= 3 &&
          p[0] !== undefined &&
          p[1] !== undefined &&
          p[2] !== undefined &&
          !isNaN(p[0]) &&
          !isNaN(p[1]) &&
          !isNaN(p[2])
        ) {
          h.approxPosition = [p[0], p[1], p[2]];
        }
        break;
      }
      case 'INTERVAL':
        h.interval = parseFloat(data);
        break;
      case 'TIME OF FIRST OBS':
        h.timeOfFirstObs = parseHeaderTime(data);
        h.timeSystem = data.substring(48, 51).trim();
        break;
      case 'TIME OF LAST OBS':
        h.timeOfLastObs = parseHeaderTime(data);
        break;
      case 'SYS / # / OBS TYPES': {
        const sys = data[0]?.trim();
        if (sys) {
          currentObsSys = sys;
          const count = parseInt(data.substring(3, 6));
          const codes = data
            .substring(7, 60)
            .trim()
            .split(/\s+/)
            .filter(Boolean);
          h.obsTypes[currentObsSys] = codes;
          void count; // continuation handled below
        } else if (currentObsSys && h.obsTypes[currentObsSys]) {
          const codes = data
            .substring(7, 60)
            .trim()
            .split(/\s+/)
            .filter(Boolean);
          h.obsTypes[currentObsSys]!.push(...codes);
        }
        break;
      }
      case 'GLONASS SLOT / FRQ #': {
        // Format: nSats (3 chars), then up to 8 pairs of "Rnn k" (slot + channel)
        const nSats = parseInt(data.substring(0, 3));
        void nSats;
        for (let i = 0; i < 8; i++) {
          const off = 4 + i * 7;
          const sat = data.substring(off, off + 3).trim();
          const ch = data.substring(off + 3, off + 7).trim();
          if (sat && sat[0] === 'R' && ch) {
            const slot = parseInt(sat.substring(1));
            const k = parseInt(ch);
            if (!isNaN(slot) && !isNaN(k)) h.glonassSlots[slot] = k;
          }
        }
        break;
      }
      case '# / TYPES OF OBSERV': {
        const existing = h.obsTypes['_v2'];
        const codes = data.substring(6, 60).trim().split(/\s+/).filter(Boolean);
        if (!existing || existing.length === 0) {
          h.obsTypes['_v2'] = codes;
        } else {
          existing.push(...codes);
        }
        break;
      }
    }
  }
  // RINEX 3.00–3.02 label BeiDou B1I as band 1 (C1I/L1I); from 3.03 band 1
  // is B1C (1575.42 MHz) and B1I is band 2 (C2I, 1561.098 MHz). Read as
  // B1C, every B1I phase took the wrong wavelength: the cycle-slip tests
  // fired on half the BeiDou epochs (GMSD, Trimble NetR9; HKSL, Leica GR50).
  // Renamed here, as RTKLIB does, so everything downstream sees band 2 —
  // unless the file already has band-2 codes (a writer using 3.03 names).
  if (
    h.version >= 3 &&
    h.version < 3.03 &&
    h.obsTypes['C'] &&
    !h.obsTypes['C'].some((c) => c[1] === '2')
  )
    h.obsTypes['C'] = h.obsTypes['C'].map((c) =>
      c[1] === '1' ? `${c[0]}2${c.slice(2)}` : c
    );
  return h;
}

function parseHeaderTime(data: string): Date | null {
  const p = data.trim().split(/\s+/).map(Number);
  if (p.length < 6) return null;
  const yr = p[0]!,
    mo = p[1]!,
    dy = p[2]!,
    hr = p[3]!,
    mn = p[4]!,
    sc = p[5]!;
  if ([yr, mo, dy, hr, mn, sc].some(isNaN)) return null;
  const wholeSec = Math.floor(sc);
  const ms = Math.round((sc - wholeSec) * 1000);
  return new Date(Date.UTC(yr, mo - 1, dy, hr, mn, wholeSec, ms));
}

/* ================================================================== */
/*  SNR index helpers                                                  */
/* ================================================================== */

function snrIndicesWithBand(
  obsTypes: Record<string, string[]>,
  system: string
): { idx: number; band: string }[] {
  const codes = obsTypes[system];
  if (!codes) return [];
  const result: { idx: number; band: string }[] = [];
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (c.startsWith('S')) result.push({ idx: i, band: c[1]! });
  }
  return result;
}

function snrIndicesWithBandV2(
  obsTypes: Record<string, string[]>
): { idx: number; band: string }[] {
  const codes = obsTypes['_v2'];
  if (!codes) return [];
  const result: { idx: number; band: string }[] = [];
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (c.startsWith('S')) result.push({ idx: i, band: c[1]! });
  }
  return result;
}

/* ================================================================== */
/*  RINEX observation value extraction                                 */
/* ================================================================== */

function readObsValue(line: string, index: number): number | null {
  const start = index * 16;
  if (start + 14 > line.length) return null;
  const raw = line.substring(start, start + 14).trim();
  if (!raw) return null;
  const v = parseFloat(raw);
  return isNaN(v) ? null : v;
}

/* ================================================================== */
/*  Epoch line parsers                                                 */
/* ================================================================== */

interface EpochLineInfo {
  time: number;
  flag: number;
  numSats: number;
  satIds?: string[];
  /** Receiver clock offset (s), null when the record leaves it blank. */
  clockOffset: number | null;
}

/** Optional F15.12 / F12.9 receiver clock offset field. */
function readClockField(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const v = parseFloat(t);
  return isNaN(v) ? null : v;
}

/**
 * Canonical satellite id ("G02") from a RINEX one: some writers pad the
 * number with a space ("G 2"), RINEX 2 may omit the system letter ("12").
 */
function normalizePrn(id: string): string {
  let sys = id[0]!;
  let num = id.substring(1);
  if (sys === ' ' || /\d/.test(sys)) {
    num = id;
    sys = 'G';
  }
  return sys + num.replace(/\s/g, '').padStart(2, '0');
}

function parseEpochLine3(line: string): EpochLineInfo | null {
  if (line[0] !== '>') return null;
  const yr = parseInt(line.substring(2, 6));
  const mo = parseInt(line.substring(7, 9));
  const dy = parseInt(line.substring(10, 12));
  const hr = parseInt(line.substring(13, 15));
  const mn = parseInt(line.substring(16, 18));
  const sc = parseFloat(line.substring(19, 29));
  const flag = parseInt(line.substring(31, 32));
  const numSats = parseInt(line.substring(32, 35));
  // Events without a significant epoch may leave the time blank (A3).
  const blankTime = [yr, mo, dy, hr, mn].some(isNaN) || isNaN(sc);
  if (blankTime && !(flag >= 2 && flag <= 5)) return null;
  const wholeSec = Math.floor(sc);
  const ms = Math.round((sc - wholeSec) * 1000);
  const time = blankTime ? NaN : Date.UTC(yr, mo - 1, dy, hr, mn, wholeSec, ms);
  return {
    time,
    flag: isNaN(flag) ? 0 : flag,
    numSats: isNaN(numSats) ? 0 : numSats,
    // 6X reserved, then F15.12 from column 42 (RINEX 3.04 Table A3)
    clockOffset: readClockField(line.substring(41, 56)),
  };
}

function parseEpochLine2(line: string): EpochLineInfo | null {
  const yr2 = parseInt(line.substring(1, 3));
  const mo = parseInt(line.substring(4, 6));
  const dy = parseInt(line.substring(7, 9));
  const hr = parseInt(line.substring(10, 12));
  const mn = parseInt(line.substring(13, 15));
  const sc = parseFloat(line.substring(15, 26));
  const flag = parseInt(line.substring(28, 29));
  const numSats = parseInt(line.substring(29, 32));
  const blankTime = [yr2, mo, dy, hr, mn].some(isNaN) || isNaN(sc);
  if (blankTime && !(flag >= 2 && flag <= 5)) return null;
  const yr = yr2 >= 80 ? 1900 + yr2 : 2000 + yr2;
  const wholeSec = Math.floor(sc);
  const ms = Math.round((sc - wholeSec) * 1000);
  const time = blankTime ? NaN : Date.UTC(yr, mo - 1, dy, hr, mn, wholeSec, ms);

  // Satellite list: 12(A1,I2) in columns 33–68 only — the receiver clock
  // offset (F12.9) follows in columns 69–80 and is not a satellite.
  return {
    time,
    flag: isNaN(flag) ? 0 : flag,
    numSats: isNaN(numSats) ? 0 : numSats,
    satIds: v2SatList(line),
    clockOffset: readClockField(line.substring(68, 80)),
  };
}

/** Satellite ids of a RINEX 2 epoch (or continuation) line, cols 33–68. */
function v2SatList(line: string): string[] {
  const ids: string[] = [];
  const satPart = line.substring(32, 68);
  for (let i = 0; i + 3 <= satPart.length; i += 3) {
    const id = satPart.substring(i, i + 3);
    if (id.trim()) ids.push(id);
  }
  return ids;
}

/* ================================================================== */
/*  CRX (Compact RINEX / Hatanaka) decompression — see ./crx.ts       */
/* ================================================================== */

/* ================================================================== */
/*  Streaming parser                                                   */
/* ================================================================== */

/**
 * Callback invoked for each satellite observation line with all raw values.
 * `lli` holds each observation's loss-of-lock indicator digit (RINEX LLI,
 * bit 0 = lost lock since the previous epoch), null where blank.
 */
export type SatObsCallback = (
  time: number,
  prn: string,
  codes: string[],
  values: (number | null)[],
  lli?: (number | null)[],
  /** Signal strength indicator digit (1–9) per value, null where blank. */
  ssi?: (number | null)[]
) => void;

/**
 * One epoch record. Observation epochs (flag 0 = OK, 1 = power failure
 * since the previous epoch) are reported before their satellites' values;
 * events (flag 2–5) carry their special records (header lines) verbatim and
 * `time` NaN when the record leaves the epoch blank. Flag 6 (cycle-slip
 * records) is skipped.
 */
export interface ObsEpochRecord {
  time: number;
  flag: number;
  numSats: number;
  /** Receiver clock offset (s), null when not reported. */
  clockOffset: number | null;
  /** Event special records (flags 2–5). */
  records?: string[];
}
export type ObsEpochCallback = (epoch: ObsEpochRecord) => void;

/** LLI digit after observation `index` of a data line, null if blank. */
function readObsLli(line: string, index: number): number | null {
  return flagDigit(line[index * 16 + 14]);
}

/** SSI digit after observation `index` of a data line, null if blank. */
function readObsSsi(line: string, index: number): number | null {
  return flagDigit(line[index * 16 + 15]);
}

function flagDigit(c: string | undefined): number | null {
  if (c === undefined || c === ' ') return null;
  const d = c.charCodeAt(0) - 48;
  return d >= 0 && d <= 9 ? d : null;
}

/**
 * What {@link parseRinexStream} does besides reading: the per-epoch
 * summaries (EpochSummary, and the stats built from them — only a QC view
 * needs them, ~30 % of the parse) and the setTimeout yields that keep a
 * page responsive (pointless in a worker). Both on by default.
 */
export interface ParseStreamMode {
  /** Build the per-epoch summaries and stats. Default true. */
  summaries?: boolean;
  /** Yield to the event loop while reading. Default true. */
  yieldToUi?: boolean;
}

export interface ParseOptions {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
  onSatObs?: SatObsCallback;
  /** `true`: no summaries and no yields (a Web Worker); or each separately. */
  workerMode?: boolean | ParseStreamMode;
}

export async function parseRinexStream(
  file: File,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
  onSatObs?: SatObsCallback,
  /** `true`: no summaries and no yields (a Web Worker). An object sets
   *  them separately — e.g. `{ summaries: false }` on a page that only
   *  needs the observations, still yielding to keep it responsive. */
  workerMode?: boolean | ParseStreamMode,
  onEpoch?: ObsEpochCallback
): Promise<RinexResult> {
  const mode: ParseStreamMode =
    typeof workerMode === 'object'
      ? workerMode
      : { summaries: !workerMode, yieldToUi: !workerMode };
  const skipEpochs = mode.summaries === false;
  const yield_ = mode.yieldToUi === false ? noYield : yieldToMain;
  const decoder = new TextDecoder('ascii');
  let buffer = '';
  let header: RinexHeader | null = null;
  const headerLines: string[] = [];
  const epochs: EpochSummary[] = [];
  const satellitesSeen: Record<string, Set<string>> = {};

  // --- shared epoch accumulation ---
  let epochInfo: EpochLineInfo | null = null;
  let satsPerSystem: Record<string, number> = {};
  let snrValues: number[] = [];
  let snrPerSystemAccum: Record<string, number[]> = {};
  let snrPerSatAccum: Record<string, number[]> = {};
  let snrPerSatBandAccum: Record<string, number[]> = {}; // "PRN:band" → values

  // --- RINEX (non-CRX) state ---
  let satLinesRemaining = 0;
  let eventSkipLines = 0; // lines remaining to skip for event records (flag 2-5)
  /** The event being read (flags 2–5): its special records accumulate. */
  let pendingEvent: ObsEpochRecord | null = null;
  function startEvent(info: EpochLineInfo): number {
    if (info.flag === 6) return info.numSats; // cycle-slip records: skipped
    pendingEvent = {
      time: info.time,
      flag: info.flag,
      numSats: info.numSats,
      clockOffset: null,
      records: [],
    };
    if (info.numSats === 0) endEvent();
    return info.numSats;
  }
  function eventLine(line: string) {
    if (!pendingEvent) return;
    pendingEvent.records!.push(line);
    if (pendingEvent.records!.length >= pendingEvent.numSats) endEvent();
  }
  function endEvent() {
    if (pendingEvent) onEpoch?.(pendingEvent);
    pendingEvent = null;
  }
  /** Is this an observation epoch (flag 0 OK or 1 power failure)? */
  const isObsFlag = (f: number) => f === 0 || f === 1;
  // v2 specifics
  let v2SatIds: string[] = [];
  let v2SatIndex = 0;
  let v2LinesPerSat = 0;
  let v2CurrentSatLine = 0;
  let v2SnrBandInfo: { idx: number; band: string }[] = [];
  let v2ContinuationSatsRemaining = 0;

  // --- CRX state ---
  type CrxPhase = 'epoch' | 'clock' | 'satdata';
  let crxPhase: CrxPhase = 'epoch';
  let crxSatList: string[] = []; // PRN list for current epoch
  let crxSatIndex = 0; // which satellite we're on
  let crxPrevEpochLine = ''; // for text-differencing epoch lines
  // Per-satellite decompression state: PRN → array of DiffState per obs
  const crxDiffStates = new Map<string, (DiffState | null)[]>();
  /** Per satellite, the CRX flag characters (LLI, SSI per observation). */
  const crxFlagStates = new Map<string, string[]>();
  const crxFlagSeen = new Map<string, number>();
  let crxCurEpoch = NaN;
  let crxPrevEpoch = NaN;

  /* -------- helpers -------- */

  function trackSat(sys: string, prn: string) {
    if (!satellitesSeen[sys]) satellitesSeen[sys] = new Set();
    satellitesSeen[sys]!.add(prn);
    satsPerSystem[sys] = (satsPerSystem[sys] ?? 0) + 1;
  }

  function pushSnr(sys: string, prn: string, val: number, band?: string) {
    if (skipEpochs) return;
    snrValues.push(val);
    if (!snrPerSystemAccum[sys]) snrPerSystemAccum[sys] = [];
    snrPerSystemAccum[sys]!.push(val);
    if (!snrPerSatAccum[prn]) snrPerSatAccum[prn] = [];
    snrPerSatAccum[prn]!.push(val);
    if (band) {
      const key = `${prn}:${band}`;
      if (!snrPerSatBandAccum[key]) snrPerSatBandAccum[key] = [];
      snrPerSatBandAccum[key]!.push(val);
    }
  }

  function finishEpoch() {
    if (!epochInfo) return;
    if (!skipEpochs) {
      const snrBySys: Record<string, number> = {};
      for (const [sys, vals] of Object.entries(snrPerSystemAccum)) {
        if (vals.length > 0)
          snrBySys[sys] = vals.reduce((a, b) => a + b, 0) / vals.length;
      }
      const meanSnr =
        snrValues.length > 0
          ? snrValues.reduce((a, b) => a + b, 0) / snrValues.length
          : null;
      const snrPerSat: Record<string, number> = {};
      for (const [prn, vals] of Object.entries(snrPerSatAccum)) {
        if (vals.length > 0)
          snrPerSat[prn] = vals.reduce((a, b) => a + b, 0) / vals.length;
      }
      const snrPerSatBand: Record<string, number> = {};
      for (const [key, vals] of Object.entries(snrPerSatBandAccum)) {
        if (vals.length > 0)
          snrPerSatBand[key] = vals.reduce((a, b) => a + b, 0) / vals.length;
      }
      epochs.push({
        time: epochInfo.time,
        totalSats: Object.values(satsPerSystem).reduce((a, b) => a + b, 0),
        satsPerSystem: { ...satsPerSystem },
        meanSnr,
        snrPerSystem: snrBySys,
        snrPerSat,
        snrPerSatBand,
      });
    }
    epochInfo = null;
    satsPerSystem = {};
    snrValues = [];
    snrPerSystemAccum = {};
    snrPerSatAccum = {};
    snrPerSatBandAccum = {};
  }

  function resetEpochAccum(info: EpochLineInfo, report = true) {
    epochInfo = info;
    if (report) reportEpoch(info);
    satsPerSystem = {};
    snrValues = [];
    snrPerSystemAccum = {};
    snrPerSatAccum = {};
    snrPerSatBandAccum = {};
  }

  function reportEpoch(info: EpochLineInfo) {
    onEpoch?.({
      time: info.time,
      flag: info.flag,
      numSats: info.numSats,
      clockOffset: info.clockOffset,
    });
  }

  /* -------- RINEX 3 (non-CRX) -------- */

  // Per-system SNR index cache (built once per system on first encounter)
  const snrCache = new Map<string, { idx: number; band: string }[]>();
  function getSnrIndices(sys: string): { idx: number; band: string }[] {
    let cached = snrCache.get(sys);
    if (!cached) {
      cached = snrIndicesWithBand(header!.obsTypes, sys);
      snrCache.set(sys, cached);
    }
    return cached;
  }

  function processSatLineV3(line: string) {
    if (!header || line.length < 3) return;
    const sys = line[0]!;
    const prn = normalizePrn(line.substring(0, 3));
    trackSat(sys, prn);
    const obsLine = line.substring(3);
    const codes = header.obsTypes[sys] ?? [];

    if (onSatObs && epochInfo) {
      // Read all values once, use for both SNR and callback
      const values: (number | null)[] = new Array(codes.length);
      const lli: (number | null)[] = new Array(codes.length);
      const ssi: (number | null)[] = new Array(codes.length);
      const scale = header.scaleFactors?.[sys];
      for (let i = 0; i < codes.length; i++) {
        const v = readObsValue(obsLine, i);
        const f = scale?.[codes[i]!];
        values[i] = v !== null && f ? v / f : v;
        lli[i] = readObsLli(obsLine, i);
        ssi[i] = readObsSsi(obsLine, i);
      }
      if (!skipEpochs) {
        for (const { idx, band } of getSnrIndices(sys)) {
          const val = values[idx] ?? null;
          if (val !== null && val > 0) pushSnr(sys, prn, val, band);
        }
      }
      onSatObs(epochInfo.time, prn, codes, values, lli, ssi);
    } else if (!skipEpochs) {
      for (const { idx, band } of getSnrIndices(sys)) {
        const val = readObsValue(obsLine, idx);
        if (val !== null && val > 0) pushSnr(sys, prn, val, band);
      }
    }
  }

  /* -------- RINEX 2 (non-CRX) -------- */

  // v2: accumulate all obs values across continuation lines for onSatObs callback
  let v2ObsAccum: (number | null)[] = [];
  let v2LliAccum: (number | null)[] = [];
  let v2SsiAccum: (number | null)[] = [];

  function processSatLineV2(line: string) {
    if (!header || v2SatIndex >= v2SatIds.length) return;
    const prn = normalizePrn(v2SatIds[v2SatIndex]!);
    const sys = prn[0]!;

    // Only count satellite on first line
    if (v2CurrentSatLine === 0) {
      trackSat(sys, prn);
      if (onSatObs) {
        v2ObsAccum = [];
        v2LliAccum = [];
        v2SsiAccum = [];
      }
    }

    const lineOffset = v2CurrentSatLine * 5;
    for (const { idx, band } of v2SnrBandInfo) {
      if (idx >= lineOffset && idx < lineOffset + 5) {
        const val = readObsValue(line, idx - lineOffset);
        if (val !== null && val > 0) pushSnr(sys, prn, val, band);
      }
    }
    if (onSatObs) {
      for (let i = 0; i < 5; i++) {
        if (lineOffset + i < (header.obsTypes['_v2'] ?? []).length) {
          v2ObsAccum.push(readObsValue(line, i));
          v2LliAccum.push(readObsLli(line, i));
          v2SsiAccum.push(readObsSsi(line, i));
        }
      }
    }
    v2CurrentSatLine++;
    if (v2CurrentSatLine >= v2LinesPerSat) {
      if (onSatObs && epochInfo) {
        const codes = header.obsTypes['_v2'] ?? [];
        onSatObs(
          epochInfo.time,
          prn,
          codes,
          v2ObsAccum,
          v2LliAccum,
          v2SsiAccum
        );
      }
      v2CurrentSatLine = 0;
      v2SatIndex++;
    }
  }

  /* -------- CRX satellite processing -------- */

  function processCrxSatDataLine(prn: string, line: string) {
    if (!header) return;
    const sys = prn[0]!;
    trackSat(sys, prn);

    const ntype =
      header.version >= 3
        ? (header.obsTypes[sys] ?? []).length
        : (header.obsTypes['_v2'] ?? []).length;
    if (ntype === 0) return;

    const { fields, flagStr } = parseCrxDataLine(line, ntype);

    // Flags (LLI, SSI per observation) are a diff against the satellite's
    // previous flags: ' ' unchanged, '&' cleared, anything else replaces.
    // A satellite missing from the previous epoch starts from blank flags.
    const t = epochInfo?.time ?? 0;
    if (t !== crxCurEpoch) {
      crxPrevEpoch = crxCurEpoch;
      crxCurEpoch = t;
    }
    let flags = crxFlagStates.get(prn);
    if (!flags || crxFlagSeen.get(prn) !== crxPrevEpoch)
      crxFlagStates.set(prn, (flags = []));
    crxFlagSeen.set(prn, t);
    for (let i = 0; i < flagStr.length; i++) {
      const c = flagStr[i]!;
      if (c === '&') flags[i] = ' ';
      else if (c !== ' ') flags[i] = c;
    }

    // Get or create diff state for this satellite (keyed by PRN)
    let states = crxDiffStates.get(prn);
    if (!states) {
      states = new Array(ntype).fill(null) as (DiffState | null)[];
      crxDiffStates.set(prn, states);
    }
    while (states.length < ntype) states.push(null);

    // Determine which obs indices are SNR (with band info) — only needed for EpochSummary
    const sBandMap = skipEpochs
      ? null
      : new Map(
          (header.version >= 3
            ? getSnrIndices(sys)
            : snrIndicesWithBandV2(header.obsTypes)
          ).map((s) => [s.idx, s.band])
        );

    const crxCodes =
      header.version >= 3
        ? (header.obsTypes[sys] ?? [])
        : (header.obsTypes['_v2'] ?? []);
    const crxScale =
      header.version >= 3 ? header.scaleFactors?.[sys] : undefined;

    // Decompress each observation, collecting values for callback
    const obsValues: (number | null)[] = onSatObs
      ? new Array(ntype).fill(null)
      : [];

    for (let j = 0; j < ntype; j++) {
      const field = fields[j]!;
      if (field.empty) {
        // CRINEX 1 treats a blank data field's flags as blank — and carries
        // that forward (crx2rnx.c); CRINEX 3 keeps flags independently.
        if (header.crxVersion === 1) flags[2 * j] = flags[2 * j + 1] = ' ';
        continue;
      }

      const { state, result } = crxDecompress(states[j] ?? null, field);
      states[j] = state;

      if (onSatObs) {
        const f = crxScale?.[crxCodes[j]!];
        obsValues[j] = f ? result / 1000 / f : result / 1000;
      }

      if (sBandMap) {
        const band = sBandMap.get(j);
        if (band !== undefined) {
          const snrFloat = result / 1000;
          if (snrFloat > 0) pushSnr(sys, prn, snrFloat, band);
        }
      }
    }

    if (onSatObs && epochInfo) {
      const codes =
        header.version >= 3
          ? (header.obsTypes[sys] ?? [])
          : (header.obsTypes['_v2'] ?? []);
      const lli: (number | null)[] = new Array(ntype);
      const ssi: (number | null)[] = new Array(ntype);
      for (let j = 0; j < ntype; j++) {
        const has = obsValues[j] !== null;
        lli[j] = has ? flagDigit(flags[2 * j]) : null;
        ssi[j] = has ? flagDigit(flags[2 * j + 1]) : null;
      }
      onSatObs(epochInfo.time, prn, codes, obsValues, lli, ssi);
    }
  }

  /* -------- CRX line processor -------- */

  // CRX 1.0 uses '&' as epoch initializer (converted to ' '), CRX 3.0 uses '>'
  let crxEpochTopFrom = '>';
  let crxEpochTopTo = '>';
  let crxEventSkipLines = 0; // lines remaining to skip for event records
  let crxClockState: DiffState | null = null;

  function processCrxLine(line: string) {
    if (!header) return;
    const isV3 = header.version >= 3;

    // One-time setup of epoch markers based on CRX version
    if (header.crxVersion < 3) {
      crxEpochTopFrom = '&';
      crxEpochTopTo = ' ';
    }

    // Event special records (flags 2-5) are copied verbatim by rnx2crx
    if (crxEventSkipLines > 0) {
      crxEventSkipLines--;
      eventLine(line);
      return;
    }

    if (crxPhase === 'epoch') {
      // Skip escape lines (CRX 3.0: lines starting with &)
      if (header.crxVersion >= 3 && line[0] === '&') return;

      // Detect initialized epoch (first char matches ep_top_from)
      const isInitEpoch = line[0] === crxEpochTopFrom;
      const isTextDiff = !isInitEpoch && crxPrevEpochLine.length > 0;

      if (isInitEpoch || isTextDiff) {
        let epochLine: string;
        if (isInitEpoch) {
          // Convert ep_top_from to ep_top_to (CRX 1.0: & → space)
          epochLine = crxEpochTopTo + line.substring(1);
          // Reset previous line to trigger full copy on repair
          crxPrevEpochLine = '';
        } else {
          // Apply text differencing
          epochLine = crxRepair(crxPrevEpochLine, line);
        }
        // crx2rnx chops trailing blanks off the repaired line (CHOP_BLANK)
        // before it becomes the reference for the next epoch's difference.
        epochLine = epochLine.replace(/ +$/, '');

        if (isV3) {
          if (epochLine[0] !== '>') return; // not a valid epoch

          const info = parseEpochLine3(epochLine);
          if (!info) {
            crxPrevEpochLine = epochLine;
            return;
          }

          // Handle event records (flag 2-5): skip embedded header lines
          if (info.flag >= 2) {
            crxPrevEpochLine = epochLine;
            crxEventSkipLines = startEvent(info); // # of special records
            return;
          }
          if (!isObsFlag(info.flag)) {
            crxPrevEpochLine = epochLine;
            return;
          }

          resetEpochAccum(info, false);

          // Satellite list from position 41+, exactly numSats of them:
          // when an epoch has fewer satellites than the last, the repaired
          // line keeps the old line's tail (crx2rnx keeps it too, as the
          // reference for the next difference) — it must not be read.
          crxSatList = [];
          for (let k = 0; k < info.numSats; k++) {
            crxSatList.push(
              normalizePrn(epochLine.substring(41 + 3 * k, 44 + 3 * k))
            );
          }

          crxSatIndex = 0;
          crxPrevEpochLine = epochLine;
          crxPhase = 'clock';
        } else {
          // CRX 1.0 / RINEX 2
          const info = parseEpochLine2(epochLine);
          if (!info) {
            crxPrevEpochLine = epochLine;
            return;
          }

          // Handle event records (flag 2-5): skip embedded header lines
          if (info.flag >= 2) {
            crxPrevEpochLine = epochLine;
            crxEventSkipLines = startEvent(info);
            return;
          }
          if (!isObsFlag(info.flag)) {
            crxPrevEpochLine = epochLine;
            return;
          }

          resetEpochAccum(info, false);
          // rnx2crx joins the continuation lines' ids onto the epoch line
          // (and moves the clock to its own line), so the list runs past
          // column 68. Only numSats ids: the repaired line may keep a stale
          // tail.
          crxSatList = [];
          for (let k = 0; k < info.numSats; k++)
            crxSatList.push(
              normalizePrn(epochLine.substring(32 + 3 * k, 35 + 3 * k))
            );
          crxSatIndex = 0;
          crxPrevEpochLine = epochLine;
          crxPhase = 'clock';
        }
      }
    } else if (crxPhase === 'clock') {
      // Receiver clock offset: Hatanaka-differenced like the data, in units
      // of the RINEX field's last digit (F15.12 → ps, RINEX 2 F12.9 → ns).
      // A blank line is an epoch without one. (RINEX 4.02 appends the
      // pico-second difference after a space; not decoded.)
      const tok = line.split(' ')[0] ?? '';
      if (epochInfo) {
        if (tok) {
          const init = tok[1] === '&';
          const v = parseInt(init ? tok.substring(2) : tok);
          const r = crxDecompress(crxClockState, {
            empty: false,
            init,
            arcOrder: init ? parseInt(tok[0]!) : -1,
            value: isNaN(v) ? 0 : v,
          });
          crxClockState = r.state;
          epochInfo.clockOffset = r.result / (isV3 ? 1e12 : 1e9);
        } else {
          crxClockState = null;
          epochInfo.clockOffset = null;
        }
        reportEpoch(epochInfo);
      }
      if (crxSatList.length > 0) {
        crxPhase = 'satdata';
      } else {
        crxPhase = 'epoch';
        finishEpoch();
      }
    } else if (crxPhase === 'satdata') {
      const prn = crxSatList[crxSatIndex]!;
      processCrxSatDataLine(prn, line);
      crxSatIndex++;
      if (crxSatIndex >= crxSatList.length) {
        crxPhase = 'epoch';
        finishEpoch();
      }
    }
  }

  /* -------- RINEX (non-CRX) line processor -------- */

  function processRinexLine(line: string) {
    if (!header) return;

    // Event special records (flags 2-5) and cycle-slip records (flag 6)
    if (eventSkipLines > 0) {
      eventSkipLines--;
      eventLine(line);
      return;
    }

    if (header.version >= 3) {
      if (satLinesRemaining > 0) {
        processSatLineV3(line);
        satLinesRemaining--;
        if (satLinesRemaining === 0) finishEpoch();
      } else if (line[0] === '>') {
        const info = parseEpochLine3(line);
        if (!info) return;
        if (info.flag >= 2) {
          eventSkipLines = startEvent(info);
          return;
        }
        if (isObsFlag(info.flag)) {
          resetEpochAccum(info);
          satLinesRemaining = info.numSats;
          if (info.numSats === 0) finishEpoch();
        }
      }
    } else {
      if (v2ContinuationSatsRemaining > 0) {
        v2SatIds.push(...v2SatList(line));
        v2ContinuationSatsRemaining--;
        if (v2ContinuationSatsRemaining === 0) {
          v2SatIndex = 0;
          v2CurrentSatLine = 0;
          satLinesRemaining = v2SatIds.length * v2LinesPerSat;
          if (satLinesRemaining === 0) finishEpoch();
        }
      } else if (satLinesRemaining > 0) {
        processSatLineV2(line);
        satLinesRemaining--;
        if (satLinesRemaining === 0) finishEpoch();
      } else {
        const info = parseEpochLine2(line);
        if (!info) return;
        if (info.flag >= 2 && info.flag <= 5) {
          eventSkipLines = startEvent(info);
          return;
        }
        if (info.flag === 6) {
          // Cycle-slip records: observation layout (sat list continuation
          // lines + data lines), skipped.
          const nObs = (header.obsTypes['_v2'] ?? []).length;
          eventSkipLines =
            Math.max(0, Math.ceil((info.numSats - 12) / 12)) +
            info.numSats * (Math.ceil(nObs / 5) || 1);
          return;
        }
        if (isObsFlag(info.flag)) {
          resetEpochAccum(info);
          v2SatIds = info.satIds ?? [];
          const v2ObsPerSat = (header.obsTypes['_v2'] ?? []).length;
          v2LinesPerSat = Math.ceil(v2ObsPerSat / 5) || 1;
          v2SnrBandInfo = snrIndicesWithBandV2(header.obsTypes);
          v2SatIndex = 0;
          v2CurrentSatLine = 0;
          const continuationLines = Math.max(
            0,
            Math.ceil((info.numSats - 12) / 12)
          );
          if (continuationLines > 0) {
            v2ContinuationSatsRemaining = continuationLines;
          } else {
            satLinesRemaining = v2SatIds.length * v2LinesPerSat;
            if (satLinesRemaining === 0) finishEpoch();
          }
        }
      }
    }
  }

  /* -------- main line dispatch -------- */

  function processLine(line: string) {
    if (!header) return;
    if (header.isCrx) {
      processCrxLine(line);
    } else {
      processRinexLine(line);
    }
  }

  /* ================================================================ */
  /*  Stream the file in chunks                                        */
  /* ================================================================ */

  function processChunkText(text: string, isLast: boolean) {
    buffer += text;
    const lastNl = buffer.lastIndexOf('\n');
    if (lastNl === -1 && !isLast) return;

    const chunk = isLast ? buffer : buffer.substring(0, lastNl);
    buffer = isLast ? '' : buffer.substring(lastNl + 1);
    const lines = chunk.split('\n');

    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line && !header) continue;
      if (!header) {
        headerLines.push(line);
        if (line.includes('END OF HEADER')) header = parseHeader(headerLines);
        continue;
      }
      processLine(line);
    }
  }

  // Detect compression by magic bytes
  let src: Blob = file;
  let magic = new Uint8Array(await src.slice(0, 3).arrayBuffer());
  // Unix compress (.Z, older archives): not streamable; decode whole (a
  // daily Hatanaka file is a few MB).
  if (isUnixCompress(magic)) {
    src = new Blob([
      uncompressLzw(
        new Uint8Array(await file.arrayBuffer())
      ) as Uint8Array<ArrayBuffer>,
    ]);
    magic = new Uint8Array(await src.slice(0, 3).arrayBuffer());
  }
  const isGz = magic[0] === 0x1f && magic[1] === 0x8b;

  if (isGz) {
    // Streaming gzip decompression via DecompressionStream
    let bytesRead = 0;
    const raw = src.stream();
    const decompressed = raw.pipeThrough(new DecompressionStream('gzip'));
    const reader = decompressed.getReader();

    for (;;) {
      if (signal?.aborted) {
        reader.cancel();
        throw new DOMException('Aborted', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      processChunkText(decoder.decode(value, { stream: true }), false);
      // Progress based on compressed bytes is not exact, estimate from decompressed
      onProgress?.(
        Math.min(99, Math.round((bytesRead / (src.size * 4)) * 100))
      );
      await yield_();
    }
    processChunkText(decoder.decode(), true);
  } else {
    // Plain file: slice in chunks for memory efficiency
    for (let offset = 0; offset < src.size; offset += CHUNK_SIZE) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const end = Math.min(offset + CHUNK_SIZE, src.size);
      const slice = src.slice(offset, end);
      const arrayBuf = await slice.arrayBuffer();
      processChunkText(
        decoder.decode(arrayBuf, { stream: end < src.size }),
        false
      );
      onProgress?.(Math.min(99, Math.round((end / src.size) * 100)));
      await yield_();
    }

    // Process remaining buffer
    if (buffer.length > 0) {
      processChunkText('', true);
    }
  }

  if (epochInfo && satLinesRemaining === 0 && crxPhase === 'epoch')
    finishEpoch();

  if (!header)
    throw new Error('No valid RINEX header found (missing END OF HEADER).');

  onProgress?.(100);
  return {
    header,
    epochs,
    stats: computeStats(header, epochs, satellitesSeen),
  };
}

/* ================================================================== */
/*  Stats                                                              */
/* ================================================================== */

function computeStats(
  header: RinexHeader,
  epochs: EpochSummary[],
  satellitesSeen: Record<string, Set<string>>
): RinexStats {
  const n = epochs.length;
  const startTime = n > 0 ? new Date(epochs[0]!.time) : header.timeOfFirstObs;
  const endTime = n > 0 ? new Date(epochs[n - 1]!.time) : header.timeOfLastObs;

  let duration: number | null = null;
  if (startTime && endTime)
    duration = (endTime.getTime() - startTime.getTime()) / 1000;

  let interval = header.interval;
  if (interval === null && n >= 2)
    interval = (epochs[1]!.time - epochs[0]!.time) / 1000;

  const uniqueSatsPerSystem: Record<string, number> = {};
  let totalUnique = 0;
  const systems: string[] = [];
  for (const [sys, prns] of Object.entries(satellitesSeen)) {
    uniqueSatsPerSystem[sys] = prns.size;
    totalUnique += prns.size;
    systems.push(sys);
  }
  systems.sort(systemCmp);

  const meanSatellites =
    n > 0 ? epochs.reduce((s, e) => s + e.totalSats, 0) / n : 0;

  const snrEpochs = epochs.filter((e) => e.meanSnr !== null);
  const meanSnr =
    snrEpochs.length > 0
      ? snrEpochs.reduce((s, e) => s + e.meanSnr!, 0) / snrEpochs.length
      : null;

  return {
    totalEpochs: n,
    validEpochs: n,
    duration,
    startTime,
    endTime,
    interval,
    uniqueSatellites: totalUnique,
    uniqueSatsPerSystem,
    systems,
    meanSatellites,
    meanSnr,
  };
}
