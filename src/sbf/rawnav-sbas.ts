/**
 * Septentrio SBF GEORawL1 (4020): one 250-bit SBAS L1 C/A message per
 * block. Message type 9 carries the GEO satellite's navigation (state
 * vector), decoded by the shared `decodeSbasGeoNav` (src/navbits/sbas.ts),
 * the same decoder the u-blox RXM-SFRBX path uses.
 *
 * Block layout (mosaic-X5 reference guide §4): after the 8-byte SBF
 * header, TOW u4 + WNc u2, SVID u1, CRCPassed u1, ViterbiCnt u1,
 * Source u1, FreqNr u1, RxChannel u1, then NAVBits as u4[8] — the first
 * received bit is the MSB of NAVBits[0] (each u4 little-endian in the
 * stream, message bits MSB-first within the word). The 250-bit message
 * occupies the first 250 of the 256 bits; the trailing 6 are padding.
 *
 * As with the other SBF raw paths, the receiver's own CRCPassed flag is
 * ignored in favour of re-running CRC-24Q on the transported bits, so a
 * failed check is reported as `badCrc`.
 *
 * GEORawL5 (4021) is deliberately not routed here: it carries the DFMC
 * L5 SBAS message set (MT 32/34/35/…), a different format from the L1
 * message type 9 this decoder understands.
 */
import { decodeSbasGeoNav, sbasCrcOk } from '../navbits/sbas';
import { isSbasL1Preamble, sbasL5MessageType } from '../navbits/sbas-l5';
import type { GlonassEphemeris } from '../rinex/nav';
import { scanSbfFrames, svidToPrn } from './frame';

/** Callback fed every CRC-valid SBAS message (any type), as MSB-first bits. */
export type SbasMessageCb = (
  msg: Uint8Array,
  prn: number,
  week: number,
  tow: number
) => void;

/** Callback fed every CRC-valid native-DFMC (L5) message, with its type. */
export type DfmcMessageCb = (
  msg: Uint8Array,
  prn: number,
  week: number,
  tow: number,
  type: number
) => void;

/**
 * Extract the 250-bit GEO message from a GEORawL1 (4020) / GEORawL5 (4021)
 * block at frame offset `b`. The two blocks share a layout: TOW u4 (+8, ms of
 * GPS week), WNc u2 (+12), SVID u1 (+14), then NAVBits u4[8] at +20 with the
 * first received bit as the MSB of NAVBits[0]. Returns null for a non-SBAS SVID.
 */
function readGeoMessage(
  view: DataView,
  b: number
): { msg: Uint8Array; prn: number; wnc: number; towSec: number } | null {
  const tow = view.getUint32(b + 8, true); // ms of GPS week
  const wnc = view.getUint16(b + 12, true); // full GPS week
  const prnStr = svidToPrn(view.getUint8(b + 14)); // e.g. "S23" (SBAS PRN-100)
  if (!prnStr || prnStr[0] !== 'S') return null;
  const msg = new Uint8Array(32);
  for (let k = 0; k < 8; k++) {
    const w = view.getUint32(b + 20 + 4 * k, true);
    msg[4 * k] = w >>> 24;
    msg[4 * k + 1] = (w >>> 16) & 0xff;
    msg[4 * k + 2] = (w >>> 8) & 0xff;
    msg[4 * k + 3] = w & 0xff;
  }
  return { msg, prn: Number(prnStr.slice(1)) + 100, wnc, towSec: tow / 1000 };
}

/**
 * Process one GEORawL1 block at frame offset `b`: extract the 250-bit
 * SBAS L1 message, CRC-24Q gate it, and decode a GEO ephemeris if it is
 * message type 9. Returns the ephemeris, `{ badCrc: true }` on a failed
 * CRC, or `{}` for any other (non–type-9) message.
 */
export function feedGeoBlock(
  view: DataView,
  b: number,
  onSbasMessage?: SbasMessageCb
): { eph?: GlonassEphemeris; badCrc?: boolean } {
  const g = readGeoMessage(view, b);
  if (!g) return {};
  if (!sbasCrcOk(g.msg)) return { badCrc: true };
  onSbasMessage?.(g.msg, g.prn, g.wnc, g.towSec);
  const eph = decodeSbasGeoNav(g.msg, g.prn, g.wnc, g.towSec);
  return eph ? { eph } : {};
}

/** Result of routing one GEORawL5 (4021) block. */
export interface GeoL5Result {
  eph?: GlonassEphemeris;
  badCrc?: boolean;
  /** 'l1' = DO-229 content relayed on L5 (fed to `onSbasMessage`, decodable by
   *  the L1 SbasProcessor); 'l5' = a native DFMC message (header only). */
  kind?: 'l1' | 'l5';
  /** Native-DFMC message type (Table B-98), when `kind === 'l5'`. */
  dfmcType?: number;
}

/**
 * Process one GEORawL5 block at frame offset `b`. The L5 signal carries a mix:
 * GEOs relaying DO-229 (L1-format) content — routed to `onSbasMessage` and
 * decoded for a GEO ephemeris exactly like {@link feedGeoBlock} — and GEOs
 * broadcasting native DFMC frames, which are CRC-gated and surfaced via
 * `onDfmcMessage` with their Table B-98 type but not field-decoded (see
 * {@link ../navbits/sbas-l5}). Classification is by preamble.
 */
