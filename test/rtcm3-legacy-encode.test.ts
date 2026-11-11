import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { BitReader, Rtcm3Decoder } from '../src/rtcm3/decoder';
import type { Rtcm3Frame } from '../src/rtcm3/decoder';
import { decodeLegacyObs, decodeObs } from '../src/rtcm3/legacy-obs';
import { obsEpochToDate } from '../src/rtcm3/msm';
import type { ObsSatObs } from '../src/rtcm3/msm';
import {
  LegacyObsEncoder,
  legacyLockIndicator,
} from '../src/rtcm3/legacy-encode';
import type { MsmEncodeSat } from '../src/rtcm3/msm-encode';
import { encodeAntennaDescriptor } from '../src/rtcm3/station-encode';
import { createStationMeta, updateStationMeta } from '../src/rtcm3/station';
import { RtcmBaseEncoder, receiverToRtcm3 } from '../src/rtcm3/base-encode';
import { parseNovatelNav, parseNovatelRange } from '../src/novatel';
import { postProcessRtk } from '../src/positioning';
import type { RtkObsEpoch } from '../src/positioning';

const C = 299792458;
const L1 = C / 1575.42e6;
const L2 = C / 1227.6e6;
const G1 = (k: number) => C / (1602e6 + k * 0.5625e6);
const G2 = (k: number) => C / (1246e6 + k * 0.4375e6);
const T0 = Date.UTC(2026, 10, 11, 23, 30, 0); // 02:30 Moscow, next day

const decode = (frames: Uint8Array[]): Rtcm3Frame[] => {
  const dec = new Rtcm3Decoder();
  return frames.flatMap((f) => dec.decode(f));
};
const syncBit = (f: Rtcm3Frame) => {
  const r = new BitReader(f.payload);
  r.skip(f.messageType <= 1004 ? 54 : 51);
  return r.readU(1);
};

function sat(
  prn: string,
  range: number,
  sigs: Array<[string, number]>
): MsmEncodeSat {
  return {
    prn,
    signals: sigs.map(([rinexCode, lambda], i) => ({
      rinexCode,
      wavelength: lambda,
      pseudorange: range + i * 3.21,
      phase: (range + i * 2.5) / lambda + 0.37,
      cn0: 47.25 - i * 3,
      lockTime: 300 + i,
    })),
  };
}

const SATS: MsmEncodeSat[] = [
  sat('G05', 21_456_789.123, [
    ['1C', L1],
    ['2W', L2],
  ]),
  sat('G12', 24_001_234.567, [
    ['1C', L1],
    ['2X', L2],
  ]),
  sat('G30', 20_500_000.04, [
    ['1C', L1],
    ['2P', L2],
  ]),
  sat('R07', 19_876_543.21, [
    ['1C', G1(-4)],
    ['2P', G2(-4)],
  ]),
  sat('R24', 23_456_789.87, [
    ['1C', G1(2)],
    ['2C', G2(2)],
  ]),
  sat('E11', 25_555_555.5, [['1C', C / 1575.42e6]]), // not in legacy
];

describe('legacy lock-time indicator (DF013)', () => {
  // Decoder table (RTCM Table 3.4-2).
  const sec = (i: number) =>
    i < 24
      ? i
      : i < 48
        ? 2 * i - 24
        : i < 72
          ? 4 * i - 120
          : i < 96
            ? 8 * i - 408
            : i < 120
              ? 16 * i - 1176
              : i < 127
                ? 32 * i - 3096
                : 937;
  it('inverts the decoder table for every indicator and is monotonic', () => {
    for (let i = 0; i <= 127; i++) expect(legacyLockIndicator(sec(i))).toBe(i);
    let prev = 0;
    for (let t = 0; t < 2000; t += 0.7) {
      expect(legacyLockIndicator(t)).toBeGreaterThanOrEqual(prev);
      prev = legacyLockIndicator(t);
    }
  });
});

