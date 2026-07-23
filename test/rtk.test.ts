import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { solveDgnss, RtkFloatEngine, toRtkEpoch } from '../src/positioning/rtk';
import type {
  RtkMeasurement,
  RtkEpochMeasurements,
} from '../src/positioning/rtk';
import { satClockCorrection } from '../src/positioning';
import { computeSatPosition, ecefToAzEl } from '../src/orbit';
import type {
  Ephemeris,
  GlonassEphemeris,
  KeplerEphemeris,
} from '../src/rinex/nav';
import { geodeticToEcef, getEnuDifference } from '../src/coordinates/ecef';
import { C_LIGHT, OMEGA_E } from '../src/constants/gnss';
import { parseNovatelRange, parseNovatelNav } from '../src/novatel';

/* ================================================================== */
/*  Synthetic scenario: exact geometry, known baseline                 */
/* ================================================================== */

const GPS_EPOCH = Date.UTC(1980, 0, 6);
const T0 = Date.UTC(2025, 2, 26, 4, 0, 0); // GPS-scale epoch ms
const sowOf = (ms: number) => ((ms - GPS_EPOCH) / 1000) % 604800;
const weekOf = (ms: number) => Math.floor((ms - GPS_EPOCH) / (604800 * 1000));

const BASE = geodeticToEcef(
  (30.53 * Math.PI) / 180,
  (114.36 * Math.PI) / 180,
  40
);
const TRUE_BASELINE: [number, number, number] = [3.2, -2.4, 1.7];
const ROVER: [number, number, number] = [
  BASE[0] + TRUE_BASELINE[0],
  BASE[1] + TRUE_BASELINE[1],
  BASE[2] + TRUE_BASELINE[2],
];

/** Circular MEO ephemeris (zero clock — cancels in DD anyway). */
function kepler(prn: string, m0: number, omega0: number): KeplerEphemeris {
  return {
    system: prn[0] as 'G' | 'E' | 'C',
    prn,
    toc: sowOf(T0),
    tocDate: new Date(T0),
    af0: 0,
    af1: 0,
    af2: 0,
    iode: 1,
    crs: 0,
    deltaN: 0,
    m0,
    cuc: 0,
    e: 0,
    cus: 0,
    sqrtA: Math.sqrt(26559800),
    toe: sowOf(T0),
    cic: 0,
    omega0,
    cis: 0,
    i0: 0.9617,
    crc: 0,
    omega: 0,
    omegaDot: 0,
    idot: 0,
    week: weekOf(T0),
    svHealth: 0,
    tgd: 0,
  };
}

/** Pick `count` ephemerides visible above 20° elevation at BASE. */
function visibleKepler(sysPrefix: string, count: number): KeplerEphemeris[] {
  const out: { eph: KeplerEphemeris; el: number }[] = [];
  let n = 1;
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 6; j++) {
      const eph = kepler(
        `${sysPrefix}${String(n).padStart(2, '0')}`,
        (i * Math.PI) / 6,
        (j * Math.PI) / 3
      );
      const s = computeSatPosition(eph, T0);
      const el = ecefToAzEl(BASE[0], BASE[1], BASE[2], s.x, s.y, s.z).el;
      if (el > (20 * Math.PI) / 180) {
        out.push({ eph, el });
        n++;
      }
    }
  }
  out.sort((a, b) => b.el - a.el);
  return out.slice(0, count).map((o, i) => ({
    ...o.eph,
    prn: `${sysPrefix}${String(i + 1).padStart(2, '0')}`,
  }));
}

function sagnac(
  pos: { x: number; y: number; z: number },
  travelS: number
): [number, number, number] {
  const th = OMEGA_E * travelS;
  const c = Math.cos(th);
  const s = Math.sin(th);
  return [pos.x * c + pos.y * s, -pos.x * s + pos.y * c, pos.z];
}

/**
 * Synthesize a measurement exactly consistent with the solver's model
 * (same computeSatPosition / Sagnac / transmission-time handling), so
 * a noise-free scenario must be recovered to numerical precision.
 */
