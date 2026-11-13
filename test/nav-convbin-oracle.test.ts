/**
 * Independent oracle: RTKLIB 2.4.2p13 convbin's RINEX 3.03 navigation
 * output for the same raw captures (test-fixtures/convbin/README.md)
 * against our decoders, record by record and field by field.
 *
 * Where RTKLIB 2.4.2 and the RINEX specification disagree the spec
 * decides; each such RTKLIB quirk is listed in QUIRKS with the reason.
 * Fields some of our decoders do not produce are listed in GAPS — the
 * test fails if a gap closes or a new one opens.
 */
import { describe, expect, it } from 'vitest';
import { parseNavFile, type Ephemeris } from '../src/rinex/nav';
import { uraMeters } from '../src/rtcm3/accuracy';
import { hasFixture, rawSources, readText } from './nav-sources';

/** RTKLIB 2.4.2 rinex.c ura_eph[]: the upper bound of each URA index. */
const RTKLIB_URA = [
  2.4, 3.4, 4.85, 6.85, 9.65, 13.65, 24, 48, 96, 192, 384, 768, 1536, 3072,
  6144, 0,
];

/** RTKLIB 2.4.2 output that departs from RINEX 3.05 (field → why). */
const QUIRKS: Record<string, string> = {
  // RINEX "transmission time of message": RTKLIB prints its reception
  // time; most of our decoders leave it "not known" (.999999999999E+09).
  ttm: 'RTKLIB writes the reception time',
  // Galileo: RTKLIB 2.4.2 prints the raw SISA word (32767) and data
  // source 1 even for F/NAV (1045) sets; RINEX wants metres and bit 1.
  'E.svAccuracy': 'RTKLIB raw SISA word, not metres (Table A8)',
  'E.dataSources': 'RTKLIB writes 1 (I/NAV) for F/NAV sets too',
  // QZSS: Table A12 says L2P flag 1 and the fit interval as a 0/1 flag;
  // RTKLIB writes 0 and hours (2).
  'J.l2pFlag': 'Table A12: fixed 1 (RTKLIB 0)',
  'J.fitInterval': 'Table A12: flag 0/1 (RTKLIB hours)',
  // SBAS: start of the 1-s message (RTKLIB, tow − 1) vs reception time.
  'S.messageFrameTime': 'start vs end of the 1 s message',
  'S.iodn': 'RTKLIB 2.4.2 does not write the IODN (0)',
  'R.ageOfOperation': 'RTKLIB 2.4.2 writes 0',
};

/** Fields a decoder of ours does not produce (yet), by source. */
const GAPS: Record<string, string[]> = {
  // NovAtel GALEPHEMERIS / BDSEPHEMERIS carry these; not decoded yet
  'novatel:oem7_nav_slice.gps': ['E.tgd2', 'C.tgd2', 'C.svAccuracy', 'C.aodc'],
  // RT27 RETSVDATA GPS: fields not located in the struct yet
  trimble: ['G.svAccuracy', 'G.l2Codes', 'G.iodc', 'G.fitInterval'],
};

const ORACLES: [file: string, source: string][] = [
  ['convbin/rtcm.nav', 'rtcm3'],
  ['convbin/ubx_sfrbx.nav', 'ubx:f9p_sfrbx_slice.ubx'],
  ['convbin/oem7.nav', 'novatel:oem7_nav_slice.gps'],
  ['convbin/oemv.nav', 'novatel:oemv_rangecmp.gps'],
  ['convbin/rt17.nav', 'trimble'],
];

const WEEK_MS = 604800_000;

describe.each(ORACLES)('%s vs %s', (file, key) => {
  const has = hasFixture(file);
  const cb = has ? parseNavFile(readText(file)).ephemerides : [];
  const ours = rawSources()[key] ?? [];

  it('every RTKLIB record has ours, equal field for field', () => {
    expect(cb.length).toBeGreaterThan(0);
    const gaps = new Set<string>();
    let matched = 0;
    for (const c of cb) {
      // Same PRN and epoch; RTKLIB 2.4.2 resolves the OEMV RAWEPHEM
      // 10-bit week 1024 weeks late (2029 instead of 2009: no time
      // reference in the log) — matched and pinned below.
      const cands = ours.filter(
        (o) =>
          o.prn === c.prn &&
          (o.tocDate.getTime() === c.tocDate.getTime() ||
            o.tocDate.getTime() + 1024 * WEEK_MS === c.tocDate.getTime())
      );
      // RTKLIB keeps one Galileo set per satellite (the last decoded):
      // pick ours with the same clock.
      const o = cands.sort(
        (a, b) =>
          Math.abs(
            ('af0' in a ? a.af0 : a.tauN) - ('af0' in c ? c.af0 : c.tauN)
          ) -
          Math.abs(
            ('af0' in b ? b.af0 : b.tauN) - ('af0' in c ? c.af0 : c.tauN)
          )
      )[0];
      // RTKLIB emits a few sets ours rejects or merges; count below.
      if (!o) continue;
      matched++;
      const rolled = o.tocDate.getTime() !== c.tocDate.getTime();
      for (const [f, v] of Object.entries(c)) {
        if (typeof v !== 'number') continue;
        const id = `${c.system}.${f}`;
        if (QUIRKS[f] || QUIRKS[id]) continue;
        const w = (o as unknown as Record<string, number | undefined>)[f];
        if (w === undefined) {
          if (v !== 0) gaps.add(id);
          continue;
        }
        if (f === 'week' && rolled) {
          expect(v - w, `${c.prn} RTKLIB week rollover`).toBe(1024);
          continue;
        }
        if (f === 'svAccuracy' || (c.system === 'S' && f === 'freqNum')) {
          // RTKLIB's URA upper bound ↔ the RINEX nominal value (Table A6)
          const idx = RTKLIB_URA.indexOf(v);
          expect(idx, `${c.prn} ${f} ${v}`).toBeGreaterThanOrEqual(0);
          expect(w, `${c.prn} ${f}`).toBe(uraMeters(idx));
          continue;
        }
        expect(
          Math.abs(w - v) <= Math.abs(v) * 1e-11 + 1e-25,
          `${c.prn} ${c.tocDate.toISOString()} ${f}: ours ${w} RTKLIB ${v}`
        ).toBe(true);
      }
    }
    expect(matched / cb.length).toBeGreaterThan(0.95);
    expect([...gaps].sort()).toEqual([...(GAPS[key] ?? [])].sort());
  });
});

describe('RTKLIB 2.4.2 RINEX quirks our reader tolerates', () => {
  it('reads "R 3" PRNs and ".1234E-04" mantissas', () => {
    // convbin 2.4.2 prints the PRN as %c%2d and Fortran-style mantissas
    // without the leading zero (RINEX 3.05 asks A1,I2.2).
    const text = readText('convbin/rtcm.nav');
    expect(text).toMatch(
      /^R 3 2026 11 {2}6 {2}9 15 {2}0 {2}\.276621431112E-04/m
    );
    const r03 = parseNavFile(text).ephemerides.find((e) => e.prn === 'R03');
    expect(r03).toBeDefined();
    expect((r03 as Ephemeris & { tauN: number }).tauN).toBe(0.276621431112e-4);
  });
});
