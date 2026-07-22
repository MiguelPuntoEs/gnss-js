import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import type { RinexHeader } from '../src/rinex';
import { writeRinexObsBlob, type CompactEpoch } from '../src/rinex';
import { writeRinex4ObsBlob } from '../src/rinex';
import { writeRinex2ObsBlob } from '../src/rinex';

/**
 * Characterization tests: the writer output is snapshotted so the
 * shared-core refactor (and any future change) is diffable. Only the
 * PGM / RUN BY / DATE line depends on the wall clock — normalized out.
 */

const header = {
  markerName: 'TEST00XYZ',
  observer: 'OBSERVER',
  agency: 'AGENCY',
  receiverNumber: '12345',
  receiverType: 'RCV TYPE',
  receiverVersion: '1.0',
  antNumber: '999',
  antType: 'ANT TYPE',
  approxPosition: [3924687.7039, 301132.7618, 5001910.7712],
  antDelta: [0.1, 0.02, 0.003],
  glonassSlots: { '5': -1, '12': 4 },
} as unknown as RinexHeader;

const obsTypes = new Map<string, string[]>([
  ['G', ['C1C', 'L1C', 'S1C']],
  ['R', ['C1C', 'S1C']],
]);

function epoch(timeMs: number, offset: number): CompactEpoch {
  return {
    time: timeMs,
    sats: new Map([
      [
        'G01',
        new Float64Array([20_000_123.456 + offset, 105_123_456.789, 45.2]),
      ],
      ['G07', new Float64Array([21_500_000.001 + offset, NaN, 38.0])],
      ['R05', new Float64Array([19_876_543.21 + offset, 41.5])],
    ]),
  };
}

const epochs = [
  epoch(Date.UTC(2024, 0, 1, 10, 0, 0), 0),
  epoch(Date.UTC(2024, 0, 1, 10, 0, 30), 7.5),
];

async function decode(blob: Blob): Promise<string> {
  const buf = Buffer.from(await blob.arrayBuffer());
  return gunzipSync(buf)
    .toString('utf8')
    .replace(/^.*PGM \/ RUN BY \/ DATE\s*$/m, '<PGM LINE>PGM / RUN BY / DATE');
}

describe('obs writers (characterization)', () => {
  it('RINEX 3.04 output is stable', async () => {
    expect(
      await decode(await writeRinexObsBlob(header, epochs, obsTypes))
    ).toMatchSnapshot();
  });

  it('RINEX 4.01 output is stable', async () => {
    expect(
      await decode(await writeRinex4ObsBlob(header, epochs, obsTypes))
    ).toMatchSnapshot();
  });

  it('RINEX 2.11 output is stable', async () => {
    expect(
      await decode(await writeRinex2ObsBlob(header, epochs, obsTypes))
    ).toMatchSnapshot();
  });

  it('v3 and v4 differ only in version line and comment', async () => {
    const v3 = await decode(await writeRinexObsBlob(header, epochs, obsTypes));
    const v4 = await decode(await writeRinex4ObsBlob(header, epochs, obsTypes));
    const diff = v3
      .split('\n')
      .filter((line, i) => v4.split('\n')[i] !== line)
      .map((l) => l.slice(60).trim());
    expect(diff).toEqual(['RINEX VERSION / TYPE', 'COMMENT']);
  });

  it('empty input produces an empty blob', async () => {
    const blob = await writeRinexObsBlob(header, [], obsTypes);
    expect(blob.size).toBe(0);
  });
});