function synth(
  eph: Ephemeris,
  rx: readonly [number, number, number],
  timeMs: number,
  o: {
    code: string;
    clockM: number;
    lambdaM: number;
    ambCycles?: number;
    phaseBiasCycles?: number;
    lockTimeMs?: number;
    gloChannel?: number | null;
    prBiasM?: number;
  }
): RtkMeasurement {
  let pr = 2.4e7;
  let rho = 0;
  for (let i = 0; i < 10; i++) {
    const tTx = timeMs - (pr / C_LIGHT) * 1000;
    const dts = satClockCorrection(eph, tTx);
    const sat = computeSatPosition(eph, tTx - dts * 1000);
    const travel =
      Math.hypot(sat.x - rx[0], sat.y - rx[1], sat.z - rx[2]) / C_LIGHT;
    const [sx, sy, sz] = sagnac(sat, travel);
    rho = Math.hypot(sx - rx[0], sy - rx[1], sz - rx[2]);
    pr = rho + o.clockM;
  }
  return {
    code: o.code,
    pr: pr + (o.prBiasM ?? 0),
    cp:
      (rho + o.clockM) / o.lambdaM +
      (o.phaseBiasCycles ?? 0) +
      (o.ambCycles ?? 0),
    lockTimeMs: o.lockTimeMs ?? 600_000,
    gloChannel: o.gloChannel ?? null,
  };
}

const L1 = C_LIGHT / 1575.42e6;

interface Scenario {
  ephs: Ephemeris[];
  amb: Record<string, number>; // true SD integer ambiguity per PRN
}

function gpsGalScenario(): Scenario {
  const ephs = [...visibleKepler('G', 6), ...visibleKepler('E', 5)];
  const amb: Record<string, number> = {};
  ephs.forEach((e, i) => {
    amb[e.prn] = ((i * 37) % 25) - 12; // deterministic pseudo-random ints
  });
  return { ephs, amb };
}

/** Build one epoch pair; rover ambiguity = base amb + scenario int. */
function makeEpoch(
  sc: Scenario,
  timeMs: number,
  opts: {
    exclude?: string[];
    prBias?: Record<string, number>;
    extraAmb?: Record<string, number>;
    lockTimeMs?: Record<string, number>;
  } = {}
): { rover: Map<string, RtkMeasurement>; base: Map<string, RtkMeasurement> } {
  const rover = new Map<string, RtkMeasurement>();
  const base = new Map<string, RtkMeasurement>();
  const lock = 600_000 + (timeMs - T0);
  for (const eph of sc.ephs) {
    if (opts.exclude?.includes(eph.prn)) continue;
    const sys = eph.prn[0]!;
    // Distinct receiver clock/code bias per system exercises the
    // inter-system independence of the DD (nothing must leak).
    const clockBase = sys === 'G' ? 150 : sys === 'E' ? 210 : 95;
    const clockRover = sys === 'G' ? -80 : sys === 'E' ? -35 : -120;
    base.set(
      eph.prn,
      synth(eph, BASE, timeMs, {
        code: '1C',
        clockM: clockBase,
        lambdaM: L1,
        phaseBiasCycles: 0.31,
        lockTimeMs: lock,
      })
    );
    rover.set(
      eph.prn,
      synth(eph, ROVER, timeMs, {
        code: '1C',
        clockM: clockRover,
        lambdaM: L1,
        phaseBiasCycles: -0.72,
        ambCycles: sc.amb[eph.prn]! + (opts.extraAmb?.[eph.prn] ?? 0),
        lockTimeMs: opts.lockTimeMs?.[eph.prn] ?? lock,
        prBiasM: opts.prBias?.[eph.prn],
      })
    );
  }
  return { rover, base };
}

/** Expected DD ambiguity (cycles) of `prn` against its group ref. */
function expectDd(sc: Scenario, refs: Record<string, string>, prn: string) {
  const ref = refs[prn[0] + '1C']!;
  return sc.amb[prn]! - sc.amb[ref]!;
}

