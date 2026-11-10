/**
 * PPP-AR on real data with integer-clock products: GFZ rapid orbit + 30 s
 * clock and the CNES code/phase biases (OSB) that make the undifferenced
 * ambiguities integers between satellites. Truth is the ESA daily SINEX
 * (ITRF2020, 2024-001). Local-only fixtures — see scripts/fetch-test-data.sh.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { gunzipSync } from 'zlib';
import { join } from 'path';
import {
  solvePpp,
  buildPppAntenna,
  createPppCorrections,
  type PppEpoch,
} from '../src/positioning';
import { parseRinexStream, parseBiasSinex, SatOsbTable } from '../src/rinex';
import { parseSp3 } from '../src/rinex/sp3';
import { parseClk } from '../src/rinex/clk';
import { parseAntex } from '../src/antex';
import { FREQ } from '../src/constants/gnss';
import { getEnuDifference } from '../src/coordinates';

const FIX = join(__dirname, '..', 'test-fixtures');
const FILES = [
  'GBM_RAP.sp3.gz',
  'GBM_RAP_ge.clk.gz',
  'CNES_ABS_ge.bia.gz',
  'igs20.atx',
  'ALIC.crx',
  'ANMG.crx',
];
const HAS = FILES.every((f) => existsSync(join(FIX, f)));
const gz = (f: string) => gunzipSync(readFileSync(join(FIX, f))).toString();

// ESA0OPSFIN daily SINEX (ITRF2020, 2024-001), as in ppp-fcb.test.ts.
const TRUTH: Record<string, [number, number, number]> = {
  ANMG: [-1270827.11054, 6242631.27079, 307792.38356],
  ALIC: [-4052052.90341, 4212835.97164, -2545104.37612],
};

async function loadEpochs(st: string) {
  const crx = new Uint8Array(readFileSync(join(FIX, st + '.crx')));
  const byTime = new Map<number, PppEpoch['obs']>();
  const res = await parseRinexStream(
    new File([crx], st + '.crx'),
    undefined,
    undefined,
    (time, prn, codes, values) => {
      const get = (c: string) => {
        const i = codes.indexOf(c);
        return i >= 0 ? values[i] : null;
      };
      let s: PppEpoch['obs'][number] | null = null;
      if (prn[0] === 'G') {
        const c1w = get('C1W');
        const c1 = c1w ?? get('C1C');
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
            code1: c1w ? '1W' : '1C',
            code2: '2W',
            phase1: '1C', // GPS: C1W code with the L1C carrier
            phase2: '2W',
            slip: false,
          };
      } else if (prn[0] === 'E') {
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
            code1: '1C',
            code2: '5Q',
            slip: false,
          };
      }
      if (!s) return;
      if (!byTime.has(time)) byTime.set(time, []);
      byTime.get(time)!.push(s);
    }
  );
  const epochs = [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timeMs, obs]) => ({ timeMs, obs }));
  return { epochs, header: res.header };
}

describe.skipIf(!HAS)('PPP-AR with CNES integer-clock products', () => {
  it(
    'fixes 1 h sessions and pulls the horizontal error to ~1 cm',
    { timeout: 300_000 },
    async () => {
      const sp3 = parseSp3(gz('GBM_RAP.sp3.gz'));
      const clk = parseClk(gz('GBM_RAP_ge.clk.gz'));
      const osb = new SatOsbTable(parseBiasSinex(gz('CNES_ABS_ge.bia.gz')));
      expect(osb.hasPhase).toBe(true);
      const antenna = buildPppAntenna(
        parseAntex(readFileSync(join(FIX, 'igs20.atx'), 'utf8'))
      );

      const rows: { float3d: number; fixed3d: number; fixedH: number }[] = [];
      for (const st of ['ALIC', 'ANMG']) {
        const { epochs: all, header } = await loadEpochs(st);
        const d = header.antDelta ?? [0, 0, 0];
        const corrections = createPppCorrections({
          antenna,
          rcvAntType: header.antType,
          antDeltaEnu: [d[1]!, d[2]!, d[0]!],
        });
        const truth = TRUTH[st]!;
        // Two afternoon windows (UTC) where both stations fix.
        for (const startH of [16, 20]) {
          const t0 = all[0]!.timeMs + startH * 3600e3;
          const epochs = all.filter(
            (e) => e.timeMs >= t0 && e.timeMs < t0 + 3600e3
          );
          const sol = solvePpp(epochs, sp3, {
            aprioriPos: header.approxPosition as [number, number, number],
            elevationMaskDeg: 10,
            corrections,
            clk,
            osb,
            ar: true,
          });
          expect(sol.ar).toBeDefined();
          expect(sol.ar!.position).not.toBeNull();
          expect(sol.ar!.nFixedEnd).toBeGreaterThanOrEqual(5);
          // First fix within ~45 min (attempts start once arcs are 10 min old).
          expect(sol.ar!.firstFixSec).toBeLessThan(2700);
          const ef = getEnuDifference(...sol.position, ...truth);
          const ex = getEnuDifference(...sol.ar!.position!, ...truth);
          rows.push({
            float3d: Math.hypot(...ef),
            fixed3d: Math.hypot(...ex),
            fixedH: Math.hypot(ex[0], ex[1]),
          });
        }
      }
      // Measured 2026-11-10: float 3D 1.4–5.3 cm → fixed 1.2–2.6 cm, fixed
      // horizontal 0.7–1.1 cm.
      for (const r of rows) expect(r.fixedH).toBeLessThan(0.015);
      const mean = (k: 'float3d' | 'fixed3d') =>
        rows.reduce((a, r) => a + r[k], 0) / rows.length;
      expect(mean('fixed3d')).toBeLessThan(mean('float3d'));
    }
  );
});
