import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { BitReader, Rtcm3Decoder } from '../src/rtcm3/decoder';
import type { Rtcm3Frame } from '../src/rtcm3/decoder';
import {
  decodeMsmFull,
  obsEpochToDate,
  resetGloFreqCache,
  setGloFreqNumber,
} from '../src/rtcm3/msm';
import type { ObsEpoch, ObsSatObs } from '../src/rtcm3/msm';
import {
  MsmEncoder,
  encodeMsm,
  lockTimeIndicator10,
  lockTimeIndicator4,
  msmEpochField,
} from '../src/rtcm3/msm-encode';
import type { MsmEncodeSat, MsmLevel } from '../src/rtcm3/msm-encode';
import { BitWriter, frameRtcm3 } from '../src/rtcm3/writer';

const FIX = join(__dirname, '..', 'test-fixtures');
const C = 299792458;

function decodeFrames(frames: Uint8Array[]): Rtcm3Frame[] {
  const dec = new Rtcm3Decoder();
  const out: Rtcm3Frame[] = [];
  for (const f of frames) out.push(...dec.decode(f));
  return out;
}

/** Multiple-message bit (DF393) of an MSM payload. */
function multiBit(f: Rtcm3Frame): number {
  const r = new BitReader(f.payload);
  r.skip(54);
  return r.readU(1);
}

beforeEach(() => resetGloFreqCache());

describe('BitWriter', () => {
  it('round-trips through BitReader for every width and sign mode', () => {
    const w = new BitWriter();
    const vals: Array<[string, number, number]> = [];
    let seed = 1;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let n = 1; n <= 38; n++) {
      const u = Math.floor(rnd() * 2 ** n);
      const s = Math.floor(rnd() * 2 ** n) - 2 ** (n - 1);
      vals.push(['u', u, n], ['s', s, n]);
      if (n > 1) {
        const sm =
          Math.floor(rnd() * (2 ** (n - 1) - 1)) * (rnd() < 0.5 ? -1 : 1);
        vals.push(['sm', sm, n]);
      }
    }
    for (const [k, v, n] of vals) {
      if (k === 'u') w.writeU(v, n);
      else if (k === 's') w.writeS(v, n);
      else w.writeSM(v, n);
    }
    const r = new BitReader(w.toBytes());
    for (const [k, v, n] of vals) {
      const got = k === 'u' ? r.readU(n) : k === 's' ? r.readS(n) : r.readSM(n);
      expect(got).toBe(v); // sign-magnitude −0 keeps its sign
    }
  });

  it('refuses values that do not fit', () => {
    const w = new BitWriter();
    expect(() => w.writeU(256, 8)).toThrow(RangeError);
    expect(() => w.writeU(-1, 8)).toThrow(RangeError);
    expect(() => w.writeS(128, 8)).toThrow(RangeError);
    expect(() => w.writeS(-129, 8)).toThrow(RangeError);
    expect(() => w.writeU(1.5, 8)).toThrow(RangeError);
  });
});

describe('frameRtcm3', () => {
  it('produces frames the streaming decoder accepts (CRC-24Q)', () => {
    const w = new BitWriter();
    w.writeU(1005, 12);
    w.zeros(140);
    const frame = frameRtcm3(w.toBytes());
    const [f] = new Rtcm3Decoder().decode(frame);
    expect(f?.messageType).toBe(1005);
    expect(f?.length).toBe(19);
    const bad = frame.slice();
    bad[5]! ^= 0x10;
    expect(new Rtcm3Decoder().decode(bad)).toHaveLength(0);
  });
});

