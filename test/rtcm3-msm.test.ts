import { describe, it, expect, beforeEach } from 'vitest';
import {
  decodeMsmFull,
  obsEpochToDate,
  resetGloFreqCache,
} from '../src/rtcm3/msm';
import type { Rtcm3Frame } from '../src/rtcm3/decoder';

/* ================================================================== */
/*  Helpers to build synthetic MSM frames                              */
/* ================================================================== */

class BitWriter {
  private bytes: number[] = [];
  private currentByte = 0;
  private bitPos = 0; // bits written in currentByte (0-7)

  writeU(value: number, numBits: number): void {
    for (let i = numBits - 1; i >= 0; i--) {
      const bit = (value >>> i) & 1;
      this.currentByte = (this.currentByte << 1) | bit;
      this.bitPos++;
      if (this.bitPos === 8) {
        this.bytes.push(this.currentByte);
        this.currentByte = 0;
        this.bitPos = 0;
      }
    }
  }

  writeS(value: number, numBits: number): void {
    // Two's complement
    const mask = (1 << numBits) - 1;
    this.writeU(value & mask, numBits);
  }

  toUint8Array(): Uint8Array {
    const result = [...this.bytes];
    if (this.bitPos > 0) {
      result.push(this.currentByte << (8 - this.bitPos));
    }
    return new Uint8Array(result);
  }
}

/**
 * Build a minimal MSM4 frame for GPS with given satellites and signals.
 */
function buildMsm4Frame(opts: {
  messageType: number;
  satIndices: number[]; // 1-based satellite indices in the 64-bit mask
  sigIndices: number[]; // 0-based signal indices in the 32-bit mask
  // All cells active unless specified
  cellValues?: {
    psr: number; // raw signed 15-bit
    cp: number; // raw signed 22-bit
    ll: number; // 4-bit lock time
    hc: number; // 1-bit half cycle
    cnr: number; // 6-bit C/N0
  }[];
}): Rtcm3Frame {
  const { messageType, satIndices, sigIndices } = opts;
  const w = new BitWriter();

  // Message type (12 bits)
  w.writeU(messageType, 12);
  // Station ID (12 bits)
  w.writeU(0, 12);
  // Epoch time (30 bits) — use 100000 ms
  w.writeU(100000, 30);
  // Multiple message (1), IODS (3), reserved (7), clock steering (2),
  // external clock (2), smoothing (1), smoothing interval (3)
  w.writeU(0, 1 + 3 + 7 + 2 + 2 + 1 + 3);

  // Satellite mask (64 bits)
  let satMaskHi = 0;
  let satMaskLo = 0;
  for (const idx of satIndices) {
    if (idx <= 32) satMaskHi |= 1 << (32 - idx);
    else satMaskLo |= 1 << (64 - idx);
  }
  w.writeU(satMaskHi >>> 0, 32);
  w.writeU(satMaskLo >>> 0, 32);

  // Signal mask (32 bits)
  let sigMask = 0;
  for (const idx of sigIndices) {
    sigMask |= 1 << (31 - idx);
  }
  w.writeU(sigMask >>> 0, 32);

  const numSat = satIndices.length;
  const numSig = sigIndices.length;

  // Cell mask (all active)
  for (let i = 0; i < numSat * numSig; i++) {
    w.writeU(1, 1);
  }

  // Satellite data (MSM4): rrint(8) + rrmod(10) per sat.
  // No extended sat info — DF419 exists only in MSM5/7.
  for (let j = 0; j < numSat; j++) {
    w.writeU(80, 8); // ~80ms rough range integer
  }
  for (let j = 0; j < numSat; j++) {
    w.writeU(512, 10); // ~0.5ms fractional rough range
  }

  // Signal data (MSM4): psr(s15) + cp(s22) + ll(4) + hc(1) + cnr(6)
  const numCells = numSat * numSig;
  const cells =
    opts.cellValues ??
    Array.from({ length: numCells }, () => ({
      psr: 1000,
      cp: 2000,
      ll: 6,
      hc: 0,
      cnr: 42,
    }));

  for (let i = 0; i < numCells; i++) w.writeS(cells[i]!.psr, 15);
  for (let i = 0; i < numCells; i++) w.writeS(cells[i]!.cp, 22);
  for (let i = 0; i < numCells; i++) w.writeU(cells[i]!.ll, 4);
  for (let i = 0; i < numCells; i++) w.writeU(cells[i]!.hc, 1);
  for (let i = 0; i < numCells; i++) w.writeU(cells[i]!.cnr, 6);

  const payload = w.toUint8Array();
  return { messageType, length: payload.length, payload };
}

