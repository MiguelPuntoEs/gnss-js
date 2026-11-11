/**
 * Loss-of-lock indicator (LLI) statistics for observation QC, as Leica
 * SpiderQC and teqc report them.
 *
 * RINEX LLI is a bit field, and only bit 0 means the receiver lost lock
 * since the previous epoch (a possible cycle slip). Bit 1 flags a
 * half-cycle ambiguity; bit 2 means "under anti-spoofing" (RINEX 2) or
 * BOC tracking of an MBOC signal (RINEX 3) and is routine — counting it as
 * lost lock would flag every encrypted GPS L2 and every Galileo E1
 * observation.
 */
import { BAND_LABELS, SYSTEM_NAMES } from '../constants/gnss';

export interface LockBandStats {
  system: string;
  band: string;
  /** e.g. "L1 (GPS)". */
  label: string;
  /** Carrier-phase observations seen. */
  phaseObs: number;
  /** With LLI bit 0: lock lost since the previous epoch. */
  lossOfLock: number;
  /** With LLI bit 1: half-cycle ambiguity. */
  halfCycle: number;
}

export interface LossOfLockResult {
  bands: LockBandStats[];
  /** Per satellite: phase observations with lock lost (bit 0). */
  perSatellite: Record<string, number>;
  /** False when the input carried no LLI at all (not every source does). */
  available: boolean;
}

const ORDER = 'GRECJIS';
const rank = (s: string) =>
  ORDER.includes(s) ? ORDER.indexOf(s) : ORDER.length;

export class LossOfLockAccumulator {
  private bands = new Map<string, LockBandStats>();
  private perSat: Record<string, number> = {};
  private any = false;

  onObservation(
    prn: string,
    codes: string[],
    values: (number | null)[],
    lli: (number | null)[] | undefined
  ) {
    if (lli) this.any = true;
    const sys = prn[0]!;
    // Once per band and epoch: a band with several tracking codes (L2L and
    // L2W) is one carrier; lock is lost if any of its codes says so.
    const perBand = new Map<string, number>();
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code[0] !== 'L') continue;
      const v = values[i];
      if (v == null || v === 0) continue;
      const band = code[1]!;
      perBand.set(band, (perBand.get(band) ?? 0) | (lli?.[i] ?? 0));
    }
    for (const [band, f] of perBand) {
      const key = `${sys}:${band}`;
      let b = this.bands.get(key);
      if (!b)
        this.bands.set(
          key,
          (b = {
            system: sys,
            band,
            label: `${BAND_LABELS[sys]?.[band] ?? `L${band}`} (${SYSTEM_NAMES[sys] ?? sys})`,
            phaseObs: 0,
            lossOfLock: 0,
            halfCycle: 0,
          })
        );
      b.phaseObs++;
      if (f & 1) {
        b.lossOfLock++;
        this.perSat[prn] = (this.perSat[prn] ?? 0) + 1;
      }
      if (f & 2) b.halfCycle++;
    }
  }

  finalize(): LossOfLockResult {
    return {
      bands: [...this.bands.values()].sort(
        (a, b) =>
          rank(a.system) - rank(b.system) || a.band.localeCompare(b.band)
      ),
      perSatellite: this.perSat,
      available: this.any,
    };
  }
}
