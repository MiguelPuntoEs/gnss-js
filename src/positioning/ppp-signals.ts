/**
 * Multi-signal PPP observations: every usable signal of a satellite at an
 * epoch (band, tracking attribute, frequency, code, carrier, loss-of-lock,
 * signal strength), the input of the uncombined engine
 * ({@link solvePppUncombined}). {@link selectPppSignals} picks one tracking
 * mode per frequency band from a RINEX-3 observation record;
 * {@link toDualFrequencyObs} reduces a record to the dual-frequency
 * observation the ionosphere-free engine ({@link solvePpp}) takes.
 */

import { FREQ, gloFreq } from '../constants/gnss';
import type { PppSatObs } from './ppp';

/** One tracked signal (one frequency band) of a satellite at an epoch. */
export interface PppSignal {
  /** RINEX band digit ('1', '2', '5' …). */
  band: string;
  /** Carrier frequency (Hz). */
  freq: number;
  /** ANTEX frequency code of the band ('G01', 'E05' …). */
  antexBand: string;
  /** RINEX-3 tracking code of the pseudorange ('1W', '5Q' …), for code
   *  biases and receiver code-bias grouping. */
  code: string;
  /** RINEX-3 tracking code of the carrier, when it differs from `code`
   *  (GPS: C1W pseudorange with the L1C carrier). Default `code`. */
  phaseCode?: string;
  /** Pseudorange (m); 0 / absent: not tracked. */
  pr: number;
  /** Carrier phase (cycles); 0 / absent: not tracked. */
  cp: number;
  /** Loss of lock on this carrier since the previous epoch (RINEX LLI
   *  bit 0, or a receiver's lock-time reset). */
  lli?: boolean;
  /** Carrier-to-noise density (dB-Hz), when known. */
  snr?: number;
}

/** One satellite's signals at an epoch. */
export interface PppMultiSatObs {
  prn: string;
  /** In order of preference: the first two are the satellite's primary
   *  pair (the one an ionosphere-free solution would use). */
  signals: PppSignal[];
}

export interface PppMultiEpoch {
  /** GPS-scale epoch time (ms). */
  timeMs: number;
  obs: PppMultiSatObs[];
}

/**
 * Band order and tracking attributes per constellation, preferred first.
 * The first two bands are the clock-reference pair of the IGS products
 * (GPS L1/L2, GLONASS G1/G2, Galileo E1/E5a, BeiDou B1I/B3I, QZSS L1/L2);
 * the pseudorange and the carrier of a band are picked independently.
 */
export const PPP_SIGNAL_PRIORITY: Record<
  string,
  { band: string; code: string; phase: string }[]
> = {
  G: [
    { band: '1', code: 'WC', phase: 'CW' },
    { band: '2', code: 'WLXS', phase: 'WLXS' },
    { band: '5', code: 'QXI', phase: 'QXI' },
  ],
  R: [
    { band: '1', code: 'PC', phase: 'PC' },
    { band: '2', code: 'PC', phase: 'PC' },
  ],
  E: [
    { band: '1', code: 'CXB', phase: 'CXB' },
    { band: '5', code: 'QXI', phase: 'QXI' },
    { band: '7', code: 'QXI', phase: 'QXI' },
    { band: '8', code: 'QXI', phase: 'QXI' },
    { band: '6', code: 'CXB', phase: 'CXB' },
  ],
  C: [
    { band: '2', code: 'IX', phase: 'IX' },
    { band: '6', code: 'IX', phase: 'IX' },
    { band: '1', code: 'PXD', phase: 'PXD' },
    { band: '5', code: 'PXD', phase: 'PXD' },
    { band: '7', code: 'IX', phase: 'IX' },
  ],
  J: [
    { band: '1', code: 'CX', phase: 'CX' },
    { band: '2', code: 'LXS', phase: 'LXS' },
    { band: '5', code: 'QXI', phase: 'QXI' },
  ],
};

