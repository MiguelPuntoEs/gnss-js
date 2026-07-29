/**
 * Per-frequency receiver antenna corrections for RTK.
 *
 * RTK forms double differences per signal (L1, L2, … separately), so — unlike
 * PPP, which works on the ionosphere-free combination — it needs the antenna
 * phase-centre offset (PCO) and no-azimuth phase-centre variation (PCV) for
 * each frequency in isolation, not IF-combined. This module is therefore a
 * deliberately separate model from {@link buildPppAntenna}.
 *
 * The satellite antenna cancels in the base↔rover double difference, so only
 * the *receiver* antennas matter — and only when base and rover differ (same
 * antenna type + orientation cancels too). The correction is the same range
 * quantity the PPP receiver term applies (PCO projected on the line of sight +
 * elevation PCV + marker→ARP delta), added to the modelled geometric range.
 */

import type { AntexFile, AntennaEntry, FrequencyData } from '../antex/index';
import { enuToEcef, interpPcv, vdot, type AntennaOffset } from './ppp-antenna';

/** A single-frequency receiver antenna offset (PCO in ENU metres + no-azimuth
 *  PCV over zenith). Shares {@link AntennaOffset}'s shape so {@link interpPcv}
 *  applies directly. */
export type RtkAntennaOffset = AntennaOffset;

export interface RtkAntennaModel {
  /** Receiver PCO + PCV for one ANTEX frequency code (e.g. 'G01', 'E05'), or
   *  null when the antenna type or that frequency isn't calibrated. */
  rcvOffset(antType: string, freq: string): RtkAntennaOffset | null;
}

function freqOf(entry: AntennaEntry, code: string): FrequencyData | undefined {
  return entry.frequencies.find((f) => f.frequency === code);
}

/**
 * Build a per-frequency receiver antenna model from an ANTEX file (e.g.
 * igs20.atx). Receiver antennas are keyed by their 20-char type (RINEX header
 * "ANT # / TYPE"); satellite entries are ignored (they cancel in the DD).
 */
export function buildRtkAntenna(antex: AntexFile): RtkAntennaModel {
  const rcvs = new Map<string, AntennaEntry>();
  for (const a of antex.antennas) {
    if (!a.isSatellite && !rcvs.has(a.type)) rcvs.set(a.type, a);
  }
  const mm = 1e-3;
  return {
    rcvOffset(antType, freq) {
      const entry = rcvs.get(antType);
      if (!entry) return null;
      const f = freqOf(entry, freq);
      if (!f) return null;
      return {
        pco: [f.pcoN * mm, f.pcoE * mm, f.pcoU * mm],
        pcvZen1Deg: entry.zen1,
        pcvDzenDeg: entry.dzen,
        pcvNoazi: f.pcvNoazi.map((v) => v * mm),
      };
    },
  };
}

/**
 * Additive range correction (m) for one receiver observing one satellite,
 * matching the PPP receiver-antenna convention: it is *added to the modelled
 * geometric range* (marker→satellite). `losRcvToSat` is the unit line of sight
 * from the receiver to the satellite; `antDeltaEnu` is the marker→ARP offset
 * in local ENU (m).
 */
export function rcvAntennaRangeM(
  off: RtkAntennaOffset,
  losRcvToSat: [number, number, number],
  latRad: number,
  lonRad: number,
  elRad: number,
  antDeltaEnu: readonly [number, number, number] = [0, 0, 0]
): number {
  const total: [number, number, number] = [
    off.pco[0] + antDeltaEnu[0],
    off.pco[1] + antDeltaEnu[1],
    off.pco[2] + antDeltaEnu[2],
  ];
  const ecef = enuToEcef(total, latRad, lonRad);
  // APC = marker + offset ⇒ the marker→satellite range loses e·offset.
  let m = -vdot(losRcvToSat, ecef);
  const zenithDeg = 90 - (elRad * 180) / Math.PI;
  m += interpPcv(off, zenithDeg);
  return m;
}

/** Per-receiver antenna configuration for {@link RtkFloatOptions.antenna}. */
export interface RtkReceiverAntenna {
  /** RINEX antenna type (20-char "ANT # / TYPE"), keyed into the model. */
  type: string;
  /** Marker→ARP offset in local ENU (m). RINEX "ANTENNA: DELTA H/E/N" is
   *  [Up, East, North] → pass as [E, N, U]. Default [0,0,0]. */
  deltaEnu?: [number, number, number];
}

/** RTK antenna configuration: a per-frequency model + the base/rover antennas.
 *  Corrections are applied only for a receiver whose antenna is supplied and
 *  found in the model; the satellite antenna is never needed (cancels in the
 *  double difference). */
export interface RtkAntennaConfig {
  model: RtkAntennaModel;
  base?: RtkReceiverAntenna;
  rover?: RtkReceiverAntenna;
}

/** ANTEX frequency code for an RTK signal group ("G1C" → "G01"): system letter
 *  + '0' + band digit. */
export function antexFreqOfGroup(group: string): string {
  return `${group[0]}0${group[1]}`;
}
