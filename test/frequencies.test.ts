import { describe, it, expect } from 'vitest';
import { FREQ, gloFreq, C_LIGHT } from '../src/constants/gnss';
import {
  FREQ_GPS_L1,
  FREQ_GLO_L1,
  FREQ_GLO_L1OC,
  FREQ_GAL_E5,
  FREQ_BDS_B1I,
  FREQ_BDS_B1C,
  FREQ_QZS_L6,
  FREQ_NAVIC_L5,
  DELTA_GLO_L1,
} from '../src/signals/definitions';

/**
 * The MHz constants in signals/definitions.ts are derived from the
 * canonical Hz table in constants/gnss.ts. These spot checks pin the
 * published ICD values so an accidental edit to FREQ is caught.
 */
describe('canonical frequency table', () => {
  it('matches published ICD values (spot checks, Hz)', () => {
    expect(FREQ.G!['1']).toBe(1575.42e6);
    expect(FREQ.G!['2']).toBe(1227.6e6);
    expect(FREQ.E!['8']).toBe(1191.795e6); // E5 AltBOC
    expect(FREQ.C!['2']).toBe(1561.098e6); // B1I
    expect(FREQ.R!['3']).toBe(1202.025e6); // L3OC
    expect(FREQ.R!['4']).toBe(1600.995e6); // L1OC
    expect(FREQ.R!['6']).toBe(1248.06e6); // L2OC
    expect(FREQ.I!['9']).toBe(2492.028e6); // NavIC S-band
  });

  it('derived MHz constants agree with the Hz table', () => {
    expect(FREQ_GPS_L1).toBe(1575.42);
    expect(FREQ_GLO_L1).toBe(1602.0);
    expect(DELTA_GLO_L1).toBe(0.5625);
    expect(FREQ_GLO_L1OC).toBe(1600.995);
    expect(FREQ_GAL_E5).toBe(1191.795);
    expect(FREQ_BDS_B1I).toBe(1561.098);
    expect(FREQ_BDS_B1C).toBe(1575.42);
    expect(FREQ_QZS_L6).toBe(1278.75);
    expect(FREQ_NAVIC_L5).toBe(1176.45);
  });

  it('GLONASS FDMA channel formula', () => {
    // k = -7..+6; slot with k=0 sits on the base frequency
    expect(gloFreq({ R01: 0 }, 'R01', '1')).toBe(1602.0e6);
    expect(gloFreq({ R02: -7 }, 'R02', '1')).toBe(1602.0e6 - 7 * 0.5625e6);
  });

  it('wavelength sanity: L1 ≈ 19 cm', () => {
    expect(C_LIGHT / FREQ.G!['1']!).toBeCloseTo(0.19029, 4);
  });
});
