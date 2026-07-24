import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseBinex, getBnxi, binexCsum8, binexCrc16 } from '../src/binex';

/**
 * Fixtures are single-record BINEX test vectors from EarthScope's
 * gnsstools (codecs/binex/data, Apache-2.0). The GPS (0x01-01) and
 * GLONASS (0x01-02) records ship with teqc-generated RINEX 2 oracles;
 * every decoded field below is pinned to those oracles. The 0x7f-05
 * observation record has no RINEX oracle, so it is checked for
 * internal consistency (checksum coverage, sane ranges, phase↔range
 * coherence) against a full 45-satellite epoch.
 */
const FIX = join(__dirname, '../test-fixtures');
const load = (name: string) => new Uint8Array(readFileSync(join(FIX, name)));
const has = (name: string) => existsSync(join(FIX, name));

/* ── ubnxi + checksum unit tests (no fixture) ──────────────────── */

describe('BINEX ubnxi (getBnxi)', () => {
  it('decodes 1–4 byte big-endian continuation integers', () => {
    // 1-byte: high bit clear
    expect(getBnxi(Uint8Array.of(0x49), 0)).toEqual({ value: 73, size: 1 });
    // 2-byte: 0x81 0x00 → (1<<7)+0 = 128 (the XOR-8 / CRC16 boundary)
    expect(getBnxi(Uint8Array.of(0x81, 0x00), 0)).toEqual({
      value: 128,
      size: 2,
    });
    // 2-byte: 0x90 0x5e → (0x10<<7)+0x5e = 2142 (the obs-record length)
    expect(getBnxi(Uint8Array.of(0x90, 0x5e), 0)).toEqual({
      value: 2142,
      size: 2,
    });
    // 3-byte
    expect(getBnxi(Uint8Array.of(0x81, 0x81, 0x00), 0)).toEqual({
      value: 16512,
      size: 3,
    });
    // 4-byte: first three continue, fourth is a full 8 bits
    expect(getBnxi(Uint8Array.of(0x81, 0x81, 0x81, 0xff), 0)).toEqual({
      value: 4227583,
      size: 4,
    });
  });
});

describe('BINEX checksums', () => {
  it('computes the XOR-8 and CRC16 the framing selects by length', () => {
    const b = Uint8Array.of(0x01, 0x02, 0x03, 0x04);
    expect(binexCsum8(b, 0, 4)).toBe(0x01 ^ 0x02 ^ 0x03 ^ 0x04);
    // CRC16-CCITT (poly 0x1021, init 0) of {0x00} is 0.
    expect(binexCrc16(Uint8Array.of(0x00), 0, 1)).toBe(0);
  });
});

/* ── GPS ephemeris 0x01-01 vs teqc RINEX oracle ────────────────── */

describe.skipIf(!has('binex_gps_eph.bnx'))(
  'parseBinex (0x01-01 GPS eph)',
  () => {
    const res = has('binex_gps_eph.bnx')
      ? parseBinex(load('binex_gps_eph.bnx'))
      : null!;

    it('frames one record with a valid checksum', () => {
      expect(res.badCrc).toBe(0);
      expect(res.messageCounts['0x01-01']).toBe(1);
      expect(res.ephemerides.length).toBe(1);
    });

    it('matches every field of the RINEX oracle (PRN G32, week 1657)', () => {
      const e = res.ephemerides[0]!;
      if (!('iode' in e)) throw new Error('expected a Keplerian ephemeris');
      expect(e.prn).toBe('G32');
      expect(e.system).toBe('G');
      expect(e.tocDate.getTime()).toBe(Date.UTC(2011, 9, 11, 4, 0, 0));
      expect(e.week).toBe(1657);
      expect(e.toe).toBe(187200);
      expect(e.af0).toBeCloseTo(-3.434410318732e-4, 16);
      expect(e.af1).toBeCloseTo(-6.36646291241e-12, 18);
      expect(e.af2).toBe(0);
      expect(e.iode).toBe(66);
      expect(e.crs).toBeCloseTo(76.25, 6);
      expect(e.deltaN).toBeCloseTo(5.145928634297e-9, 18);
      expect(e.m0).toBeCloseTo(5.779880987472e-1, 10);
      expect(e.e).toBeCloseTo(1.218166504987e-2, 12);
      expect(e.sqrtA).toBeCloseTo(5.153549472809e3, 5);
      expect(e.omega0).toBeCloseTo(-2.241032253589, 9);
      expect(e.i0).toBeCloseTo(9.536347329087e-1, 10);
      expect(e.crc).toBeCloseTo(287.53125, 5);
      expect(e.omega).toBeCloseTo(-7.17269211176e-1, 10);
      expect(e.omegaDot).toBeCloseTo(-8.62321633443e-9, 18);
      expect(e.idot).toBeCloseTo(4.360895934534e-10, 20);
      expect(e.svHealth).toBe(0);
      expect(e.tgd).toBeCloseTo(-2.793967723846e-9, 18);
    });
  }
);

