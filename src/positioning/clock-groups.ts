/**
 * Receiver-clock groups for PPP (`PppOptions.clockGroup`): which satellites
 * share a receiver clock, i.e. which have no inter-system bias between
 * them. The default is one clock per constellation. BeiDou is not one
 * signal family in practice: BeiDou-2 and BeiDou-3 satellites, and the two
 * BeiDou-3 manufacturers (CAST and SECM), show inter-satellite-type code
 * and phase biases at the decimetre/centimetre level in multi-GNSS
 * analyses (e.g. CODE's and Wuhan's MGEX processing). Splitting the clock
 * lets each group carry its own bias; it costs one parameter per epoch.
 *
 * The groups come from the satellites' block names in an ANTEX file
 * (igs20.atx: "BEIDOU-2M", "BEIDOU-3M-CAST", "BEIDOU-3M-SECM", …).
 */
import type { AntennaEntry } from '../antex';

/**
 * 'bds2-bds3': BeiDou-2 and BeiDou-3 on separate clocks ("C2", "C3").
 * 'bds-maker': BeiDou-2, BeiDou-3 CAST and BeiDou-3 SECM ("C2", "C3-CAST",
 * "C3-SECM"). Other constellations keep one clock each.
 */
export type ClockGroupMode = 'bds2-bds3' | 'bds-maker';

const antexMs = (s: string): number | null => {
  const p = s
    .trim()
    .split(/[\s:-]+/)
    .map(Number);
  if (p.length < 3 || p.some((v) => Number.isNaN(v))) return null;
  return Date.UTC(p[0]!, (p[1]! || 1) - 1, p[2]! || 1, p[3] ?? 0, p[4] ?? 0);
};

/** Each satellite PRN's block name (ANTEX TYPE) valid at `dateMs`. */
export function satelliteBlocks(
  entries: readonly AntennaEntry[],
  dateMs: number
): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) {
    if (!e.isSatellite || !e.serialNo.trim()) continue;
    const from = antexMs(e.validFrom) ?? -Infinity;
    const until = antexMs(e.validUntil) ?? Infinity;
    if (dateMs < from || dateMs > until) continue;
    out.set(e.serialNo.trim(), e.type.trim());
  }
  return out;
}

/** A `PppOptions.clockGroup` function from satellite block names. */
export function clockGroupFromBlocks(
  blocks: ReadonlyMap<string, string>,
  mode: ClockGroupMode
): (prn: string) => string {
  const cache = new Map<string, string>();
  return (prn) => {
    let g = cache.get(prn);
    if (g !== undefined) return g;
    g = prn[0]!;
    if (g === 'C') {
      const block = blocks.get(prn) ?? '';
      // Unknown block (newer than the ANTEX): by PRN, BeiDou-3 from C19.
      const bds3 = block ? /BEIDOU-3/.test(block) : Number(prn.slice(1)) >= 19;
      if (!bds3) g = 'C2';
      else if (mode === 'bds2-bds3') g = 'C3';
      else g = /SECM/.test(block) ? 'C3-SECM' : 'C3-CAST';
    }
    cache.set(prn, g);
    return g;
  };
}
