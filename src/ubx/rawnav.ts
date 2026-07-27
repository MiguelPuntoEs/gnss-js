/**
 * u-blox UBX raw navigation-message decoding for the non-GPS
 * constellations: Galileo I/NAV (E1B/E5b), BeiDou D1/D2 (B1I/B2I),
 * GLONASS L1/L2 C/A strings and SBAS L1 C/A GEO navigation (message
 * type 9) from RXM-SFRBX (class 0x02, id 0x13). GPS/QZSS LNAV stays in
 * `parseUbxNav` (./nav.ts) and GPS CNAV in `parseUbxCnav` (./cnav.ts).
 *
 * The per-constellation word repack is a port of RTKLIB demo5
 * (rtklibexplorer fork, src/rcv/ublox.c: decode_rxmsfrbx routing into
 * decode_inav / decode_cnav / decode_gnav, Copyright (c) 2007-2020
 * T. Takasu, BSD-2-Clause); the bit-field decoding and data-set
 * assembly live in src/navbits (gal.ts / bds.ts / glo.ts), shared with
 * the Septentrio SBF path (src/sbf/rawnav-gal.ts / rawnav-bds.ts).
 *
 * How u-blox packs each message into the little-endian 32-bit `dwrd`
 * words (interface description §RXM-SFRBX; verified on a ZED-F9P
 * capture against convbin):
 *
 * - Galileo I/NAV (gnssId 2, sigId 1 = E1B, 5 = E5b): one nominal page
 *   pair per message, bits MSB-first — the 114-bit even part
 *   left-justified in dwrd 0-3 (pad bits 114-127 ignored) and the
 *   120-bit odd part left-justified in dwrd 4-7. E1B messages carry a
 *   9th reserved word, E5b messages 8 words; both repack identically
 *   (RTKLIB decode_inav reads 8 dwrds for either). The two carriers
 *   broadcast the same words and feed ONE assembler per satellite,
 *   like RTKLIB's shared subframe buffer and the SBF module's single
 *   I/NAV assembler. u-blox does not track E5a, so F/NAV (sigId 3) is
 *   out of scope; E6 (sigId 8) is skipped like RTKLIB.
 * - BeiDou D1/D2 (gnssId 3, B1I sigId 0/1, B2I sigId 2/3): ten dwrds,
 *   each carrying one 30-bit word in its 30 LSBs, already
 *   de-interleaved with the BCH parity bits in place — exactly the
 *   300-bit layout `bdsSubframeParityOk` / `BdsAssembler` expect
 *   (RTKLIB decode_cnav packs `U4(p)` low 30 bits straight into its
 *   subframe buffer). B1I and B2I carry the same message and share
 *   the assembler.
 * - GLONASS (gnssId 6, sigId 0 = L1OF, 2 = L2OF): four dwrds holding
 *   the 85-bit navigation string MSB-first from the idle bit (RTKLIB
 *   repacks each little-endian dwrd big-endian: `buff[k]=p[3-j]`);
 *   bits 85-95 are padding and dwrd 3 carries the receiver-counted
 *   superframe/frame numbers. The frequency slot is the payload
 *   `freqId` minus 7. L1 and L2 strings are identical and share one
 *   assembler per slot.
 *
 * Parity handling: the receiver marks nothing in SFRBX, so every
 * integrity check is re-run here — CRC-24Q per I/NAV page pair,
 * BCH(15,11,1) per BDS word, Hamming (KX) per GLONASS string —
 * and `badParity` counts exactly the messages rejected for a failed
 * check. (RTKLIB checks only the GLONASS Hamming code and the I/NAV
 * CRC on this path; the BDS BCH check is this library's addition, as
 * in the SBF module.)
 *
 * GLONASS time reference: tk/tb count into a UTC day, so each string
 * needs a receiver time stamp (RTKLIB `raw->time`, set by the last
 * RXM-RAWX). This parser mirrors that: the running reference is the
 * most recent RXM-RAWX epoch (GPS week + rcvTow) in the stream, never
 * the system clock; GLONASS strings seen before the first time
 * reference are skipped. `refWeek` substitutes for the RAWX week
 * field only when the receiver reports it as 0 (time not yet known).
 *
 * Documented deviations from RTKLIB's u-blox path:
 * - GLONASS string buffers reset on a > 30 s gap between strings
 *   (`GloStringAssembler`), not on the u-blox frame-number change
 *   RTKLIB uses (dwrd-3 bytes it stores as "frame-id") — the
 *   convention the SBF port settled, where no frame counter exists.
 * - The RINEX GLONASS message-frame-time comes from the broadcast tk
 *   of the frame that completed the record, not the receiver time of
 *   day (RTKLIB's geph->tof) — see the oracle notes in
 *   test/bdsglo-raw.test.ts; the two differ by the ~8 s string-4
 *   offset within the frame.
 */

