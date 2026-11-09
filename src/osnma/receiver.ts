/**
 * Galileo OSNMA (Open Service Navigation Message Authentication)
 * receiver, after the OSNMA SIS ICD v1.1 (October 2023) and the
 * Receiver Guidelines v1.3.
 *
 * Feed it Galileo E1-B I/NAV nominal page pairs; it reassembles the
 * 40-bit OSNMA field of each page into the per-subframe HKROOT (DSM
 * blocks) and MACK (tags + TESLA key) messages and runs the whole
 * chain of trust:
 *
 *   Merkle root ─▶ public key (DSM-PKR, or a known key + its path)
 *     ─▶ ECDSA-signed TESLA root key (DSM-KROOT)
 *     ─▶ TESLA chain keys (one per subframe, delayed disclosure)
 *     ─▶ MAC tags over the satellites' navigation data
 *
 * A tag that verifies proves the satellite's ephemeris/clock (ADKD 0,
 * 12) or GST-UTC/GPS timing parameters (ADKD 4) are the ones Galileo
 * signed. A tag that does not verify against an authenticated key means
 * the navigation data differ from what was signed — a spoofing or
 * replay symptom. Supported: SHA-256 chains, HMAC-SHA-256 tags and
 * ECDSA P-256 keys — the configuration Galileo has used since the
 * service started; other choices are reported as unsupported.
 */

import { hmacSha256, sha256 } from './sha256';
import { p256Verify, p521Verify } from './ecdsa';
import {
  OSNMA_KNOWN_PUBLIC_KEYS,
  OSNMA_MERKLE_ROOT,
  merkleLeafOk,
  publicKeyLeaf,
  type OsnmaPublicKeyRecord,
} from './merkle';

/* ------------------------------------------------------------------ */
/*  Bit helpers                                                        */
/* ------------------------------------------------------------------ */

const bitAt = (b: Uint8Array, i: number) => (b[i >> 3]! >> (7 - (i & 7))) & 1;

function bitsU(b: Uint8Array, start: number, n: number): number {
  let x = 0;
  for (let i = 0; i < n; i++) x = x * 2 + bitAt(b, start + i);
  return x;
}

/** Copy `n` bits of `src` from `start` into `dst` at bit `at`. */
function copyBits(
  dst: Uint8Array,
  at: number,
  src: Uint8Array,
  start: number,
  n: number
): void {
  for (let i = 0; i < n; i++)
    if (bitAt(src, start + i)) dst[(at + i) >> 3]! |= 0x80 >> ((at + i) & 7);
}

function sliceBits(src: Uint8Array, start: number, n: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(n / 8));
  copyBits(out, 0, src, start, n);
  return out;
}

const eqBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** The first `nBits` of a and b agree. */
function eqBits(a: Uint8Array, b: Uint8Array, nBits: number): boolean {
  for (let i = 0; i < nBits; i++) if (bitAt(a, i) !== bitAt(b, i)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const WEEK = 604800;
/** Subframes kept for late (retro) verification once a KROOT arrives. */
const HISTORY_SUBFRAMES = 80;
/** Bound on TESLA derivations per key check (a KROOT is ≤ 1 day old). */
const MAX_DERIVATIONS = 3000;
/** Minimum equivalent tag length to call data authenticated (Guidelines). */
const MIN_TAG_BITS: Record<number, number> = { 0: 80, 4: 40, 12: 80 };

const KEY_BITS = [96, 104, 112, 120, 128, 160, 192, 224, 256];
const TAG_BITS: Record<number, number> = { 5: 20, 6: 24, 7: 28, 8: 32, 9: 40 };

/** ANNEX C MAC look-up table: per ID, the slot sequence of each MACK. */
const MACLT: Record<number, [string[], string[]]> = {
  27: [
    ['00S', '00E', '00E', '00E', '12S', '00E'],
    ['00S', '00E', '00E', '04S', '12S', '00E'],
  ],
  28: [
    ['00S', '00E', '00E', '00E', '00S', '00E', '00E', '12S', '00E', '00E'],
    ['00S', '00E', '00E', '00S', '00E', '00E', '04S', '12S', '00E', '00E'],
  ],
  31: [
    ['00S', '00E', '00E', '12S', '00E'],
    ['00S', '00E', '00E', '12S', '04S'],
  ],
  33: [
    ['00S', '00E', '04S', '00E', '12S', '00E'],
    ['00S', '00E', '00E', '12S', '00E', '12E'],
  ],
  34: [
    ['00S', 'FLX', '04S', 'FLX', '12S', '00E'],
    ['00S', 'FLX', '00E', '12S', '00E', '12E'],
  ],
  35: [
    ['00S', 'FLX', '04S', 'FLX', '12S', 'FLX'],
    ['00S', 'FLX', 'FLX', '12S', 'FLX', 'FLX'],
  ],
  36: [
    ['00S', 'FLX', '04S', 'FLX', '12S'],
    ['00S', 'FLX', '00E', '12S', '12E'],
  ],
  37: [
    ['00S', '00E', '04S', '00E', '12S'],
    ['00S', '00E', '00E', '12S', '12E'],
  ],
  38: [
    ['00S', 'FLX', '04S', 'FLX', '12S'],
    ['00S', 'FLX', 'FLX', '12S', 'FLX'],
  ],
  39: [
    ['00S', 'FLX', '04S', 'FLX'],
    ['00S', 'FLX', '00E', '12S'],
  ],
  40: [
    ['00S', '00E', '04S', '12S'],
    ['00S', '00E', '00E', '12E'],
  ],
};

/** I/NAV word bits authenticated per word type (ICD Annex B). */
const ADKD0_WORDS: [number, number, number][] = [
  // [word type, first bit in the 128-bit word, bit count]
  [1, 6, 120],
  [2, 6, 120],
  [3, 6, 122],
  [4, 6, 120],
  [5, 6, 67],
];
const ADKD0_BITS = 549;
const ADKD4_BITS = 141; // WT6 bits 6..104 (99) ‖ WT10 bits 86..127 (42)

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export type OsnmaNmaStatus = 'reserved' | 'test' | 'operational' | 'dont-use';
export type OsnmaCpks =
  | 'reserved'
  | 'nominal'
  | 'end-of-chain'
  | 'chain-revoked'
  | 'new-public-key'
  | 'public-key-revoked'
  | 'new-merkle-tree'
  | 'alert-message';

const NMAS: OsnmaNmaStatus[] = ['reserved', 'test', 'operational', 'dont-use'];
const CPKS: OsnmaCpks[] = [
  'reserved',
  'nominal',
  'end-of-chain',
  'chain-revoked',
  'new-public-key',
  'public-key-revoked',
  'new-merkle-tree',
  'alert-message',
];

/** GST as Galileo week + time of week (s). */
export interface Gst {
  wn: number;
  tow: number;
}

/** A TESLA chain whose root key verified against a public key. */
export interface OsnmaChain {
  /** Chain ID (CIDKR). */
  cid: number;
  /** PKID of the public key that verified the DSM-KROOT. */
  pkid: number;
  /** Hash function: 'SHA-256' | 'SHA3-256'. */
  hashFunction: string;
  /** MAC function: 'HMAC-SHA-256' | 'CMAC-AES'. */
  macFunction: string;
  keyBits: number;
  tagBits: number;
  /** MAC look-up table entry (ANNEX C). */
  maclt: number;
  /** Time of applicability GST0 of the KROOT. */
  gst0: Gst;
  /** Whether this library can verify tags of this chain. */
  supported: boolean;
}

export interface OsnmaTagStats {
  /** Tags whose MAC verified. */
  ok: number;
  /** Tags whose MAC did not verify against an authenticated key. */
  failed: number;
}

/** Per-satellite authentication state. */
export interface OsnmaSatellite {
  /** 'E05'… */
  prn: string;
  /** This satellite transmits OSNMA data (non-zero OSNMA field). */
  transmitsOsnma: boolean;
  /** Ephemeris, clock and status (ADKD 0 + slow-MAC ADKD 12). */
  ced: OsnmaTagStats & {
    /** IODnav of the latest authenticated data set (≥ 80 tag bits). */
    authenticatedIodNav: number | null;
    /** GST subframe of the latest tag that completed authentication. */
    lastAuthenticated: Gst | null;
  };
  /** GST-UTC / GST-GPS conversion parameters (ADKD 4). */
  timing: OsnmaTagStats & { lastAuthenticated: Gst | null };
}

export interface OsnmaEvent {
  gst: Gst;
  kind:
    | 'public-key-verified'
    | 'public-key-rejected'
    | 'kroot-verified'
    | 'kroot-rejected'
    | 'key-rejected'
    | 'tag-failed'
    | 'macseq-failed'
    | 'alert-message'
    | 'unsupported';
  message: string;
  prn?: string;
}

export interface OsnmaStatus {
  /** Latest NMA header seen (null before any OSNMA page). */
  nmaStatus: OsnmaNmaStatus | null;
  cid: number | null;
  cpks: OsnmaCpks | null;
  /** Public keys proven against the Merkle root. */
  publicKeys: { pkid: number; source: 'known' | 'broadcast' }[];
  /** TESLA chains with a verified root key. */
  chains: OsnmaChain[];
  /** Chain keys (one per subframe) verified back to a KROOT. */
  keysVerified: number;
  /** Keys that did not hash back to the root (a forged or broken chain). */
  keysRejected: number;
  /** GST of the latest verified TESLA key. */
  lastKey: Gst | null;
  tags: OsnmaTagStats & {
    /** Tags whose key, data or chain is not available yet / any more. */
    unverifiable: number;
    /** Dummy tags (COP = 0) verified. */
    dummy: number;
  };
  satellites: OsnmaSatellite[];
  /** Notable events, oldest first (capped). */
  events: OsnmaEvent[];
  /** OSNMA pages fed (E1-B pages with a non-zero OSNMA field). */
  osnmaPages: number;
  /** MACK messages left unused because the NMA status was "don't use". */
  dontUseMacks: number;
  /** An authenticated OSNMA Alert Message was received: OSNMA stopped. */
  alert: boolean;
}

export interface OsnmaReceiverOptions {
  /**
   * Merkle tree root(s) (32 bytes each); default {@link OSNMA_MERKLE_ROOT}.
   * During a Merkle tree renewal pass both the old and the new root.
   */
  merkleRoot?: Uint8Array | readonly Uint8Array[];
  /**
   * Public keys known in advance (each checked against the root);
   * default {@link OSNMA_KNOWN_PUBLIC_KEYS}. Pass [] to rely only on
   * keys broadcast in DSM-PKR.
   */
  publicKeys?: readonly OsnmaPublicKeyRecord[];
}

/* ------------------------------------------------------------------ */
/*  Internal state                                                     */
/* ------------------------------------------------------------------ */

interface SubframeCollect {
  sf: number;
  hk: (number | undefined)[];
  mack: (Uint8Array | undefined)[];
}

interface MackRecord {
  sf: number;
  prna: number;
  nmaHeader: number;
  mack: Uint8Array; // 60 bytes
  /** Remaining work: tags of fast ADKDs, slow-MAC tags. */
  fastDone: boolean;
  slowDone: boolean;
}

interface ChainState extends OsnmaChain {
  kroot: Uint8Array;
  alpha: Uint8Array; // 6 bytes
  /** Verified keys by subframe start (absolute GST seconds). */
  keys: Map<number, Uint8Array>;
}

interface DsmCollect {
  blocks: (Uint8Array | undefined)[];
  nmaHeader: number;
}

interface WordRecord {
  sf: number;
  word: Uint8Array; // 16 bytes (128 bits)
}

interface AuthAccumulator {
  key: string; // navdata identity
  bits: number;
}

interface SatState {
  prn: string;
  transmitsOsnma: boolean;
  ced: OsnmaSatellite['ced'];
  timing: OsnmaSatellite['timing'];
  acc: Map<number, AuthAccumulator>; // per ADKD group (0 for 0/12, 4)
}

const gstOf = (abs: number): Gst => ({
  wn: Math.floor(abs / WEEK),
  tow: abs % WEEK,
});

/** 32-bit GST as broadcast: WN (12 bits) ‖ TOW (20 bits). */
function gst32(abs: number): Uint8Array {
  const { wn, tow } = gstOf(abs);
  const v = ((wn & 0xfff) << 20) | (tow & 0xfffff);
  return new Uint8Array([
    v >>> 24,
    (v >>> 16) & 0xff,
    (v >>> 8) & 0xff,
    v & 0xff,
  ]);
}

const hexOf = (b: Uint8Array) =>
  Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');

const prnName = (svid: number) => `E${String(svid).padStart(2, '0')}`;

/* ------------------------------------------------------------------ */
/*  Receiver                                                           */
/* ------------------------------------------------------------------ */

export class OsnmaReceiver {
  private readonly roots: Uint8Array[];
  /** An authenticated OSNMA Alert Message stopped all processing. */
  private alerted = false;
  /** Revoked public keys and chains (hex), never to be used again. */
  private readonly revoked = new Set<string>();
  private readonly pubKeys = new Map<
    number,
    { key: Uint8Array; npkt: number; source: 'known' | 'broadcast' }
  >();
  private readonly collect = new Map<number, SubframeCollect>(); // per svid
  private readonly dsms = new Map<number, DsmCollect>(); // per DSM ID
  private readonly chains = new Map<number, ChainState>(); // per CID
  private readonly macks: MackRecord[] = [];
  private readonly words = new Map<number, Map<number, WordRecord[]>>();
  private readonly sats = new Map<number, SatState>();
  private readonly events: OsnmaEvent[] = [];
  private nmaHeader: number | null = null;
  private keysVerified = 0;
  private keysRejected = 0;
  private lastKey: number | null = null;
  private tags = { ok: 0, failed: 0, unverifiable: 0, dummy: 0 };
  private osnmaPages = 0;
  private dontUseMacks = 0;
  private latestSf = 0;
  /** Keys already rejected, as `sf:hex` (one event each). */
  private readonly rejectedKeys = new Set<string>();

  constructor(opts: OsnmaReceiverOptions = {}) {
    const r = opts.merkleRoot ?? OSNMA_MERKLE_ROOT;
    this.roots = r instanceof Uint8Array ? [r] : [...r];
    for (const r of opts.publicKeys ?? OSNMA_KNOWN_PUBLIC_KEYS) {
      const leaf = publicKeyLeaf(r.npkt, r.pkid, r.key);
      if (this.leafOk(leaf, r.mid, r.path))
        this.pubKeys.set(r.pkid, { key: r.key, npkt: r.npkt, source: 'known' });
    }
  }

  /**
   * Feed one E1-B I/NAV nominal page pair: `page` holds the 114-bit even
   * part (tail removed) followed by the 120-bit odd part, MSB first, as
   * Septentrio's GALRawINAV carries it (CRC already checked by the
   * caller). `wn`/`tow` give the GST of the page's first symbol.
   */
  pushPage(svid: number, wn: number, tow: number, page: Uint8Array): void {
    if (svid < 1 || svid > 36) return;
    // Even/odd flags must mark a nominal pair (even part first).
    if (bitAt(page, 0) !== 0 || bitAt(page, 114) !== 1) return;
    if (bitAt(page, 1) || bitAt(page, 115)) return; // alert page
    const abs = wn * WEEK + Math.round(tow);
    const sf = abs - (abs % 30);
    const idx = Math.floor((abs % 30) / 2);

    // Navigation word (112 bits even ‖ 16 bits odd).
    const word = new Uint8Array(16);
    copyBits(word, 0, page, 2, 112);
    copyBits(word, 112, page, 116, 16);
    this.storeWord(svid, sf, word);

    const hk = bitsU(page, 132, 8);
    const mack = sliceBits(page, 140, 32);
    const osnma = hk !== 0 || mack.some((b) => b !== 0);
    if (osnma) {
      this.osnmaPages++;
      this.sat(svid).transmitsOsnma = true;
    }

    let c = this.collect.get(svid);
    if (c && c.sf !== sf) {
      this.closeSubframe(svid, c);
      c = undefined;
    }
    if (!c) {
      c = { sf, hk: [], mack: [] };
      this.collect.set(svid, c);
    }
    if (osnma) {
      c.hk[idx] = hk;
      c.mack[idx] = mack;
    }
    if (idx === 14) {
      this.closeSubframe(svid, c);
      this.collect.delete(svid);
    }
    if (sf > this.latestSf) {
      this.latestSf = sf;
      this.prune();
    }
  }

  /** Process anything still buffered (end of a file). */
  flush(): void {
    for (const [svid, c] of this.collect) this.closeSubframe(svid, c);
    this.collect.clear();
  }

  status(): OsnmaStatus {
    const h = this.nmaHeader;
    return {
      nmaStatus: h === null ? null : NMAS[h >> 6]!,
      cid: h === null ? null : (h >> 4) & 3,
      cpks: h === null ? null : CPKS[(h >> 1) & 7]!,
      publicKeys: [...this.pubKeys].map(([pkid, k]) => ({
        pkid,
        source: k.source,
      })),
      chains: [...this.chains.values()].map((c) => ({
        cid: c.cid,
        pkid: c.pkid,
        hashFunction: c.hashFunction,
        macFunction: c.macFunction,
        keyBits: c.keyBits,
        tagBits: c.tagBits,
        maclt: c.maclt,
        gst0: c.gst0,
        supported: c.supported,
      })),
      keysVerified: this.keysVerified,
      keysRejected: this.keysRejected,
      lastKey: this.lastKey === null ? null : gstOf(this.lastKey),
      tags: { ...this.tags },
      satellites: [...this.sats.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, s]) => ({
          prn: s.prn,
          transmitsOsnma: s.transmitsOsnma,
          ced: { ...s.ced },
          timing: { ...s.timing },
        })),
      events: this.events.slice(),
      osnmaPages: this.osnmaPages,
      dontUseMacks: this.dontUseMacks,
      alert: this.alerted,
    };
  }

  /* ---------------------------- internals --------------------------- */

  private sat(svid: number): SatState {
    let s = this.sats.get(svid);
    if (!s) {
      s = {
        prn: prnName(svid),
        transmitsOsnma: false,
        ced: {
          ok: 0,
          failed: 0,
          authenticatedIodNav: null,
          lastAuthenticated: null,
        },
        timing: { ok: 0, failed: 0, lastAuthenticated: null },
        acc: new Map(),
      };
      this.sats.set(svid, s);
    }
    return s;
  }

  private event(e: OsnmaEvent): void {
    this.events.push(e);
    if (this.events.length > 200) this.events.shift();
  }

  private storeWord(svid: number, sf: number, word: Uint8Array): void {
    const wt = bitsU(word, 0, 6);
    if (!((wt >= 1 && wt <= 6) || wt === 10)) return;
    let m = this.words.get(svid);
    if (!m) this.words.set(svid, (m = new Map()));
    let list = m.get(wt);
    if (!list) m.set(wt, (list = []));
    const last = list[list.length - 1];
    if (last && last.sf === sf) last.word = word;
    else list.push({ sf, word });
    if (list.length > HISTORY_SUBFRAMES) list.shift();
  }

  private prune(): void {
    const oldest = this.latestSf - HISTORY_SUBFRAMES * 30;
    while (this.macks.length && this.macks[0]!.sf < oldest) {
      const m = this.macks.shift()!;
      if (!m.fastDone || !m.slowDone) this.tags.unverifiable++;
    }
    for (const c of this.chains.values())
      for (const sf of c.keys.keys())
        if (sf < oldest && sf !== this.lastKey) c.keys.delete(sf);
  }

  private closeSubframe(svid: number, c: SubframeCollect): void {
    // All 15 OSNMA sections are needed to rebuild HKROOT and MACK.
    for (let i = 0; i < 15; i++)
      if (c.hk[i] === undefined || !c.mack[i]) return;
    const hk = new Uint8Array(c.hk as number[]);
    const mack = new Uint8Array(60);
    for (let i = 0; i < 15; i++) mack.set(c.mack[i]!, 4 * i);
    const nma = hk[0]!;
    this.nmaHeader = nma;
    if (this.alerted || nma >> 6 === 0) return; // nothing to authenticate
    this.applyRevocations(nma);
    this.onDsmBlock(c.sf, nma, hk[1]! >> 4, hk[1]! & 0xf, hk.subarray(2));
    this.macks.push({
      sf: c.sf,
      prna: svid,
      nmaHeader: nma,
      mack,
      fastDone: false,
      slowDone: false,
    });
    this.onKeyFrom(this.macks[this.macks.length - 1]!);
    this.processMacks();
  }

  private leafOk(leaf: Uint8Array, mid: number, path: readonly Uint8Array[]) {
    return this.roots.some((root) => merkleLeafOk(leaf, mid, path, root));
  }

  /**
   * "Don't use" headers announcing a revocation (ICD §5.4.1, §5.5.3):
   * drop the revoked chain or public key and never accept it again.
   */
  private applyRevocations(nma: number): void {
    if (nma >> 6 !== 3) return;
    const cpks = (nma >> 1) & 7;
    const chain = this.chains.get((nma >> 4) & 3);
    if (cpks === 3 && chain) {
      this.revoked.add(hexOf(chain.kroot));
      this.chains.delete(chain.cid);
    }
    if (cpks === 5 && chain) {
      const pk = this.pubKeys.get(chain.pkid);
      if (pk) this.revoked.add(hexOf(pk.key));
      this.pubKeys.delete(chain.pkid);
      for (const [cid, c] of this.chains)
        if (c.pkid === chain.pkid) {
          this.revoked.add(hexOf(c.kroot));
          this.chains.delete(cid);
        }
    }
  }

  /* ----------------------------- DSM ------------------------------- */

  private onDsmBlock(
    sf: number,
    nma: number,
    id: number,
    bid: number,
    block: Uint8Array
  ): void {
    let d = this.dsms.get(id);
    const prev = d?.blocks[bid];
    if (d && prev && !eqBytes(prev, block)) d = undefined; // new message
    if (!d) {
      d = { blocks: [], nmaHeader: nma };
      this.dsms.set(id, d);
    }
    d.blocks[bid] = block.slice();
    d.nmaHeader = nma;
    const b0 = d.blocks[0];
    if (!b0) return;
    const nb = (b0[0]! >> 4) + 6;
    if (nb < 7 || nb > 16) return;
    for (let i = 0; i < nb; i++) if (!d.blocks[i]) return;
    const msg = new Uint8Array(13 * nb);
    for (let i = 0; i < nb; i++) msg.set(d.blocks[i]!, 13 * i);
    this.dsms.delete(id);
    if (id >= 12) this.onPkr(sf, msg);
    else this.onKroot(sf, d.nmaHeader, msg);
  }

  private onPkr(sf: number, msg: Uint8Array): void {
    const mid = msg[0]! & 0xf;
    const path = [0, 1, 2, 3].map((j) => msg.slice(1 + 32 * j, 33 + 32 * j));
    const npkt = msg[129]! >> 4;
    const npkid = msg[129]! & 0xf;
    const gst = gstOf(sf);
    if (npkt === 4) {
      // Alert message: verified like a key, payload = rest of the DSM.
      const leaf = msg.slice(129);
      if (this.leafOk(leaf, mid, path)) {
        this.event({
          gst,
          kind: 'alert-message',
          message: 'OSNMA Alert Message received: stop using OSNMA.',
        });
        this.alerted = true;
        this.pubKeys.clear();
        this.chains.clear();
      }
      return;
    }
    const keyLen = npkt === 1 ? 33 : npkt === 3 ? 67 : 0;
    if (!keyLen) return;
    const key = msg.slice(130, 130 + keyLen);
    const leaf = msg.slice(129, 130 + keyLen);
    if (this.revoked.has(hexOf(key))) return;
    if (!this.leafOk(leaf, mid, path)) {
      this.event({
        gst,
        kind: 'public-key-rejected',
        message: `Broadcast public key PKID ${npkid} does not verify against the Merkle root.`,
      });
      return;
    }
    const had = this.pubKeys.get(npkid);
    if (!had || !eqBytes(had.key, key))
      this.pubKeys.set(npkid, { key, npkt, source: 'broadcast' });
    this.event({
      gst,
      kind: 'public-key-verified',
      message:
        had && eqBytes(had.key, key)
          ? `Broadcast public key PKID ${npkid} verified against the Merkle root (matches the known key).`
          : `Public key PKID ${npkid} received and verified against the Merkle root.`,
    });
  }

  private onKroot(sf: number, nma: number, msg: Uint8Array): void {
    const gst = gstOf(sf);
    const pkid = msg[0]! & 0xf;
    const cid = msg[1]! >> 6;
    const hf = (msg[1]! >> 2) & 3;
    const mf = msg[1]! & 3;
    const ks = msg[2]! >> 4;
    const ts = msg[2]! & 0xf;
    const maclt = msg[3]!;
    const wnk = ((msg[4]! & 0xf) << 8) | msg[5]!;
    const towhk = msg[6]!;
    const keyBits = KEY_BITS[ks];
    const tagBits = TAG_BITS[ts];
    if (!keyBits || !tagBits) return;
    const klen = keyBits / 8;
    const pk = this.pubKeys.get(pkid);
    if (!pk) return; // retried when the DSM comes round again
    const m = new Uint8Array(13 + klen);
    m[0] = nma;
    m.set(msg.subarray(1, 13 + klen), 1);
    // DS: 512 bits for P-256, 1056 for P-521 (Table 15).
    const sigLen = pk.npkt === 1 ? 64 : 132;
    const sig = msg.subarray(13 + klen, 13 + klen + sigLen);
    const verify = pk.npkt === 1 ? p256Verify : p521Verify;
    if (sig.length !== sigLen || !verify(pk.key, m, sig)) {
      this.event({
        gst,
        kind: 'kroot-rejected',
        message: `DSM-KROOT (chain ${cid}) signature does not verify with public key PKID ${pkid}.`,
      });
      return;
    }
    const kroot = msg.slice(13, 13 + klen);
    if (this.revoked.has(hexOf(kroot))) return;
    const gst0 = wnk * WEEK + towhk * 3600;
    // A key enters into force with its first KROOT: every key with a
    // lower PKID is out of use (renewal step 2), except across a Merkle
    // tree renewal, which restarts the PKID count.
    if (((nma >> 1) & 7) !== 6)
      for (const id of [...this.pubKeys.keys()])
        if (id < pkid) this.pubKeys.delete(id);
    const existing = this.chains.get(cid);
    if (existing && eqBytes(existing.alpha, msg.subarray(7, 13))) {
      // Same chain, another (floating) KROOT: record it as a known key.
      existing.keys.set(gst0 - 30, kroot);
      return;
    }
    const chain: ChainState = {
      cid,
      pkid,
      hashFunction: ['SHA-256', 'reserved', 'SHA3-256', 'reserved'][hf]!,
      macFunction: ['HMAC-SHA-256', 'CMAC-AES', 'reserved', 'reserved'][mf]!,
      keyBits,
      tagBits,
      maclt,
      gst0: gstOf(gst0),
      supported: hf === 0 && mf === 0 && maclt in MACLT,
      kroot,
      alpha: msg.slice(7, 13),
      keys: new Map([[gst0 - 30, kroot]]),
    };
    this.chains.set(cid, chain);
    this.event({
      gst,
      kind: 'kroot-verified',
      message: `TESLA root key of chain ${cid} verified with public key PKID ${pkid}.`,
    });
    if (!chain.supported)
      this.event({
        gst,
        kind: 'unsupported',
        message: `Chain ${cid} uses ${chain.hashFunction}/${chain.macFunction}, MACLT ${maclt}: tags not verified.`,
      });
    // Keys and tags buffered before the KROOT arrived.
    for (const r of this.macks) this.onKeyFrom(r);
    this.processMacks();
  }

  /* ---------------------------- TESLA ------------------------------ */

  /** F(K) for the key of subframe `sf`: the key of subframe sf − 30. */
  private oneWay(c: ChainState, key: Uint8Array, sf: number): Uint8Array {
    return sha256(key, gst32(sf - 30), c.alpha).slice(0, c.keyBits / 8);
  }

  private chainFor(nmaHeader: number): ChainState | undefined {
    return this.chains.get((nmaHeader >> 4) & 3);
  }

  /** Verify the TESLA key carried in a MACK against the chain. */
  private onKeyFrom(r: MackRecord): void {
    const c = this.chainFor(r.nmaHeader);
    if (!c || !c.supported) return;
    const nt = Math.floor((480 - c.keyBits) / (c.tagBits + 16));
    const key = sliceBits(r.mack, nt * (c.tagBits + 16), c.keyBits);
    const known = c.keys.get(r.sf);
    if (known) {
      // All satellites broadcast the same key in a subframe.
      if (!eqBytes(known, key)) this.rejectKey(r);
      return;
    }
    const tag = `${r.sf}:${hexOf(key)}`;
    if (this.rejectedKeys.has(tag)) return;
    // Nearest verified key before this subframe.
    let anchor = -Infinity;
    for (const sf of c.keys.keys()) if (sf < r.sf && sf > anchor) anchor = sf;
    if (anchor === -Infinity) return;
    const n = (r.sf - anchor) / 30;
    if (n > MAX_DERIVATIONS) return;
    let k = key;
    for (let i = 0, sf = r.sf; i < n; i++, sf -= 30) k = this.oneWay(c, k, sf);
    if (eqBytes(k, c.keys.get(anchor)!)) {
      c.keys.set(r.sf, key);
      this.keysVerified++;
      if (this.lastKey === null || r.sf > this.lastKey) this.lastKey = r.sf;
    } else {
      this.rejectedKeys.add(tag);
      this.rejectKey(r);
    }
  }

  private rejectKey(r: MackRecord): void {
    this.keysRejected++;
    this.event({
      gst: gstOf(r.sf),
      kind: 'key-rejected',
      prn: prnName(r.prna),
      message: `TESLA key from ${prnName(r.prna)} does not hash back to the verified chain.`,
    });
  }

  /* ----------------------------- tags ------------------------------ */

  private processMacks(): void {
    for (const r of this.macks) {
      if (r.fastDone && r.slowDone) continue;
      if (r.nmaHeader >> 6 === 3) {
        // "Don't use": data must not be authenticated with this MACK.
        r.fastDone = r.slowDone = true;
        this.dontUseMacks++;
        continue;
      }
      const c = this.chainFor(r.nmaHeader);
      if (!c || !c.supported) continue;
      const fastKey = c.keys.get(r.sf + 30);
      const slowKey = c.keys.get(r.sf + 330);
      if (!r.fastDone && fastKey) {
        this.verifyTags(c, r, fastKey, false);
        r.fastDone = true;
      }
      if (!r.slowDone && slowKey) {
        this.verifyTags(c, r, slowKey, true);
        r.slowDone = true;
      }
    }
  }

  private verifyTags(
    c: ChainState,
    r: MackRecord,
    key: Uint8Array,
    slow: boolean
  ): void {
    const lt = c.tagBits;
    const nt = Math.floor((480 - c.keyBits) / (lt + 16));
    const seq = MACLT[c.maclt]![(r.sf / 30) % 2]!;
    if (seq.length !== nt) return;
    const nmas = r.nmaHeader >> 6;
    const tagAt = (i: number) => sliceBits(r.mack, i * (lt + 16), lt);
    const infoAt = (i: number) => bitsU(r.mack, i * (lt + 16) + lt, 16);

    if (!slow) {
      // MACSEQ over PRNA ‖ GST_SF ‖ the Tag-Info of the flexible slots.
      const flex: number[] = [];
      seq.forEach((s, i) => s === 'FLX' && flex.push(i));
      const m = new Uint8Array(5 + 2 * flex.length);
      m[0] = r.prna;
      m.set(gst32(r.sf), 1);
      flex.forEach((i, k) => {
        const v = infoAt(i);
        m[5 + 2 * k] = v >> 8;
        m[6 + 2 * k] = v & 0xff;
      });
      const macseq = bitsU(r.mack, lt, 12);
      const calc = bitsU(hmacSha256(key, m), 0, 12);
      if (macseq !== calc) {
        this.event({
          gst: gstOf(r.sf),
          kind: 'macseq-failed',
          prn: prnName(r.prna),
          message: `MACSEQ from ${prnName(r.prna)} does not verify: its tag list is not trusted.`,
        });
        this.tags.failed++;
        return;
      }
    }

    for (let i = 0; i < nt; i++) {
      let prnd: number;
      let adkd: number;
      let cop: number;
      if (i === 0) {
        prnd = r.prna;
        adkd = 0;
        cop = bitsU(r.mack, lt + 12, 4);
      } else {
        const info = infoAt(i);
        prnd = info >> 8;
        adkd = (info >> 4) & 0xf;
        cop = info & 0xf;
      }
      if ((adkd === 12) !== slow) continue;
      const slot = seq[i]!;
      if (slot !== 'FLX') {
        const want = parseInt(slot.slice(0, 2), 10);
        const self = slot[2] === 'S';
        if (adkd !== want || (prnd === r.prna) !== self) {
          this.tags.failed++;
          this.event({
            gst: gstOf(r.sf),
            kind: 'tag-failed',
            prn: prnName(r.prna),
            message: `Tag ${i} from ${prnName(r.prna)} breaks the MAC look-up table (ADKD ${adkd}).`,
          });
          continue;
        }
      }
      if (prnd < 1 || prnd > 36 || (adkd !== 0 && adkd !== 4 && adkd !== 12))
        continue; // constellation-wide or reserved: nothing to check yet
      const nav =
        cop === 0
          ? new Uint8Array(
              Math.ceil((adkd === 4 ? ADKD4_BITS : ADKD0_BITS) / 8)
            )
          : adkd === 4
            ? this.timingData(prnd, r.sf, cop)
            : this.cedData(prnd, r.sf, cop);
      if (!nav) {
        this.tags.unverifiable++;
        continue;
      }
      const nBits = adkd === 4 ? ADKD4_BITS : ADKD0_BITS;
      // m = [PRND] ‖ PRNA ‖ GST_SF ‖ CTR ‖ NMAS ‖ navdata ‖ zero pad
      // (Eq. 24/26; Tag0 has no PRND).
      const head = i === 0 ? 6 : 7;
      const m = new Uint8Array(head + Math.ceil((2 + nBits) / 8));
      let o = 0;
      if (i !== 0) m[o++] = prnd;
      m[o++] = r.prna;
      m.set(gst32(r.sf), o);
      o += 4;
      m[o++] = i + 1;
      m[o] = nmas << 6;
      copyBits(m, 8 * o + 2, nav, 0, nBits);
      const mac = hmacSha256(key, m);
      const ok = eqBits(mac, tagAt(i), lt);
      if (cop === 0) {
        if (ok) this.tags.dummy++;
        else this.tags.failed++;
        continue;
      }
      this.onTag(prnd, adkd, r, nav, ok, lt);
    }
  }

  private onTag(
    prnd: number,
    adkd: number,
    r: MackRecord,
    nav: Uint8Array,
    ok: boolean,
    lt: number
  ): void {
    const s = this.sat(prnd);
    const stats = adkd === 4 ? s.timing : s.ced;
    if (!ok) {
      this.tags.failed++;
      stats.failed++;
      this.event({
        gst: gstOf(r.sf),
        kind: 'tag-failed',
        prn: s.prn,
        message: `${adkd === 4 ? 'Timing' : 'Ephemeris'} tag for ${s.prn} (sent by ${prnName(r.prna)}) does not match its navigation data.`,
      });
      return;
    }
    this.tags.ok++;
    stats.ok++;
    // Accumulate verified tag bits per data set (Guidelines §3.6).
    const group = adkd === 4 ? 4 : 0;
    const id = Array.from(nav).join(',');
    let a = s.acc.get(group);
    if (!a || a.key !== id) s.acc.set(group, (a = { key: id, bits: 0 }));
    a.bits += lt;
    if (a.bits >= MIN_TAG_BITS[adkd]!) {
      if (adkd === 4) s.timing.lastAuthenticated = gstOf(r.sf);
      else {
        s.ced.lastAuthenticated = gstOf(r.sf);
        s.ced.authenticatedIodNav = bitsU(nav, 0, 10); // WT1 IODnav
      }
    }
  }

  /** Latest word of `wt` from `svid` in subframes [sf − 30·cop, sf − 30]. */
  private wordIn(svid: number, wt: number, sf: number, cop: number) {
    const list = this.words.get(svid)?.get(wt);
    if (!list) return undefined;
    const lo = sf - 30 * Math.max(cop, 1);
    for (let i = list.length - 1; i >= 0; i--) {
      const w = list[i]!;
      if (w.sf < sf && w.sf >= lo) return w.word;
      if (w.sf < lo) break;
    }
    return undefined;
  }

  /** ADKD 0/12 data: WT1-5 of one IODnav (Annex B.1). */
  private cedData(svid: number, sf: number, cop: number): Uint8Array | null {
    const out = new Uint8Array(Math.ceil(ADKD0_BITS / 8));
    let at = 0;
    let iod: number | null = null;
    for (const [wt, start, n] of ADKD0_WORDS) {
      const w = this.wordIn(svid, wt, sf, cop);
      if (!w) return null;
      if (wt <= 4) {
        const v = bitsU(w, 6, 10);
        if (iod === null) iod = v;
        else if (v !== iod) return null;
      }
      copyBits(out, at, w, start, n);
      at += n;
    }
    return out;
  }

  /** ADKD 4 data: WT6 ‖ WT10 timing parameters (Annex B.2). */
  private timingData(svid: number, sf: number, cop: number): Uint8Array | null {
    const w6 = this.wordIn(svid, 6, sf, cop);
    const w10 = this.wordIn(svid, 10, sf, Math.max(cop, 2));
    if (!w6 || !w10) return null;
    const out = new Uint8Array(Math.ceil(ADKD4_BITS / 8));
    copyBits(out, 0, w6, 6, 99);
    copyBits(out, 99, w10, 86, 42);
    return out;
  }
}
