import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseRinexStream, parseNavFile } from '../src/rinex';
import type { Ephemeris } from '../src/rinex/nav';
import { solveSpp, ionoFree, satClockCorrection } from '../src/positioning';
import { FREQ } from '../src/constants/gnss';

const DIR = join(__dirname, '../test-fixtures');
const HAS_DATA =
  existsSync(join(DIR, 'ABMF.crx')) && existsSync(join(DIR, 'BRDC.nav'));

function fileFrom(buf: Buffer, name: string): File {
  return new File([new Uint8Array(buf)], name);
}

/** Mid-day epoch (better sky than the 00:00 file boundary). */
const TARGET_MS = Date.UTC(2024, 0, 1, 12, 0, 0);

interface Ctx {
  single: Map<string, number>;
  dual: Map<string, number>;
  approx: [number, number, number];
  ephMap: Map<string, Ephemeris>;
}

let cached: Promise<Ctx> | null = null;

/**
 * Ground truth: ABMF (Guadeloupe) IGS station — the RINEX header's
 * APPROX POSITION XYZ (metre-level accurate for IGS stations), read
 * from the file itself so the test carries no hardcoded coordinates.
 */
function load(): Promise<Ctx> {
  cached ??= (async () => {
    const obsBuf = readFileSync(join(DIR, 'ABMF.crx'));
    const nav = parseNavFile(readFileSync(join(DIR, 'BRDC.nav'), 'utf-8'));

    const single = new Map<string, number>(); // C1C
    const dual = new Map<string, number>(); // iono-free C1C/C2W (GPS)

    const result = await parseRinexStream(
      fileFrom(obsBuf, 'ABMF.crx'),
      undefined,
      undefined,
      (time, prn, codes, values) => {
        if (time !== TARGET_MS) return;
        const get = (code: string) => {
          const i = codes.indexOf(code);
          const v = i >= 0 ? values[i] : null;
          return v !== null && v !== undefined && v > 1e6 ? v : null;
        };
        const c1 = get('C1C');
        if (c1) single.set(prn, c1);
        if (prn.startsWith('G')) {
          const c2 = get('C2W');
          if (c1 && c2) {
            dual.set(prn, ionoFree(c1, c2, FREQ.G!['1']!, FREQ.G!['2']!));
          }
        }
      }
    );

    const ephMap = new Map<string, Ephemeris>();
    const age = (x: Ephemeris) => Math.abs(x.tocDate.getTime() - TARGET_MS);
    for (const e of nav.ephemerides) {
      const prev = ephMap.get(e.prn);
      if (!prev || age(e) < age(prev)) ephMap.set(e.prn, e);
    }

    return {
      single,
      dual,
      approx: result.header.approxPosition as [number, number, number],
      ephMap,
    };
  })();
  return cached;
}

const err = (p: [number, number, number], approx: [number, number, number]) =>
  Math.hypot(p[0] - approx[0], p[1] - approx[1], p[2] - approx[2]);

describe.skipIf(!HAS_DATA)('SPP against ABMF ground truth', () => {
  it('has a usable observation epoch', async () => {
    const { single, dual, approx } = await load();
    expect(single.size).toBeGreaterThan(10);
    expect(dual.size).toBeGreaterThan(5);
    expect(Math.hypot(...approx)).toBeGreaterThan(6e6);
  });

  it('solves single-frequency multi-GNSS within 30 m', async () => {
    const { single, ephMap, approx } = await load();
    const sol = solveSpp(single, ephMap, TARGET_MS);
    expect(sol).not.toBeNull();
    expect(sol!.converged).toBe(true);
    expect(err(sol!.position, approx)).toBeLessThan(30);
    expect(sol!.usedSatellites.length).toBeGreaterThan(8);
    expect(sol!.dop?.pdop).toBeGreaterThan(0.5);
    expect(sol!.dop?.pdop).toBeLessThan(6);
  });

  it('solves iono-free GPS within 10 m', async () => {
    const { dual, ephMap, approx } = await load();
    const sol = solveSpp(dual, ephMap, TARGET_MS);
    expect(sol).not.toBeNull();
    expect(sol!.converged).toBe(true);
    expect(err(sol!.position, approx)).toBeLessThan(10);
  });

  it('post-fit residuals are metre-level for the iono-free solution', async () => {
    const { dual, ephMap } = await load();
    const sol = solveSpp(dual, ephMap, TARGET_MS)!;
    const values = Object.values(sol.residuals);
    const rms = Math.sqrt(
      values.reduce((s, v) => s + v * v, 0) / values.length
    );
    expect(rms).toBeLessThan(10);
  });

  it('satellite clock corrections are microsecond-scale', async () => {
    const { single, ephMap } = await load();
    for (const [prn, eph] of ephMap) {
      if (!single.has(prn)) continue;
      const dts = satClockCorrection(eph, TARGET_MS);
      expect(Math.abs(dts), prn).toBeLessThan(2e-3); // < 2 ms
    }
  });
});

describe('solveSpp input validation', () => {
  it('returns null with too few satellites', () => {
    expect(solveSpp(new Map([['G01', 2e7]]), new Map(), 0)).toBeNull();
  });
});