/**
 * Build a minimal MSM7 frame (GPS) with one satellite and one signal.
 * MSM7 sat data: rrint(8) + extsat(4) + rrmod(10) + rdop(s14);
 * cell data: psr(s20) + cp(s24) + ll(10) + hc(1) + cnr(10) + dop(s15).
 */
function buildMsm7Frame(cell: {
  psr: number; // raw signed 20-bit
  cp: number; // raw signed 24-bit
  ll: number;
  hc: number;
  cnr: number; // raw, 1/16 dB-Hz
  dop: number; // raw signed 15-bit
}): Rtcm3Frame {
  const w = new BitWriter();
  w.writeU(1077, 12); // GPS MSM7
  w.writeU(0, 12);
  w.writeU(100000, 30);
  w.writeU(0, 1 + 3 + 7 + 2 + 2 + 1 + 3);
  w.writeU(0x80000000, 32); // sat mask: G01
  w.writeU(0, 32);
  w.writeU(1 << 30, 32); // signal mask: index 1 → "1C"
  w.writeU(1, 1); // cell mask

  w.writeU(80, 8); // rough range integer (ms)
  w.writeU(0, 4); // extended sat info
  w.writeU(512, 10); // rough range fraction (512/1024 ms)
  w.writeS(0, 14); // rough phase range rate

  w.writeS(cell.psr, 20);
  w.writeS(cell.cp, 24);
  w.writeU(cell.ll, 10);
  w.writeU(cell.hc, 1);
  w.writeU(cell.cnr, 10);
  w.writeS(cell.dop, 15);

  const payload = w.toUint8Array();
  return { messageType: 1077, length: payload.length, payload };
}

/* ================================================================== */
/*  Tests                                                              */
/* ================================================================== */

beforeEach(() => {
  resetGloFreqCache();
});