/* ================================================================== */
/*  solveDgnss                                                         */
/* ================================================================== */

describe('solveDgnss (synthetic geometry)', () => {
  const sc = gpsGalScenario();

  it('recovers an exact known baseline from DD pseudoranges', () => {
    const { rover, base } = makeEpoch(sc, T0);
    const sol = solveDgnss(rover, base, BASE, sc.ephs, T0, {
      troposphere: false,
    });
    expect(sol).not.toBeNull();
    expect(sol!.converged).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(sol!.position[i]! - ROVER[i]!)).toBeLessThan(1e-3);
      expect(Math.abs(sol!.baseline[i]! - TRUE_BASELINE[i]!)).toBeLessThan(
        1e-3
      );
    }
    // One reference per signal group, chosen at highest elevation.
    expect(Object.keys(sol!.refSatellites).sort()).toEqual(['E1C', 'G1C']);
    expect(sol!.nSats).toBe(11);
    expect(sol!.rejectedSatellites).toEqual([]);
  });

  it('per-constellation DD: reference satellites are the highest', () => {
    const { rover, base } = makeEpoch(sc, T0);
    const sol = solveDgnss(rover, base, BASE, sc.ephs, T0, {
      troposphere: false,
    })!;
    for (const [group, refPrn] of Object.entries(sol.refSatellites)) {
      const els = sc.ephs
        .filter((e) => e.prn[0] === group[0])
        .map((e) => {
          const s = computeSatPosition(e, T0);
          return {
            prn: e.prn,
            el: ecefToAzEl(BASE[0], BASE[1], BASE[2], s.x, s.y, s.z).el,
          };
        })
        .sort((a, b) => b.el - a.el);
      expect(refPrn).toBe(els[0]!.prn);
    }
  });

  it('rejects a satellite with a gross pseudorange error', () => {
    const { rover, base } = makeEpoch(sc, T0, { prBias: { G04: 80 } });
    const sol = solveDgnss(rover, base, BASE, sc.ephs, T0, {
      troposphere: false,
    });
    expect(sol).not.toBeNull();
    expect(sol!.rejectedSatellites).toContain('G04');
    for (let i = 0; i < 3; i++)
      expect(Math.abs(sol!.position[i]! - ROVER[i]!)).toBeLessThan(1e-3);
  });

  it('returns null when fewer than 3 DD rows remain', () => {
    const { rover, base } = makeEpoch(sc, T0, {
      exclude: sc.ephs.slice(3).map((e) => e.prn),
    });
    expect(
      solveDgnss(rover, base, BASE, sc.ephs, T0, { troposphere: false })
    ).toBeNull();
  });
});

/* ================================================================== */
/*  RtkFloatEngine                                                     */
/* ================================================================== */

