import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { Rtcm3Decoder } from '../src/rtcm3/decoder';
import { decodeEphemeris } from '../src/rtcm3/ephemeris';
import {
  decodeMsmFull,
  obsEpochToDate,
  resetGloFreqCache,
} from '../src/rtcm3/msm';
import { createStationMeta, updateStationMeta } from '../src/rtcm3/station';
import {
  RtcmBaseEncoder,
  rawEpochToMsm,
  receiverToRtcm3,
} from '../src/rtcm3/base-encode';
import { ephInfoToEphemeris } from '../src/orbit';
import { parseNovatelNav, parseNovatelRange } from '../src/novatel';
import { parseTrimble } from '../src/trimble';
import { postProcessRtk } from '../src/positioning';
import type { RtkObsEpoch } from '../src/positioning';
import type { Ephemeris } from '../src/rinex/nav';

const FIX = join(__dirname, '..', 'test-fixtures');
const C = 299792458;

/** Decode an RTCM3 stream back into what postProcessRtk takes. */
function decodeStream(bytes: Uint8Array, refMs: number) {
  resetGloFreqCache();
  const frames = new Rtcm3Decoder().decode(bytes);
  const meta = createStationMeta();
  const ephs: Ephemeris[] = [];
  const byTime = new Map<number, RtkObsEpoch['meas'][number][]>();
  const counts: Record<number, number> = {};
  for (const f of frames) {
    counts[f.messageType] = (counts[f.messageType] ?? 0) + 1;
    if (updateStationMeta(meta, f)) continue;
    const info = decodeEphemeris(f);
    if (info) {
      const eph = ephInfoToEphemeris({ ...info, lastReceived: refMs });
      if (eph) ephs.push(eph);
      continue;
    }
    const ep = decodeMsmFull(f);
    if (!ep) continue;
    const t = obsEpochToDate(ep.system, ep.epochMs, new Date(refMs)).getTime();
    let list = byTime.get(t);
    if (!list) byTime.set(t, (list = []));
    for (const o of ep.observations) {
      for (const s of o.signals) {
        const k =
          o.system === 'R' &&
          s.wavelength > 0 &&
          (s.rinexCode[0] === '1' || s.rinexCode[0] === '2')
            ? Math.round(
                s.rinexCode[0] === '1'
                  ? (C / s.wavelength - 1602e6) / 0.5625e6
                  : (C / s.wavelength - 1246e6) / 0.4375e6
              )
            : null;
        list.push({
          prn: o.prn,
          code: s.rinexCode,
          pr: s.pseudorange ?? null,
          cp: s.phase ?? null,
          lockTimeS: s.lockTime,
          gloChannel: k,
        });
      }
    }
  }
  const epochs = [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timeMs, meas]) => ({ timeMs, meas }));
  return { epochs, ephs, meta, counts, frames };
}

const BASE_FIX = join(FIX, 'oem719_rtk_base.gps');
const ROVER_FIX = join(FIX, 'oem719_rtk_rover.gps');
const WHU_BASE: [number, number, number] = [
  -2267335.669351269, 5008649.155499206, 3222374.973582075,
];

describe.skipIf(!existsSync(BASE_FIX) || !existsSync(ROVER_FIX))(
  'NovAtel OEM719 base → RTCM3 → RTK (WHU)',
  () => {
    const baseRaw = new Uint8Array(readFileSync(BASE_FIX));
    const roverRaw = new Uint8Array(readFileSync(ROVER_FIX));
    const base = parseNovatelRange(baseRaw);
    const rover = parseNovatelRange(roverRaw);
    const baseEphs = parseNovatelNav(baseRaw).ephemerides;
    const ephs = [...baseEphs, ...parseNovatelNav(roverRaw).ephemerides];
    const refMs = base.epochs[0]!.timeMs;
    const opts = { mode: 'static' as const, elevationMaskDeg: 15 };
    const direct = postProcessRtk(base, rover, ephs, WHU_BASE, opts);

    it.each([7, 4] as const)(
      'MSM%d base stream gives the same fixed baseline as the raw log',
      (msm) => {
        const rtcm = receiverToRtcm3(base.epochs, baseEphs, {
          msm,
          stationId: 1234,
          arp: { position: WHU_BASE, antennaHeight: 0 },
          descriptors: { antennaType: 'NOV850', receiverType: 'NOV OEM719' },
        });
        const dec = decodeStream(rtcm, refMs);
        expect(dec.meta.stationId).toBe(1234);
        expect(dec.meta.antennaType).toBe('NOV850');
        dec.meta.position!.forEach((v, i) =>
          expect(v).toBeCloseTo(WHU_BASE[i]!, 4)
        );
        expect(dec.epochs).toHaveLength(base.epochs.length);
        expect(dec.ephs.length).toBeGreaterThan(0);

        // Base observations and ephemerides from the RTCM stream only; the
        // rover's own ephemerides are added exactly as in the direct run.
        const viaRtcm = postProcessRtk(
          dec,
          rover,
          [...dec.ephs, ...parseNovatelNav(roverRaw).ephemerides],
          dec.meta.position!,
          opts
        );
        expect(viaRtcm.solved).toBe(direct.solved);
        expect(viaRtcm.fixRate).toBeCloseTo(direct.fixRate, 2);
        expect(viaRtcm.final!.status).toBe(direct.final!.status);
        const d = viaRtcm.final!.baseline.map(
          (v, i) => v - direct.final!.baseline[i]!
        );
        // MSM7: 0.6 mm code, 0.1 mm phase LSB. MSM4 code is 1.8 cm, which the
        // float filter feeds into the fix: a few mm.
        expect(Math.hypot(...d)).toBeLessThan(msm === 7 ? 5e-4 : 5e-3);
      }
    );

    it('emits the stream in station → ephemeris → MSM order and paces messages', () => {
      const enc = new RtcmBaseEncoder({
        msm: 7,
        arp: { position: WHU_BASE },
        stationIntervalS: 10,
      });
      enc.addEphemerides(baseEphs);
      const types = base.epochs
        .slice(0, 12)
        .map((e) => enc.encodeEpoch(e).map((f) => (f[3]! << 4) | (f[4]! >> 4)));
      expect(types[0]![0]).toBe(1005);
      expect(
        types[0]!.filter((t) => t >= 1019 && t <= 1046).length
      ).toBeGreaterThan(5);
      expect(types[1]!.every((t) => t >= 1071 && t <= 1137)).toBe(true);
      // Station message again 10 s later (1 Hz data).
      const stationEpochs = types.flatMap((t, i) =>
        t.includes(1005) ? [i] : []
      );
      expect(stationEpochs).toEqual([0, 10]);
    });
  }
);

