/**
 * Core GNSS constants: constellation metadata, signal frequencies,
 * GLONASS FDMA helpers, and processing parameters.
 */

/* ── System names ─────────────────────────────────────────────── */

export const SYSTEM_NAMES: Record<string, string> = {
  G: 'GPS',
  R: 'GLONASS',
  E: 'Galileo',
  C: 'BeiDou',
  J: 'QZSS',
  I: 'NavIC',
  S: 'SBAS',
};

/** Short human-readable labels for each constellation identifier. */
export const SYS_SHORT: Record<string, string> = {
  G: 'GPS',
  R: 'GLO',
  E: 'GAL',
  C: 'BDS',
  J: 'QZS',
  I: 'NIC',
  S: 'SBS',
};

/* ── Physical constants ───────────────────────────────────────── */

/** Speed of light in m/s. */
export const C_LIGHT = 299792458;

/* ── Signal frequencies ───────────────────────────────────────── */

/** Carrier frequencies (Hz) per system letter, per RINEX band digit. GLONASS FDMA bands 1/2 use gloFreq(). */
export const FREQ: Record<string, Record<string, number>> = {
  G: { '1': 1575.42e6, '2': 1227.6e6, '5': 1176.45e6 },
  // R bands 4/6 are the CDMA L1OC/L2OC center frequencies
  R: { '3': 1202.025e6, '4': 1600.995e6, '6': 1248.06e6 },
  E: {
    '1': 1575.42e6,
    '5': 1176.45e6,
    '6': 1278.75e6,
    '7': 1207.14e6,
    '8': 1191.795e6,
  },
  C: {
    '1': 1575.42e6,
    '2': 1561.098e6,
    '5': 1176.45e6,
    '6': 1268.52e6,
    '7': 1207.14e6,
  },
  J: { '1': 1575.42e6, '2': 1227.6e6, '5': 1176.45e6, '6': 1278.75e6 },
  I: { '5': 1176.45e6, '9': 2492.028e6 },
  S: { '1': 1575.42e6, '5': 1176.45e6 },
};

export const BAND_LABELS: Record<string, Record<string, string>> = {
  G: { '1': 'L1', '2': 'L2', '5': 'L5' },
  R: { '1': 'G1', '2': 'G2', '3': 'G3' },
  E: { '1': 'E1', '5': 'E5a', '6': 'E6', '7': 'E5b', '8': 'E5' },
  C: { '1': 'B1C', '2': 'B1I', '5': 'B2a', '6': 'B3I', '7': 'B2I' },
  J: { '1': 'L1', '2': 'L2', '5': 'L5', '6': 'L6' },
  I: { '5': 'L5', '9': 'S' },
  S: { '1': 'L1', '5': 'L5' },
};

/** Preferred dual-frequency pairs [primary, secondary] per system. */
export const DUAL_FREQ_PAIRS: Record<string, [string, string][]> = {
  G: [
    ['1', '2'],
    ['1', '5'],
  ],
  R: [
    ['1', '2'],
    ['1', '3'],
  ],
  E: [
    ['1', '5'],
    ['1', '7'],
    ['1', '6'],
  ],
  C: [
    ['2', '7'],
    ['2', '6'],
    ['1', '5'],
  ],
  J: [
    ['1', '2'],
    ['1', '5'],
  ],
  I: [['5', '9']],
  S: [['1', '5']],
};

/* ── GLONASS FDMA ─────────────────────────────────────────────── */

export const GLO_F1_BASE = 1602.0e6;
export const GLO_F1_STEP = 0.5625e6;
export const GLO_F2_BASE = 1246.0e6;
export const GLO_F2_STEP = 0.4375e6;
export const GLO_F3 = 1202.025e6; // CDMA, fixed

/** Fallback channel assignments when RINEX header lacks GLONASS SLOT / FRQ #. */
export const GLO_CHANNEL_FALLBACK: Record<string, number> = {
  R01: 1,
  R02: -4,
  R03: 5,
  R04: 6,
  R05: 1,
  R06: -4,
  R07: 5,
  R08: 6,
  R09: -2,
  R10: -7,
  R11: 0,
  R12: -1,
  R13: -2,
  R14: -7,
  R15: 0,
  R16: -1,
  R17: 4,
  R18: -3,
  R19: 3,
  R20: 2,
  R21: 4,
  R22: -3,
  R23: 3,
  R24: 2,
};

/**
 * Build a PRN → channel-k map from parsed RINEX header glonassSlots.
 * Falls back to hardcoded ICD assignments if the header record is absent.
 */
export function buildGloChannelMap(
  slots: Record<number, number>
): Record<string, number> {
  if (Object.keys(slots).length === 0) return { ...GLO_CHANNEL_FALLBACK };
  const map: Record<string, number> = {};
  for (const [slot, k] of Object.entries(slots)) {
    map[`R${String(slot).padStart(2, '0')}`] = k;
  }
  return map;
}

/** Get GLONASS FDMA frequency for a given PRN and band. */
export function gloFreq(
  gloChannels: Record<string, number>,
  prn: string,
  band: string
): number | undefined {
  const k = gloChannels[prn];
  if (k === undefined) return undefined;
  if (band === '1') return GLO_F1_BASE + k * GLO_F1_STEP;
  if (band === '2') return GLO_F2_BASE + k * GLO_F2_STEP;
  if (band === '3') return GLO_F3;
  return undefined;
}

/** Resolve frequency for a PRN + band, handling GLONASS FDMA. */
export function getFreq(
  gloChannels: Record<string, number>,
  prn: string,
  band: string
): number | undefined {
  const sys = prn[0]!;
  if (sys === 'R') return gloFreq(gloChannels, prn, band);
  return FREQ[sys]?.[band];
}