describe('decodeMsmFull', () => {
  it('returns null for non-MSM messages', () => {
    const frame: Rtcm3Frame = {
      messageType: 1005,
      length: 20,
      payload: new Uint8Array(20),
    };
    expect(decodeMsmFull(frame)).toBeNull();
  });

  it('returns null for MSM1-3', () => {
    const frame: Rtcm3Frame = {
      messageType: 1073,
      length: 20,
      payload: new Uint8Array(20),
    };
    expect(decodeMsmFull(frame)).toBeNull();
  });

  it('decodes GPS MSM4 with one satellite and one signal', () => {
    const frame = buildMsm4Frame({
      messageType: 1074,
      satIndices: [1], // G01
      sigIndices: [1], // signal index 1 → "1C"
    });

    const epoch = decodeMsmFull(frame);
    expect(epoch).not.toBeNull();
    expect(epoch!.system).toBe('G');
    expect(epoch!.messageType).toBe(1074);
    expect(epoch!.observations).toHaveLength(1);

    const obs = epoch!.observations[0]!;
    expect(obs.prn).toBe('G01');
    expect(obs.system).toBe('G');
    expect(obs.signals).toHaveLength(1);
    expect(obs.signals[0]!.rinexCode).toBe('1C');
    expect(obs.signals[0]!.pseudorange).toBeGreaterThan(0);
    expect(obs.signals[0]!.phase).toBeGreaterThan(0);
    expect(obs.signals[0]!.cn0).toBe(42);
    expect(obs.signals[0]!.wavelength).toBeCloseTo(0.190294, 4);
  });

  it('decodes GPS MSM4 with multiple satellites', () => {
    const frame = buildMsm4Frame({
      messageType: 1074,
      satIndices: [1, 5, 10], // G01, G05, G10
      sigIndices: [1], // "1C"
    });

    const epoch = decodeMsmFull(frame);
    expect(epoch).not.toBeNull();
    expect(epoch!.observations).toHaveLength(3);
    expect(epoch!.observations.map((o) => o.prn)).toEqual([
      'G01',
      'G05',
      'G10',
    ]);
  });

  it('decodes GPS MSM4 with multiple signals', () => {
    const frame = buildMsm4Frame({
      messageType: 1074,
      satIndices: [1],
      sigIndices: [1, 7], // "1C" (L1) and "2C" (L2)
    });

    const epoch = decodeMsmFull(frame);
    expect(epoch).not.toBeNull();
    expect(epoch!.observations).toHaveLength(1);
    expect(epoch!.observations[0]!.signals).toHaveLength(2);
    expect(epoch!.observations[0]!.signals.map((s) => s.rinexCode)).toEqual([
      '1C',
      '2C',
    ]);
  });

  it('decodes Galileo MSM4', () => {
    const frame = buildMsm4Frame({
      messageType: 1094, // Galileo MSM4
      satIndices: [1, 2],
      sigIndices: [1], // "1C" (E1)
    });

    const epoch = decodeMsmFull(frame);
    expect(epoch).not.toBeNull();
    expect(epoch!.system).toBe('E');
    expect(epoch!.observations).toHaveLength(2);
    expect(epoch!.observations[0]!.prn).toBe('E01');
    expect(epoch!.observations[0]!.signals[0]!.rinexCode).toBe('1C');
  });

  it('decodes BeiDou MSM4', () => {
    const frame = buildMsm4Frame({
      messageType: 1124, // BDS MSM4
      satIndices: [3],
      sigIndices: [1], // "2I" (B1)
    });

    const epoch = decodeMsmFull(frame);
    expect(epoch).not.toBeNull();
    expect(epoch!.system).toBe('C');
    expect(epoch!.observations[0]!.prn).toBe('C03');
    expect(epoch!.observations[0]!.signals[0]!.rinexCode).toBe('2I');
  });

  it('skips unknown signal indices', () => {
    const frame = buildMsm4Frame({
      messageType: 1074,
      satIndices: [1],
      sigIndices: [0], // index 0 → EMPTY (no code)
    });

    const epoch = decodeMsmFull(frame);
    // The satellite might have 0 signals if all are unknown
    expect(epoch).not.toBeNull();
    expect(epoch!.observations).toHaveLength(0);
  });

  it('reports C/N0 = 0 as undefined', () => {
    const frame = buildMsm4Frame({
      messageType: 1074,
      satIndices: [1],
      sigIndices: [1],
      cellValues: [{ psr: 1000, cp: 2000, ll: 0, hc: 0, cnr: 0 }],
    });

    const epoch = decodeMsmFull(frame);
    expect(epoch!.observations[0]!.signals[0]!.cn0).toBeUndefined();
  });

  it('reports lock time from indicator', () => {
    const frame = buildMsm4Frame({
      messageType: 1074,
      satIndices: [1],
      sigIndices: [1],
      cellValues: [{ psr: 1000, cp: 2000, ll: 6, hc: 0, cnr: 42 }],
    });

    const epoch = decodeMsmFull(frame);
    // LTI 6 for MSM4 → 1.024 seconds
    expect(epoch!.observations[0]!.signals[0]!.lockTime).toBeCloseTo(1.024, 3);
  });
});

