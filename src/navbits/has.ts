/**
 * Galileo High Accuracy Service (HAS) decoding from E6-B C/NAV pages —
 * Galileo HAS SIS ICD Issue 1.0 (May 2022).
 *
 * Layers, receiver-independent like the rest of src/navbits:
 *
 * - C/NAV page: 492 bits per second per satellite (after Viterbi
 *   decoding, sync stripped) = 14 reserved bits + 24-bit HAS page
 *   header + 424-bit (53-octet) HAS encoded page + CRC-24Q over the
 *   first 462 bits + 6 tail bits (ICD §2.3).
 * - Message assembly: a HAS message of MS pages is spread over the
 *   255-page vertical Reed-Solomon code block of ./rs255; every
 *   satellite broadcasts *different* page IDs of the *same* message
 *   ID, so pages are collected network-wide and the message decodes
 *   as soon as MS distinct page IDs arrived from any satellites
 *   (ICD §5.2).
 * - MT1 content: header (TOH, content flags, mask ID, IOD set ID) and
 *   the flagged sub-blocks — satellite/signal masks, orbit corrections
 *   (radial/in-track/cross-track vs the referenced GPS IODE / Galileo
 *   IODNav), full-set and subset clock corrections, code and phase
 *   biases — with the scale factors and reserved values of ICD §6.
 *
 * Sign convention (ICD §7.2-7.3, opposite of the RTCM/IGS SSR orbit
 * sign): corrected position = broadcast position + R·Δ(rad,in,cross),
 * corrected clock = broadcast clock + Δclock/c. Values are kept
 * exactly as broadcast (metres).
 *
 * Field layout cross-checked against FGI's HASlib reference decoder
 * (github.com/nlsfi/HASlib, EUPL-1.2) and validated field-for-field
 * against its output on a TU Delft DLF5 mosaic-X5 capture.
 */

import { crc24q } from './cnav';
import { getBitS, getBitU } from './index';
import { type RsPage, rs255DecodeErasures } from './rs255';

/** Bytes holding one 492-bit C/NAV page (61 whole bytes + 4 bits). */
export const HAS_PAGE_BYTES = 62;

/** 24-bit page-header pattern marking a dummy page (ICD §3.1). */
export const HAS_DUMMY_HEADER = 0xaf3bc3;

/** Validity-interval enum in seconds; index 15 is reserved (ICD §6.4). */
export const HAS_VALIDITY_SECONDS: readonly (number | null)[] = [
  5,
  10,
  15,
  20,
  30,
  60,
  90,
  120,
  180,
  240,
  300,
  600,
  900,
  1800,
  3600,
  null,
];

/** GPS signal-mask bit → signal (ICD §6.4.3, Table 20). */
export const HAS_GPS_SIGNALS: readonly string[] = [
  'L1 C/A',
  'Reserved',
  'Reserved',
  'L1C(D)',
  'L1C(P)',
  'L1C(D+P)',
  'L2 CM',
  'L2 CL',
  'L2 CM+CL',
  'L2 P',
  'Reserved',
  'L5 I',
  'L5 Q',
  'L5 I+Q',
  'Reserved',
  'Reserved',
];

/** Galileo signal-mask bit → signal (ICD §6.4.3, Table 21). */
export const HAS_GALILEO_SIGNALS: readonly string[] = [
  'E1-B',
  'E1-C',
  'E1-B+E1-C',
  'E5a-I',
  'E5a-Q',
  'E5a-I+E5a-Q',
  'E5b-I',
  'E5b-Q',
  'E5b-I+E5b-Q',
  'E5-I',
  'E5-Q',
  'E5-I+E5-Q',
  'E6-B',
  'E6-C',
  'E6-B+E6-C',
  'Reserved',
];

/** Constellations HAS corrects: GPS (GNSS ID 0), Galileo (GNSS ID 2). */
export type HasSystem = 'G' | 'E';

const SYSTEM_OF_GNSS_ID: Record<number, HasSystem> = { 0: 'G', 2: 'E' };
/** Broadcast-IOD field width per system (ICD Table 25). */
const IOD_BITS: Record<HasSystem, number> = { G: 8, E: 10 };

