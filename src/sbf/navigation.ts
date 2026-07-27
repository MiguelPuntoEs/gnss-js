/**
 * One-pass SBF navigation decoder.
 *
 * A Septentrio broadcasts navigation data as a mix of *decoded* blocks
 * (GPSNav/GALNav/GLONav/BDSNav/QZSNav — already-parsed ephemeris) and
 * *raw* navigation-frame blocks (GPSRawCA, GALRawINAV/FNAV, GLORawCA,
 * BDSRaw, GPSRawL2C/L5, GEORawL1) whose bits must be assembled — and which class a
 * given receiver emits depends on its configuration. The granular
 * `parseSbf*` functions each re-scan the whole stream for one class;
 * this decoder walks the byte stream **once**, routing every navigation
 * block through a single dispatch to the same per-block `feed*` helpers,
 * and returns the merged, de-duplicated result. It is the decoder a
 * consumer that just wants "all the ephemeris in this SBF" should call.
 *
 * Merge/de-dup: assemblers already suppress repeats of an unchanged
 * issue of data within a scan; across the decoded and raw paths, records
 * are de-duped by (prn, time-of-clock, Galileo I/NAV-vs-F/NAV source),
 * so a stream carrying both a decoded GALNav block and the raw I/NAV
 * pages for the same epoch yields one record, while the distinct Galileo
 * I/NAV and F/NAV clock sets are both kept.
 */

import type { Ephemeris } from '../rinex/nav';
import { scanSbfFrames } from './frame';
import {
  decodeGpsQzsNav,
  decodeGalNav,
  decodeBdsNav,
  decodeGloNav,
} from './nav';
import {
  feedCnavBlock,
  newCnavAssemblers,
  type SbfCnavEphemeris,
} from './rawnav';
import { feedGalBlock, newGalAssemblers } from './rawnav-gal';
import { feedBdsBlock, feedGloBlock } from './rawnav-bds';
import { feedGpsLnavBlock } from './rawnav-gps';
import { feedGeoBlock } from './rawnav-sbas';
import { BdsAssembler } from '../navbits/bds';
import { GloStringAssembler } from '../navbits/glo';
import { GpsLnavAssembler } from '../navbits';

const F4_DNU = -2e10;

/** Per-source diagnostics — how many blocks of each class were seen. */
export interface SbfNavCounts {
  /** Decoded ephemeris blocks (GPSNav/GALNav/GLONav/BDSNav/QZSNav). */
  decodedNav: number;
  /** Raw GPS/QZSS LNAV blocks (GPSRawCA/QZSRawL1CA). */
  gpsLnavRaw: number;
  /** Raw GPS CNAV blocks (GPSRawL2C/L5). */
  cnavRaw: number;
  /** Raw Galileo page blocks (GALRawINAV/FNAV). */
  galRaw: number;
  /** Raw GLONASS string blocks (GLORawCA). */
  gloRaw: number;
  /** Raw BeiDou D1/D2 subframe blocks (BDSRaw). */
  bdsRaw: number;
  /** Raw SBAS L1 GEO message blocks (GEORawL1). */
  sbasRaw: number;
  /** Frames dropped by a CRC/parity check across all raw decoders. */
  badFrames: number;
}

export interface SbfNavigation {
  /**
   * Legacy Keplerian + GLONASS ephemerides, merged from the decoded Nav
   * blocks and the raw GAL I/NAV+F/NAV, GLO strings, BDS D1/D2 and
   * GPS/QZSS LNAV assemblers, de-duped as described in the module header.
   */
  ephemerides: Ephemeris[];
  /** GPS L2C/L5 CNAV ephemerides (RINEX-4 nav records). */
  cnav: SbfCnavEphemeris[];
  /**
   * Iono coefficient sets keyed like `NavHeader.ionoCorrections`
   * (GPSA/GPSB, GAL, BDSA/BDSB); the last valid block of each type wins.
   */
  ionoCorrections: Record<string, number[]>;
  /** GPS-UTC ΔtLS from the last GPSUtc block, if any. */
  leapSeconds: number | null;
  counts: SbfNavCounts;
}

/** De-dup key: PRN + clock epoch + Galileo I/NAV-vs-F/NAV source. */
function ephKey(e: Ephemeris): string {
  const source = 'source' in e ? (e as { source: string }).source : '';
  return `${e.prn}|${e.tocDate.getTime()}|${source}`;
}

/**
 * Decode every navigation block in an SBF byte stream in a single pass:
 * decoded ephemeris blocks, raw GPS/QZSS LNAV, GPS CNAV, Galileo I/NAV +
 * F/NAV, GLONASS strings, BeiDou D1/D2, and the Klobuchar/NeQuick iono +
 * GPS-UTC leap-second blocks. See the module header for merge semantics.
 */
