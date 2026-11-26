import { describe, it, expect } from 'vitest';
import { parseDjiMrk, photoPositions } from '../src/positioning';
import type { RtkTrackPoint } from '../src/positioning';
import { geodeticToEcef, getEnuDifference } from '../src/coordinates/ecef';

// Lines in the layout of a DJI M300/P1 Timestamp.MRK (tab-separated).
const MRK = [
  '1\t21315.672240\t[2235]\t  -180,N\t   574,E\t   233,V\t14.51726464,Lat\t101.01860978,Lon\t16.455,Ellh\t0.981048, 1.261513, 2.862853\t16,Q',
  '2\t22362.317452\t[2235]\t   343,N\t   441,E\t   317,V\t14.51620816,Lat\t101.02308786,Lon\t173.622,Ellh\t0.016926, 0.018939, 0.046755\t50,Q',
  'not a record',
].join('\r\n');

const GPS0 = Date.UTC(1980, 0, 6);
const d2r = Math.PI / 180;

describe('parseDjiMrk', () => {
  it('reads time, offset, onboard position and flag', () => {
    const ev = parseDjiMrk(MRK);
    expect(ev).toHaveLength(2);
    expect(ev[0]!.index).toBe(1);
    expect(ev[0]!.timeMs).toBeCloseTo(
      GPS0 + (2235 * 604800 + 21315.67224) * 1000,
      3
    );
    expect(ev[0]!.offsetNed).toEqual([-0.18, 0.574, 0.233]);
    expect(ev[0]!.onboard!.lat).toBeCloseTo(14.51726464 * d2r, 12);
    expect(ev[0]!.onboard!.height).toBe(16.455);
    expect(ev[0]!.onboard!.sigma).toEqual([0.981048, 1.261513, 2.862853]);
    expect(ev[0]!.onboard!.status).toBe('single');
    expect(ev[1]!.onboard!.status).toBe('fixed');
  });
});

describe('photoPositions', () => {
  // A straight 10 m/s eastward pass at 5 Hz, 100 m up.
  const lat = 14.5 * d2r;
  const lon0 = 101 * d2r;
  const R = 6378137 * Math.cos(lat);
  const t0 = GPS0 + 2235 * 604800e3;
  const track: RtkTrackPoint[] = Array.from({ length: 50 }, (_, i) => {
    const lon = lon0 + (2 * i) / R;
    const position = geodeticToEcef(lat, lon, 100);
    return {
      timeMs: t0 + i * 200,
      position,
      lat,
      lon,
      height: 100,
      enu: [0, 0, 0],
      status: i === 30 ? 'float' : 'fixed',
      nSats: 20,
    };
  });

  it('interpolates to the shutter time and applies the NED offset', () => {
    const [p] = photoPositions(track, [
      { index: 7, timeMs: t0 + 1050, offsetNed: [0.1, 0.2, 0.3] },
    ]);
    // 1.05 s = 5.25 steps east of the start; then 0.1 N, 0.2 E, 0.3 down.
    const start = track[0]!.position;
    const enu = getEnuDifference(...p!.position, ...start);
    const step = getEnuDifference(...track[1]!.position, ...start)[0];
    expect(enu[0]).toBeCloseTo(5.25 * step + 0.2, 3);
    expect(enu[1]).toBeCloseTo(0.1, 3);
    expect(enu[2]).toBeCloseTo(-0.3, 3);
    expect(p!.status).toBe('fixed');
    expect(p!.gapMs).toBe(200);
  });

  it('takes the worse status of the two epochs either side', () => {
    const [p] = photoPositions(track, [{ index: 1, timeMs: t0 + 5900 }]);
    expect(p!.status).toBe('float');
  });

  it('leaves out events outside the track or in a gap', () => {
    const gappy = track.filter((_, i) => i < 10 || i > 20);
    const out = photoPositions(gappy, [
      { index: 1, timeMs: t0 - 100 },
      { index: 2, timeMs: t0 + 3000 },
      { index: 3, timeMs: t0 + 20_000 },
      { index: 4, timeMs: t0 + 1000 },
    ]);
    expect(out.map((p) => p.index)).toEqual([4]);
  });

  it('reports the camera against the onboard position', () => {
    const [p] = photoPositions(track, [
      {
        index: 1,
        timeMs: t0,
        onboard: { lat, lon: lon0, height: 99, status: 'single' },
      },
    ]);
    expect(p!.vsOnboard![2]).toBeCloseTo(1, 3);
  });
});