describe('lock-time indicators', () => {
  const LTI4 = [
    0, 0.032, 0.064, 0.128, 0.256, 0.512, 1.024, 2.048, 4.096, 8.192, 16.384,
    32.768, 65.536, 131.072, 262.144, 524.288,
  ];
  it('DF402 inverts the decoder table and is monotonic', () => {
    LTI4.forEach((t, i) => expect(lockTimeIndicator4(t)).toBe(i));
    expect(lockTimeIndicator4(0.031)).toBe(0);
    expect(lockTimeIndicator4(1.5)).toBe(6);
    expect(lockTimeIndicator4(1e6)).toBe(15);
  });

  it('DF407 inverts the decoder for every indicator 0–704', () => {
    const dec = (lti: number) => {
      if (lti < 64) return lti / 1000;
      const n = Math.min(20, Math.floor((lti - 64) / 32));
      return ((lti - 64 - 32 * n) * 2 ** (n + 1) + 2 ** (n + 6)) / 1000;
    };
    for (let lti = 0; lti <= 704; lti++) {
      expect(lockTimeIndicator10(dec(lti))).toBe(lti);
    }
    let prev = 0;
    for (let t = 0; t < 1e5; t = t * 1.07 + 0.001) {
      const v = lockTimeIndicator10(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(lockTimeIndicator10(1e9)).toBe(704);
  });
});

describe('msmEpochField', () => {
  const t = Date.UTC(2026, 10, 11, 21, 30, 15, 250); // GPS-scale ms
  it.each(['G', 'R', 'E', 'C', 'J'])(
    '%s round-trips through obsEpochToDate',
    (sys) => {
      const back = obsEpochToDate(
        sys,
        msmEpochField(sys, t),
        new Date(t + 3600e3)
      );
      expect(back.getTime()).toBe(t);
    }
  );
});

/* ------------------------------------------------------------------ */
/*  Synthetic epochs                                                   */
/* ------------------------------------------------------------------ */

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const L1 = C / 1575.42e6;
const L2 = C / 1227.6e6;
const E5a = C / 1176.45e6;
const GLO1 = (k: number) => C / (1602e6 + k * 0.5625e6);

function synthSat(
  prn: string,
  range: number,
  lambdas: Array<[string, number]>
): MsmEncodeSat {
  return {
    prn,
    signals: lambdas.map(([code, lambda], i) => ({
      rinexCode: code,
      wavelength: lambda,
      pseudorange: range + i * 1.234567,
      phase: (range + i * 0.5) / lambda + 0.123,
      doppler: -(234.5678 + i * 0.0123) / lambda, // range rate m/s → Hz
      cn0: 44.3125 - i,
      lockTime: 600 + i,
      halfCycle: i === 1,
    })),
  };
}

const SYNTH: MsmEncodeSat[] = [
  synthSat('G05', 21_456_789.123, [
    ['1C', L1],
    ['2W', L2],
    ['5Q', E5a],
  ]),
  synthSat('G12', 24_001_234.567, [
    ['1C', L1],
    ['2L', L2],
  ]),
  synthSat('R07', 19_876_543.21, [
    ['1C', GLO1(-4)],
    ['2C', C / (1246e6 - 4 * 0.4375e6)],
  ]),
  synthSat('E11', 25_555_555.5, [
    ['1C', C / 1575.42e6],
    ['5Q', E5a],
  ]),
  synthSat('C19', 22_222_222.2, [['2I', C / 1561.098e6]]),
  synthSat('C01', 37_000_000, [['2I', C / 1561.098e6]]), // GEO, rough range > 120 ms
  synthSat('J02', 38_500_000, [['1C', L1]]),
];

/** Field resolution per level: [pseudorange m, phase m, doppler m/s]. */
const RES: Record<MsmLevel, [number, number, number]> = {
  4: [C / 1000 / 2 ** 24, C / 1000 / 2 ** 29, Infinity],
  5: [C / 1000 / 2 ** 24, C / 1000 / 2 ** 29, 0.0001],
  6: [C / 1000 / 2 ** 29, C / 1000 / 2 ** 31, Infinity],
  7: [C / 1000 / 2 ** 29, C / 1000 / 2 ** 31, 0.0001],
};

describe('MSM encode → decode', () => {
  it.each([4, 5, 6, 7] as MsmLevel[])(
    'MSM%d preserves every observable to its resolution',
    (level) => {
      // MSM4/6 carry no GLONASS channel: a rover learns it from a 1020.
      if (level === 4 || level === 6) setGloFreqNumber(7, -4);
      const frames = decodeFrames(
        encodeMsm(
          { timeMs: T0, observations: SYNTH },
          { msm: level, stationId: 2731 }
        )
      );
      expect(frames.map((f) => f.messageType)).toEqual(
        [1070, 1080, 1090, 1110, 1120].map((b) => b + level)
      );
      // Every message but the last says "more follow for this epoch".
      expect(frames.map(multiBit)).toEqual([1, 1, 1, 1, 0]);

      const decoded = new Map<string, ObsSatObs>();
      for (const f of frames) {
        expect(new BitReader(f.payload).readU(24) & 0xfff).toBe(2731);
        const ep = decodeMsmFull(f)!;
        expect(
          obsEpochToDate(ep.system, ep.epochMs, new Date(T0)).getTime()
        ).toBe(T0);
        for (const o of ep.observations) decoded.set(o.prn, o);
      }

      const [rPr, rPh, rDop] = RES[level];
      for (const sat of SYNTH) {
        const got = decoded.get(sat.prn)!;
        expect(got, sat.prn).toBeDefined();
        expect(got.signals.map((s) => s.rinexCode)).toEqual(
          sat.signals
            .map((s) => s.rinexCode)
            .sort((a, b) => {
              // decoder emits in signal-ID order; the fixtures are already in it
              return (
                sat.signals.findIndex((s) => s.rinexCode === a) -
                sat.signals.findIndex((s) => s.rinexCode === b)
              );
            })
        );
        for (const want of sat.signals) {
          const s = got.signals.find((x) => x.rinexCode === want.rinexCode)!;
          const lambda = want.wavelength!;
          expect(
            Math.abs(s.pseudorange! - want.pseudorange!)
          ).toBeLessThanOrEqual(rPr / 2 + 1e-6);
          expect(
            Math.abs((s.phase! - want.phase!) * lambda)
          ).toBeLessThanOrEqual(rPh / 2 + 1e-6);
          expect(s.halfCycle).toBe(want.halfCycle);
          if (level >= 6) expect(s.cn0).toBe(want.cn0);
          else expect(s.cn0).toBe(Math.round(want.cn0!));
          if (rDop !== Infinity) {
            expect(
              Math.abs((s.doppler! - want.doppler!) * lambda)
            ).toBeLessThanOrEqual(rDop / 2 + 1e-9);
          } else {
            expect(s.doppler).toBeUndefined();
          }
          // Lock time: the largest representable value not above the input.
          expect(s.lockTime!).toBeLessThanOrEqual(want.lockTime!);
          expect(s.lockTime!).toBeGreaterThan(want.lockTime! / 2);
        }
      }
    }
  );

  it('carries the GLONASS channel in MSM5/7 so phase decodes without a 1020', () => {
    const frames = decodeFrames(
      encodeMsm({ timeMs: T0, observations: [SYNTH[2]!] }, { msm: 7 })
    );
    const sig = decodeMsmFull(frames[0]!)!.observations[0]!.signals[0]!;
    expect(sig.wavelength).toBeCloseTo(GLO1(-4), 12);
    expect(sig.phase).toBeDefined();
  });

  it('uses gloChannels when GLONASS signals arrive without a wavelength', () => {
    const sat: MsmEncodeSat = {
      prn: 'R07',
      signals: [{ rinexCode: '1C', pseudorange: 2e7, phase: 2e7 / GLO1(-4) }],
    };
    const noK = decodeMsmFull(
      decodeFrames(encodeMsm({ timeMs: T0, observations: [sat] }))[0]!
    )!;
    expect(noK.observations[0]!.signals[0]!.phase).toBeUndefined();
    resetGloFreqCache();
    const withK = decodeMsmFull(
      decodeFrames(
        encodeMsm(
          { timeMs: T0, observations: [sat] },
          { gloChannels: new Map([[7, -4]]) }
        )
      )[0]!
    )!;
    expect(withK.observations[0]!.signals[0]!.phase! * GLO1(-4)).toBeCloseTo(
      2e7,
      3
    );
  });

  it('splits a system across messages when cells exceed 64', () => {
    const codes: Array<[string, number]> = [
      ['1C', L1],
      ['1W', L1],
      ['2W', L2],
      ['2L', L2],
      ['5Q', E5a],
      ['1L', L1],
    ];
    const sats = Array.from({ length: 14 }, (_, i) =>
      synthSat(`G${String(i + 1).padStart(2, '0')}`, 2e7 + i * 1e5, codes)
    );
    const frames = decodeFrames(
      encodeMsm({ timeMs: T0, observations: sats }, { msm: 7 })
    );
    expect(frames.length).toBe(2); // 10 × 6 = 60 cells, then 4 × 6
    expect(frames.map(multiBit)).toEqual([1, 0]);
    const prns = frames.flatMap((f) =>
      decodeMsmFull(f)!.observations.map((o) => o.prn)
    );
    expect(prns).toEqual(sats.map((s) => s.prn));
  });

  it('maps QZSS 193+ and SBAS 120+ PRN numbering', () => {
    const frames = decodeFrames(
      encodeMsm({
        timeMs: T0,
        observations: [
          synthSat('J194', 3.8e7, [['1C', L1]]),
          synthSat('S23', 3.8e7, [['1C', L1]]),
        ],
      })
    );
    const prns = frames.map((f) => decodeMsmFull(f)!.observations[0]!.prn);
    expect(prns).toEqual(['S123', 'J02']); // decoder's own SBAS naming
  });

  it('marks a signal with pseudorange but no phase as phase-invalid', () => {
    const sat: MsmEncodeSat = {
      prn: 'G01',
      signals: [{ rinexCode: '1C', wavelength: L1, pseudorange: 2.1e7 }],
    };
    const s = decodeMsmFull(
      decodeFrames(encodeMsm({ timeMs: T0, observations: [sat] }))[0]!
    )!.observations[0]!.signals[0]!;
    expect(s.pseudorange).toBeCloseTo(2.1e7, 3);
    expect(s.phase).toBeUndefined();
    expect(s.doppler).toBeUndefined();
  });
});

describe('compact MSM1–3', () => {
  const LIGHT_MS = C / 1000;
  it.each([1, 2, 3] as MsmLevel[])(
    'MSM%d carries its fields, ranges exact modulo 1 ms',
    (level) => {
      setGloFreqNumber(7, -4); // no DF419 in MSM1–3 either: from a 1020
      const frames = decodeFrames(
        encodeMsm({ timeMs: T0, observations: SYNTH }, { msm: level })
      );
      expect(frames.map((f) => f.messageType % 10)).toEqual(
        frames.map(() => level)
      );
      expect(frames.every((f) => decodeMsmFull(f) === null)).toBe(true); // opt-in only
      for (const f of frames) {
        const ep = decodeMsmFull(f, { compactMsm: true })!;
        expect(ep.rangeModulo1ms).toBe(true);
        for (const o of ep.observations) {
          const want = SYNTH.find((x) => x.prn === o.prn)!;
          const ks = new Set<number>();
          for (const sig of o.signals) {
            const w = want.signals.find((x) => x.rinexCode === sig.rinexCode)!;
            expect(sig.cn0).toBeUndefined();
            expect(sig.doppler).toBeUndefined();
            if (level === 2) expect(sig.pseudorange).toBeUndefined();
            else {
              const k = (w.pseudorange! - sig.pseudorange!) / LIGHT_MS;
              expect(Math.abs(k - Math.round(k)) * LIGHT_MS).toBeLessThan(0.01);
              ks.add(Math.round(k));
            }
            if (level === 1) expect(sig.phase).toBeUndefined();
            else {
              const lambda = w.wavelength!;
              const k = ((w.phase! - sig.phase!) * lambda) / LIGHT_MS;
              expect(Math.abs(k - Math.round(k)) * LIGHT_MS).toBeLessThan(
                0.001
              );
              ks.add(Math.round(k));
              expect(sig.halfCycle).toBe(w.halfCycle);
            }
          }
          expect(ks.size).toBe(1); // one whole-ms count per satellite
        }
      }
    }
  );

  it('shrinks the stream: MSM1 < MSM3 < MSM4 < MSM7', () => {
    const size = (level: MsmLevel) =>
      encodeMsm({ timeMs: T0, observations: SYNTH }, { msm: level }).reduce(
        (n, f) => n + f.length,
        0
      );
    expect(size(1)).toBeLessThan(size(3));
    expect(size(3)).toBeLessThan(size(4));
    expect(size(4)).toBeLessThan(size(7));
  });
});

describe('MSM lock arcs', () => {
  type Extra = Partial<MsmEncodeSat['signals'][number]>;
  const sat = (t: number, extra: Extra = {}): MsmEncodeSat => ({
    prn: 'G05',
    signals: [
      {
        rinexCode: '1C',
        wavelength: L1,
        pseudorange: 2e7 + t,
        phase: (2e7 + t) / L1,
        ...extra,
      },
    ],
  });
  const sigAt = (enc: MsmEncoder, t: number, extra: Extra = {}) =>
    decodeMsmFull(
      decodeFrames(
        enc.encode({ timeMs: T0 + t * 1000, observations: [sat(t, extra)] })
      )[0]!
    )!.observations[0]!.signals[0]!;

  it('grows lock time from presence alone and restarts after a gap', () => {
    const enc = new MsmEncoder({ msm: 7 });
    const locks = [0, 1, 2, 3].map((t) => sigAt(enc, t).lockTime!);
    expect(locks[0]).toBe(0);
    for (let i = 1; i < locks.length; i++) {
      expect(locks[i]!).toBeGreaterThan(locks[i - 1]!);
      expect(locks[i]!).toBeLessThanOrEqual(i);
    }
    // G05 missing from a GPS epoch (another GPS satellite present).
    enc.encode({
      timeMs: T0 + 4000,
      observations: [{ ...sat(4), prn: 'G06' }],
    });
    expect(sigAt(enc, 5).lockTime).toBe(0);
  });

  it('restarts on a flagged slip and when the receiver lock time drops', () => {
    const enc = new MsmEncoder({ msm: 7 });
    expect(sigAt(enc, 0, { lockTime: 100 }).lockTime).toBeGreaterThan(90);
    expect(sigAt(enc, 1, { lockTime: 101 }).lockTime).toBeGreaterThan(90);
    expect(sigAt(enc, 2, { lockTime: 0.5 }).lockTime).toBeLessThanOrEqual(0.5);
    expect(sigAt(enc, 3, { lockTime: 1.5 }).lockTime).toBeGreaterThan(1);
    expect(sigAt(enc, 4, { lockTime: 2.5, slip: true }).lockTime).toBe(0);
    // With receiver lock time, a skipped epoch is not a slip …
    expect(sigAt(enc, 7, { lockTime: 5.5 }).lockTime).toBeGreaterThan(2);
    // … but lock that grew less than the gap was lost in it (NovAtel E21):
    // the indicator must drop below the last one sent, or rovers miss it.
    const before = sigAt(enc, 8, { lockTime: 6.5 }).lockTime!;
    expect(sigAt(enc, 12, { lockTime: 6.8 }).lockTime).toBeLessThan(before);
    expect(sigAt(enc, 13, { lockTime: 7.8 }).lockTime).toBeLessThan(before);
    // A saturated counter (UBX 64.5 s) repeating is not a slip.
    const sat = new MsmEncoder({ msm: 7 });
    sigAt(sat, 0, { lockTime: 64.5 });
    expect(sigAt(sat, 5, { lockTime: 64.5 }).lockTime).toBeGreaterThan(65);
  });

  it('re-anchors a phase whose ambiguity is out of range, once per arc', () => {
    const enc = new MsmEncoder({ msm: 7 });
    const far = (t: number) => ({ phase: (2e7 + t) / L1 + 1e6 }); // 190 km off
    const a = sigAt(enc, 0, far(0));
    const b = sigAt(enc, 1, far(1));
    expect(Math.abs(a.phase! * L1 - a.pseudorange!)).toBeLessThan(1);
    // Same integer shift both epochs: phase differences are preserved.
    expect((b.phase! - a.phase!) * L1).toBeCloseTo(1, 3);
    expect(b.lockTime!).toBeGreaterThan(a.lockTime!);
  });
});

/* ------------------------------------------------------------------ */
/*  Real data: a Trimble RTK base (DLF100, TU Delft)                   */
/* ------------------------------------------------------------------ */

describe('real stream round trip (DLF100 MSM)', () => {
  const buf = new Uint8Array(
    readFileSync(join(FIX, 'dlf100_rtcm_rtk_base.rtcm'))
  );
  const frames = new Rtcm3Decoder().decode(buf);
  const REF = new Date('2026-11-06T00:00:00Z');

  /** Payload with DF393 (bit 54, multiple-message) cleared. */
  const sansMulti = (p: Uint8Array) => {
    const q = p.slice();
    q[6]! &= ~0x02;
    return q;
  };

  it('re-encodes every Trimble MSM7 message bit-for-bit', () => {
    resetGloFreqCache();
    const msm = frames.filter((f) => decodeMsmFull(f) !== null);
    expect(msm.length).toBe(430);

    // DLF100 is steered (DF411 = 1); the station ID comes from the stream.
    const stationId = new BitReader(msm[0]!.payload).readU(24) & 0xfff;
    const enc = new MsmEncoder({ msm: 7, stationId, clockSteering: 1 });
    let cells = 0;
    for (const f of msm) {
      const orig = decodeMsmFull(f)!;
      const timeMs = obsEpochToDate(orig.system, orig.epochMs, REF).getTime();
      const out = decodeFrames(
        enc.encode({ timeMs, observations: orig.observations })
      );
      expect(out).toHaveLength(1);
      // Identical except DF393, which depends on how the epoch is batched.
      expect(sansMulti(out[0]!.payload)).toEqual(sansMulti(f.payload));
      cells += orig.observations.reduce((n, o) => n + o.signals.length, 0);
    }
    expect(cells).toBe(12525);
  });

  it('encodes whole receiver epochs as one DF393 chain without losing a cell', () => {
    resetGloFreqCache();
    const msm = frames.filter((f) => decodeMsmFull(f) !== null);
    const epochs: Rtcm3Frame[][] = [];
    let cur: Rtcm3Frame[] = [];
    for (const f of msm) {
      cur.push(f);
      if (multiBit(f) === 0) {
        epochs.push(cur);
        cur = [];
      }
    }
    expect(epochs.length).toBeGreaterThan(50);
    const enc = new MsmEncoder({ msm: 7, clockSteering: 1 });
    const key = (e: ObsEpoch[]) =>
      e
        .flatMap((x) =>
          x.observations.flatMap((o) =>
            o.signals.map(
              (s) =>
                `${o.prn}${s.rinexCode}:${s.pseudorange}:${s.phase}:${s.cn0}`
            )
          )
        )
        .sort();
    for (const group of epochs) {
      const decoded = group.map((f) => decodeMsmFull(f)!);
      const timeMs = obsEpochToDate(
        decoded[0]!.system,
        decoded[0]!.epochMs,
        REF
      ).getTime();
      const out = decodeFrames(
        enc.encode({
          timeMs,
          observations: decoded.flatMap((e) => e.observations),
        })
      );
      // Trimble packs satellites by tracked-signal set; we fill in PRN
      // order. Both are valid — only the chain and the content must hold.
      expect(out.map(multiBit)).toEqual(
        out.map((_, i) => (i < out.length - 1 ? 1 : 0))
      );
      const again = out.map((f) => decodeMsmFull(f)!);
      for (const e of again) {
        const sigs = new Set(
          e.observations.flatMap((o) => o.signals.map((s) => s.rinexCode))
        );
        expect(e.observations.length * sigs.size).toBeLessThanOrEqual(64);
      }
      expect(key(again)).toEqual(key(decoded));
    }
  });
});