/* ================================================================== */
/*  C/NAV page layer                                                   */
/* ================================================================== */

/**
 * Check the CRC-24Q of one C/NAV page (bits 0-461 data, bits 462-485
 * parity). `page` must hold at least 61 bytes.
 */
export function hasPageCrcOk(page: Uint8Array): boolean {
  if (page.length < 61) return false;
  return crc24q(page, 462) === getBitU(page, 462, 24);
}

/** Parsed HAS page: header fields plus the 53-octet encoded body. */
export interface HasPage {
  /** HAS status flag: 0 test, 1 operational, 2 reserved, 3 do not use. */
  status: number;
  /** Message type; 1 is the only type defined by ICD Issue 1.0. */
  messageType: number;
  /** Message ID, 0-31 (cyclic; changes with the message content). */
  messageId: number;
  /** Message size in pages, 1-32 (broadcast as MS − 1). */
  messageSize: number;
  /** Page ID, 1-255: 1-based codeword symbol index of ./rs255. */
  pageId: number;
  /** The 53 encoded-page octets (bits 38-461 of the page). */
  body: Uint8Array;
}

/**
 * Split one C/NAV page (≥ 61 bytes, CRC not re-checked here — see
 * `hasPageCrcOk`) into HAS page header + body. Returns null for dummy
 * pages (header pattern 0xAF3BC3).
 */
export function parseHasPage(page: Uint8Array): HasPage | null {
  if (getBitU(page, 14, 24) === HAS_DUMMY_HEADER) return null;
  const body = new Uint8Array(53);
  for (let i = 0; i < 53; i++) body[i] = getBitU(page, 38 + 8 * i, 8);
  return {
    status: getBitU(page, 14, 2),
    messageType: getBitU(page, 18, 2),
    messageId: getBitU(page, 20, 5),
    messageSize: getBitU(page, 25, 5) + 1,
    pageId: getBitU(page, 30, 8),
    body,
  };
}

/* ================================================================== */
/*  MT1 content                                                        */
/* ================================================================== */

/** One system's satellite/signal mask (ICD §6.4.3). */
export interface HasSystemMask {
  /** GNSS ID as broadcast: 0 GPS, 2 Galileo. */
  gnssId: number;
  system: HasSystem;
  /** Masked satellites in mask order, e.g. ["E03", "E05", ...]. */
  prns: string[];
  /** Set bits of the 16-bit signal mask, ascending. */
  signalIndices: number[];
  /** ICD names for `signalIndices`. */
  signals: string[];
  /**
   * Cell mask, [satellite][signal] in mask order — true when the
   * sat×signal combination carries biases. Null when the cell-mask
   * availability flag is 0 (all combinations available).
   */
  cellMask: boolean[][] | null;
  /** Nav-message index the corrections refer to (0 = LNAV / I/NAV). */
  navMessage: number;
}

/** The satellite/signal mask block of one mask ID. */
export interface HasMasks {
  maskId: number;
  systems: HasSystemMask[];
}

/** Orbit correction for one satellite (ICD §6.5). */
export interface HasOrbitCorrection {
  system: HasSystem;
  prn: string;
  /** Broadcast issue of data the deltas refer to (IODE / IODNav). */
  gnssIod: number;
  /** Delta radial in m (LSB 0.0025), null = data not available. */
  deltaRadial: number | null;
  /** Delta in-track in m (LSB 0.008), null = data not available. */
  deltaInTrack: number | null;
  /** Delta cross-track in m (LSB 0.008), null = data not available. */
  deltaCrossTrack: number | null;
}

export interface HasOrbitBlock {
  validityIndex: number;
  /** Validity interval in s (null = reserved index 15). */
  validitySeconds: number | null;
  corrections: HasOrbitCorrection[];
}

/** Clock correction for one satellite (ICD §6.6-6.7). */
export interface HasClockCorrection {
  system: HasSystem;
  prn: string;
  /**
   * Delta clock C0 in m, multiplier folded in; positive means the
   * satellite clock offset grows (add Δclock/c to the broadcast
   * clock). Null when data not available or the satellite is flagged
   * "shall not be used" (see `notUsable`).
   */
  deltaClock: number | null;
  /** True for the reserved "insufficient accuracy, do not use" value. */
  notUsable: boolean;
}

