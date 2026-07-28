import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseSbfGeoL5, decodeSbfNavigation } from '../src/sbf/index';
import { SbasProcessor } from '../src/positioning/sbas';
import {
  sbasL5MessageName,
  isSbasL5Correction,
  SBAS_L5_PREAMBLE_UW,
} from '../src/navbits/sbas-l5';

const FIX = join(__dirname, '../test-fixtures/sbf_sbas_l5_slice.sbf');

describe.skipIf(!existsSync(FIX))('SBAS L5 / DFMC (DLF500 GEORawL5)', () => {
  const data = new Uint8Array(readFileSync(FIX));

  it('splits L5 frames into DO-229-on-L5 (legacy) and native DFMC', () => {
    const r = parseSbfGeoL5(data);
    // The 5-min DLF500 slice: ~1200 GEORawL5 frames, all CRC-valid.
    expect(r.messages).toBeGreaterThan(1000);
    expect(r.badCrc).toBe(0);
    // Two EGNOS GEOs relay DO-229 content on L5 (decodable), two broadcast
    // native DFMC — so both buckets are non-empty.
    expect(r.legacyMessages).toBeGreaterThan(300);
    expect(r.dfmc.messages).toBeGreaterThan(300);
    // Native-DFMC GEOs are distinct PRNs.
    expect(r.dfmc.prns.length).toBeGreaterThanOrEqual(1);
    expect(r.dfmc.prns.every((p) => p[0] === 'S')).toBe(true);
  });

  it('sees only test/null DFMC types (no live corrections yet)', () => {
    const { dfmc } = parseSbfGeoL5(data);
    const types = Object.keys(dfmc.byType)
      .map(Number)
      .sort((a, b) => a - b);
    // EGNOS V3 DFMC broadcasts only MT0 (Do Not Use) and MT63 (Null).
    expect(types).toEqual([0, 63]);
    expect(isSbasL5Correction(0)).toBe(false);
    expect(isSbasL5Correction(63)).toBe(false);
    expect(isSbasL5Correction(32)).toBe(true); // clock-ephemeris (Table B-98)
    expect(sbasL5MessageName(0)).toMatch(/Do Not Use/);
    expect(sbasL5MessageName(63)).toMatch(/Null/);
    expect(SBAS_L5_PREAMBLE_UW).toBe(0x5c693a);
  });

  it('routes DO-229-on-L5 content into the L1 SbasProcessor', () => {
    const sbas = new SbasProcessor();
    let dfmcSeen = 0;
    const nav = decodeSbfNavigation(data, {
      onSbasMessage: (msg, prn, week, tow) => sbas.update(msg, week, tow, prn),
      onDfmcMessage: () => dfmcSeen++,
    });
    // The legacy-on-L5 frames build a real GPS PRN mask + iono grid.
    const gps = sbas.activeSats().filter((p) => p[0] === 'G');
    expect(gps.length).toBeGreaterThan(20);
    expect(sbas.ionoGridPoints()).toBeGreaterThan(0);
    // Native DFMC frames are surfaced (for inspection) but not fed to L1.
    expect(dfmcSeen).toBeGreaterThan(300);
    expect(nav.dfmc.messages).toBe(dfmcSeen);
    // Every native-DFMC frame is one of the total L5 blocks seen.
    expect(nav.counts.sbasL5Raw).toBeGreaterThanOrEqual(nav.dfmc.messages);
  });
});