describe('RtkFloatEngine (synthetic geometry)', () => {
  const sc = gpsGalScenario();
  const mk = () =>
    new RtkFloatEngine(BASE, sc.ephs, { mode: 'static', troposphere: false });

  it('converges to the exact baseline with integer float ambiguities', () => {
    const engine = mk();
    let first = null;
    let last = null;
    for (let k = 0; k < 4; k++) {
      const t = T0 + k * 1000;
      const { rover, base } = makeEpoch(sc, t);
      last = engine.process(rover, base, t);
      first ??= last;
    }
    expect(last).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(last!.position[i]! - ROVER[i]!)).toBeLessThan(1e-3);
      expect(
        Math.abs(last!.floatBaseline[i]! - TRUE_BASELINE[i]!)
      ).toBeLessThan(1e-3);
    }
    expect(last!.nSats).toBe(11);
    expect(last!.ratio).toBeUndefined();
    // Noise-free: every float DD ambiguity must sit on its integer.
    for (const [prn, n] of Object.entries(last!.ambiguities)) {
      expect(Math.abs(n - expectDd(sc, last!.refSatellites, prn))).toBeLessThan(
        1e-6
      );
    }
    // Formal position sigmas tighten as code epochs accumulate (the
    // float ambiguities keep them above the phase level this early —
    // that separation is exactly what stage 2's LAMBDA will resolve).
    for (let i = 0; i < 3; i++) {
      expect(last!.sigmas[i]!).toBeLessThan(first!.sigmas[i]!);
      expect(last!.sigmas[i]!).toBeLessThan(3);
    }
  });

  it('switches reference satellites and re-maps ambiguities exactly', () => {
    const engine = mk();
    let sol = null;
    for (let k = 0; k < 3; k++) {
      const t = T0 + k * 1000;
      const { rover, base } = makeEpoch(sc, t);
      sol = engine.process(rover, base, t);
    }
    const gRefBefore = sol!.refSatellites['G1C']!;
    // Drop the current GPS reference: the engine must re-target.
    for (let k = 3; k < 5; k++) {
      const t = T0 + k * 1000;
      const { rover, base } = makeEpoch(sc, t, { exclude: [gRefBefore] });
      sol = engine.process(rover, base, t);
    }
    const gRefAfter = sol!.refSatellites['G1C']!;
    expect(gRefAfter).not.toBe(gRefBefore);
    for (let i = 0; i < 3; i++)
      expect(Math.abs(sol!.position[i]! - ROVER[i]!)).toBeLessThan(1e-3);
    // Re-mapped ambiguities stay on the integers of the new reference.
    for (const [prn, n] of Object.entries(sol!.ambiguities)) {
      if (prn === gRefBefore) continue; // dropped sat keeps a dormant state
      expect(Math.abs(n - expectDd(sc, sol!.refSatellites, prn))).toBeLessThan(
        1e-6
      );
    }
  });

  it('resets the ambiguity on loss of lock (cycle slip)', () => {
    const engine = mk();
    for (let k = 0; k < 3; k++) {
      const t = T0 + k * 1000;
      const { rover, base } = makeEpoch(sc, t);
      engine.process(rover, base, t);
    }
    // G03 slips by +7 cycles and its lock time restarts.
    let sol = null;
    for (let k = 3; k < 5; k++) {
      const t = T0 + k * 1000;
      const { rover, base } = makeEpoch(sc, t, {
        extraAmb: { G03: 7 },
        lockTimeMs: { G03: 500 + (k - 3) * 1000 },
      });
      sol = engine.process(rover, base, t);
    }
    for (let i = 0; i < 3; i++)
      expect(Math.abs(sol!.position[i]! - ROVER[i]!)).toBeLessThan(1e-3);
    expect(
      Math.abs(
        sol!.ambiguities['G03']! - (expectDd(sc, sol!.refSatellites, 'G03') + 7)
      )
    ).toBeLessThan(1e-6);
  });

  it('re-initialises on phase/code divergence without a lock cue', () => {
    const engine = mk();
    for (let k = 0; k < 3; k++) {
      const t = T0 + k * 1000;
      const { rover, base } = makeEpoch(sc, t);
      engine.process(rover, base, t);
    }
    // +40 cycles ≈ 7.6 m phase jump, lock time keeps counting.
    let sol = null;
    for (let k = 3; k < 5; k++) {
      const t = T0 + k * 1000;
      const { rover, base } = makeEpoch(sc, t, { extraAmb: { G03: 40 } });
      sol = engine.process(rover, base, t);
    }
    for (let i = 0; i < 3; i++)
      expect(Math.abs(sol!.position[i]! - ROVER[i]!)).toBeLessThan(1e-3);
    expect(
      Math.abs(
        sol!.ambiguities['G03']! -
          (expectDd(sc, sol!.refSatellites, 'G03') + 40)
      )
    ).toBeLessThan(1e-6);
  });

  it('tracks a moving rover in kinematic mode', () => {
    const engine = new RtkFloatEngine(BASE, sc.ephs, {
      mode: 'kinematic',
      troposphere: false,
    });
    for (let k = 0; k < 5; k++) {
      const t = T0 + k * 1000;
      const pos: [number, number, number] = [
        ROVER[0] + 0.5 * k,
        ROVER[1] + 0.2 * k,
        ROVER[2] - 0.3 * k,
      ];
      const rover = new Map<string, RtkMeasurement>();
      const base = new Map<string, RtkMeasurement>();
      const lock = 600_000 + k * 1000;
      for (const eph of sc.ephs) {
        base.set(
          eph.prn,
          synth(eph, BASE, t, {
            code: '1C',
            clockM: 150,
            lambdaM: L1,
            lockTimeMs: lock,
          })
        );
        rover.set(
          eph.prn,
          synth(eph, pos, t, {
            code: '1C',
            clockM: -80,
            lambdaM: L1,
            ambCycles: sc.amb[eph.prn]!,
            lockTimeMs: lock,
          })
        );
      }
      const sol = engine.process(rover, base, t);
      if (k === 0) continue; // first epoch: DGNSS init only
      expect(sol).not.toBeNull();
      for (let i = 0; i < 3; i++)
        expect(Math.abs(sol!.position[i]! - pos[i]!)).toBeLessThan(0.01);
    }
  });

  it('handles GLONASS FDMA double differences (float)', () => {
    // GLONASS state-vector ephemerides pinned at the epoch (tk ≈ 0);
    // the same computeSatPosition path serves synthesis and solving.
    const leapMs = 18_000;
    const gloEphs: GlonassEphemeris[] = [];
    const positions = [
      [1, 0.2, 1.1],
      [-0.5, 0.9, 1.2],
      [0.3, -0.6, 1.3],
      [-0.9, -0.3, 1.05],
      [0.7, 0.8, 0.95],
    ];
    positions.forEach((d, i) => {
      // Offsets from the base direction, pushed to GLONASS altitude.
      const dir = [
        BASE[0] + d[0]! * 8e6,
        BASE[1] + d[1]! * 8e6,
        BASE[2] + d[2]! * 8e6,
      ];
      const r = Math.hypot(dir[0]!, dir[1]!, dir[2]!);
      const kx = 25_500_000 / r;
      gloEphs.push({
        system: 'R',
        prn: `R${String(i + 1).padStart(2, '0')}`,
        tocDate: new Date(T0 - leapMs), // UTC epoch of T0 → tk = 0
        tauN: 0,
        gammaN: 0,
        messageFrameTime: 0,
        x: (dir[0]! * kx) / 1000,
        y: (dir[1]! * kx) / 1000,
        z: (dir[2]! * kx) / 1000,
        xDot: 0,
        yDot: 0,
        zDot: 0,
        xAcc: 0,
        yAcc: 0,
        zAcc: 0,
        health: 0,
        freqNum: i - 2, // channels −2…+2 → distinct wavelengths
      });
    });
    const ephs: Ephemeris[] = [...visibleKepler('G', 5), ...gloEphs];
    const amb: Record<string, number> = {};
    ephs.forEach((e, i) => (amb[e.prn] = ((i * 29) % 21) - 10));

    const engine = new RtkFloatEngine(BASE, ephs, {
      mode: 'static',
      troposphere: false,
    });
    let sol = null;
    for (let k = 0; k < 3; k++) {
      const t = T0 + k * 1000;
      const rover = new Map<string, RtkMeasurement>();
      const base = new Map<string, RtkMeasurement>();
      const lock = 600_000 + k * 1000;
      for (const eph of ephs) {
        const isGlo = eph.system === 'R';
        const kch = isGlo ? (eph as GlonassEphemeris).freqNum : null;
        const lambda = isGlo ? C_LIGHT / (1602e6 + kch! * 562500) : L1;
        base.set(eph.prn, {
          ...synth(eph, BASE, t, {
            code: '1C',
            clockM: isGlo ? 170 : 150,
            lambdaM: lambda,
            lockTimeMs: lock,
            gloChannel: kch,
          }),
        });
        rover.set(eph.prn, {
          ...synth(eph, ROVER, t, {
            code: '1C',
            clockM: isGlo ? -60 : -80,
            lambdaM: lambda,
            ambCycles: amb[eph.prn]!,
            lockTimeMs: lock,
            gloChannel: kch,
          }),
        });
      }
      sol = engine.process(rover, base, t);
    }
    expect(sol).not.toBeNull();
    expect(sol!.refSatellites['R1C']).toBeDefined();
    // Both CDMA and FDMA groups must contribute; baseline exact.
    for (let i = 0; i < 3; i++)
      expect(Math.abs(sol!.position[i]! - ROVER[i]!)).toBeLessThan(1e-2);
    const nGlo = Object.keys(sol!.ambiguities).filter(
      (p) => p[0] === 'R'
    ).length;
    expect(nGlo).toBeGreaterThanOrEqual(3);
  });
});