export interface HasClockBlock {
  validityIndex: number;
  validitySeconds: number | null;
  /** Delta-clock C0 multiplier per system (1-4), in mask order. */
  multipliers: { system: HasSystem; multiplier: number }[];
  corrections: HasClockCorrection[];
}

/** Code or phase bias of one satellite × signal cell (ICD §6.8-6.9). */
export interface HasSignalBias {
  system: HasSystem;
  prn: string;
  signalIndex: number;
  signal: string;
  /** Bias in m (code, LSB 0.02) or cycles (phase, LSB 0.01); null = N/A. */
  bias: number | null;
  /** Phase-discontinuity indicator (phase biases only). */
  discontinuity?: number;
}

export interface HasBiasBlock {
  validityIndex: number;
  validitySeconds: number | null;
  biases: HasSignalBias[];
}

/** Which sub-blocks the MT1 header flags as present (ICD §6.2). */
export interface HasContentFlags {
  mask: boolean;
  orbit: boolean;
  clockFullSet: boolean;
  clockSubset: boolean;
  codeBias: boolean;
  phaseBias: boolean;
}

/** One decoded HAS MT1 message. */
export interface HasMessage {
  /** Receiver time of week (s) of the page completing the message. */
  tow?: number;
  /** HAS status of the carrying pages (0 test, 1 operational). */
  status: number;
  messageId: number;
  /** Message size in pages (= pages used for the RS decode). */
  messageSize: number;
  /** Time of hour of the corrections, s (0-3599, ICD §6.2). */
  toh: number;
  maskId: number;
  iodSetId: number;
  flags: HasContentFlags;
  /** The mask block in force (own or cached, see `maskFromCache`). */
  masks?: HasMasks;
  /** True when `masks` came from an earlier message with this mask ID. */
  maskFromCache: boolean;
  orbit?: HasOrbitBlock;
  clockFullSet?: HasClockBlock;
  clockSubset?: HasClockBlock;
  codeBias?: HasBiasBlock;
  phaseBias?: HasBiasBlock;
  /** Null when fully parsed, else why the sub-blocks are missing. */
  parseError: string | null;
}

class Cursor {
  pos = 0;
  constructor(
    private readonly buf: Uint8Array,
    readonly bits: number
  ) {}

  u(len: number): number {
    if (this.pos + len > this.bits) throw new RangeError('truncated');
    const v = getBitU(this.buf, this.pos, len);
    this.pos += len;
    return v;
  }

  s(len: number): number {
    if (this.pos + len > this.bits) throw new RangeError('truncated');
    const v = getBitS(this.buf, this.pos, len);
    this.pos += len;
    return v;
  }
}

const prnOf = (system: HasSystem, idx: number): string =>
  `${system}${String(idx + 1).padStart(2, '0')}`;

function parseMaskBlock(c: Cursor, maskId: number): HasMasks {
  const nSys = c.u(4);
  const systems: HasSystemMask[] = [];
  for (let s = 0; s < nSys; s++) {
    const gnssId = c.u(4);
    const system = SYSTEM_OF_GNSS_ID[gnssId];
    if (system === undefined) throw new RangeError(`unknown GNSS ID ${gnssId}`);
    const prns: string[] = [];
    for (let b = 0; b < 40; b++) if (c.u(1)) prns.push(prnOf(system, b));
    const signalIndices: number[] = [];
    for (let b = 0; b < 16; b++) if (c.u(1)) signalIndices.push(b);
    const signalNames = system === 'G' ? HAS_GPS_SIGNALS : HAS_GALILEO_SIGNALS;
    let cellMask: boolean[][] | null = null;
    if (c.u(1)) {
      cellMask = prns.map(() => signalIndices.map(() => c.u(1) === 1));
    }
    systems.push({
      gnssId,
      system,
      prns,
      signalIndices,
      signals: signalIndices.map((i) => signalNames[i]!),
      cellMask,
      navMessage: c.u(3),
    });
  }
  c.u(6); // reserved
  return { maskId, systems };
}