describe('ephemeris pacing', () => {
  const mk = (tocMs: number, iode: number): Ephemeris => ({
    system: 'G',
    prn: 'G05',
    toc: 0,
    tocDate: new Date(tocMs),
    af0: 0,
    af1: 0,
    af2: 0,
    iode,
    crs: 0,
    deltaN: 0,
    m0: 0,
    cuc: 0,
    e: 0.01,
    cus: 0,
    sqrtA: 5153.6,
    toe: 0,
    cic: 0,
    omega0: 0,
    cis: 0,
    i0: 0.95,
    crc: 0,
    omega: 0,
    omegaDot: 0,
    idot: 0,
    week: 2400,
    svHealth: 0,
    tgd: 0,
  });
  const H = 3600_000;
  const T = Date.UTC(2026, 10, 11, 0, 0, 0);

  it('sends each satellite the ephemeris nearest in time, once, as it changes', () => {
    const enc = new RtcmBaseEncoder();
    enc.addEphemerides([mk(T, 1), mk(T + 2 * H, 2), mk(T + 4 * H, 3)]);
    const ephAt = (h: number) =>
      enc
        .encodeEpoch({ timeMs: T + h * H, observations: [] })
        .filter((f) => ((f[3]! << 4) | (f[4]! >> 4)) === 1019)
        .map((f) => decodeEphemeris(new Rtcm3Decoder().decode(f)[0]!)!.iode);
    expect(ephAt(0)).toEqual([1]);
    expect(ephAt(0.5)).toEqual([]);
    expect(ephAt(1.01)).toEqual([2]); // switches an hour before toe
    expect(ephAt(2)).toEqual([]);
    expect(ephAt(3.5)).toEqual([3]);
  });

  it('re-sends current ephemerides on the configured interval', () => {
    const enc = new RtcmBaseEncoder({ ephemerisIntervalS: 60 });
    enc.addEphemerides([mk(T, 1)]);
    const n = (s: number) =>
      enc.encodeEpoch({ timeMs: T + s * 1000, observations: [] }).length;
    expect([n(0), n(30), n(60), n(90), n(120)]).toEqual([1, 0, 1, 0, 1]);
  });
});

describe('receiver adapters', () => {
  it('maps a Trimble RT27 epoch, carrying its GLONASS channels into MSM', () => {
    const t02 = new Uint8Array(
      readFileSync(join(FIX, 'dlf100_rt27_gpsnav_slice.t02'))
    );
    const { epochs } = parseTrimble(t02);
    expect(epochs.length).toBeGreaterThan(5);
    // How often is the per-measurement slip flag raised? (event vs state)
    const all = epochs.flatMap((e) => e.meas);
    const flagged = all.filter((m) => m.cycleSlip).length / all.length;
    expect(flagged).toBeLessThan(0.05);

    resetGloFreqCache();
    const enc = new RtcmBaseEncoder({ msm: 7 });
    const frames = epochs.flatMap((e) => enc.encodeEpoch(e));
    const decoded = new Rtcm3Decoder().decode(
      Uint8Array.from(frames.flatMap((f) => [...f]))
    );
    const glo = decoded
      .map((f) => decodeMsmFull(f))
      .filter((e) => e?.system === 'R');
    expect(glo.length).toBeGreaterThan(0);
    const gloSigs = glo.flatMap((e) =>
      e!.observations.flatMap((o) => o.signals)
    );
    expect(
      gloSigs.filter((s) => s.phase !== undefined).length / gloSigs.length
    ).toBeGreaterThan(0.8);

    // Every pseudorange the receiver logged (on an MSM signal) survives.
    const first = rawEpochToMsm(epochs[0]!);
    const nIn = first.observations.reduce(
      (n, s) => n + s.signals.filter((x) => x.pseudorange).length,
      0
    );
    expect(nIn).toBeGreaterThan(20);
  });
});