export function decodeSbfNavigation(
  data: Uint8Array,
  opts: {
    /** Called for every CRC-valid SBAS L1 message (all types) — feed an
     *  {@link ../positioning/sbas.SbasProcessor} to build SBAS corrections. */
    onSbasMessage?: (
      msg: Uint8Array,
      prn: number,
      week: number,
      tow: number
    ) => void;
  } = {}
): SbfNavigation {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const ephemerides: Ephemeris[] = [];
  const seen = new Set<string>();
  const cnav: SbfCnavEphemeris[] = [];
  const ionoCorrections: Record<string, number[]> = {};
  let leapSeconds: number | null = null;
  const counts: SbfNavCounts = {
    decodedNav: 0,
    gpsLnavRaw: 0,
    cnavRaw: 0,
    galRaw: 0,
    gloRaw: 0,
    bdsRaw: 0,
    sbasRaw: 0,
    badFrames: 0,
  };

  // Assemblers are stateful across the whole scan (one instance each).
  const cnavAsm = newCnavAssemblers();
  const galAsm = newGalAssemblers();
  const gloAsm = new GloStringAssembler();
  const bdsAsm = new BdsAssembler();
  const lnavAsm = new GpsLnavAssembler();

  const addEph = (e: Ephemeris | null) => {
    if (!e) return;
    const key = ephKey(e);
    if (seen.has(key)) return;
    seen.add(key);
    ephemerides.push(e);
  };

  /** Read `n` consecutive f4 fields, or null when any is do-not-use. */
  const f4s = (b: number, n: number): number[] | null => {
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      const v = view.getFloat32(b + 4 * k, true);
      if (v === F4_DNU) return null;
      out.push(v);
    }
    return out;
  };

  scanSbfFrames(data, view, (id, b, len) => {
    switch (id) {
      /* ---- decoded ephemeris blocks ---- */
      case 5891: // GPSNav
        if (len >= 140) {
          counts.decodedNav++;
          addEph(decodeGpsQzsNav(view, b, 'G'));
        }
        return;
      case 4095: // QZSNav
        if (len >= 140) {
          counts.decodedNav++;
          addEph(decodeGpsQzsNav(view, b, 'J'));
        }
        return;
      case 4002: // GALNav
        if (len >= 149) {
          counts.decodedNav++;
          addEph(decodeGalNav(view, b));
        }
        return;
      case 4081: // BDSNav
        if (len >= 140) {
          counts.decodedNav++;
          addEph(decodeBdsNav(view, b));
        }
        return;
      case 4004: // GLONav
        if (len >= 96) {
          counts.decodedNav++;
          addEph(decodeGloNav(view, b));
        }
        return;

      /* ---- raw navigation-frame blocks ---- */
      case 4017: // GPSRawCA
      case 4066: {
        // QZSRawL1CA
        if (len < 60) return;
        counts.gpsLnavRaw++;
        const r = feedGpsLnavBlock(view, b, lnavAsm);
        if (r.eph) addEph(r.eph);
        else if (r.badParity) counts.badFrames++;
        return;
      }
      case 4018: // GPSRawL2C
      case 4019: {
        // GPSRawL5
        if (len < 60) return;
        counts.cnavRaw++;
        const r = feedCnavBlock(view, b, id, cnavAsm);
        if (r.eph) cnav.push(r.eph);
        else if (r.badCrc) counts.badFrames++;
        return;
      }
      case 4022: // GALRawFNAV
      case 4023: {
        // GALRawINAV
        if (len < 52) return;
        counts.galRaw++;
        const r = feedGalBlock(data, view, b, id, galAsm);
        if (r.eph) addEph(r.eph);
        else if (r.badCrc) counts.badFrames++;
        return;
      }
      case 4026: {
        // GLORawCA
        if (len < 32) return;
        counts.gloRaw++;
        const r = feedGloBlock(view, b, gloAsm);
        if (r.eph) addEph(r.eph);
        else if (r.badCrc) counts.badFrames++;
        return;
      }
      case 4047: {
        // BDSRaw
        if (len < 60) return;
        counts.bdsRaw++;
        const r = feedBdsBlock(view, b, bdsAsm);
        if (r.eph) addEph(r.eph);
        else if (r.badCrc) counts.badFrames++;
        return;
      }
      case 4020: {
        // GEORawL1 (SBAS L1 C/A GEO message)
        if (len < 52) return;
        counts.sbasRaw++;
        const r = feedGeoBlock(view, b, opts.onSbasMessage);
        if (r.eph) addEph(r.eph);
        else if (r.badCrc) counts.badFrames++;
        return;
      }

      /* ---- iono / UTC ---- */
      case 5893: // GPSIon
      case 4120: {
        // BDSIon
        if (len < 48) return;
        const alpha = f4s(b + 16, 4);
        const beta = f4s(b + 32, 4);
        if (!alpha || !beta) return;
        const sys = id === 5893 ? 'GPS' : 'BDS';
        ionoCorrections[`${sys}A`] = alpha;
        ionoCorrections[`${sys}B`] = beta;
        return;
      }
      case 4030: {
        // GALIon
        if (len < 28) return;
        const ai = f4s(b + 16, 3);
        if (ai) ionoCorrections['GAL'] = ai;
        return;
      }
      case 5894: // GPSUtc
        if (len >= 37) leapSeconds = view.getInt8(b + 33);
        return;
    }
  });

  return { ephemerides, cnav, ionoCorrections, leapSeconds, counts };
}
