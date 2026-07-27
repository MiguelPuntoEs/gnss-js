import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseSbfReceiverSetup } from '../src/sbf/setup';
import { ecefToGeodetic } from '../src/coordinates/ecef';

// A single ReceiverSetup (5902) block sliced from the TU Delft DLF500NLD1
// Septentrio stream — the block a RINEX header's marker/receiver/antenna and
// APPROX POSITION lines come from.
const SBF_FILE = join(__dirname, '../test-fixtures/dlf500_sbf_setup_slice.sbf');

describe.skipIf(!existsSync(SBF_FILE))('parseSbfReceiverSetup (5902)', () => {
  const bytes = new Uint8Array(readFileSync(SBF_FILE));

  it('decodes marker, receiver and antenna identity', () => {
    const s = parseSbfReceiverSetup(bytes);
    expect(s).not.toBeNull();
    expect(s!.markerName).toBe('DLF500NLD');
    expect(s!.stationCode).toBe('DLF5');
    expect(s!.rxName).toBe('SSRC7');
    expect(s!.rxVersion).toBe('5.7.0');
    expect(s!.productName).toBe('PolaRx5');
    expect(s!.markerType).toBe('GEODETIC');
    // RINEX antenna+radome field (16-char name + 4-char radome).
    expect(s!.antType).toContain('LEIAR25.R3');
  });

  it('decodes the reference position (Delft, NL) to ECEF', () => {
    const s = parseSbfReceiverSetup(bytes)!;
    expect(s.position).not.toBeNull();
    const [lat, lon, h] = ecefToGeodetic(...s.position!);
    expect((lat * 180) / Math.PI).toBeCloseTo(51.986, 2);
    expect((lon * 180) / Math.PI).toBeCloseTo(4.387, 2);
    expect(h).toBeGreaterThan(30);
    expect(h).toBeLessThan(120);
    // latitude/longitude are exposed in radians.
    expect(s.latitude).toBeCloseTo((51.986 * Math.PI) / 180, 4);
  });

  it('returns null when there is no ReceiverSetup block', () => {
    expect(parseSbfReceiverSetup(new Uint8Array(0))).toBeNull();
  });
});