/* ── GLONASS ephemeris 0x01-02 vs teqc RINEX oracle ────────────── */

describe.skipIf(!has('binex_glo_eph.bnx'))(
  'parseBinex (0x01-02 GLONASS eph)',
  () => {
    const res = has('binex_glo_eph.bnx')
      ? parseBinex(load('binex_glo_eph.bnx'))
      : null!;

    it('matches the RINEX oracle (slot R12, state vector in km)', () => {
      expect(res.badCrc).toBe(0);
      const e = res.ephemerides[0]!;
      if ('iode' in e) throw new Error('expected a state-vector ephemeris');
      expect(e.prn).toBe('R12');
      expect(e.system).toBe('R');
      // day 1429 (era 0) + tod−10800 → 1983-11-29 00:15:00 UTC
      expect(e.tocDate.getTime()).toBe(Date.UTC(1983, 10, 29, 0, 15, 0));
      expect(e.tauN).toBeCloseTo(3.392156213522e-5, 14);
      expect(e.gammaN).toBe(0);
      expect(e.messageFrameTime).toBe(1380);
      expect(e.x).toBeCloseTo(-2.320079394531e4, 6);
      expect(e.xDot).toBeCloseTo(5.899152755737e-1, 10);
      expect(e.xAcc).toBeCloseTo(-2.793967723846e-9, 18);
      expect(e.y).toBeCloseTo(9.671173339844e3, 6);
      expect(e.z).toBeCloseTo(4.311312011719e3, 6);
      expect(e.zDot).toBeCloseTo(3.503056526184, 9);
      expect(e.freqNum).toBe(-1);
      expect(e.health).toBe(0);
    });
  }
);

/* ── other single-record ephemeris vectors (no RINEX oracle) ───── */

describe.skipIf(!has('binex_gal_eph.bnx'))(
  'parseBinex (Galileo/BeiDou/QZSS/SBAS eph)',
  () => {
    const one = (name: string) => parseBinex(load(name)).ephemerides[0]!;

    it('decodes Galileo 0x01-04 into a sane Keplerian record', () => {
      const e = one('binex_gal_eph.bnx');
      expect(e.system).toBe('E');
      expect(e.prn).toBe('E24');
      if (!('iode' in e)) throw new Error('expected Keplerian');
      expect(e.sqrtA).toBeGreaterThan(5000);
      expect(e.sqrtA).toBeLessThan(5500);
      expect(e.e).toBeLessThan(0.02);
      expect(e.week).toBe(1899);
    });

    it('decodes BeiDou 0x01-05 with B1 group delay and BDT week', () => {
      const e = one('binex_bds_eph.bnx');
      expect(e.system).toBe('C');
      expect(e.prn).toBe('C38');
      if (!('iode' in e)) throw new Error('expected Keplerian');
      expect(e.sqrtA).toBeGreaterThan(5000);
      expect(Math.abs(e.tgd)).toBeLessThan(1e-7);
    });

    it('decodes QZSS 0x01-06 (J04, geosync eccentric/inclined)', () => {
      const e = one('binex_qzss_eph.bnx');
      expect(e.system).toBe('J');
      expect(e.prn).toBe('J04');
      if (!('iode' in e)) throw new Error('expected Keplerian');
      expect(e.sqrtA).toBeCloseTo(6493.58, 1); // a ≈ 42164 km
    });

    it('decodes SBAS 0x01-03 into a state-vector record', () => {
      const e = one('binex_sbas_eph.bnx');
      expect(e.system).toBe('S');
      if ('iode' in e) throw new Error('expected state-vector');
      const r = Math.hypot(e.x, e.y, e.z);
      expect(r).toBeGreaterThan(40000); // GEO radius ≈ 42164 km
      expect(r).toBeLessThan(44000);
    });
  }
);

