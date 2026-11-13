/**
 * Every broadcast-ephemeris source gnss-js decodes, loaded from the test
 * fixtures: RINEX 2/3/4 files, u-blox RXM-SFRBX, Septentrio SBF, NovAtel
 * OEM, Trimble RT27, BINEX 0x01 and RTCM3 ephemeris messages. Shared by
 * the navigation round-trip and convention tests. Fixtures missing on
 * this machine (the large RINEX files are downloaded by
 * scripts/fetch-test-data.sh) are left out of the result.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseNavFile, type Ephemeris } from '../src/rinex/nav';
import { parseUbxNav } from '../src/ubx/nav';
import { parseUbxRawNav } from '../src/ubx/rawnav';
import { decodeSbfNavigation } from '../src/sbf/navigation';
import { parseNovatelNav } from '../src/novatel/nav';
import { parseTrimbleNav } from '../src/trimble/nav';
import { parseBinex } from '../src/binex/index';
import { Rtcm3Decoder } from '../src/rtcm3/decoder';
import { decodeEphemeris } from '../src/rtcm3/ephemeris';
import { ephInfoToEphemeris } from '../src/orbit';

export const fixture = (name: string) =>
  join(__dirname, '..', 'test-fixtures', name);
export const hasFixture = (name: string) => existsSync(fixture(name));
export const readText = (name: string) => readFileSync(fixture(name), 'utf8');
export const readBin = (name: string) =>
  new Uint8Array(readFileSync(fixture(name)));

/** Reception time of the DLF100 RTCM capture (resolves 10-bit weeks). */
export const RTCM_RECEIVED = Date.UTC(2026, 10, 6, 12);

/** Raw receiver captures → decoded ephemerides, keyed by source. */
export function rawSources(): Record<string, Ephemeris[]> {
  const out: Record<string, Ephemeris[]> = {};
  const add = (
    key: string,
    file: string,
    f: (b: Uint8Array) => Ephemeris[]
  ) => {
    if (hasFixture(file)) out[key] = f(readBin(file));
  };
  for (const u of ['f9p_sfrbx_slice.ubx', 'f9p_rawnav_slice.ubx'])
    add(`ubx:${u}`, u, (b) => [
      ...parseUbxNav(b).ephemerides,
      ...parseUbxRawNav(b).ephemerides,
    ]);
  for (const s of [
    'dlf500_sbf_nav_slice.sbf',
    'tudb_nav_slice.sbf',
    'dlf5_bdsglo_slice.sbf',
    'dlf5_galraw_slice.sbf',
    'dlf500_navic_slice.sbf',
  ])
    add(`sbf:${s}`, s, (b) => decodeSbfNavigation(b).ephemerides);
  for (const n of [
    'oem7_nav_slice.gps',
    'oemv_rangecmp.gps',
    'oem719_rtk_base.gps',
  ])
    add(`novatel:${n}`, n, (b) => parseNovatelNav(b).ephemerides);
  add(
    'trimble',
    'dlf100_rt27_gpsnav_slice.t02',
    (b) => parseTrimbleNav(b).ephemerides
  );
  for (const sys of ['gps', 'glo', 'gal', 'bds', 'qzss', 'sbas'])
    add(
      `binex:${sys}`,
      `binex_${sys}_eph.bnx`,
      (b) => parseBinex(b).ephemerides
    );
  add('rtcm3', 'dlf100_rtcm_rtk_base.rtcm', (b) =>
    new Rtcm3Decoder()
      .decode(b)
      .map((f) => decodeEphemeris(f))
      .filter((i) => i != null)
      .map((i) => ephInfoToEphemeris({ ...i, lastReceived: RTCM_RECEIVED }))
      .filter((e): e is Ephemeris => e != null)
  );
  return out;
}

/** The three IGS/DLR broadcast files, when downloaded. */
export function rinexSources(): Record<string, Ephemeris[]> {
  const out: Record<string, Ephemeris[]> = {};
  for (const f of ['brdc_v2.nav', 'brdc_v3_igs.nav', 'brdc_v4_dlr.nav'])
    if (hasFixture(f))
      out[`rinex:${f}`] = parseNavFile(readText(f)).ephemerides;
  return out;
}