function parseOrbitBlock(c: Cursor, masks: HasMasks): HasOrbitBlock {
  const validityIndex = c.u(4);
  const corrections: HasOrbitCorrection[] = [];
  for (const sys of masks.systems) {
    for (const prn of sys.prns) {
      const gnssIod = c.u(IOD_BITS[sys.system]);
      const rad = c.s(13);
      const inT = c.s(12);
      const cross = c.s(12);
      corrections.push({
        system: sys.system,
        prn,
        gnssIod,
        deltaRadial: rad === -4096 ? null : rad * 0.0025,
        deltaInTrack: inT === -2048 ? null : inT * 0.008,
        deltaCrossTrack: cross === -2048 ? null : cross * 0.008,
      });
    }
  }
  return {
    validityIndex,
    validitySeconds: HAS_VALIDITY_SECONDS[validityIndex]!,
    corrections,
  };
}

/** Read one 13-bit delta clock, mapping the two reserved values. */
function clockValue(
  c: Cursor,
  system: HasSystem,
  prn: string,
  multiplier: number
): HasClockCorrection {
  const raw = c.s(13);
  return {
    system,
    prn,
    deltaClock:
      raw === -4096 || raw === 4095 ? null : raw * 0.0025 * multiplier,
    notUsable: raw === 4095,
  };
}

function parseClockFullBlock(c: Cursor, masks: HasMasks): HasClockBlock {
  const validityIndex = c.u(4);
  const multipliers = masks.systems.map((sys) => ({
    system: sys.system,
    multiplier: c.u(2) + 1,
  }));
  const corrections: HasClockCorrection[] = [];
  for (let s = 0; s < masks.systems.length; s++) {
    const sys = masks.systems[s]!;
    for (const prn of sys.prns)
      corrections.push(
        clockValue(c, sys.system, prn, multipliers[s]!.multiplier)
      );
  }
  return {
    validityIndex,
    validitySeconds: HAS_VALIDITY_SECONDS[validityIndex]!,
    multipliers,
    corrections,
  };
}

function parseClockSubsetBlock(c: Cursor, masks: HasMasks): HasClockBlock {
  const validityIndex = c.u(4);
  const nSys = c.u(4);
  const multipliers: HasClockBlock['multipliers'] = [];
  const corrections: HasClockCorrection[] = [];
  for (let s = 0; s < nSys; s++) {
    const gnssId = c.u(4);
    const sys = masks.systems.find((m) => m.gnssId === gnssId);
    if (!sys) throw new RangeError(`subset GNSS ID ${gnssId} not in mask`);
    const multiplier = c.u(2) + 1;
    multipliers.push({ system: sys.system, multiplier });
    const selected: string[] = [];
    for (const prn of sys.prns) if (c.u(1)) selected.push(prn);
    for (const prn of selected)
      corrections.push(clockValue(c, sys.system, prn, multiplier));
  }
  return {
    validityIndex,
    validitySeconds: HAS_VALIDITY_SECONDS[validityIndex]!,
    multipliers,
    corrections,
  };
}

function parseBiasBlock(
  c: Cursor,
  masks: HasMasks,
  kind: 'code' | 'phase'
): HasBiasBlock {
  const validityIndex = c.u(4);
  const biases: HasSignalBias[] = [];
  for (const sys of masks.systems) {
    for (let s = 0; s < sys.prns.length; s++) {
      for (let g = 0; g < sys.signalIndices.length; g++) {
        if (sys.cellMask && !sys.cellMask[s]![g]) continue;
        const raw = c.s(11);
        const entry: HasSignalBias = {
          system: sys.system,
          prn: sys.prns[s]!,
          signalIndex: sys.signalIndices[g]!,
          signal: sys.signals[g]!,
          bias: raw === -1024 ? null : raw * (kind === 'code' ? 0.02 : 0.01),
        };
        if (kind === 'phase') entry.discontinuity = c.u(2);
        biases.push(entry);
      }
    }
  }
  return {
    validityIndex,
    validitySeconds: HAS_VALIDITY_SECONDS[validityIndex]!,
    biases,
  };
}

