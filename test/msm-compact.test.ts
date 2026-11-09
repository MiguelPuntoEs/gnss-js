import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  Rtcm3Decoder,
  createStreamStats,
  updateStreamStats,
  decodeObs,
  decodeMsmFull,
  obsEpochToDate,
  type ObsEpoch,
} from '../src/rtcm3';
import { ephInfoToEphemeris } from '../src/orbit';
import { resolveMsmRanges } from '../src/positioning';
import { C_LIGHT } from '../src/constants/gnss';

const LIGHT_MS = C_LIGHT / 1000;

/** MSB-first bit packer for building test frames. */
class BitWriter {
  private bits: number[] = [];
  u(v: number, n: number) {
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(v / 2 ** i) % 2);
    return this;
  }
  s(v: number, n: number) {
    return this.u(v < 0 ? 2 ** n + v : v, n);
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8) + 1);
    this.bits.forEach((b, i) => {
      if (b) out[i >> 3]! |= 0x80 >> (i & 7);
    });
    return out;
  }
}

/**
 * One GPS MSM1/2/3 frame: satellites G05 + G12, signal 1C (signal-mask index 1)
 * plus 2W (index 9) on G05 only. Field layout per RTCM 10403.3 §3.5 (as RTKLIB's
 * decode_msm1/2/3): header, DF398 per satellite, then per cell DF400 (MSM1/3),
 * DF401 + DF402 + DF420 (MSM2/3).
 */
function compactFrame(variant: 1 | 2 | 3) {
  const w = new BitWriter();
  const type = 1070 + variant;
  w.u(type, 12).u(1234, 12).u(345_600_000, 30); // TOW ms
  w.u(0, 1).u(0, 3).u(0, 7).u(0, 2).u(0, 2).u(0, 1).u(0, 3);
  // satellite mask: bits for PRN 5 and 12 (1-based, MSB first)
  for (let i = 1; i <= 64; i++) w.u(i === 5 || i === 12 ? 1 : 0, 1);
  // signal mask: index 1 → 1C, index 9 → 2W (RINEX ids from the GPS table)
  for (let i = 0; i < 32; i++) w.u(i === 1 || i === 9 ? 1 : 0, 1);
  // cell mask (sat-major): G05 {1C, 2W}, G12 {1C}
  w.u(1, 1).u(1, 1).u(1, 1).u(0, 1);
  // DF398 rough range mod 1 ms (×2^-10 ms)
  w.u(512, 10).u(100, 10);
  const cells = 3;
  if (variant !== 2) {
    // DF400 fine pseudorange (×2^-24 ms); the last cell invalid (-2^14)
    w.s(1000, 15).s(-2000, 15).s(-16384, 15);
  }
  if (variant !== 1) {
    // DF401 fine phase (×2^-29 ms), DF402 lock, DF420 half-cycle
    w.s(8000, 22).s(-16000, 22).s(100, 22);
    for (let i = 0; i < cells; i++) w.u(7, 4);
    w.u(0, 1).u(1, 1).u(0, 1);
  }
  const payload = w.bytes();
  return { messageType: type, length: payload.length, payload };
}

describe('compact MSM (1–3) decode', () => {
  const ms = (v: number) => (v * C_LIGHT) / 1000;

  it('MSM3: code + phase, modulo 1 ms, flagged', () => {
    const ep = decodeMsmFull(compactFrame(3), { compactMsm: true })!;
    expect(ep.rangeModulo1ms).toBe(true);
    expect(ep.observations.map((o) => o.prn)).toEqual(['G05', 'G12']);
    const [c1, c2] = ep.observations[0]!.signals;
    expect(c1!.rinexCode).toBe('1C');
    expect(c2!.rinexCode).toBe('2W');
    expect(c1!.pseudorange).toBeCloseTo(ms(0.5 + 1000 / 2 ** 24), 6);
    expect(c2!.pseudorange).toBeCloseTo(ms(0.5 - 2000 / 2 ** 24), 6);
    expect(c1!.phase! * c1!.wavelength).toBeCloseTo(
      ms(0.5 + 8000 / 2 ** 29),
      6
    );
    expect(c1!.cn0).toBeUndefined();
    expect(c1!.lockTime).toBeGreaterThan(0);
    expect(c2!.halfCycle).toBe(true);
    // G12's code cell is the invalid sentinel → phase only.
    const g12 = ep.observations[1]!.signals[0]!;
    expect(g12.pseudorange).toBeUndefined();
    expect(g12.phase).toBeDefined();
  });

  it('is opt-in: without compactMsm, MSM1–3 decode to null as before', () => {
    expect(decodeMsmFull(compactFrame(3))).toBeNull();
    expect(decodeObs(compactFrame(3))).toBeNull();
    expect(decodeObs(compactFrame(3), { compactMsm: true })).not.toBeNull();
  });

  it('the stream census lists compact-MSM satellites and signals', () => {
    const stats = createStreamStats();
    updateStreamStats(stats, [compactFrame(3)], 40);
    expect([...stats.satellites.keys()].sort()).toEqual(['G05', 'G12']);
    expect([...stats.obsTypes.G!].sort()).toEqual(['C1C', 'C2W', 'L1C', 'L2W']);
  });

  it('MSM1 is code only, MSM2 phase only', () => {
    const m1 = decodeMsmFull(compactFrame(1), { compactMsm: true })!
      .observations[0]!.signals[0]!;
    expect(m1.pseudorange).toBeDefined();
    expect(m1.phase).toBeUndefined();
    expect(m1.lockTime).toBeUndefined();
    const m2 = decodeMsmFull(compactFrame(2), { compactMsm: true })!
      .observations[0]!.signals[0]!;
    expect(m2.pseudorange).toBeUndefined();
    expect(m2.phase).toBeDefined();
  });
});