/* ================================================================== */
/*  Adapter                                                            */
/* ================================================================== */

describe('toRtkEpoch', () => {
  it('selects the L1-band code per satellite and drops the rest', () => {
    const epoch = toRtkEpoch([
      { prn: 'G14', code: '1C', pr: 2.1e7, cp: 1.1e8, lockTimeS: 12.5 },
      { prn: 'G14', code: '2W', pr: 2.1e7, cp: 8.6e7, lockTimeS: 12.5 },
      { prn: 'C08', code: '2I', pr: 2.4e7, cp: 1.2e8, lockTimeS: 30 },
      { prn: 'C08', code: '7I', pr: 2.4e7, cp: 1.2e8, lockTimeS: 30 },
      { prn: 'C30', code: '1P', pr: 2.2e7, cp: 1.2e8, lockTimeS: 30 },
      {
        prn: 'R05',
        code: '1C',
        pr: 2.0e7,
        cp: 1.0e8,
        lockTimeS: 9,
        gloChannel: 1,
      },
      { prn: 'G09', code: '1C', pr: null, cp: 1.0e8, lockTimeS: 5 },
      { prn: 'S23', code: '1C', pr: 2.6e7, cp: null, lockTimeS: 3 },
      { prn: 'I05', code: '5A', pr: 2.6e7, cp: null, lockTimeS: 3 },
    ]);
    expect([...epoch.keys()].sort()).toEqual(['C08', 'C30', 'G14', 'R05']);
    expect(epoch.get('G14')!.code).toBe('1C');
    expect(epoch.get('G14')!.lockTimeMs).toBe(12500);
    expect(epoch.get('C08')!.code).toBe('2I'); // B1I preferred over B2
    expect(epoch.get('C30')!.code).toBe('1P'); // B1C fallback
    expect(epoch.get('R05')!.gloChannel).toBe(1);
  });
});