describe('legacy obs encode → decode', () => {
  const variants = [
    { dual: false, extended: false, types: [1001, 1009] },
    { dual: false, extended: true, types: [1002, 1010] },
    { dual: true, extended: false, types: [1003, 1011] },
    { dual: true, extended: true, types: [1004, 1012] },
  ];

  it.each(variants)('$types', ({ dual, extended, types }) => {
    const frames = decode(
      new LegacyObsEncoder({ dual, extended, stationId: 77 }).encode({
        timeMs: T0,
        observations: SATS,
      })
    );
    expect(frames.map((f) => f.messageType)).toEqual(types);
    expect(frames.map(syncBit)).toEqual([1, 0]);
    const got = new Map<string, ObsSatObs>();
    for (const f of frames) {
      expect(new BitReader(f.payload).readU(24) & 0xfff).toBe(77);
      const ep = decodeLegacyObs(f, { refTimeMs: T0 })!;
      expect(
        obsEpochToDate(ep.system, ep.epochMs, new Date(T0)).getTime()
      ).toBe(T0);
      for (const o of ep.observations) got.set(o.prn, o);
    }
    expect([...got.keys()].sort()).toEqual(['G05', 'G12', 'G30', 'R07', 'R24']);

    for (const s of SATS.filter((x) => got.has(x.prn))) {
      const o = got.get(s.prn)!;
      expect(o.signals).toHaveLength(dual ? 2 : 1);
      o.signals.forEach((d, i) => {
        const w = s.signals[i]!;
        expect(d.rinexCode).toBe(w.rinexCode); // DF010/DF016 round-trip
        // Basic types drop the whole light-ms units of the L1 range.
        const unit = s.prn[0] === 'G' ? 299792.458 : 599584.916;
        const fold = (x: number) => (extended ? x : x % unit);
        expect(
          Math.abs(fold(d.pseudorange!) - fold(w.pseudorange!))
        ).toBeLessThanOrEqual(0.0101 + (i ? 0.01 : 0));
        expect(
          Math.abs(
            fold(d.phase! * d.wavelength) - fold(w.phase! * w.wavelength!)
          )
        ).toBeLessThan(0.0003 + 0.01);
        if (extended) expect(d.cn0).toBe(w.cn0);
        expect(d.lockTime!).toBeLessThanOrEqual(w.lockTime!);
        expect(d.lockTime!).toBeGreaterThan(w.lockTime! * 0.9);
      });
    }
  });

  it('carries phase to 0.5 mm against the quantized L1 range (extended)', () => {
    const [f] = decode(
      new LegacyObsEncoder({ systems: ['G'] }).encode({
        timeMs: T0,
        observations: [SATS[0]!],
      })
    );
    const d = decodeLegacyObs(f!)!.observations[0]!.signals;
    const w = SATS[0]!.signals;
    expect(Math.abs(d[0]!.phase! * L1 - w[0]!.phase! * L1)).toBeLessThanOrEqual(
      0.00026
    );
    expect(Math.abs(d[1]!.phase! * L2 - w[1]!.phase! * L2)).toBeLessThanOrEqual(
      0.00026
    );
  });

  it('re-anchors a far phase once per arc and keeps it continuous', () => {
    const enc = new LegacyObsEncoder({ systems: ['G'], dual: false });
    const at = (t: number) =>
      decodeLegacyObs(
        decode(
          enc.encode({
            timeMs: T0 + t * 1000,
            observations: [
              {
                prn: 'G05',
                signals: [
                  {
                    rinexCode: '1C',
                    wavelength: L1,
                    pseudorange: 2e7 + t,
                    phase: (2e7 + t) / L1 + 5e5,
                  },
                ],
              },
            ],
          })
        )[0]!
      )!.observations[0]!.signals[0]!;
    const a = at(0);
    const b = at(1);
    expect(Math.abs(a.phase! * L1 - a.pseudorange!)).toBeLessThan(1);
    expect((b.phase! - a.phase!) * L1).toBeCloseTo(1, 3);
    expect(b.lockTime!).toBeGreaterThanOrEqual(a.lockTime!);
  });

  it('splits at 31 satellites per message', () => {
    const many = Array.from({ length: 32 }, (_, i) =>
      sat(`G${String(i + 1).padStart(2, '0')}`, 2e7 + i * 1e5, [['1C', L1]])
    );
    const frames = decode(
      new LegacyObsEncoder().encode({ timeMs: T0, observations: many })
    );
    expect(frames.map((f) => decodeLegacyObs(f)!.observations.length)).toEqual([
      31, 1,
    ]);
    expect(frames.map(syncBit)).toEqual([1, 0]);
  });

  it('picks the GLONASS day of week nearest the reference across Moscow midnight', () => {
    const t = Date.UTC(2026, 10, 11, 20, 59, 59); // 23:59:59 Moscow
    const [f] = decode(
      new LegacyObsEncoder({ systems: ['R'] }).encode({
        timeMs: t,
        observations: [SATS[3]!],
      })
    );
    for (const ref of [t - 5000, t + 5000, t + 3600_000]) {
      const ep = decodeLegacyObs(f!, { refTimeMs: ref })!;
      expect(obsEpochToDate('R', ep.epochMs, new Date(ref)).getTime()).toBe(t);
    }
  });
});

describe('1007/1008 antenna descriptor', () => {
  it('round-trips both forms', () => {
    const meta = createStationMeta();
    const f7 = new Rtcm3Decoder().decode(
      encodeAntennaDescriptor({
        stationId: 9,
        antennaType: 'LEIAR25.R4      LEIT',
        antennaSetupId: 2,
      })
    )[0]!;
    expect(f7.messageType).toBe(1007);
    updateStationMeta(meta, f7);
    expect([meta.stationId, meta.antennaType, meta.antennaSetupId]).toEqual([
      9,
      'LEIAR25.R4      LEIT',
      2,
    ]);
    const f8 = new Rtcm3Decoder().decode(
      encodeAntennaDescriptor({
        stationId: 9,
        antennaType: 'LEIAR25.R4      LEIT',
        antennaSerial: '725123',
      })
    )[0]!;
    expect(f8.messageType).toBe(1008);
    updateStationMeta(meta, f8);
    expect(meta.antennaSerial).toBe('725123');
  });
});

/* ------------------------------------------------------------------ */