describe('resolveMsmRanges (real TU Delft MSM7, made compact)', () => {
  // ~60 s of DLF100NLD0 (TU Delft open caster): MSM7 + its own ephemerides
  // + the 1006 station position.
  const bytes = new Uint8Array(
    readFileSync(join(__dirname, '../test-fixtures/dlf100_rtcm_rtk_base.rtcm'))
  );
  const stats = createStreamStats();
  const frames = new Rtcm3Decoder().decode(bytes);
  updateStreamStats(stats, frames, bytes.length);
  const rx = stats.stationMeta.position!;
  const ref = new Date('2026-11-06T09:14:00Z');
  const epochs = frames
    .map((f) => decodeObs(f))
    .filter((e): e is ObsEpoch => e !== null && e.system !== 'R');

  /** Strip the whole milliseconds (after a common receiver-clock shift),
   *  exactly what an MSM3 encoder would have sent. */
  function makeCompact(ep: ObsEpoch, clockShiftM: number): ObsEpoch {
    return {
      ...ep,
      rangeModulo1ms: true,
      observations: ep.observations.map((o) => {
        const rough = o.signals.find(
          (s) => s.pseudorange !== undefined
        )!.pseudorange!;
        const n = Math.floor((rough + clockShiftM) / LIGHT_MS);
        const cut = n * LIGHT_MS - clockShiftM;
        return {
          ...o,
          signals: o.signals.map((s) => ({
            ...s,
            ...(s.pseudorange !== undefined
              ? { pseudorange: s.pseudorange - cut }
              : {}),
            ...(s.phase !== undefined && s.wavelength > 0
              ? { phase: s.phase - cut / s.wavelength }
              : {}),
          })),
        };
      }),
    };
  }

  it('recovers every range from a 30 km-off position and a 1.5 ms clock (fractions straddling ½)', () => {
    const rxOff: [number, number, number] = [
      rx[0] + 20e3,
      rx[1] - 15e3,
      rx[2] + 15e3,
    ];
    const shift = 1.5 * LIGHT_MS;
    let checked = 0;
    for (const ep of epochs.slice(0, 40)) {
      if (
        !ep.observations.every((o) =>
          o.signals.some((s) => s.pseudorange !== undefined)
        )
      )
        continue;
      const t = obsEpochToDate(ep.system, ep.epochMs, ref).getTime();
      const r = resolveMsmRanges(makeCompact(ep, shift), {
        timeMs: t,
        rxEcef: rxOff,
        ephFor: (prn) => {
          const info = stats.ephemerides.get(prn);
          return info ? ephInfoToEphemeris(info) : null;
        },
      });
      expect(r.rangeModulo1ms).toBeUndefined();
      const withEph = ep.observations.filter((o) =>
        stats.ephemerides.has(o.prn)
      );
      expect(r.observations).toHaveLength(withEph.length);
      // Every satellite back to its true range + the clock shift, up to ONE
      // whole millisecond common to the whole epoch (the receiver clock's
      // own ambiguity — absorbed by the solved clock, not the position).
      const offsets = r.observations.map((o) => {
        const orig = ep.observations.find((x) => x.prn === o.prn)!;
        const a = o.signals.find(
          (s) => s.pseudorange !== undefined
        )!.pseudorange!;
        const b = orig.signals.find(
          (s) => s.pseudorange !== undefined
        )!.pseudorange!;
        return a - (b + shift);
      });
      for (const d of offsets) {
        expect(Math.abs(d - offsets[0]!)).toBeLessThan(1e-6);
        const k = d / LIGHT_MS;
        expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
      }
      checked += r.observations.length;
    }
    expect(checked).toBeGreaterThan(200);
  });

  it('passes full-range epochs through untouched', () => {
    const ep = epochs[0]!;
    expect(
      resolveMsmRanges(ep, { timeMs: 0, rxEcef: rx, ephFor: () => null })
    ).toBe(ep);
  });
});
