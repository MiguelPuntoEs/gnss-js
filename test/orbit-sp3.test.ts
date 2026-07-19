import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseNavFile } from '../src/rinex';
import type { Ephemeris } from '../src/rinex/nav';
import { computeSatPosition } from '../src/orbit';

const DIR = join(__dirname, '../test-fixtures');
const HAS_DATA =
  existsSync(join(DIR, 'ESA_MGEX.sp3')) && existsSync(join(DIR, 'BRDC.nav'));

/** Test epoch: 2024-01-01 12:00:00 GPS time. */
const T_MS = Date.UTC(2024, 0, 1, 12, 0, 0);

/** Read satellite positions (m) at the test epoch from the ESA SP3. */
function readSp3(): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>();
  let inEpoch = false;
  for (const line of readFileSync(join(DIR, 'ESA_MGEX.sp3'), 'utf-8').split(
    '\n'
  )) {
    if (line.startsWith('*')) {
      const f = line.slice(1).trim().split(/\s+/).map(Number);
      inEpoch =
        f[0] === 2024 && f[1] === 1 && f[2] === 1 && f[3] === 12 && f[4] === 0;
    } else if (inEpoch && line.startsWith('P')) {
      const prn = line.slice(1, 4);
      const p = line.slice(4).trim().split(/\s+/).map(Number);
      out.set(prn, [p[0]! * 1000, p[1]! * 1000, p[2]! * 1000]);
    }
  }
  return out;
}

function bestEph(ephs: Ephemeris[], prn: string): Ephemeris | null {
  let best: Ephemeris | null = null;
  for (const e of ephs) {
    if (e.prn !== prn) continue;
    if (
      !best ||
      Math.abs(e.tocDate.getTime() - T_MS) <
        Math.abs(best.tocDate.getTime() - T_MS)
    ) {
      best = e;
    }
  }
  return best;
}

/**
 * Precise-orbit truth: ESA MGEX final orbits (~2.5 cm accuracy).
 * Broadcast-vs-precise differences are metre-level for GPS/GAL and a
 * few metres for GLONASS (plus antenna-offset vs centre-of-mass), so
 * the thresholds below are generous but catch any time-scale or
 * convention bug (18 s of GLONASS motion is 63 km).
 */
describe.skipIf(!HAS_DATA)('broadcast orbits vs ESA MGEX SP3', () => {
  const sp3 = HAS_DATA
    ? readSp3()
    : new Map<string, [number, number, number]>();
  const nav = HAS_DATA
    ? parseNavFile(readFileSync(join(DIR, 'BRDC.nav'), 'utf-8'))
    : { ephemerides: [] as Ephemeris[] };

  const check = (prn: string, maxErrM: number) => {
    const truth = sp3.get(prn);
    const eph = bestEph(nav.ephemerides, prn);
    expect(truth, `${prn} in SP3`).toBeDefined();
    expect(eph, `${prn} in BRDC`).not.toBeNull();
    const p = computeSatPosition(eph!, T_MS);
    const err = Math.hypot(p.x - truth![0], p.y - truth![1], p.z - truth![2]);
    expect(err, `${prn} error ${err.toFixed(1)} m`).toBeLessThan(maxErrM);
  };

  it('GPS satellites within 20 m', () => {
    for (const prn of ['G05', 'G10', 'G23', 'G32']) check(prn, 20);
  });

  it('Galileo satellites within 20 m', () => {
    for (const prn of ['E07', 'E21', 'E27']) check(prn, 20);
  });

  it('GLONASS satellites within 500 m (regression: was 63 km off)', () => {
    // computeSatPosition must hand glonassPosition UTC-axis time; the
    // GPS-axis input used to leak through, displacing every GLONASS
    // satellite by ~18 s of orbital motion.
    for (const prn of ['R05', 'R19', 'R04', 'R14']) check(prn, 500);
  });

  it('BDS MEO satellites within 30 m', () => {
    for (const prn of ['C21', 'C29']) {
      if (!sp3.has(prn) || !bestEph(nav.ephemerides, prn)) continue;
      check(prn, 30);
    }
  });
});