/* ── BeiDou constellation ─────────────────────────────────────── */

export interface BdsSatellite {
  prn: string;
  phase: 'BDS-2' | 'BDS-3';
  orbit: 'GEO' | 'IGSO' | 'MEO';
}

export const BDS_SATELLITES: BdsSatellite[] = [
  { prn: 'C01', phase: 'BDS-2', orbit: 'GEO' },
  { prn: 'C02', phase: 'BDS-2', orbit: 'GEO' },
  { prn: 'C03', phase: 'BDS-2', orbit: 'GEO' },
  { prn: 'C04', phase: 'BDS-2', orbit: 'GEO' },
  { prn: 'C05', phase: 'BDS-2', orbit: 'GEO' },
  { prn: 'C06', phase: 'BDS-2', orbit: 'IGSO' },
  { prn: 'C07', phase: 'BDS-2', orbit: 'IGSO' },
  { prn: 'C08', phase: 'BDS-2', orbit: 'IGSO' },
  { prn: 'C09', phase: 'BDS-2', orbit: 'IGSO' },
  { prn: 'C10', phase: 'BDS-2', orbit: 'IGSO' },
  { prn: 'C13', phase: 'BDS-2', orbit: 'IGSO' },
  { prn: 'C16', phase: 'BDS-2', orbit: 'IGSO' },
  { prn: 'C11', phase: 'BDS-2', orbit: 'MEO' },
  { prn: 'C12', phase: 'BDS-2', orbit: 'MEO' },
  { prn: 'C14', phase: 'BDS-2', orbit: 'MEO' },
  { prn: 'C19', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C20', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C21', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C22', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C23', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C24', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C25', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C26', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C27', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C28', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C29', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C30', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C32', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C33', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C34', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C35', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C36', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C37', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C41', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C42', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C43', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C44', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C45', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C46', phase: 'BDS-3', orbit: 'MEO' },
  { prn: 'C38', phase: 'BDS-3', orbit: 'IGSO' },
  { prn: 'C39', phase: 'BDS-3', orbit: 'IGSO' },
  { prn: 'C40', phase: 'BDS-3', orbit: 'IGSO' },
  { prn: 'C59', phase: 'BDS-3', orbit: 'GEO' },
  { prn: 'C60', phase: 'BDS-3', orbit: 'GEO' },
  { prn: 'C61', phase: 'BDS-3', orbit: 'GEO' },
];

/* ── Observation indexing ──────────────────────────────────────── */

import type { RinexHeader } from '../rinex/parser';

/** Callback type for cycle slip notifications. */
export type OnSlipDetected = (
  time: number,
  prn: string,
  bands: Set<string>
) => void;

/**
 * Tracking attribute priority for observation code selection.
 * Higher is better. X (combined) and C (C/A) preferred over W (encrypted).
 */
const ATTR_PRIORITY: Record<string, number> = {
  X: 8,
  C: 7,
  S: 6,
  L: 6,
  Q: 6,
  I: 5,
  B: 5,
  D: 4,
  Z: 3,
  P: 2,
  W: 1,
};

function attrRank(code: string): number {
  return ATTR_PRIORITY[code[2] ?? ''] ?? 3;
}

/**
 * Build observation indices per system per band, preferring better tracking attributes.
 * @param header Parsed RINEX header containing observation type definitions
 * @returns Map of system letter to Map of band digit to {L, C} column indices
 */
export function buildObsIndices(
  header: RinexHeader
): Map<string, Map<string, { L: number; C: number | null }>> {
  const result = new Map<
    string,
    Map<string, { L: number; C: number | null }>
  >();

  for (const [sys, codes] of Object.entries(header.obsTypes)) {
    if (sys === '_v2') continue;
    const lIdx = new Map<string, number>();
    const lRank = new Map<string, number>();
    const cIdx = new Map<string, number>();
    const cRank = new Map<string, number>();

    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      const type = code[0];
      const band = code[1];
      if (!band) continue;
      const rank = attrRank(code);
      if (type === 'L' && rank > (lRank.get(band) ?? -1)) {
        lIdx.set(band, i);
        lRank.set(band, rank);
      }
      if ((type === 'C' || type === 'P') && rank > (cRank.get(band) ?? -1)) {
        cIdx.set(band, i);
        cRank.set(band, rank);
      }
    }

    const bandMap = new Map<string, { L: number; C: number | null }>();
    for (const [band, li] of lIdx) {
      bandMap.set(band, { L: li, C: cIdx.get(band) ?? null });
    }
    if (bandMap.size > 0) result.set(sys, bandMap);
  }

  // RINEX v2
  const v2codes = header.obsTypes['_v2'];
  if (v2codes) {
    const lIdx = new Map<string, number>();
    const cIdx = new Map<string, number>();
    for (let i = 0; i < v2codes.length; i++) {
      const code = v2codes[i]!;
      const type = code[0];
      const band = code[1];
      if (!band) continue;
      if (type === 'L' && !lIdx.has(band)) lIdx.set(band, i);
      if ((type === 'C' || type === 'P') && !cIdx.has(band)) cIdx.set(band, i);
    }
    const bandMap = new Map<string, { L: number; C: number | null }>();
    for (const [band, li] of lIdx) {
      bandMap.set(band, { L: li, C: cIdx.get(band) ?? null });
    }
    if (bandMap.size > 0) result.set('_v2', bandMap);
  }

  return result;
}

/* ── Processing parameters ────────────────────────────────────── */

export const ARC_GAP_FACTOR = 5;
export const DEFAULT_ELEV_MASK_DEG = 5;

/* ── Formatting helpers ───────────────────────────────────────── */

/** Format a Date as HH:MM:SS UTC string. */
export function formatUTCTime(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
}
