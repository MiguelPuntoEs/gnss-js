import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  estimateWidelaneFcb,
  estimateNarrowlaneFcb,
  estimateNetworkFcbs,
  extractWidelaneArcs,
  solvePpp,
  buildPppAntenna,
  createPppCorrections,
  type WlArc,
  type WlObs,
  type WlFcbResult,
  type NlArc,
  type PppEpoch,
} from '../src/positioning';
import { parseRinexStream } from '../src/rinex';
import { parseSp3 } from '../src/rinex/sp3';
import { parseAntex } from '../src/antex';
import { FREQ } from '../src/constants/gnss';

const FIX = join(__dirname, '..', 'test-fixtures');
// Self-built network: ABMF + five geographically-spread MGEX stations,
// all 2024-001 (see scripts/fetch-test-data.sh). Local-only fixtures.
const NET: Record<string, string> = {
  ABMF: 'ABMF.crx',
  BRUX: 'BRUX.crx',
  ANMG: 'ANMG.crx',
  AREG: 'AREG.crx',
  ALIC: 'ALIC.crx',
  ADIS: 'ADIS.crx',
};
const HAS_NET = Object.values(NET).every((f) => existsSync(join(FIX, f)));
const HAS_ATX = existsSync(join(FIX, 'igs20.atx'));

/** Wrap cycles to [−0.5, 0.5). */
const wrap = (x: number) => x - Math.round(x);

/**
 * Build a synthetic network: R stations × S satellites, each arc
 *   Ñ_wl = N(integer) + b_rcv + b_sat + noise.
 * Deterministic (no RNG) so the test is reproducible.
 */
function network(
  satFcb: number[],
  rcvBias: number[],
  noiseAmp = 0
): { arcs: WlArc[]; satFcb: number[]; rcvBias: number[] } {
  const arcs: WlArc[] = [];
  for (let r = 0; r < rcvBias.length; r++) {
    for (let s = 0; s < satFcb.length; s++) {
      const N = ((r * 7 + s * 13) % 11) - 5; // deterministic integer
      const noise = noiseAmp * Math.sin(r * 1.7 + s * 0.9);
      arcs.push({
        station: `ST${r}`,
        prn: `G${String(s + 1).padStart(2, '0')}`,
        wlFloat: N + rcvBias[r]! + satFcb[s]! + noise,
        nObs: 100,
      });
    }
  }
  return { arcs, satFcb, rcvBias };
}

