import { describe, it, expect } from 'vitest';
import { deg2rad, rad2deg, deg2dms } from '../src/coordinates/units';
import {
  geodeticToEcef,
  ecefToGeodetic,
  getEnuDifference,
  getAer,
  clampUnit,
} from '../src/coordinates/ecef';
import {
  geodeticToUtm,
  geodeticToMaidenhead,
  geodeticToGeohash,
} from '../src/coordinates/projections';

describe('units', () => {
  it('rad2deg and deg2rad are inverse', () => {
    expect(rad2deg(deg2rad(45))).toBeCloseTo(45, 10);
    expect(rad2deg(deg2rad(-180))).toBeCloseTo(-180, 10);
  });

  it('deg2dms converts correctly', () => {
    const [d, m, s] = deg2dms(48.8566);
    expect(d).toBe(48);
    expect(m).toBe(51);
    expect(s).toBeCloseTo(23.76, 1);
  });

  it('deg2dms handles 60-second overflow', () => {
    const [d, m, s] = deg2dms(1 + 59.99999 / 3600);
    // Should round up to next minute
    expect(d).toBe(1);
    expect(m).toBe(1);
    expect(s).toBeCloseTo(0, 2);
  });
});

describe('ecef', () => {
  it('geodeticToEcef at equator/prime meridian', () => {
    const [x, y, z] = geodeticToEcef(0, 0, 0);
    expect(x).toBeCloseTo(6378137.0, 0);
    expect(y).toBeCloseTo(0, 0);
    expect(z).toBeCloseTo(0, 0);
  });

  it('geodeticToEcef and ecefToGeodetic are inverse', () => {
    const lat = deg2rad(48.8566),
      lon = deg2rad(2.3522),
      h = 35;
    const [x, y, z] = geodeticToEcef(lat, lon, h);
    const [lat2, lon2, h2] = ecefToGeodetic(x, y, z);
    expect(lat2).toBeCloseTo(lat, 10);
    expect(lon2).toBeCloseTo(lon, 10);
    expect(h2).toBeCloseTo(h, 3);
  });

  it('ecefToGeodetic handles north pole', () => {
    const [lat, ,] = ecefToGeodetic(0, 0, 6356752.314245);
    expect(lat).toBeCloseTo(Math.PI / 2, 5);
  });

  it('getEnuDifference returns zero for same point', () => {
    const [e, n, u] = getEnuDifference(1e6, 2e6, 3e6, 1e6, 2e6, 3e6);
    expect(e).toBeCloseTo(0);
    expect(n).toBeCloseTo(0);
    expect(u).toBeCloseTo(0);
  });

  it('getAer returns zero for coincident points', () => {
    const [el, az, r] = getAer(1e6, 2e6, 3e6, 1e6, 2e6, 3e6);
    expect(el).toBe(0);
    expect(az).toBe(0);
    expect(r).toBe(0);
  });

  it('clampUnit clamps correctly', () => {
    expect(clampUnit(1.0001)).toBe(1);
    expect(clampUnit(-1.0001)).toBe(-1);
    expect(clampUnit(0.5)).toBe(0.5);
  });
});

describe('geodeticToUtm', () => {
  it('converts Madrid coordinates correctly', () => {
    const lat = deg2rad(40.4168),
      lon = deg2rad(-3.7038);
    const { zone, hemisphere, easting, northing } = geodeticToUtm(lat, lon);
    expect(zone).toBe(30);
    expect(hemisphere).toBe('N');
    expect(easting).toBeGreaterThan(400_000);
    expect(easting).toBeLessThan(500_000);
    expect(northing).toBeGreaterThan(4_470_000);
    expect(northing).toBeLessThan(4_480_000);
  });

  it('converts Sydney (southern hemisphere) correctly', () => {
    const lat = deg2rad(-33.8688),
      lon = deg2rad(151.2093);
    const { zone, hemisphere, northing } = geodeticToUtm(lat, lon);
    expect(zone).toBe(56);
    expect(hemisphere).toBe('S');
    expect(northing).toBeGreaterThan(6_000_000);
    expect(northing).toBeLessThan(7_000_000);
  });

  it('easting is always near 500000 at central meridian', () => {
    const lat = deg2rad(45),
      lon = deg2rad(3);
    const { easting } = geodeticToUtm(lat, lon);
    expect(Math.abs(easting - 500_000)).toBeLessThan(1);
  });
});

describe('geodeticToMaidenhead', () => {
  it('converts Washington DC correctly', () => {
    const lat = deg2rad(38.9072),
      lon = deg2rad(-77.0369);
    const mh = geodeticToMaidenhead(lat, lon);
    expect(mh).toHaveLength(6);
    expect(mh.slice(0, 4)).toBe('FM18');
  });

  it('converts Paris correctly', () => {
    const lat = deg2rad(48.8566),
      lon = deg2rad(2.3522);
    const mh = geodeticToMaidenhead(lat, lon);
    expect(mh.slice(0, 2)).toBe('JN');
  });

  it('returns 6 characters', () => {
    const mh = geodeticToMaidenhead(deg2rad(0), deg2rad(0));
    expect(mh).toHaveLength(6);
  });
});

describe('geodeticToGeohash', () => {
  it('returns correct length', () => {
    const gh = geodeticToGeohash(deg2rad(48.8566), deg2rad(2.3522));
    expect(gh).toHaveLength(8);
  });

  it('returns correct length with custom precision', () => {
    const gh = geodeticToGeohash(deg2rad(48.8566), deg2rad(2.3522), 5);
    expect(gh).toHaveLength(5);
  });

  it('encodes known location (Paris center starts with u09)', () => {
    const gh = geodeticToGeohash(deg2rad(48.8566), deg2rad(2.3522));
    expect(gh.startsWith('u09')).toBe(true);
  });

  it('encodes known location (London starts with gcpv)', () => {
    const gh = geodeticToGeohash(deg2rad(51.5074), deg2rad(-0.1278));
    expect(gh.startsWith('gcpv')).toBe(true);
  });

  it('only uses valid base32 characters', () => {
    const gh = geodeticToGeohash(deg2rad(40.4168), deg2rad(-3.7038));
    const valid = '0123456789bcdefghjkmnpqrstuvwxyz';
    for (const ch of gh) {
      expect(valid).toContain(ch);
    }
  });
});
