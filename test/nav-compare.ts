/**
 * Comparison helpers for navigation round trips: field-by-field at the
 * printed precision, satellite position + clock (physics), and record
 * text compared field by field.
 */
import { expect } from 'vitest';
import type { Ephemeris } from '../src/rinex/nav';
import { computeSatPosition } from '../src/orbit';
import { satClockCorrection } from '../src/positioning';
import { getGpsLeap } from '../src/time/utc';

/** Record identity: PRN, epoch, Galileo data source. */
export const ephKey = (e: Ephemeris) =>
  `${e.prn}_${e.tocDate.getTime()}_${'dataSources' in e ? e.dataSources : ''}`;

function sorted(list: readonly Ephemeris[]) {
  return [...list].sort((a, b) => (ephKey(a) < ephKey(b) ? -1 : 1));
}

/**
 * Every field of every record equal to `rel` relative precision (13
 * significant digits of E19.12: 1e-12; 12 of RINEX 2's 0.ddd D19.12:
 * 1e-11). Keys must match too, minus `ignore`.
 */
export function expectSameEphemerides(
  a: readonly Ephemeris[],
  b: readonly Ephemeris[],
  rel = 1e-12,
  ignore: string[] = []
) {
  expect(b.length).toBe(a.length);
  const sa = sorted(a);
  const sb = sorted(b);
  for (let i = 0; i < sa.length; i++) {
    const ra = sa[i]! as unknown as Record<string, unknown>;
    const rb = sb[i]! as unknown as Record<string, unknown>;
    const id = ephKey(sa[i]!);
    const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
    for (const k of keys) {
      if (ignore.includes(k)) continue;
      const va = ra[k];
      const vb = rb[k];
      if (va instanceof Date) {
        expect((vb as Date)?.getTime(), `${id} ${k}`).toBe(va.getTime());
      } else if (typeof va === 'number' && typeof vb === 'number') {
        const ok = Math.abs(va - vb) <= Math.abs(va) * rel;
        expect(ok, `${id} ${k}: ${vb} vs ${va}`).toBe(true);
      } else {
        expect(vb, `${id} ${k}`).toEqual(va);
      }
    }
  }
}

/** GPS-scale instant of an ephemeris epoch (BDT +14 s, GLONASS UTC + leap). */
export function gpsInstant(e: Ephemeris): number {
  const t = e.tocDate.getTime();
  if (e.system === 'C') return t + 14_000;
  if (e.system === 'R') return t + getGpsLeap(e.tocDate) * 1000;
  return t;
}

/**
 * Satellite ECEF and clock from both ephemerides at toc − 1 h, toc and
 * toc + 1 h: < 1 mm and < 1e-12 s apart. Every `step`-th record.
 */
export function expectSamePhysics(
  a: readonly Ephemeris[],
  b: readonly Ephemeris[],
  step = 1
) {
  const sa = sorted(a);
  const sb = sorted(b);
  let checked = 0;
  for (let i = 0; i < sa.length; i += step) {
    const ea = sa[i]!;
    const eb = sb[i]!;
    for (const dt of [-3600_000, 0, 3600_000]) {
      // GLONASS / SBAS state vectors are integrated: stay within ±15 min.
      const t = gpsInstant(ea) + ('toe' in ea ? dt : dt / 4);
      const pa = computeSatPosition(ea, t);
      const pb = computeSatPosition(eb, t);
      const d = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
      expect(d, `${ephKey(ea)} position at ${dt}`).toBeLessThan(1e-3);
      const ca = satClockCorrection(ea, t);
      const cb = satClockCorrection(eb, t);
      expect(Math.abs(ca - cb), `${ephKey(ea)} clock`).toBeLessThan(1e-12);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
}

/** Records of a RINEX 2/3 nav body: each starts on a non-indented line. */
export function recordBlocks(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.includes('END OF HEADER')) + 1;
  const out: string[] = [];
  let cur: string[] | null = null;
  for (const l of lines.slice(start)) {
    if (!l.trim()) continue;
    // RINEX 2 epoch lines start with the I2 PRN, orbit lines with 3 spaces
    if (!l.startsWith('   ')) {
      if (cur) out.push(cur.join('\n'));
      cur = [l.trimEnd()];
    } else cur?.push(l.trimEnd());
  }
  if (cur) out.push(cur.join('\n'));
  return out;
}

/**
 * A record's text with blank 19-char fields read as zero and trailing
 * zero fields dropped — the spec-allowed layout freedom of spare and
 * BNK fields — so two writers' records compare field for field.
 */
export function normaliseRecord(block: string, indent: number): string {
  return block
    .split('\n')
    .map((line, n) => {
      const head = n === 0 ? line.slice(0, indent === 3 ? 22 : 23) : '';
      const from = n === 0 ? head.length : indent;
      const fields: string[] = [];
      for (let c = from; c < line.length; c += 19) {
        const f = line.substring(c, c + 19).trim();
        fields.push(
          f === '' ? 'ZERO' : f.replace(/^-?0\.0+[DE][+-]00$/, 'ZERO')
        );
      }
      while (fields.length && fields[fields.length - 1] === 'ZERO')
        fields.pop();
      return head + fields.join('|');
    })
    .join('\n');
}