import { getBitU, setBitU } from '../navbits';
import { BdsAssembler, bdsSubframeParityOk } from '../navbits/bds';
import { GalInavAssembler, galInavPageCrcOk } from '../navbits/gal';
import { GloStringAssembler, testGloString } from '../navbits/glo';
import { decodeSbasGeoNav, sbasCrcOk } from '../navbits/sbas';
import type { Ephemeris } from '../rinex/nav';
import { ubxFrames } from './frame';

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const SEC_PER_WEEK = 7 * 86400;

const two = (n: number) => String(n).padStart(2, '0');

export interface UbxRawNavOptions {
  /**
   * Full GPS week substituted for the RXM-RAWX week field when the
   * receiver reports it as 0 (time not yet resolved). The GLONASS
   * day reference always comes from RAWX epochs in the stream —
   * a stream without any usable RXM-RAWX time stamp yields no
   * GLONASS ephemerides (Galileo and BeiDou messages carry their own
   * week and are decoded regardless); the system clock is never used.
   */
  refWeek?: number;
}

export interface UbxRawNavResult {
  /**
   * Broadcast ephemerides in stream order, unchanged rebroadcasts
   * suppressed: Galileo I/NAV (`system: 'E'`, RINEX I/NAV clock set),
   * BeiDou D1/D2 (`system: 'C'`, BDT epochs/weeks), GLONASS
   * (`system: 'R'`, UTC epochs, km state vectors) and SBAS GEO
   * (`system: 'S'`, GPS-scale epochs, km state vectors).
   */
  ephemerides: Ephemeris[];
  /** RXM-SFRBX messages routed to each constellation's decoder:
   * `gal` = E1B + E5b I/NAV pages, `bds` = B1I + B2I subframes,
   * `glo` = L1 + L2 C/A strings, `sbas` = L1 C/A GEO messages. */
  counts: { gal: number; bds: number; glo: number; sbas: number };
  /** Messages dropped for a failed integrity check: I/NAV page
   * CRC-24Q, BDS BCH(15,11,1) word parity, GLONASS Hamming (KX),
   * SBAS CRC-24Q. */
  badParity: number;
}

/**
 * Decode every Galileo/BeiDou/GLONASS broadcast ephemeris in a UBX
 * byte stream (RXM-SFRBX), the way `parseUbxNav` does for GPS/QZSS.
 * See the module header for the per-constellation repack, parity and
 * time-reference conventions.
 */
