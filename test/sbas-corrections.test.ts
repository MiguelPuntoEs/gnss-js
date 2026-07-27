import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseUbxRawNav } from '../src/ubx/rawnav';
import { SbasProcessor } from '../src/positioning/sbas';

const UBX = join(__dirname, '../test-fixtures/f9p_rawnav_slice.ubx');

describe.skipIf(!existsSync(UBX))(
  'SBAS corrections (F9P EGNOS/WAAS stream)',
  () => {
    const data = new Uint8Array(readFileSync(UBX));

    // Collect the raw SBAS messages per GEO PRN with their reception time.
    const byPrn = new Map<
      number,
      { msg: Uint8Array; week: number; tow: number }[]
    >();
    parseUbxRawNav(data, {
      onSbasMessage: (msg, prn, week, tow) => {
        if (!byPrn.has(prn)) byPrn.set(prn, []);
        // copy — the decoder reuses its buffer
        byPrn.get(prn)!.push({ msg: msg.slice(), week, tow });
      },
    });

    // Use the GEO with the most messages (a full correction set).
    const [prn, msgs] = [...byPrn.entries()].sort(
      (a, b) => b[1].length - a[1].length
    )[0]!;

    it('captured a rich single-GEO correction stream', () => {
      expect(msgs.length).toBeGreaterThan(50);
      expect(prn).toBeGreaterThanOrEqual(120);
    });

    it('decodes the full message set (mask, fast, long, iono grid)', () => {
      const sbas = new SbasProcessor();
      const types = new Set<number>();
      for (const m of msgs) {
        const t = sbas.update(m.msg, m.week, m.tow, prn);
        if (t >= 0) types.add(t);
      }
      // PRN mask (MT1), fast corrections (MT2–5/24), and the ionosphere grid
      // (MT18 mask + MT26 delays) must all have been decoded.
      expect(sbas.activeSats().some((p) => p[0] === 'G')).toBe(true);
      expect(sbas.ionoGridPoints()).toBeGreaterThan(0);
      // MT1, at least one of 2–5, 18 and 26 seen.
      expect(types.has(1)).toBe(true);
      expect([2, 3, 4, 5, 24].some((t) => types.has(t))).toBe(true);
      expect(types.has(18)).toBe(true);
      expect(types.has(26)).toBe(true);
    });

    it('produces a sane per-satellite correction near the stream end', () => {
      const sbas = new SbasProcessor();
      for (const m of msgs) sbas.update(m.msg, m.week, m.tow, prn);
      const last = msgs[msgs.length - 1]!;

      // At least one GPS satellite in the mask has a valid (fresh) correction.
      const gpsSats = sbas.activeSats().filter((p) => p[0] === 'G');
      let found = 0;
      for (const g of gpsSats) {
        const c = sbas.satCorrection(g, last.week, last.tow);
        if (!c) continue;
        found++;
        // Fast pseudorange correction is metres-scale, clock a few metres,
        // position correction a few metres, variance positive & finite.
        expect(Math.abs(c.prcM)).toBeLessThan(100);
        expect(Math.abs(c.dClkS) * 299792458).toBeLessThan(100);
        expect(Math.hypot(...c.dPos)).toBeLessThan(50);
        expect(c.varM2).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(c.varM2)).toBe(true);
      }
      expect(found).toBeGreaterThan(0);
    });

    it('interpolates an ionospheric delay somewhere in the grid coverage', () => {
      const sbas = new SbasProcessor();
      for (const m of msgs) sbas.update(m.msg, m.week, m.tow, prn);
      const last = msgs[msgs.length - 1]!;
      const D2R = Math.PI / 180;

      // Sweep a coarse global grid of pierce points; a covered one must yield a
      // plausible slant delay (SBAS grids cover a continental region).
      let hit = 0;
      let maxDelay = 0;
      for (let lat = -70; lat <= 70; lat += 5) {
        for (let lon = -170; lon <= 170; lon += 5) {
          const d = sbas.ionoDelay(
            last.week,
            last.tow,
            lat * D2R,
            lon * D2R,
            50,
            0, // azimuth
            80 * D2R // near-zenith → mapping ≈ 1
          );
          if (d && d.delayM > 0) {
            hit++;
            maxDelay = Math.max(maxDelay, d.delayM);
          }
        }
      }
      expect(hit).toBeGreaterThan(0);
      // Zenith ionospheric delay on L1 is realistically < ~30 m.
      expect(maxDelay).toBeLessThan(30);
    });
  }
);
