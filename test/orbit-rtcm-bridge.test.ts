/**
 * Tests for the RTCM3 EphemerisInfo → orbit Ephemeris bridge
 * (ephInfoToEphemeris), the path behind the live NTRIP sky plot.
 *
 * The GLONASS branch reconstructs the clock epoch (toc) from `tb`,
 * which counts 15-minute intervals from midnight *Moscow* time
 * (UTC+3). Two historical bugs are pinned here:
 *  - `tb` is stored in minutes on EphemerisInfo but was scaled as if
 *    it were the raw 15-minute index (15× too large);
 *  - the day boundary was resolved on the UTC calendar, putting toc a
 *    full day in the past between 21:00 and 24:00 UTC.
 */
import { describe, expect, it } from 'vitest';
import { ephInfoToEphemeris } from '../src/orbit';
import type { GlonassEphemeris } from '../src/rinex/nav';
import type { EphemerisInfo } from '../src/rtcm3/ephemeris';

/** Minimal GLONASS EphemerisInfo as produced by the 1020 decoder. */
function gloInfo(lastReceivedIso: string, tbMinutes: number): EphemerisInfo {
  return {
    prn: 'R05',
    constellation: 'GLONASS',
    health: 0,
    lastReceived: new Date(lastReceivedIso).getTime(),
    messageType: 1020,
    freqChannel: 1,
    tb: tbMinutes,
    // State vector in km / km/s (PZ-90), roughly a GLONASS orbit radius
    x: 11123.456,
    y: -21987.654,
    z: 8765.432,
    vx: 1.234567,
    vy: -0.765432,
    vz: 3.014159,
    ax: 0,
    ay: 0,
    az: 0,
    gammaN: 0,
    af0: 1e-5, // decoder stores raw τ_n here
  };
}

describe('ephInfoToEphemeris — GLONASS toc reconstruction', () => {
  it('converts tb (minutes, Moscow day) to the correct UTC toc', () => {
    // 12:00 UTC = 15:00 Moscow; tb = 15:15 Moscow = 915 min
    const eph = ephInfoToEphemeris(
      gloInfo('2026-07-19T12:00:00Z', 915)
    ) as GlonassEphemeris;
    expect(eph).not.toBeNull();
    expect(eph.tocDate.toISOString()).toBe('2026-07-19T12:15:00.000Z');
  });

  it('resolves the day boundary on the Moscow calendar (21:00–24:00 UTC)', () => {
    // 22:30 UTC on the 19th is already 01:30 on the 20th in Moscow;
    // tb = 01:30 Moscow = 90 min → toc must be 22:30 UTC on the 19th,
    // not 24 h earlier.
    const eph = ephInfoToEphemeris(
      gloInfo('2026-07-19T22:30:00Z', 90)
    ) as GlonassEphemeris;
    expect(eph.tocDate.toISOString()).toBe('2026-07-19T22:30:00.000Z');
  });

  it('handles the early-UTC-morning hours (Moscow same day)', () => {
    // 01:00 UTC = 04:00 Moscow; tb = 04:00 Moscow = 240 min
    const eph = ephInfoToEphemeris(
      gloInfo('2026-07-19T01:00:00Z', 240)
    ) as GlonassEphemeris;
    expect(eph.tocDate.toISOString()).toBe('2026-07-19T01:00:00.000Z');
  });

  it('negates the raw τ_n into the RINEX clock-bias convention', () => {
    const eph = ephInfoToEphemeris(
      gloInfo('2026-07-19T12:00:00Z', 900)
    ) as GlonassEphemeris;
    expect(eph.tauN).toBeCloseTo(-1e-5, 12);
  });

  it('carries the state vector through unchanged (km / km/s)', () => {
    const eph = ephInfoToEphemeris(
      gloInfo('2026-07-19T12:00:00Z', 900)
    ) as GlonassEphemeris;
    expect(eph.x).toBeCloseTo(11123.456, 6);
    expect(eph.zDot).toBeCloseTo(3.014159, 9);
    expect(eph.freqNum).toBe(1);
  });
});

describe('ephInfoToEphemeris — Keplerian validation', () => {
  const keplerInfo: EphemerisInfo = {
    prn: 'G12',
    constellation: 'GPS',
    health: 0,
    lastReceived: new Date('2026-07-20T12:00:00Z').getTime(),
    messageType: 1019,
    // RTCM 1019 broadcasts a 10-bit week: 2428 mod 1024 = 380
    week: 380,
    toe: 302400,
    toc: 302400,
    sqrtA: 5153.7,
    eccentricity: 0.01,
    inclination: 0.96,
    omega0: 1.0,
    omegaDot: -8e-9,
    argPerigee: 0.5,
    meanAnomaly: 2.0,
  };

  it('accepts a physically plausible GPS ephemeris', () => {
    expect(ephInfoToEphemeris(keplerInfo)).not.toBeNull();
  });

  it('resolves the 10-bit GPS week against the reception time', () => {
    const eph = ephInfoToEphemeris(keplerInfo)!;
    // Without rollover resolution week 380 lands in 1987.
    const dtDays =
      Math.abs(eph.tocDate.getTime() - keplerInfo.lastReceived) / 86400_000;
    expect(dtDays).toBeLessThan(4);
  });

  it('interprets the Galileo week on the GST axis (GPS week 1024)', () => {
    const gal = ephInfoToEphemeris({
      ...keplerInfo,
      prn: 'E11',
      constellation: 'Galileo',
      messageType: 1046,
      week: 2428 - 1024, // GST week as broadcast
    })!;
    const dtDays =
      Math.abs(gal.tocDate.getTime() - keplerInfo.lastReceived) / 86400_000;
    expect(dtDays).toBeLessThan(4);
  });

  it('rejects garbage that survived CRC (sqrtA out of range)', () => {
    expect(ephInfoToEphemeris({ ...keplerInfo, sqrtA: 100 })).toBeNull();
    expect(ephInfoToEphemeris({ ...keplerInfo, eccentricity: 1.5 })).toBeNull();
    expect(ephInfoToEphemeris({ ...keplerInfo, toe: 700000 })).toBeNull();
  });
});