export function parseUbxRawNav(
  data: Uint8Array,
  opts: UbxRawNavOptions = {}
): UbxRawNavResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ephemerides: Ephemeris[] = [];
  const counts = { gal: 0, bds: 0, glo: 0, sbas: 0 };
  let badParity = 0;

  const inav = new GalInavAssembler();
  const bds = new BdsAssembler();
  const glo = new GloStringAssembler();

  /** Most recent RXM-RAWX epoch (GPS scale) — RTKLIB's raw->time. */
  let refDate: Date | null = null;
  /** …and its GPS week / time-of-week, for the SBAS t0 anchor. */
  let refWeek = 0;
  let refTow = 0;
  /** Suppress unchanged SBAS GEO rebroadcasts (per PRN + epoch). */
  const sbasSeen = new Set<string>();

  for (const f of ubxFrames(data)) {
    if (f.msgClass !== 0x02) continue;

    if (f.msgId === 0x15 && f.payload.length >= 16) {
      /* RXM-RAWX: running receiver-time reference for GLONASS. */
      const rcvTow = view.getFloat64(f.payloadStart, true);
      let week = view.getUint16(f.payloadStart + 8, true);
      if (week === 0 && opts.refWeek !== undefined) week = opts.refWeek;
      if (week > 0) {
        refDate = new Date(
          GPS_EPOCH_MS + (week * SEC_PER_WEEK + rcvTow) * 1000
        );
        refWeek = week;
        refTow = rcvTow;
      }
      continue;
    }

    if (f.msgId !== 0x13) continue;
    const p = f.payload;
    // gnssId, svId, sigId, freqId, numWords, chn, version, reserved0
    if (p.length < 8) continue;
    const gnssId = p[0]!;
    const svId = p[1]!;
    const sigId = p[2]!;
    const base = f.payloadStart + 8;

    if (gnssId === 2) {
      /* ── Galileo I/NAV (E1B sigId 1, E5b sigId 5) ─────────────── */
      if (sigId === 3 || sigId === 8) continue; // E5a F/NAV, E6: no data here
      if (p.length < 8 + 32) continue; // 8 dwrds (E1B has a 9th, reserved)
      counts.gal++;
      if (svId < 1 || svId > 36) continue;

      // Repack: 114-bit even part (dwrd 0-3, left-justified) + 120-bit
      // odd part (dwrd 4-7) → the 234-bit page pair the assembler and
      // CRC helper expect (RTKLIB decode_inav's buff/subfrm layout).
      const buff = new Uint8Array(32);
      for (let k = 0; k < 8; k++) {
        const w = view.getUint32(base + 4 * k, true);
        buff[4 * k] = w >>> 24;
        buff[4 * k + 1] = (w >>> 16) & 0xff;
        buff[4 * k + 2] = (w >>> 8) & 0xff;
        buff[4 * k + 3] = w & 0xff;
      }
      const page = new Uint8Array(30);
      for (let k = 0; k < 14; k++) page[k] = buff[k]!; // even bits 0-111
      setBitU(page, 112, 2, getBitU(buff, 112, 2)); // even bits 112-113
      for (let k = 0; k < 15; k++) {
        setBitU(page, 114 + 8 * k, 8, getBitU(buff, 128 + 8 * k, 8)); // odd
      }

      // Nominal even+odd pair expected before the CRC span applies
      // (alert pages and stray part ordering: skipped, not badParity).
      if (getBitU(page, 0, 1) !== 0 || getBitU(page, 114, 1) !== 1) continue;
      if (getBitU(page, 1, 1) === 1 || getBitU(page, 115, 1) === 1) continue;
      if (!galInavPageCrcOk(page)) {
        badParity++;
        continue;
      }
      const eph = inav.push(svId, page);
      if (eph) ephemerides.push(eph);
    } else if (gnssId === 3) {
      /* ── BeiDou D1/D2 (B1I sigId 0/1, B2I sigId 2/3) ──────────── */
      if (sigId === 6 || sigId === 8) continue; // B1C/B2a: no D1/D2
      if (p.length < 8 + 40) continue; // 10 dwrds
      counts.bds++;
      if (svId < 1 || svId > 63) continue;

      // Repack: one 30-bit word in the 30 LSBs of each dwrd, already
      // de-interleaved with BCH parity in place (RTKLIB decode_cnav).
      const sf = new Uint8Array(38);
      for (let k = 0; k < 10; k++) {
        const w = view.getUint32(base + 4 * k, true);
        setBitU(sf, 30 * k, 30, w & 0x3fffffff);
      }

      if (!bdsSubframeParityOk(sf)) {
        badParity++;
        continue;
      }
      const eph = bds.push(`C${two(svId)}`, sf);
      if (eph) ephemerides.push(eph);
    } else if (gnssId === 6) {
      /* ── GLONASS L1/L2 C/A strings (sigId 0/2) ────────────────── */
      if (p.length < 8 + 16) continue; // 4 dwrds
      counts.glo++;
      if (svId < 1 || svId > 32) continue; // svId 255: unknown slot

      // Repack: each little-endian dwrd big-endian — bit 0 of the
      // result is the idle bit, string bit 85 (RTKLIB decode_gnav).
      const str = new Uint8Array(16);
      for (let k = 0; k < 4; k++) {
        const w = view.getUint32(base + 4 * k, true);
        str[4 * k] = w >>> 24;
        str[4 * k + 1] = (w >>> 16) & 0xff;
        str[4 * k + 2] = (w >>> 8) & 0xff;
        str[4 * k + 3] = w & 0xff;
      }

      if (!testGloString(str)) {
        badParity++;
        continue;
      }
      if (!refDate) continue; // no receiver time yet: day unresolvable
      const eph = glo.push(`R${two(svId)}`, str, refDate, p[3]! - 7);
      if (eph) ephemerides.push(eph);
    } else if (gnssId === 1) {
      /* ── SBAS L1 C/A GEO navigation (message type 9) ──────────── */
      if (p.length < 8 + 32) continue; // 8 dwrds (250-bit message)
      counts.sbas++;
      if (svId < 120 || svId > 158) continue;

      // Repack: each little-endian dwrd big-endian → the 250-bit
      // message MSB-first (RTKLIB decode_snav).
      const msg = new Uint8Array(32);
      for (let k = 0; k < 8; k++) {
        const w = view.getUint32(base + 4 * k, true);
        msg[4 * k] = w >>> 24;
        msg[4 * k + 1] = (w >>> 16) & 0xff;
        msg[4 * k + 2] = (w >>> 8) & 0xff;
        msg[4 * k + 3] = w & 0xff;
      }

      if (!sbasCrcOk(msg)) {
        badParity++;
        continue;
      }
      if (refWeek === 0) continue; // no receiver time yet: t0 unresolvable
      const eph = decodeSbasGeoNav(msg, svId, refWeek, refTow);
      if (eph) {
        const key = `${eph.prn}@${eph.tocDate.getTime()}`;
        if (!sbasSeen.has(key)) {
          sbasSeen.add(key);
          ephemerides.push(eph);
        }
      }
    }
    // gnssId 0/5 (GPS/QZSS): parseUbxNav / parseUbxCnav
  }

  return { ephemerides, counts, badParity };
}