const BASE = join(__dirname, '..', 'test-fixtures', 'oem719_rtk_base.gps');
const ROVER = join(__dirname, '..', 'test-fixtures', 'oem719_rtk_rover.gps');
const WHU: [number, number, number] = [
  -2267335.669351269, 5008649.155499206, 3222374.973582075,
];

describe.skipIf(!existsSync(BASE) || !existsSync(ROVER))(
  'OEM719 base → 1004/1012 (WHU)',
  () => {
    const baseRaw = existsSync(BASE)
      ? new Uint8Array(readFileSync(BASE))
      : new Uint8Array();
    const roverRaw = existsSync(ROVER)
      ? new Uint8Array(readFileSync(ROVER))
      : new Uint8Array();
    it('carries every GPS/GLONASS L1/L2 observation to the format resolution, and RTK still solves', () => {
      const base = parseNovatelRange(baseRaw);
      const rover = parseNovatelRange(roverRaw);
      const baseEphs = parseNovatelNav(baseRaw).ephemerides;
      const ephs = [...baseEphs, ...parseNovatelNav(roverRaw).ephemerides];
      const refMs = base.epochs[0]!.timeMs;
      const opts = { mode: 'static' as const, elevationMaskDeg: 15 };

      const rtcm = receiverToRtcm3(base.epochs, baseEphs, {
        obs: 'legacy',
        arp: { position: WHU },
        descriptors: { antennaType: 'NOV850' },
      });
      const frames = new Rtcm3Decoder().decode(rtcm);
      const types = new Set(frames.map((f) => f.messageType));
      expect(
        [...types]
          .filter((t) =>
            [1001, 1002, 1003, 1004, 1009, 1010, 1011, 1012].includes(t)
          )
          .sort()
      ).toEqual([1004, 1012]);
      expect(types.has(1007)).toBe(true);
      expect([...types].some((t) => t >= 1071 && t <= 1137)).toBe(false);

      const byT = new Map<number, RtkObsEpoch['meas'][number][]>();
      for (const f of frames) {
        const ep = decodeObs(f, { refTimeMs: refMs });
        if (!ep) continue;
        const t = obsEpochToDate(
          ep.system,
          ep.epochMs,
          new Date(refMs)
        ).getTime();
        const list = byT.get(t) ?? byT.set(t, []).get(t)!;
        for (const o of ep.observations) {
          for (const s of o.signals) {
            const k =
              o.system === 'R'
                ? Math.round(
                    (C / s.wavelength -
                      (s.rinexCode[0] === '1' ? 1602e6 : 1246e6)) /
                      (s.rinexCode[0] === '1' ? 0.5625e6 : 0.4375e6)
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
      const viaLegacy = [...byT]
        .sort((a, b) => a[0] - b[0])
        .map(([timeMs, meas]) => ({ timeMs, meas }));
      expect(viaLegacy).toHaveLength(base.epochs.length);

      // Observation level: code to the 0.02 m step, phase to 0.5 mm, no
      // cycle shifts, lock never dropping without a receiver slip.
      let cells = 0;
      viaLegacy.forEach((e, i) => {
        const raw = new Map(
          base.epochs[i]!.meas.map((m) => [m.prn + m.code, m])
        );
        for (const m of e.meas) {
          const r = raw.get(m.prn + m.code)!;
          expect(r, m.prn + m.code).toBeDefined();
          expect(Math.abs(m.pr! - r.pr!)).toBeLessThanOrEqual(0.0101);
          if (r.cp !== null)
            expect(Math.abs(m.cp! - r.cp!)).toBeLessThan(0.003);
          cells++;
        }
      });
      expect(cells).toBeGreaterThan(4000);

      // RTK on the same signals. This WHU GPS+GLONASS run stays float, and a
      // float baseline here moves 12–15 cm under ±1 cm of code noise on the raw
      // base — so legacy's 2 cm code step can only match it to that level.
      const carried = viaLegacy.map(
        (e) => new Set(e.meas.map((m) => m.prn + m.code))
      );
      const same = base.epochs.map((e, i) => ({
        ...e,
        meas: e.meas.filter((m) => carried[i]!.has(m.prn + m.code)),
      }));
      const direct = postProcessRtk(same, rover, ephs, WHU, opts);
      const via = postProcessRtk(viaLegacy, rover, ephs, WHU, opts);
      expect(via.solved).toBe(direct.solved);
      expect(via.final!.status).toBe(direct.final!.status);
      const d = via.final!.baseline.map(
        (v, i) => v - direct.final!.baseline[i]!
      );
      expect(Math.hypot(...d)).toBeLessThan(0.25);
    });

    it('streams 1004/1012 with ephemerides and station messages in legacy mode', () => {
      const base = parseNovatelRange(baseRaw);
      const enc = new RtcmBaseEncoder({
        obs: 'legacy',
        arp: { position: WHU },
      });
      const first = enc
        .encodeEpoch(base.epochs[0]!)
        .map((f) => (f[3]! << 4) | (f[4]! >> 4));
      expect(first[0]).toBe(1005);
      expect(first.slice(-2)).toEqual([1004, 1012]);
    });
  }
);
