import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  estimateWidelaneFcb,
  extractWidelaneArcs,
  type WlArc,
  type WlObs,
} from '../src/positioning';
import { parseRinexStream } from '../src/rinex';
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
