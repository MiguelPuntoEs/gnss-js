/**
 * NavIC / IRNSS L5-SPS navigation-message decoder (IRNSS-SIS-ICD-SPS v1.1).
 *
 * The SPS message is a master frame of four 292-bit subframes. Subframes 1 & 2
 * carry the Keplerian ephemeris + SV clock; 3 & 4 carry almanac/iono/UTC
 * messages (not decoded here). Each subframe is 30 header bits (8-bit TLM
 * sync 0x8B, 17-bit TOWC, alert, autonav, 2-bit subframe id, spare), 232 data
 * bits, a 24-bit CRC-24Q, and a 6-bit tail.
 *
 * The field set mirrors GPS LNAV but with NavIC scale factors (Cuc..Cis are
 * 2^-28, Crc/Crs 2^-4, Δn/Ω̇ 2^-41). Output is the shared {@link KeplerEphemeris}
 * (`system` 'I'), so NavIC flows through the same orbit/SPP/RINEX path as GPS,
 * Galileo and BeiDou.
 */
import { getBitU, getBitS, GPS_PI } from './index';
import { crc24q } from './cnav';
import type { KeplerEphemeris } from '../rinex/nav';

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const SEC_PER_WEEK = 604800;
/** Data bits start after the 30-bit subframe header. */
const DATA = 30;

/** CRC-24Q over the first 262 bits, stored at bits 262–285. */
export function navicSubframeCrcOk(sf: Uint8Array): boolean {
  return crc24q(sf, 262) === getBitU(sf, 262, 24);
}

/** Subframe id (1–4) of a NavIC subframe (2-bit field at bit 27, +1). */
export function navicSubframeId(sf: Uint8Array): number {
  return getBitU(sf, 27, 2) + 1;
}

/**
 * Assemble the Keplerian ephemeris from NavIC subframe 1 (`sf1`) and subframe 2
 * (`sf2`), each a 292-bit subframe (only the 232 data bits are read). `refWeek`
 * is the full (non-rolled-over) GPS week the receiver stamped; NavIC system
 * time shares the GPS second-of-week, so `toc`/`toe` map directly.
 */
export function decodeNavicSubframes(
  sf1: Uint8Array,
  sf2: Uint8Array,
  opts: { prn?: string; refWeek?: number } = {}
): KeplerEphemeris | null {
  // ── Subframe 1: SV clock + orbit-correction terms ──
  let i = DATA;
  getBitU(sf1, i, 10); // WN (NavIC week; resolved via refWeek below)
  i += 10;
  const af0 = getBitS(sf1, i, 22) * 2 ** -31;
  i += 22;
  const af1 = getBitS(sf1, i, 16) * 2 ** -43;
  i += 16;
  const af2 = getBitS(sf1, i, 8) * 2 ** -55;
  i += 8;
  i += 4; // URA index
  const tocSec = getBitU(sf1, i, 16) * 16;
  i += 16;
  const tgd = getBitS(sf1, i, 8) * 2 ** -31;
  i += 8;
  const deltaN = getBitS(sf1, i, 22) * 2 ** -41 * GPS_PI;
  i += 22;
  const iode = getBitU(sf1, i, 8); // IODEC
  i += 8;
  i += 10; // reserved
  const l5Health = getBitU(sf1, i, 1);
  i += 1;
  const sHealth = getBitU(sf1, i, 1);
  i += 1;
  const cuc = getBitS(sf1, i, 15) * 2 ** -28;
  i += 15;
  const cus = getBitS(sf1, i, 15) * 2 ** -28;
  i += 15;
  const cic = getBitS(sf1, i, 15) * 2 ** -28;
  i += 15;
  const cis = getBitS(sf1, i, 15) * 2 ** -28;
  i += 15;
  const crc = getBitS(sf1, i, 15) * 2 ** -4;
  i += 15;
  const crs = getBitS(sf1, i, 15) * 2 ** -4;
  i += 15;
  const idot = getBitS(sf1, i, 14) * 2 ** -43 * GPS_PI;

  // ── Subframe 2: Keplerian elements ──
  let j = DATA;
  const m0 = getBitS(sf2, j, 32) * 2 ** -31 * GPS_PI;
  j += 32;
  const toeSec = getBitU(sf2, j, 16) * 16;
  j += 16;
  const e = getBitU(sf2, j, 32) * 2 ** -33;
  j += 32;
  const sqrtA = getBitU(sf2, j, 32) * 2 ** -19;
  j += 32;
  const omega0 = getBitS(sf2, j, 32) * 2 ** -31 * GPS_PI;
  j += 32;
  const omega = getBitS(sf2, j, 32) * 2 ** -31 * GPS_PI;
  j += 32;
  const omegaDot = getBitS(sf2, j, 22) * 2 ** -41 * GPS_PI;
  j += 22;
  const i0 = getBitS(sf2, j, 32) * 2 ** -31 * GPS_PI;

  if (sqrtA <= 0 || e >= 1) return null;

  const week =
    opts.refWeek ??
    Math.floor((Date.now() - GPS_EPOCH_MS) / 1000 / SEC_PER_WEEK);
  const prn = opts.prn ?? 'I00';
  const tocDate = new Date(
    GPS_EPOCH_MS + (week * SEC_PER_WEEK + tocSec) * 1000
  );

  return {
    system: 'I',
    prn,
    tocDate,
    toc: (tocDate.getTime() / 1000) % SEC_PER_WEEK,
    af0,
    af1,
    af2,
    iode,
    crs,
    deltaN,
    m0,
    cuc,
    e,
    cus,
    sqrtA,
    toe: toeSec,
    cic,
    omega0,
    cis,
    i0,
    crc,
    omega,
    omegaDot,
    idot,
    week,
    svHealth: (l5Health << 1) | sHealth,
    tgd,
  };
}

/**
 * Streaming assembler: feed 292-bit NavIC subframes per PRN; emits a fresh
 * ephemeris once a satellite's subframe 1 and 2 are both in hand (deduped by
 * toc + IODEC). Mirrors {@link GpsLnavAssembler} for the raw-frame formats.
 */
export class NavicAssembler {
  private readonly sf1 = new Map<string, Uint8Array>();
  private readonly last = new Map<string, string>();

  /**
   * Push one CRC-valid subframe. Subframe 1 opens a master frame (subframe 2
   * immediately follows it in the NavIC frame order), so an ephemeris is only
   * emitted when a subframe 2 pairs with the subframe 1 that opened the *same*
   * frame — never a stale subframe 1 left over across CRC drops.
   */
  push(
    prn: string,
    subframe: Uint8Array,
    refWeek: number
  ): KeplerEphemeris | null {
    // Alert flag (bit 25) set ⇒ the SV signals its data is unreliable ("use at
    // own risk"); an unhealthy NavIC SV broadcasts a CRC-valid but non-physical
    // ephemeris, so drop it rather than emit a garbage orbit.
    if (getBitU(subframe, 25, 1)) return null;
    const id = navicSubframeId(subframe);
    if (id === 1) {
      this.sf1.set(prn, subframe); // opens a frame
      return null;
    }
    if (id !== 2) return null;

    const a = this.sf1.get(prn);
    if (!a) return null;
    this.sf1.delete(prn); // consume: only this consecutive pair is valid
    const eph = decodeNavicSubframes(a, subframe, { prn, refWeek });
    if (!eph) return null;

    const key = `${eph.toc}|${eph.iode}`;
    if (this.last.get(prn) === key) return null;
    this.last.set(prn, key);
    return eph;
  }
}
