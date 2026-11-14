import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseTle, sgp4, sgp4Init } from '../src/orbit';

/**
 * Vallado et al., "Revisiting Spacetrack Report #3" (AIAA 2006-6753)
 * verification set, as distributed with python-sgp4 (MIT): SGP4-VER.TLE
 * holds the element sets (line 2 carries start/stop/step minutes after
 * column 69) and tcppver.out the reference C++ output, TEME km and km/s.
 */
const DIR = join(__dirname, '../test-fixtures/sgp4');
const tleText = readFileSync(join(DIR, 'SGP4-VER.TLE'), 'utf-8');
const outText = readFileSync(join(DIR, 'tcppver.out'), 'utf-8');

interface Block {
  norad: number;
  rows: number[][];
}
function blocks(): Block[] {
  const out: Block[] = [];
  for (const line of outText.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length === 2 && f[1] === 'xx') out.push({ norad: +f[0]!, rows: [] });
    else if (f.length >= 7 && out.length)
      out[out.length - 1]!.rows.push(f.slice(0, 7).map(Number));
  }
  return out;
}

describe('SGP4 — Vallado verification set', () => {
  const { sets } = parseTle(tleText);
  const ref = blocks();

  it('parses every verification element set', () => {
    expect(sets.length).toBe(ref.length);
    sets.forEach((s, i) => expect(s.norad).toBe(ref[i]!.norad));
  });

  it('matches the reference positions and velocities', () => {
    let maxDr = 0;
    let maxDv = 0;
    let n = 0;
    sets.forEach((el, i) => {
      const satrec = sgp4Init(el, { opsmode: 'i' });
      // 33334 is the set's impossible orbit (n = 0.00001 rev/day): the reference just echoes
      // the previous satellite's last state, the propagator must refuse.
      if (el.norad === 33334) {
        expect(sgp4(satrec, 0)).toBeNull();
        expect(satrec.error).toBeGreaterThan(0);
        return;
      }
      for (const row of ref[i]!.rows) {
        const res = sgp4(satrec, row[0]!);
        expect(
          res,
          `${el.norad} @ ${row[0]} min (error ${satrec.error})`
        ).not.toBeNull();
        const dr = Math.hypot(
          res!.r[0] - row[1]!,
          res!.r[1] - row[2]!,
          res!.r[2] - row[3]!
        );
        const dv = Math.hypot(
          res!.v[0] - row[4]!,
          res!.v[1] - row[5]!,
          res!.v[2] - row[6]!
        );
        maxDr = Math.max(maxDr, dr);
        maxDv = Math.max(maxDv, dv);
        n++;
      }
    });
    console.log(
      `rows ${n}, max |dr| ${maxDr.toExponential(2)} km, max |dv| ${maxDv.toExponential(2)} km/s`
    );
    expect(n).toBeGreaterThan(500);
    expect(maxDr).toBeLessThan(1e-6); // 1 mm
    expect(maxDv).toBeLessThan(1e-8);
  });
});