describe('obsEpochToDate', () => {
  it('converts GPS epoch time', () => {
    // epochMs = 86400000 means 1 day into the GPS week
    // With any ref time, the result should be a valid date near the ref
    const refTime = new Date('2024-03-10T12:00:00Z');
    const date = obsEpochToDate('G', 86400000, refTime);
    expect(date).toBeInstanceOf(Date);
    // Should be within a week of the reference time
    expect(Math.abs(date.getTime() - refTime.getTime())).toBeLessThan(
      7 * 86400000
    );
  });

  it('converts BDS epoch time', () => {
    const refTime = new Date('2024-03-10T12:00:00Z');
    const date = obsEpochToDate('C', 0, refTime);
    // BDS week start
    expect(date).toBeInstanceOf(Date);
    expect(date.getTime()).toBeGreaterThan(0);
  });
});

describe('MSM7 fine phase scaling', () => {
  const C = 299792458;
  const L1 = 1575.42e6;
  const lambda = C / L1;
  const roughMs = 80 + 512 / 1024;
  const roughM = (roughMs * C) / 1000;

  it('decodes negative fine phase with correct sign', () => {
    // Regression: cp was divided by (1 << 31), which is NEGATIVE in JS,
    // flipping the sign of every MSM6/7 fine phase value.
    const frame = buildMsm7Frame({
      psr: 1000,
      cp: -2000,
      ll: 100,
      hc: 0,
      cnr: 672, // 42 dB-Hz in 1/16 units
      dop: 0,
    });
    const epoch = decodeMsmFull(frame);
    expect(epoch).not.toBeNull();
    const sig = epoch!.observations[0]!.signals[0]!;
    const expected = ((-2000 / 2 ** 31) * C) / 1000 / lambda + roughM / lambda;
    expect(sig.phase).toBeCloseTo(expected, 1);
    expect(sig.phase!).toBeLessThan(roughM / lambda);
    expect(sig.pseudorange).toBeCloseTo(
      ((1000 / 2 ** 29) * C) / 1000 + roughM,
      3
    );
    expect(sig.cn0).toBe(42);
  });

  it('treats the invalid-value sentinels as missing data', () => {
    // Most-negative raw values mean "not available" per RTCM 10403.3.
    // With the (1 << 31) bug the phase sentinel became +1/256 and
    // passed the validity check.
    const frame = buildMsm7Frame({
      psr: -524288, // s20 sentinel
      cp: -8388608, // s24 sentinel
      ll: 0,
      hc: 0,
      cnr: 672,
      dop: 0,
    });
    const epoch = decodeMsmFull(frame);
    expect(epoch).not.toBeNull();
    const sig = epoch!.observations[0]!.signals[0]!;
    expect(sig.phase).toBeUndefined();
    expect(sig.pseudorange).toBeUndefined();
  });
});

describe('MSM4 satellite-data alignment', () => {
  const C = 299792458;
  const lambda = C / 1575.42e6;
  const roughMs = 80 + 512 / 1024;
  const roughM = (roughMs * C) / 1000;

  it('decodes exact values (no phantom DF419 in MSM4)', () => {
    // Regression: MSM4/6 were decoded with a spurious 4-bit extended
    // satellite info field (MSM5/7 only), shifting all cell data by
    // 4 x numSat bits.
    const frame = buildMsm4Frame({
      messageType: 1074,
      satIndices: [1],
      sigIndices: [1],
      cellValues: [{ psr: 1000, cp: 2000, ll: 6, hc: 0, cnr: 42 }],
    });
    const epoch = decodeMsmFull(frame);
    expect(epoch).not.toBeNull();
    const sig = epoch!.observations[0]!.signals[0]!;
    expect(sig.pseudorange).toBeCloseTo(
      ((1000 / 2 ** 24) * C) / 1000 + roughM,
      3
    );
    expect(sig.phase).toBeCloseTo(
      ((2000 / 2 ** 29) * C) / 1000 / lambda + roughM / lambda,
      1
    );
    expect(sig.cn0).toBe(42);
  });
});