/**
 * Parse one RS-decoded MT1 payload (`messageSize` × 53 octets). When
 * the message does not carry the mask block itself, the mask in force
 * must be supplied via `cachedMasks` (from an earlier message with the
 * same mask ID) — without it the sub-block boundaries are unknown and
 * only the header is returned, with `parseError` set.
 */
export function parseHasMt1(
  payload: Uint8Array,
  header: Pick<HasMessage, 'status' | 'messageId' | 'messageSize'>,
  cachedMasks?: HasMasks
): HasMessage {
  const c = new Cursor(payload, payload.length * 8);
  const toh = c.u(12);
  const flags: HasContentFlags = {
    mask: c.u(1) === 1,
    orbit: c.u(1) === 1,
    clockFullSet: c.u(1) === 1,
    clockSubset: c.u(1) === 1,
    codeBias: c.u(1) === 1,
    phaseBias: c.u(1) === 1,
  };
  c.u(4); // reserved
  const maskId = c.u(5);
  const iodSetId = c.u(5);

  const msg: HasMessage = {
    ...header,
    toh,
    maskId,
    iodSetId,
    flags,
    maskFromCache: false,
    parseError: null,
  };

  try {
    let masks: HasMasks;
    if (flags.mask) {
      masks = parseMaskBlock(c, maskId);
    } else if (cachedMasks) {
      masks = cachedMasks;
      msg.maskFromCache = true;
    } else {
      msg.parseError = 'mask-unavailable';
      return msg;
    }
    msg.masks = masks;
    if (flags.orbit) msg.orbit = parseOrbitBlock(c, masks);
    if (flags.clockFullSet) msg.clockFullSet = parseClockFullBlock(c, masks);
    if (flags.clockSubset) msg.clockSubset = parseClockSubsetBlock(c, masks);
    if (flags.codeBias) msg.codeBias = parseBiasBlock(c, masks, 'code');
    if (flags.phaseBias) msg.phaseBias = parseBiasBlock(c, masks, 'phase');
  } catch (e) {
    msg.parseError = e instanceof Error ? e.message : String(e);
  }
  return msg;
}

/* ================================================================== */
/*  Network-wide message assembly                                      */
/* ================================================================== */

interface Slot {
  messageSize: number;
  status: number;
  pages: RsPage[];
  bodies: Map<number, string>;
  firstTow?: number;
}

export interface HasAssemblerStats {
  /** Non-dummy MT1 pages fed in (CRC assumed checked by the caller). */
  pages: number;
  dummyPages: number;
  /** Pages skipped: not MT1, or HAS status reserved / do-not-use. */
  skippedPages: number;
  /** Repeats of an already-collected page ID (normal: every satellite
   *  cycles through the block until the message changes). */
  duplicatePages: number;
  /** Slots restarted on conflicting size/content or page timeout. */
  resets: number;
  /** Messages completed (including ones with parseError set). */
  messages: number;
  /** Completed messages whose sub-blocks could not be parsed. */
  parseErrors: number;
}

/**
 * Streaming HAS message assembler. Feed CRC-valid C/NAV pages from
 * *all* satellites in received order (HAS is broadcast network-wide:
 * each satellite transmits different pages of the same message); a
 * `HasMessage` is returned whenever a message first completes.
 *
 * Mask blocks are cached by mask ID so that messages without the mask
 * flag (the common case — masks are only re-broadcast periodically)
 * can still locate their sub-blocks, mirroring ICD §5.4.
 */
export class HasAssembler {
  private slots = new Map<number, Slot>();
  private lastMessageId = -1;
  private maskCache = new Map<number, HasMasks>();
  /** Pages a message may span before its slot is restarted (s). */
  private readonly timeoutSec: number;
  readonly stats: HasAssemblerStats = {
    pages: 0,
    dummyPages: 0,
    skippedPages: 0,
    duplicatePages: 0,
    resets: 0,
    messages: 0,
    parseErrors: 0,
  };

  constructor(opts: { timeoutSec?: number } = {}) {
    this.timeoutSec = opts.timeoutSec ?? 30;
  }