describe('wide-lane FCB estimation', () => {
  const SAT = [0.12, -0.34, 0.45, -0.08, 0.27, -0.19];
  const RCV = [0.05, -0.11, 0.33, -0.22, 0.15];

  it('recovers satellite FCBs (up to the datum constant) from a clean network', () => {
    const { arcs } = network(SAT, RCV, 0);
    const r = estimateWidelaneFcb(arcs);
    expect(r.fixRate).toBe(1);
    expect(r.residRms).toBeLessThan(1e-6);
    expect(r.rcvBias.get('ST0')).toBeCloseTo(0, 9); // datum pinned

    // Absolute FCBs carry the datum shift; between-satellite differences are
    // datum-free and must match truth exactly.
    for (let i = 1; i < SAT.length; i++) {
      const got = wrap(r.satFcb.get(`G0${i + 1}`)! - r.satFcb.get('G01')!);
      const truth = wrap(SAT[i]! - SAT[0]!);
      expect(wrap(got - truth)).toBeCloseTo(0, 6);
    }
  });

  it('stays robust under realistic wide-lane noise', () => {
    // ~0.05 cycle arc noise — well inside the 86 cm wide-lane's tolerance.
    const { arcs } = network(SAT, RCV, 0.05);
    const r = estimateWidelaneFcb(arcs);
    expect(r.fixRate).toBe(1);
    expect(r.residRms).toBeLessThan(0.05);
    for (let i = 1; i < SAT.length; i++) {
      const got = wrap(r.satFcb.get(`G0${i + 1}`)! - r.satFcb.get('G01')!);
      const truth = wrap(SAT[i]! - SAT[0]!);
      expect(Math.abs(wrap(got - truth))).toBeLessThan(0.03);
    }
  });

  it('the recovered FCBs make every arc round to its true integer', () => {
    const { arcs } = network(SAT, RCV, 0.03);
    const r = estimateWidelaneFcb(arcs);
    // De-bias each arc with the estimates and confirm it lands on an integer.
    for (const a of arcs) {
      const debiased =
        a.wlFloat - r.rcvBias.get(a.station)! - r.satFcb.get(a.prn)!;
      expect(Math.abs(wrap(debiased))).toBeLessThan(0.1);
    }
  });

  it('handles a partial grid (stations missing some satellites)', () => {
    const { arcs } = network(SAT, RCV, 0.02);
    // Drop a few arcs — real networks never see every satellite everywhere.
    const partial = arcs.filter((_, i) => i % 7 !== 0);
    const r = estimateWidelaneFcb(partial);
    expect(r.fixRate).toBeGreaterThan(0.99);
    for (let i = 1; i < SAT.length; i++) {
      const got = wrap(r.satFcb.get(`G0${i + 1}`)! - r.satFcb.get('G01')!);
      const truth = wrap(SAT[i]! - SAT[0]!);
      expect(Math.abs(wrap(got - truth))).toBeLessThan(0.05);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Narrow-lane FCB estimation (synthetic, known-integer)              */
/* ------------------------------------------------------------------ */

describe('narrow-lane FCB estimation', () => {
  const F1 = FREQ.G!['1']!;
  const F2 = FREQ.G!['2']!;
  const C = 299792458;
  const lamNl = C / (F1 + F2);
  const factor = F2 / (F1 - F2);
  const NLFCB = [0.15, -0.28, 0.4, -0.11, 0.33]; // per-satellite NL FCB (cyc)
  const NLRCV = [0.06, -0.19, 0.27, -0.3]; // per-station NL receiver bias

  // A trivial wide-lane solution (biases zero) so mwCyc = N_WL rounds exactly.
  const wl: WlFcbResult = {
    satFcb: new Map(
      NLFCB.map((_, s) => [`G${String(s + 1).padStart(2, '0')}`, 0])
    ),
    rcvBias: new Map(NLRCV.map((_, r) => [`ST${r}`, 0])),
    residRms: 0,
    fixRate: 1,
    refStation: 'ST0',
    iterations: 0,
  };

  function nlNetwork(noiseCyc = 0): NlArc[] {
    const arcs: NlArc[] = [];
    for (let r = 0; r < NLRCV.length; r++) {
      for (let s = 0; s < NLFCB.length; s++) {
        const n1 = ((r * 5 + s * 3) % 9) - 4; // deterministic integer
        const nWl = ((r + s) % 7) - 3;
        const noise = noiseCyc * Math.sin(r * 2.1 + s * 1.3);
        const n1Float = n1 + NLRCV[r]! + NLFCB[s]! + noise;
        const aIF = lamNl * n1Float + lamNl * factor * nWl;
        arcs.push({
          station: `ST${r}`,
          prn: `G${String(s + 1).padStart(2, '0')}`,
          aIF,
          mwCyc: nWl, // WL biases are zero here → rounds to nWl
          f1: F1,
          f2: F2,
          nEpochs: 200,
        });
      }
    }
    return arcs;
  }

  it('recovers narrow-lane FCBs (up to datum) from clean arcs', () => {
    const r = estimateNarrowlaneFcb(nlNetwork(0), wl, { fixWindow: 0.15 });
    expect(r.wlRejected).toBe(0);
    expect(r.usedArcs).toBe(NLFCB.length * NLRCV.length);
    expect(r.fixRate).toBe(1);
    expect(r.residRms).toBeLessThan(1e-6);
    for (let i = 1; i < NLFCB.length; i++) {
      const got = wrap(r.satFcb.get(`G0${i + 1}`)! - r.satFcb.get('G01')!);
      const truth = wrap(NLFCB[i]! - NLFCB[0]!);
      expect(wrap(got - truth)).toBeCloseTo(0, 6);
    }
  });

  it('stays robust under ~0.03-cycle narrow-lane noise', () => {
    const r = estimateNarrowlaneFcb(nlNetwork(0.03), wl, { fixWindow: 0.15 });
    expect(r.fixRate).toBe(1);
    for (let i = 1; i < NLFCB.length; i++) {
      const got = wrap(r.satFcb.get(`G0${i + 1}`)! - r.satFcb.get('G01')!);
      const truth = wrap(NLFCB[i]! - NLFCB[0]!);
      expect(Math.abs(wrap(got - truth))).toBeLessThan(0.02);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Multi-GNSS network calibration (estimateNetworkFcbs, synthetic)    */
/* ------------------------------------------------------------------ */

describe('estimateNetworkFcbs (multi-GNSS)', () => {
  const C = 299792458;
  // Build a clean mixed GPS + Galileo network with known per-system FCBs.
  function mixed(): NlArc[] {
    const arcs: NlArc[] = [];
    const sysCfg = [
      { p: 'G', f1: FREQ.G!['1']!, f2: FREQ.G!['2']!, fcb: [0.2, -0.3, 0.1] },
      {
        p: 'E',
        f1: FREQ.E!['1']!,
        f2: FREQ.E!['5']!,
        fcb: [-0.15, 0.35, 0.05],
      },
    ];
    for (let r = 0; r < 4; r++) {
      for (const cfg of sysCfg) {
        const lamNl = C / (cfg.f1 + cfg.f2);
        const factor = cfg.f2 / (cfg.f1 - cfg.f2);
        for (let s = 0; s < cfg.fcb.length; s++) {
          const n1 = ((r * 3 + s * 2) % 7) - 3;
          const nWl = ((r + s) % 5) - 2;
          const n1Float = n1 + 0.1 * r + cfg.fcb[s]!; // 0.1·r = receiver NL bias
          arcs.push({
            station: `ST${r}`,
            prn: `${cfg.p}${String(s + 1).padStart(2, '0')}`,
            aIF: lamNl * n1Float + lamNl * factor * nWl,
            mwCyc: nWl, // WL biases zero → rounds to nWl
            f1: cfg.f1,
            f2: cfg.f2,
            nEpochs: 200,
          });
        }
      }
    }
    return arcs;
  }

  it('calibrates both constellations without cross-system contamination', () => {
    const r = estimateNetworkFcbs(mixed(), { minArcEpochs: 120, minWlObs: 40 });
    // Both systems present in the merged per-satellite maps.
    expect(r.satNlFcb.has('G01')).toBe(true);
    expect(r.satNlFcb.has('E01')).toBe(true);
    expect(r.perSystem.G).toBeDefined();
    expect(r.perSystem.E).toBeDefined();
    // Clean data ⇒ both systems fully fix.
    expect(r.perSystem.G!.nlFixRate).toBe(1);
    expect(r.perSystem.E!.nlFixRate).toBe(1);
    // Between-satellite NL FCB differences match truth, per system.
    const gd = wrap(r.satNlFcb.get('G02')! - r.satNlFcb.get('G01')!);
    expect(wrap(gd - wrap(-0.3 - 0.2))).toBeCloseTo(0, 6);
    const ed = wrap(r.satNlFcb.get('E02')! - r.satNlFcb.get('E01')!);
    expect(wrap(ed - wrap(0.35 - -0.15))).toBeCloseTo(0, 6);
  });
});

/* ------------------------------------------------------------------ */
/*  Real-data validation: self-built network fixes ABMF wide-lanes     */
/*  with NO external phase-bias product.                               */
/* ------------------------------------------------------------------ */

async function stationArcs(station: string, file: string): Promise<WlArc[]> {
  const crx = new Uint8Array(readFileSync(join(FIX, file)));
  const byTime = new Map<number, WlObs[]>();
  await parseRinexStream(
    new File([crx], file),
    undefined,
    undefined,
    (time, prn, codes, values) => {
      const sys = prn[0];
      const get = (c: string) => {
        const i = codes.indexOf(c);
        return i >= 0 ? values[i] : null;
      };
      let o: WlObs | null = null;
      if (sys === 'G') {
        const c1 = get('C1W') ?? get('C1C');
        const c2 = get('C2W');
        const l1 = get('L1C');
        const l2 = get('L2W');
        if (c1 && c2 && l1 && l2)
          o = { prn, f1: FREQ.G!['1']!, f2: FREQ.G!['2']!, c1, c2, l1, l2 };
      } else if (sys === 'E') {
        const c1 = get('C1C') ?? get('C1X');
        const c2 = get('C5Q') ?? get('C5X');
        const l1 = get('L1C') ?? get('L1X');
        const l2 = get('L5Q') ?? get('L5X');
        if (c1 && c2 && l1 && l2)
          o = { prn, f1: FREQ.E!['1']!, f2: FREQ.E!['5']!, c1, c2, l1, l2 };
      }
      if (!o) return;
      if (!byTime.has(time)) byTime.set(time, []);
      byTime.get(time)!.push(o);
    }
  );
  const epochs = [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timeMs, obs]) => ({ timeMs, obs }));
  return extractWidelaneArcs(station, epochs, { minObs: 40 });
}

describe.skipIf(!HAS_NET)('wide-lane FCB on a real self-built network', () => {
  // Parsing six full-day CRX files takes several seconds — raise the timeout.
  it(
    'fixes ABMF GPS + Galileo wide-lanes with no external bias product',
    { timeout: 60_000 },
    async () => {
      const all: WlArc[] = [];
      for (const [name, file] of Object.entries(NET)) {
        all.push(...(await stationArcs(name, file)));
      }
      // Estimate FCBs per constellation (receiver WL bias is system-specific).
      for (const sys of ['G', 'E'] as const) {
        const arcs = all.filter((a) => a.prn[0] === sys);
        expect(arcs.length).toBeGreaterThan(100);
        const r = estimateWidelaneFcb(arcs, { fixWindow: 0.15 });
        // Apply the network FCBs to ABMF and measure its wide-lane fix rate.
        const abmf = arcs.filter((a) => a.station === 'ABMF');
        let fixed = 0;
        for (const a of abmf) {
          const fcb = r.satFcb.get(a.prn);
          if (fcb === undefined) continue;
          const resid = wrap(a.wlFloat - r.rcvBias.get('ABMF')! - fcb);
          if (Math.abs(resid) < 0.15) fixed++;
        }
        // >90% of ABMF wide-lanes snap to integers (GPS ~98%, Galileo ~95%).
        expect(fixed / abmf.length).toBeGreaterThan(0.9);
        expect(r.residRms).toBeLessThan(0.15);
      }
    }
  );
});

/* ------------------------------------------------------------------ */
/*  Real-data narrow-lane: full self-contained cm PPP-AR on the        */
/*  multi-GNSS network (needs the ANTEX for the clean model).          */
/* ------------------------------------------------------------------ */

/** Run PPP for a station (GPS+Galileo+BeiDou, full corrections) → arcs. */
async function stationPppArcs(
  file: string,
  sp3: ReturnType<typeof parseSp3>,
  antenna: ReturnType<typeof buildPppAntenna>
): Promise<NlArc[]> {
  const crx = new Uint8Array(readFileSync(join(FIX, file)));
  const byTime = new Map<number, PppEpoch['obs']>();
  const result = await parseRinexStream(
    new File([crx], file),
    undefined,
    undefined,
    (time, prn, codes, values) => {
      const sys = prn[0];
      const get = (c: string) => {
        const i = codes.indexOf(c);
        return i >= 0 ? values[i] : null;
      };
      let s: PppEpoch['obs'][number] | null = null;
      if (sys === 'G') {
        const c1 = get('C1W') ?? get('C1C');
        const c2 = get('C2W');
        const l1 = get('L1C');
        const l2 = get('L2W');
        if (c1 && c2 && l1 && l2)
          s = {
            prn,
            f1: FREQ.G!['1']!,
            f2: FREQ.G!['2']!,
            c1,
            c2,
            l1,
            l2,
            band1: 'G01',
            band2: 'G02',
            slip: false,
          };
      } else if (sys === 'E') {
        const c1 = get('C1C') ?? get('C1X');
        const c2 = get('C5Q') ?? get('C5X');
        const l1 = get('L1C') ?? get('L1X');
        const l2 = get('L5Q') ?? get('L5X');
        if (c1 && c2 && l1 && l2)
          s = {
            prn,
            f1: FREQ.E!['1']!,
            f2: FREQ.E!['5']!,
            c1,
            c2,
            l1,
            l2,
            band1: 'E01',
            band2: 'E05',
            slip: false,
          };
      } else if (sys === 'C') {
        const c1 = get('C2I');
        const c2 = get('C6I');
        const l1 = get('L2I');
        const l2 = get('L6I');
        if (c1 && c2 && l1 && l2)
          s = {
            prn,
            f1: FREQ.C!['2']!,
            f2: FREQ.C!['6']!,
            c1,
            c2,
            l1,
            l2,
            band1: 'C02',
            band2: 'C06',
            slip: false,
          };
      }
      if (!s) return;
      if (!byTime.has(time)) byTime.set(time, []);
      byTime.get(time)!.push(s);
    }
  );
  const antType = result.header.antType;
  const truth = result.header.approxPosition as [number, number, number];
  const epochs = [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timeMs, obs]) => ({ timeMs, obs }));
  const corrections = createPppCorrections({
    antenna,
    rcvAntType: antType,
    rcvPco: true,
    tides: true,
    windup: true,
  });
  const sol = solvePpp(epochs, sp3, {
    aprioriPos: truth,
    groundTruth: truth,
    elevationMaskDeg: 10,
    corrections,
  });
  return sol.arcs.map((a) => ({ station: file.slice(0, 4), ...a }));
}

describe.skipIf(!HAS_NET || !HAS_ATX)(
  'narrow-lane cm PPP-AR on the real multi-GNSS network',
  () => {
    it(
      'fixes narrow-lane ambiguities across GPS + Galileo, no external product',
      { timeout: 180_000 },
      async () => {
        const sp3 = parseSp3(readFileSync(join(FIX, 'ESA_MGEX.sp3'), 'utf8'));
        const antenna = buildPppAntenna(
          parseAntex(readFileSync(join(FIX, 'igs20.atx'), 'utf8'))
        );
        const arcs: NlArc[] = [];
        for (const file of Object.values(NET)) {
          arcs.push(...(await stationPppArcs(file, sp3, antenna)));
        }
        const net = estimateNetworkFcbs(arcs, {
          minArcEpochs: 120,
          fixWindow: 0.15,
        });
        // GPS narrow-lane fixes on clean ≥1 h arcs at the centimetre level.
        expect(net.perSystem.G).toBeDefined();
        expect(net.perSystem.G!.nlUsedArcs).toBeGreaterThan(10);
        expect(net.perSystem.G!.nlFixRate).toBeGreaterThan(0.6);
        // Narrow-lane residual is centimetre (0.15 cyc ≈ 1.6 cm).
        expect(net.perSystem.G!.nlResidRms).toBeLessThan(0.2);
        // Multi-GNSS: Galileo contributes its own fixable arcs, roughly
        // doubling GPS-only coverage. Per-satellite FCBs merge both systems.
        expect(net.perSystem.E).toBeDefined();
        expect(net.perSystem.E!.nlUsedArcs).toBeGreaterThan(5);
        expect(net.satNlFcb.size).toBeGreaterThan(net.perSystem.G!.nlUsedArcs);
      }
    );
  }
);