describe('lockTimeSec via MSM7 decode', () => {
  it('returns seconds for the 10-bit indicator (DF407 is in ms)', () => {
    // lti=100 → (100-96)*4+128 = 144 ms = 0.144 s (was returned as 144)
    const frame = buildMsm7Frame({
      psr: 0,
      cp: 0,
      ll: 100,
      hc: 0,
      cnr: 672,
      dop: 0,
    });
    const sig = decodeMsmFull(frame)!.observations[0]!.signals[0]!;
    expect(sig.lockTime).toBeCloseTo(0.144, 6);
  });

  it('matches the original piecewise table at range boundaries', () => {
    for (const [lti, ms] of [
      [0, 0],
      [63, 63],
      [64, 64],
      [95, 126],
      [96, 128],
    ] as const) {
      const frame = buildMsm7Frame({
        psr: 0,
        cp: 0,
        ll: lti,
        hc: 0,
        cnr: 672,
        dop: 0,
      });
      const sig = decodeMsmFull(frame)!.observations[0]!.signals[0]!;
      expect(sig.lockTime).toBeCloseTo(ms / 1000, 9);
    }
    // Top of the table: lti=1023 → (1023-704)*2^21 + 2^26 ms
    const frame = buildMsm7Frame({
      psr: 0,
      cp: 0,
      ll: 1023,
      hc: 0,
      cnr: 672,
      dop: 0,
    });
    const sig = decodeMsmFull(frame)!.observations[0]!.signals[0]!;
    expect(sig.lockTime).toBeCloseTo((319 * 2 ** 21 + 2 ** 26) / 1000, 3);
  });
});

describe('obsEpochToDate BDS convention', () => {
  it('a BDS sow maps to the same instant as GPS sow + 14 s', () => {
    // BDT = GPS − 14 s: the BDT instant with sow s equals the GPS
    // instant with sow s + 14, so both branches must return the same
    // UTC Date (both apply the fixed 18 s GPS→UTC leap offset).
    const ref = new Date('2024-03-10T12:00:00Z');
    const sowBds = 40_000_000; // ms into the BDT week
    const bds = obsEpochToDate('C', sowBds, ref);
    const gps = obsEpochToDate('G', sowBds + 14_000, ref);
    expect(bds.getTime()).toBe(gps.getTime());
  });
});

describe('obsEpochToDate — GPS-scale convention', () => {
  // Real DELF00NLD0 capture, cross-checked against RTKLIB convbin:
  // GPS tow 355229000 ms in week 2427+? tagged 2026-07-23 02:40:29 GPS.
  // The old implementation subtracted leap seconds (returning UTC),
  // which put every downstream satellite position 18 s early.
  it('maps a GPS MSM epoch to the GPS clock face, not UTC', () => {
    const ref = new Date(Date.UTC(2026, 6, 23, 2, 43, 0));
    const d = obsEpochToDate('G', 355229000, ref);
    expect(d.toISOString()).toBe('2026-07-23T02:40:29.000Z');
  });

  it('keeps GLONASS on the same scale (UTC+3h day time + leap)', () => {
    // GLONASS epoch for the same instant: GPS 02:40:29 = UTC 02:40:11
    // = Moscow 05:40:11 on Thursday (dow 4).
    const ref = new Date(Date.UTC(2026, 6, 23, 2, 43, 0));
    const msOfDay = ((5 * 60 + 40) * 60 + 11) * 1000;
    const epochMs = (4 << 27) | msOfDay;
    const d = obsEpochToDate('R', epochMs, ref);
    expect(d.toISOString()).toBe('2026-07-23T02:40:29.000Z');
  });

  it('keeps BDS on the same scale (BDT = GPS − 14 s)', () => {
    // Same instant in BDS SOW: GPS tow 355229 s − 14 s = 355215 s
    const ref = new Date(Date.UTC(2026, 6, 23, 2, 43, 0));
    const d = obsEpochToDate('C', 355215000, ref);
    expect(d.toISOString()).toBe('2026-07-23T02:40:29.000Z');
  });
});