export interface SelectPppSignalsOptions {
  /** GLONASS frequency channels by PRN (FDMA); without them GLONASS is
   *  skipped. */
  gloChannels?: Readonly<Record<string, number>>;
  /** Bands to use per constellation in this order (overrides the default
   *  order of {@link PPP_SIGNAL_PRIORITY}), e.g. `{ C: '15' }` for BeiDou
   *  B1C/B2a only, `{ G: '125' }`. Bands not listed are left out. */
  bands?: Partial<Record<string, string>>;
  /** Loss-of-lock indicator per value (RINEX LLI digit; bit 0 = slip). */
  lli?: readonly (number | null)[];
  /** Signal strength per value (dB-Hz, the S observables are looked up
   *  by code when this is absent). */
  snr?: readonly (number | null)[];
}

/**
 * The usable signals of one satellite from a RINEX-3 observation record
 * (`codes` like 'C1C', 'L1C', 'S1C' and their `values`): per band, the
 * first tracked pseudorange and the first tracked carrier of the band's
 * attributes. A band counts only with both. Null when nothing is usable.
 */
export function selectPppSignals(
  prn: string,
  codes: readonly string[],
  values: readonly (number | null)[],
  opts: SelectPppSignalsOptions = {}
): PppMultiSatObs | null {
  const sys = prn[0]!;
  let prio = PPP_SIGNAL_PRIORITY[sys];
  if (!prio) return null;
  const order = opts.bands?.[sys];
  if (order)
    prio = [...order]
      .map((b) => prio!.find((p) => p.band === b))
      .filter((p): p is NonNullable<typeof p> => !!p);
  const idx = (c: string) => codes.indexOf(c);
  const val = (i: number) => (i >= 0 ? (values[i] ?? 0) : 0);
  const signals: PppSignal[] = [];
  for (const p of prio) {
    let ci = -1;
    let codeAttr = '';
    for (const a of p.code) {
      const i = idx(`C${p.band}${a}`);
      if (val(i)) {
        ci = i;
        codeAttr = a;
        break;
      }
    }
    let li = -1;
    let phaseAttr = '';
    for (const a of p.phase) {
      const i = idx(`L${p.band}${a}`);
      if (val(i)) {
        li = i;
        phaseAttr = a;
        break;
      }
    }
    if (ci < 0 || li < 0) continue;
    const freq =
      sys === 'R'
        ? opts.gloChannels
          ? gloFreq(opts.gloChannels as Record<string, number>, prn, p.band)
          : undefined
        : FREQ[sys]?.[p.band];
    if (!freq) continue;
    const lliVal = opts.lli?.[li];
    const sIdx = idx(`S${p.band}${phaseAttr}`);
    const snr = opts.snr?.[li] ?? (sIdx >= 0 ? values[sIdx] : null);
    signals.push({
      band: p.band,
      freq,
      antexBand: `${sys}0${p.band}`,
      code: p.band + codeAttr,
      ...(phaseAttr !== codeAttr ? { phaseCode: p.band + phaseAttr } : {}),
      pr: val(ci),
      cp: val(li),
      ...(lliVal != null && lliVal & 1 ? { lli: true } : {}),
      ...(snr ? { snr } : {}),
    });
  }
  return signals.length ? { prn, signals } : null;
}

/**
 * The dual-frequency observation of the ionosphere-free engine from a
 * multi-signal record: the first two signals, or the two of `bands`
 * (band digits, e.g. '15'). Null when either is missing.
 */
export function toDualFrequencyObs(
  sat: PppMultiSatObs,
  bands?: string
): PppSatObs | null {
  const a = bands
    ? sat.signals.find((s) => s.band === bands[0])
    : sat.signals[0];
  const b = bands
    ? sat.signals.find((s) => s.band === bands[1])
    : sat.signals[1];
  if (!a || !b) return null;
  return {
    prn: sat.prn,
    f1: a.freq,
    f2: b.freq,
    c1: a.pr,
    c2: b.pr,
    l1: a.cp,
    l2: b.cp,
    band1: a.antexBand,
    band2: b.antexBand,
    code1: a.code,
    code2: b.code,
    phase1: a.phaseCode ?? a.code,
    phase2: b.phaseCode ?? b.code,
    slip: !!(a.lli || b.lli),
  };
}
