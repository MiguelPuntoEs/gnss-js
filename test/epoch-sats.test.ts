import { describe, expect, it } from 'vitest';
import { EpochSats, writeRinexObsBlob, type CompactEpoch } from '../src/rinex';
import { gunzipSync } from 'zlib';
import type { RinexHeader } from '../src/rinex/parser';

const row = (...v: number[]) => Float64Array.from(v);

describe('EpochSats', () => {
  it('behaves like a Map for get/has/size/iteration, in insertion order', () => {
    const s = new EpochSats();
    s.set('G01', row(1, 2, 3));
    s.set('E05', row(4, NaN));
    s.set('R10', row(5));
    expect(s.size).toBe(3);
    expect(s.has('E05')).toBe(true);
    expect(s.has('C01')).toBe(false);
    expect(s.get('C01')).toBeUndefined();
    expect([...s.get('G01')!]).toEqual([1, 2, 3]);
    expect([...s.keys()]).toEqual(['G01', 'E05', 'R10']);
    expect([...s].map(([p, v]) => [p, [...v]])).toEqual([
      ['G01', [1, 2, 3]],
      ['E05', [4, NaN]],
      ['R10', [5]],
    ]);
    expect([...s.values()].map((v) => v.length)).toEqual([3, 2, 1]);
  });

  it('copies on set; get is a live view until the block moves', () => {
    const s = new EpochSats();
    const r = row(1, 2);
    s.set('G01', r);
    r[0] = 99; // not seen: set copied it
    expect(s.get('G01')![0]).toBe(1);
    const v = s.get('G01')!;
    v[1] = 7; // seen: a view of the block
    expect(s.get('G01')![1]).toBe(7);
  });

  it('widens a satellite (codes added) and keeps everyone else', () => {
    const s = new EpochSats();
    s.set('G01', row(1, 2));
    s.set('G02', row(3, 4));
    s.set('G01', row(1, 2, 5));
    expect([...s.get('G01')!]).toEqual([1, 2, 5]);
    expect([...s.get('G02')!]).toEqual([3, 4]);
    s.compact();
    expect([...s.get('G01')!]).toEqual([1, 2, 5]);
    expect([...s.get('G02')!]).toEqual([3, 4]);
    expect([...s.keys()]).toEqual(['G01', 'G02']);
  });

  it('overwrites a same-width row in place; deletes', () => {
    const s = new EpochSats();
    s.set('G01', row(1, 2));
    s.set('G02', row(3, 4));
    s.set('G01', row(8, 9));
    expect([...s.get('G01')!]).toEqual([8, 9]);
    expect(s.delete('G01')).toBe(true);
    expect(s.delete('G01')).toBe(false);
    expect([...s.keys()]).toEqual(['G02']);
    s.compact();
    expect([...s.get('G02')!]).toEqual([3, 4]);
  });

  it('grows through many satellites', () => {
    const s = new EpochSats();
    for (let i = 1; i <= 60; i++)
      s.set(`C${String(i).padStart(2, '0')}`, row(i, i * 2, i * 3));
    s.compact();
    expect(s.size).toBe(60);
    expect([...s.get('C37')!]).toEqual([37, 74, 111]);
  });

  it('writes the same RINEX as a Map', async () => {
    const header = {
      version: 3.04,
      type: 'O',
      satSystem: 'M',
      markerName: 'TEST',
      receiverType: '',
      antType: '',
      approxPosition: [4027893.0, 307045.0, 4919475.0],
      antDelta: [0, 0, 0],
      interval: 30,
      timeOfFirstObs: new Date(Date.UTC(2026, 0, 1)),
      timeOfLastObs: null,
      obsTypes: { G: ['C1C', 'L1C'], E: ['C1C', 'L1C'] },
      glonassSlots: {},
    } as unknown as RinexHeader;
    const vals: [string, Float64Array][] = [
      ['G05', row(21000000.123, 110000000.456)],
      ['E11', row(23000000.5, NaN)],
    ];
    const t = Date.UTC(2026, 0, 1);
    const asMap: CompactEpoch[] = [{ time: t, sats: new Map(vals) }];
    const blk = new EpochSats();
    for (const [p, v] of vals) blk.set(p, v);
    const asBlock: CompactEpoch[] = [{ time: t, sats: blk.compact() }];
    const text = async (e: CompactEpoch[]) =>
      gunzipSync(
        new Uint8Array(
          await (
            await writeRinexObsBlob(
              header,
              e,
              new Map(Object.entries(header.obsTypes))
            )
          ).arrayBuffer()
        )
      )
        .toString()
        .split('\n')
        .filter((l) => !/PGM \/ RUN BY|COMMENT/.test(l))
        .join('\n');
    expect(await text(asBlock)).toBe(await text(asMap));
  });
});
