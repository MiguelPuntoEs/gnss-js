import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseRinexStream, parseNavFile, parseIonex } from '../src/rinex';
import type { Ephemeris } from '../src/rinex/nav';
import { solveSpp, ionoFree, satClockCorrection } from '../src/positioning';
import { computeSatPosition } from '../src/orbit';
import { ecefToGeodetic, getEnuDifference } from '../src/coordinates';
import { FREQ, C_LIGHT } from '../src/constants/gnss';

const DIR = join(__dirname, '../test-fixtures');
const HAS_DATA =
  existsSync(join(DIR, 'ABMF.crx')) && existsSync(join(DIR, 'BRDC.nav'));
const GIM_FILE = join(DIR, 'ESA_GIM_2024001.inx');
const HAS_GIM = HAS_DATA && existsSync(GIM_FILE);

/** Vertical (up) error against the known ground truth, in metres. */
function upError(
  p: [number, number, number],
  approx: [number, number, number]
): number {
  const [lat, lon] = ecefToGeodetic(approx[0], approx[1], approx[2]);
  const enu = getEnuDifference(
    p[0],
    p[1],
    p[2],
    approx[0],
    approx[1],
    approx[2],
    lat,
    lon
  );
  return Math.abs(enu[2]);
}

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
    // GPS + Galileo + GLONASS. The ~28 m error is dominated by
    // untreated single-frequency ionosphere plus GLONASS FDMA
    // inter-frequency code biases (several m/sat) that one clock
    // parameter cannot absorb — realistic for uncalibrated SPP.
    const { single, ephMap, approx } = await load();
    const sol = solveSpp(single, ephMap, TARGET_MS);
    expect(sol).not.toBeNull();
    expect(sol!.converged).toBe(true);
    expect(err(sol!.position, approx)).toBeLessThan(30);
    expect(sol!.usedSatellites.length).toBeGreaterThan(8);
    // GLONASS satellites now contribute (regression guard: the RINEX
    // time-axis + clock-sign bugs used to get them all rejected).
    expect(
      sol!.usedSatellites.filter((p) => p.startsWith('R')).length
    ).toBeGreaterThan(3);
    expect(sol!.dop?.pdop).toBeGreaterThan(0.5);
    expect(sol!.dop?.pdop).toBeLessThan(6);
  });

  it.skipIf(!HAS_GIM)(
    'GIM ionosphere beats broadcast Klobuchar on the vertical',
    async () => {
      const { single, ephMap, approx } = await load();
      const nav = parseNavFile(readFileSync(join(DIR, 'BRDC.nav'), 'utf-8'));
      const iono = {
        alpha: nav.header.ionoCorrections['GPSA']!,
        beta: nav.header.ionoCorrections['GPSB']!,
      };
      const gim = parseIonex(readFileSync(GIM_FILE, 'utf-8'));

      const none = solveSpp(single, ephMap, TARGET_MS)!;
      const klob = solveSpp(single, ephMap, TARGET_MS, { iono })!;
      const withGim = solveSpp(single, ephMap, TARGET_MS, { gim })!;

      const uNone = upError(none.position, approx);
      const uKlob = upError(klob.position, approx);
      const uGim = upError(withGim.position, approx);

      // Modelling iono helps; the GIM helps most on the height component.
      expect(uKlob).toBeLessThan(uNone);
      expect(uGim).toBeLessThan(uKlob);
      // ABMF (tropical) measured: none 8.3 → Klobuchar 3.2 → GIM 1.1 m.
      expect(uGim).toBeLessThan(2.0);
    }
  );

  it('still solves when a whole constellation is below the elevation mask', async () => {
    // Regression: a lone satellite from a constellation that is entirely below
    // the horizon (e.g. a single QZSS bird seen from the Atlantic) used to sink
    // the ENTIRE multi-GNSS fix. Its per-system clock column had no above-mask
    // satellites, so the normal matrix was singular and solveSpp returned null.
    // Reproduced here by injecting one QZSS satellite (invisible from ABMF in
    // Guadeloupe) with a geometrically consistent pseudorange.
    const { single, ephMap, approx } = await load();

    const baseline = solveSpp(single, ephMap, TARGET_MS);
    expect(baseline).not.toBeNull();

    const jPrn = [...ephMap.keys()].find((p) => p.startsWith('J'));
    expect(jPrn, 'BRDC.nav should carry a QZSS ephemeris').toBeDefined();
    const jEph = ephMap.get(jPrn!)!;
    const jSat = computeSatPosition(jEph, TARGET_MS);
    // Below the horizon from ABMF → its elevation will fail the mask.
    const jUp = getEnuDifference(
      jSat.x,
      jSat.y,
      jSat.z,
      approx[0],
      approx[1],
      approx[2],
      ...(ecefToGeodetic(approx[0], approx[1], approx[2]).slice(0, 2) as [
        number,
        number,
      ])
    )[2];
    expect(jUp, 'QZSS sat must be below the local horizon').toBeLessThan(0);

    const rho = Math.hypot(
      jSat.x - approx[0],
      jSat.y - approx[1],
      jSat.z - approx[2]
    );
    const withQzss = new Map(single);
    withQzss.set(jPrn!, rho - C_LIGHT * satClockCorrection(jEph, TARGET_MS));

    const sol = solveSpp(withQzss, ephMap, TARGET_MS);
    expect(
      sol,
      'a below-mask constellation must not sink the solve'
    ).not.toBeNull();
    expect(sol!.converged).toBe(true);
    // The masked QZSS satellite is excluded, so the fix is unchanged.
    expect(sol!.usedSatellites).not.toContain(jPrn);
    expect(err(sol!.position, approx)).toBeCloseTo(
      err(baseline!.position, approx),
      6
    );
  });

  it('solves iono-free GPS within 10 m', async () => {
    const { dual, ephMap, approx } = await load();
    // The broadcast clock is referenced to the P1/P2 iono-free
    // combination, so the group delay must NOT be applied here.
    const sol = solveSpp(dual, ephMap, TARGET_MS, { tgd: false });
    expect(sol).not.toBeNull();
    expect(sol!.converged).toBe(true);
    expect(err(sol!.position, approx)).toBeLessThan(10);
  });

  it('post-fit residuals are metre-level for the iono-free solution', async () => {
    const { dual, ephMap } = await load();
    const sol = solveSpp(dual, ephMap, TARGET_MS, { tgd: false })!;
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