/* ── observation record 0x7f-05 (45-sat multi-GNSS epoch) ──────── */

describe.skipIf(!has('binex_obs_7f05.bnx'))(
  'parseBinex (0x7f-05 observations)',
  () => {
    const res = has('binex_obs_7f05.bnx')
      ? parseBinex(load('binex_obs_7f05.bnx'))
      : null!;

    it('frames one epoch with a valid CRC16', () => {
      expect(res.badCrc).toBe(0);
      expect(res.messageCounts['0x7f-05']).toBe(1);
      expect(res.epochs.length).toBe(1);
    });

    it('decodes the receiver epoch in the RINEX parser convention', () => {
      expect(res.epochs[0]!.timeMs).toBe(Date.UTC(2023, 10, 29, 0, 59, 59));
    });

    it('decodes all 45 satellites across six constellations', () => {
      const meas = res.epochs[0]!.meas;
      expect(meas.length).toBe(172);
      const sats: Record<string, Set<string>> = {};
      for (const m of meas) (sats[m.prn[0]!] ??= new Set()).add(m.prn);
      const count = (s: string) => sats[s]?.size ?? 0;
      expect(count('G')).toBe(12);
      expect(count('E')).toBe(10);
      expect(count('J')).toBe(1);
      expect(count('C')).toBe(10);
      expect(count('S')).toBe(3);
      expect(count('R')).toBe(9);
    });

    it('maps BeiDou B1I to the "2I" convention (as SBF/NovAtel do)', () => {
      expect(res.obsCodes['C']).toContain('2I');
      expect(res.obsCodes['G']).toEqual(expect.arrayContaining(['1C', '2W']));
    });

    const at = (prn: string, code: string) =>
      res.epochs[0]!.meas.find((m) => m.prn === prn && m.code === code);

    it('decodes GPS G22 pseudorange/phase/Doppler/SNR', () => {
      const g = at('G22', '1C')!;
      expect(g.pr).toBeCloseTo(20537032.564, 3);
      expect(g.cp).toBeCloseTo(107923048.187, 2);
      expect(g.doppler).toBeCloseTo(79.535, 2);
      expect(g.cn0).toBeCloseTo(48.6, 6);
      expect(g.slip).toBe(false);
    });

    it('resolves the GLONASS FCN so every FDMA phase is in cycles', () => {
      const glo = res.epochs[0]!.meas.filter((m) => m.prn[0] === 'R');
      expect(glo.length).toBeGreaterThan(0);
      for (const m of glo) expect(m.cp).not.toBeNull();
    });

    it('is internally consistent (ranges, SNR, phase↔range)', () => {
      const C = 299792458;
      for (const m of res.epochs[0]!.meas) {
        if (m.pr !== null) {
          expect(m.pr).toBeGreaterThan(1e6);
          expect(m.pr).toBeLessThan(5e7);
        }
        if (m.cn0 !== null) {
          expect(m.cn0).toBeGreaterThan(10);
          expect(m.cn0).toBeLessThan(65);
        }
        // GPS L1 phase range must track the pseudorange to within metres.
        if (m.prn[0] === 'G' && m.code === '1C' && m.cp !== null) {
          const phaseM = (m.cp * C) / 1575.42e6;
          expect(Math.abs(phaseM - m.pr!)).toBeLessThan(100);
        }
      }
    });
  }
);

/* ── corrupt-frame rejection ───────────────────────────────────── */

describe.skipIf(!has('binex_gps_eph.bnx'))('parseBinex (bad checksum)', () => {
  it('counts a corrupted record and decodes nothing from it', () => {
    const bad = load('binex_gps_eph.bnx');
    bad[20]! ^= 0xff; // flip a body byte
    const res = parseBinex(bad);
    expect(res.badCrc).toBe(1);
    expect(res.ephemerides.length).toBe(0);
  });
});