/* ================================================================== */
/*  Dataset: WHU OEM719 short baseline (2025-03-26)                    */
/* ================================================================== */

const BASE_FIX = join(__dirname, '../test-fixtures/oem719_rtk_base.gps');
const ROVER_FIX = join(__dirname, '../test-fixtures/oem719_rtk_rover.gps');

/**
 * Base coordinates: the base logs BESTPOS with position type 1
 * (FIXEDPOS — operator-surveyed coordinates, constant over the whole
 * file); decoded per OEM7 manual §3.22 (lat/lon/MSL-height doubles +
 * undulation float) and converted to ECEF.
 * Rover truth: the WHU RTK-GNSS repository's post-processed reference
 * for this dataset (plot/AnalyzeRTKData.m, "25d短基线" fixed-solution
 * mean) — the rover antenna is static, ~1.58 km from the base.
 */
const WHU_BASE: [number, number, number] = [
  -2267335.669351269, 5008649.155499206, 3222374.973582075,
];
const WHU_ROVER_TRUTH: [number, number, number] = [
  -2267808.336856440175, 5009321.489190992899, 3221021.847353241406,
];

describe.skipIf(!existsSync(BASE_FIX) || !existsSync(ROVER_FIX))(
  'WHU OEM719 short-baseline dataset',
  () => {
    const ready = existsSync(BASE_FIX) && existsSync(ROVER_FIX);
    const baseRaw = ready ? new Uint8Array(readFileSync(BASE_FIX)) : null!;
    const roverRaw = ready ? new Uint8Array(readFileSync(ROVER_FIX)) : null!;
    const pairs: {
      t: number;
      rover: RtkEpochMeasurements;
      base: RtkEpochMeasurements;
    }[] = [];
    let ephs: Ephemeris[] = [];
    if (ready) {
      const baseObs = parseNovatelRange(baseRaw);
      const roverObs = parseNovatelRange(roverRaw);
      ephs = [
        ...parseNovatelNav(baseRaw).ephemerides,
        ...parseNovatelNav(roverRaw).ephemerides,
      ];
      const baseByTime = new Map(baseObs.epochs.map((e) => [e.timeMs, e.meas]));
      const seen = new Set<number>();
      for (const e of roverObs.epochs) {
        if (seen.has(e.timeMs)) continue; // RANGE/RANGECMP duplicates
        seen.add(e.timeMs);
        const b = baseByTime.get(e.timeMs);
        if (!b) continue;
        pairs.push({
          t: e.timeMs,
          rover: toRtkEpoch(e.meas),
          base: toRtkEpoch(b),
        });
      }
    }

    it('provides a synchronized multi-GNSS window', () => {
      expect(pairs.length).toBeGreaterThanOrEqual(100);
      const ephSys = new Set(ephs.map((e) => e.system));
      expect(ephSys.has('G')).toBe(true);
      expect(ephSys.has('E')).toBe(true);
      expect(ephSys.has('C')).toBe(true);
    });

    it('DGNSS agrees with the surveyed rover point at the metre level', () => {
      let n = 0;
      let sumH = 0;
      let sumV = 0;
      for (const p of pairs) {
        const sol = solveDgnss(p.rover, p.base, WHU_BASE, ephs, p.t, {
          elevationMaskDeg: 15,
        });
        if (!sol || !sol.converged) continue;
        const [dE, dN, dU] = getEnuDifference(
          sol.position[0],
          sol.position[1],
          sol.position[2],
          WHU_ROVER_TRUTH[0],
          WHU_ROVER_TRUTH[1],
          WHU_ROVER_TRUTH[2]
        );
        sumH += dE * dE + dN * dN;
        sumV += dU * dU;
        n++;
      }
      expect(n).toBeGreaterThanOrEqual(100);
      // Measured on the fixture window: 0.09 m horizontal / 0.34 m
      // vertical RMS — asserted with margin at the metre level.
      expect(Math.sqrt(sumH / n)).toBeLessThan(1); // horizontal RMS (m)
      expect(Math.sqrt(sumV / n)).toBeLessThan(1.5); // vertical RMS (m)
    });

    it('static float solution converges to the decimetre level', () => {
      const engine = new RtkFloatEngine(WHU_BASE, ephs, {
        mode: 'static',
        elevationMaskDeg: 15,
      });
      let last = null;
      let nSol = 0;
      for (const p of pairs) {
        const sol = engine.process(p.rover, p.base, p.t);
        if (sol) {
          last = sol;
          nSol++;
        }
      }
      expect(last).not.toBeNull();
      expect(nSol).toBeGreaterThanOrEqual(100);
      expect(last!.nSats).toBeGreaterThanOrEqual(10);
      const [dE, dN, dU] = getEnuDifference(
        last!.position[0],
        last!.position[1],
        last!.position[2],
        WHU_ROVER_TRUTH[0],
        WHU_ROVER_TRUTH[1],
        WHU_ROVER_TRUTH[2]
      );
      expect(Math.hypot(dE, dN)).toBeLessThan(0.3); // decimetre horizontal
      expect(Math.abs(dU)).toBeLessThan(0.6);
      // Float baseline length ≈ 1.58 km short baseline.
      const bl = Math.hypot(...last!.floatBaseline);
      expect(bl).toBeGreaterThan(1570);
      expect(bl).toBeLessThan(1600);
    });
  }
);
