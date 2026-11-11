/**
 * Receiver hardware health, normalised across manufacturers: what the
 * receiver itself reports about its CPU, temperature, antenna feed, RF
 * front-ends (AGC, noise, jamming indicators) and detected interference.
 *
 * Sources: Septentrio SBF ReceiverStatus (4014) + RFStatus (4092); u-blox
 * UBX-MON-HW (0x0A 0x09), MON-RF (0x0A 0x38), MON-SYS (0x0A 0x39); NovAtel
 * HWMONITOR (963), RXSTATUS (93), ITDETECTSTATUS (2065).
 *
 * Each message decodes to a partial {@link ReceiverHealthRecord} (only the
 * fields that message carries); {@link summarizeReceiverHealth} folds a
 * stream of them into the latest complete picture. Only conditions the
 * receiver itself flags become {@link HealthFlag}s — no thresholds are
 * invented here.
 */

/** Antenna feed state as the receiver senses it. */
export type AntennaState = 'ok' | 'open' | 'short' | 'off' | 'unknown';

/** Jamming / interference state of one RF band. */
export type JammingState =
  'none' | 'warning' | 'critical' | 'mitigated' | 'unknown';

export interface AntennaHealth {
  /** 0 = main/primary antenna, 1 = secondary/aux. */
  antenna: number;
  state: AntennaState;
  /** Antenna supply voltage (V), when reported. */
  voltageV: number | null;
  /** Antenna current draw (mA), when reported. */
  currentMa: number | null;
}

export interface RfBandHealth {
  /** Human band label, e.g. 'GPS L1/E1', 'L2', 'L1 (u-blox block 0)'. */
  band: string;
  /** 0 = main/primary antenna, 1 = secondary/aux. */
  antenna: number;
  /** AGC gain (dB) — Septentrio. */
  agcGainDb: number | null;
  /** AGC level as % of full scale — u-blox (agcCnt / 8191). */
  agcPct: number | null;
  /** Front-end noise level (u-blox noisePerMS, unitless). */
  noisePerMs: number | null;
  /** CW jamming indicator 0–255 — u-blox (0 = none, 255 = strong). */
  jamIndicator: number | null;
  /** Fraction of samples blanked by pulse blanking (%) — Septentrio. */
  blankingPct: number | null;
  jamming: JammingState;
}

/** One interferer the receiver has detected (and possibly mitigated). */
export interface InterferenceReport {
  /** RF path / band label. */
  band: string;
  antenna: number;
  /** Centre frequency (MHz), when reported. */
  centerMHz: number | null;
  /** Bandwidth (MHz), when reported. */
  bandwidthMHz: number | null;
  /** Estimated interferer power (dBm) — NovAtel spectrum analysis. */
  powerDbm: number | null;
  /** 'detected' = present, not removed; 'mitigated' = the receiver's
   *  filters are removing it; 'suppressed' = a configured notch covers it. */
  state: 'detected' | 'mitigated' | 'suppressed';
  /** How it was found: spectrum vs statistical analysis (NovAtel). */
  method: 'spectrum' | 'statistics' | null;
}

export type HealthLevel = 'ok' | 'warning' | 'error';

/** A condition the receiver itself reports. */
export interface HealthFlag {
  level: 'warning' | 'error';
  /** Stable machine code, e.g. 'temperature', 'antenna-short', 'jamming'. */
  code: string;
  /** Plain-language description. */
  text: string;
}

/** What one health message carries. Absent fields = not in this message. */
export interface ReceiverHealthRecord {
  /** GPS-scale epoch (ms); null for u-blox MON messages (no time tag). */
  timeMs: number | null;
  /** Message name, e.g. 'ReceiverStatus', 'MON-RF', 'HWMONITOR'. */
  source: string;
  cpuLoadPct?: number | null;
  temperatureC?: number | null;
  uptimeS?: number | null;
  antennas?: AntennaHealth[];
  bands?: RfBandHealth[];
  /** Full current list from this source (replaces, not appends). */
  interference?: InterferenceReport[];
  /** Spoofing detected by the receiver (SBF RFStatus, NovAtel RXSTATUS). */
  spoofing?: boolean | null;
  /** Full current flag list from this source (replaces, not appends). */
  flags?: HealthFlag[];
}

/** Latest-known receiver health, folded from many records. */
export interface ReceiverHealth {
  /** Time of the newest time-tagged record folded in (ms), if any. */
  timeMs: number | null;
  cpuLoadPct: number | null;
  temperatureC: number | null;
  uptimeS: number | null;
  antennas: AntennaHealth[];
  bands: RfBandHealth[];
  interference: InterferenceReport[];
  spoofing: boolean | null;
  flags: HealthFlag[];
  /** Worst flag level ('ok' when none). */
  level: HealthLevel;
  /** Which messages contributed, with counts. */
  sources: Record<string, number>;
}

const bandKey = (b: { band: string; antenna: number }) =>
  `${b.antenna}:${b.band}`;

/**
 * Fold records (in stream order) into the latest health picture: scalar
 * fields take the newest non-null value; antennas and bands merge by key
 * (newest wins per field set); interference and flags are replaced per
 * source, so a condition that clears in a later message disappears.
 */
export function summarizeReceiverHealth(
  records: readonly ReceiverHealthRecord[]
): ReceiverHealth {
  let timeMs: number | null = null;
  let cpuLoadPct: number | null = null;
  let temperatureC: number | null = null;
  let uptimeS: number | null = null;
  let spoofing: boolean | null = null;
  const antennas = new Map<number, AntennaHealth>();
  const bands = new Map<string, RfBandHealth>();
  const interferenceBySource = new Map<string, InterferenceReport[]>();
  const flagsBySource = new Map<string, HealthFlag[]>();
  const sources: Record<string, number> = {};

  for (const r of records) {
    sources[r.source] = (sources[r.source] ?? 0) + 1;
    if (r.timeMs != null && (timeMs == null || r.timeMs >= timeMs))
      timeMs = r.timeMs;
    if (r.cpuLoadPct != null) cpuLoadPct = r.cpuLoadPct;
    if (r.temperatureC != null) temperatureC = r.temperatureC;
    if (r.uptimeS != null) uptimeS = r.uptimeS;
    if (r.spoofing != null) spoofing = r.spoofing;
    for (const a of r.antennas ?? []) {
      const prev = antennas.get(a.antenna);
      antennas.set(a.antenna, {
        antenna: a.antenna,
        state: a.state !== 'unknown' ? a.state : (prev?.state ?? 'unknown'),
        voltageV: a.voltageV ?? prev?.voltageV ?? null,
        currentMa: a.currentMa ?? prev?.currentMa ?? null,
      });
    }
    for (const b of r.bands ?? []) bands.set(bandKey(b), b);
    if (r.interference) interferenceBySource.set(r.source, r.interference);
    if (r.flags) flagsBySource.set(r.source, r.flags);
  }

  const flags = [...flagsBySource.values()].flat();
  const level: HealthLevel = flags.some((f) => f.level === 'error')
    ? 'error'
    : flags.length > 0
      ? 'warning'
      : 'ok';
  return {
    timeMs,
    cpuLoadPct,
    temperatureC,
    uptimeS,
    antennas: [...antennas.values()].sort((a, b) => a.antenna - b.antenna),
    bands: [...bands.values()],
    interference: [...interferenceBySource.values()].flat(),
    spoofing,
    flags,
    level,
    sources,
  };
}