export function feedGeoL5Block(
  view: DataView,
  b: number,
  onSbasMessage?: SbasMessageCb,
  onDfmcMessage?: DfmcMessageCb
): GeoL5Result {
  const g = readGeoMessage(view, b);
  if (!g) return {};
  if (!sbasCrcOk(g.msg)) return { badCrc: true };
  if (isSbasL1Preamble(g.msg)) {
    onSbasMessage?.(g.msg, g.prn, g.wnc, g.towSec);
    const eph = decodeSbasGeoNav(g.msg, g.prn, g.wnc, g.towSec);
    return eph ? { kind: 'l1', eph } : { kind: 'l1' };
  }
  const dfmcType = sbasL5MessageType(g.msg);
  onDfmcMessage?.(g.msg, g.prn, g.wnc, g.towSec, dfmcType);
  return { kind: 'l5', dfmcType };
}

export interface SbfGeoNavResult {
  /** SBAS GEO ephemerides in stream order, unchanged repeats suppressed. */
  ephemerides: GlonassEphemeris[];
  /** GEORawL1 messages whose CRC-24Q check failed (dropped). */
  badCrc: number;
  /** Total GEORawL1 blocks seen (with valid SBF framing). */
  messages: number;
}

/**
 * Decode every GEORawL1 block in an SBF byte stream into SBAS GEO
 * ephemerides (message type 9), de-duping unchanged rebroadcasts by
 * (PRN, time-of-clock). The one-pass {@link decodeSbfNavigation} routes
 * the same blocks through {@link feedGeoBlock}; this standalone parser
 * mirrors the per-constellation `parseSbf*` helpers.
 */
export function parseSbfGeoNav(
  data: Uint8Array,
  opts: {
    onSbasMessage?: (
      msg: Uint8Array,
      prn: number,
      week: number,
      tow: number
    ) => void;
  } = {}
): SbfGeoNavResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ephemerides: GlonassEphemeris[] = [];
  const seen = new Set<string>();
  let badCrc = 0;
  let messages = 0;

  scanSbfFrames(data, view, (id, b, len) => {
    if (id !== 4020 || len < 52) return;
    messages++;
    const r = feedGeoBlock(view, b, opts.onSbasMessage);
    if (r.eph) {
      const key = `${r.eph.prn}|${r.eph.tocDate.getTime()}`;
      if (!seen.has(key)) {
        seen.add(key);
        ephemerides.push(r.eph);
      }
    } else if (r.badCrc) {
      badCrc++;
    }
  });

  return { ephemerides, badCrc, messages };
}

/** Census of the SBAS L5 (DFMC) frames in a stream. Correction content is not
 *  field-decoded (see {@link ../navbits/sbas-l5}). */
export interface DfmcCensus {
  /** Native-DFMC frame count by Table B-98 message type. */
  byType: Record<number, number>;
  /** GEO PRNs (e.g. 'S21') broadcasting native DFMC. */
  prns: string[];
  /** Total CRC-valid native-DFMC frames. */
  messages: number;
}

export interface SbfGeoL5Result {
  /** GEO ephemerides from DO-229 (L1-format) content relayed on L5 (MT9). */
  ephemerides: GlonassEphemeris[];
  /** CRC-valid L5-signal frames carrying DO-229 (L1-format) content. */
  legacyMessages: number;
  /** Native-DFMC frame census. */
  dfmc: DfmcCensus;
  /** GEORawL5 frames whose CRC-24Q check failed (dropped). */
  badCrc: number;
  /** Total GEORawL5 blocks seen (with valid SBF framing). */
  messages: number;
}

/**
 * Decode every GEORawL5 (4021) block in an SBF byte stream. DO-229 (L1-format)
 * content relayed on L5 is fed to `onSbasMessage` (usable by the L1
 * SbasProcessor) and decoded for GEO ephemerides; native DFMC frames are
 * CRC-gated and counted by message type. The one-pass
 * {@link ../sbf/navigation.decodeSbfNavigation} performs the same routing.
 */
export function parseSbfGeoL5(
  data: Uint8Array,
  opts: { onSbasMessage?: SbasMessageCb; onDfmcMessage?: DfmcMessageCb } = {}
): SbfGeoL5Result {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ephemerides: GlonassEphemeris[] = [];
  const seen = new Set<string>();
  const byType: Record<number, number> = {};
  const dfmcPrns = new Set<string>();
  let legacyMessages = 0;
  let dfmcMessages = 0;
  let badCrc = 0;
  let messages = 0;

  scanSbfFrames(data, view, (id, b, len) => {
    if (id !== 4021 || len < 52) return;
    messages++;
    const r = feedGeoL5Block(view, b, opts.onSbasMessage, opts.onDfmcMessage);
    if (r.badCrc) {
      badCrc++;
    } else if (r.kind === 'l1') {
      legacyMessages++;
      if (r.eph) {
        const key = `${r.eph.prn}|${r.eph.tocDate.getTime()}`;
        if (!seen.has(key)) {
          seen.add(key);
          ephemerides.push(r.eph);
        }
      }
    } else if (r.kind === 'l5' && r.dfmcType !== undefined) {
      dfmcMessages++;
      byType[r.dfmcType] = (byType[r.dfmcType] ?? 0) + 1;
      const prn = view.getUint8(b + 14);
      const s = svidToPrn(prn);
      if (s) dfmcPrns.add(s);
    }
  });

  return {
    ephemerides,
    legacyMessages,
    dfmc: { byType, prns: [...dfmcPrns].sort(), messages: dfmcMessages },
    badCrc,
    messages,
  };
}