  /**
   * Push one 492-bit C/NAV page (≥ 61 bytes; check the CRC first with
   * `hasPageCrcOk`). `tow` — a receiver time of week in seconds, any
   * origin as long as it is common to all pages — enables the slot
   * timeout and is stamped on completed messages.
   */
  push(page: Uint8Array, tow?: number): HasMessage | null {
    const p = parseHasPage(page);
    if (!p) {
      this.stats.dummyPages++;
      return null;
    }
    this.stats.pages++;
    if (p.messageType !== 1 || p.status > 1 || p.pageId === 0) {
      this.stats.skippedPages++;
      return null;
    }
    if (p.messageId === this.lastMessageId) return null; // already decoded

    let slot = this.slots.get(p.messageId);
    const timedOut =
      slot?.firstTow !== undefined &&
      tow !== undefined &&
      tow - slot.firstTow > this.timeoutSec;
    if (slot && (slot.messageSize !== p.messageSize || timedOut)) {
      this.stats.resets++;
      slot = undefined;
    }
    if (!slot) {
      slot = {
        messageSize: p.messageSize,
        status: p.status,
        pages: [],
        bodies: new Map(),
        firstTow: tow,
      };
      this.slots.set(p.messageId, slot);
    }

    const bodyKey = Array.from(p.body, (b) =>
      b.toString(16).padStart(2, '0')
    ).join('');
    const existing = slot.bodies.get(p.pageId);
    if (existing !== undefined) {
      if (existing === bodyKey) {
        this.stats.duplicatePages++;
        return null;
      }
      // Same page ID, different content: a new message generation is
      // reusing this message ID — restart collection from this page.
      this.stats.resets++;
      slot.pages = [];
      slot.bodies.clear();
      slot.firstTow = tow;
    }
    slot.bodies.set(p.pageId, bodyKey);
    slot.pages.push({ pageId: p.pageId, octets: p.body });
    if (slot.pages.length < slot.messageSize) return null;

    const payload = rs255DecodeErasures(slot.pages, slot.messageSize);
    if (!payload) return null; // unreachable with distinct page IDs
    this.slots.delete(p.messageId);
    this.lastMessageId = p.messageId;

    const msg = parseHasMt1(
      payload,
      {
        status: slot.status,
        messageId: p.messageId,
        messageSize: slot.messageSize,
      },
      undefined
    );
    // Re-parse against the cached mask when this message has none.
    const resolved =
      msg.parseError === 'mask-unavailable' && this.maskCache.has(msg.maskId)
        ? parseHasMt1(
            payload,
            {
              status: slot.status,
              messageId: p.messageId,
              messageSize: slot.messageSize,
            },
            this.maskCache.get(msg.maskId)
          )
        : msg;
    if (resolved.flags.mask && resolved.masks)
      this.maskCache.set(resolved.maskId, resolved.masks);
    if (tow !== undefined) resolved.tow = tow;
    this.stats.messages++;
    if (resolved.parseError !== null) this.stats.parseErrors++;
    return resolved;
  }
}

export interface HasParseResult {
  /** Completed messages in stream order. */
  messages: HasMessage[];
  /** Total pages examined. */
  pages: number;
  /** Pages dropped for a failed CRC-24Q re-check. */
  badCrc: number;
  /** Dummy pages (idle filler, no HAS content). */
  dummyPages: number;
}

/**
 * Assemble HAS messages from raw 492-bit C/NAV pages (61+ bytes each,
 * any satellite order): each page is CRC-checked (failures counted and
 * dropped) and fed to a `HasAssembler`.
 */
export function parseHasMessages(pages: Iterable<Uint8Array>): HasParseResult {
  const assembler = new HasAssembler();
  const messages: HasMessage[] = [];
  let count = 0;
  let badCrc = 0;
  for (const page of pages) {
    count++;
    if (!hasPageCrcOk(page)) {
      badCrc++;
      continue;
    }
    const msg = assembler.push(page);
    if (msg) messages.push(msg);
  }
  return {
    messages,
    pages: count,
    badCrc,
    dummyPages: assembler.stats.dummyPages,
  };
}
