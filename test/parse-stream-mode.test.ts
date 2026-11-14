import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseRinexStream } from '../src/rinex';

const file = () =>
  new File(
    [readFileSync(join(__dirname, '../test-fixtures/anmg_obs_slice.rnx'))],
    'anmg_obs_slice.rnx'
  );

describe('parseRinexStream modes', () => {
  it('summaries and yields can be switched off separately', async () => {
    let obs = 0;
    const count = () => {
      obs++;
    };
    const full = await parseRinexStream(file(), undefined, undefined, count);
    const n = obs;
    expect(n).toBeGreaterThan(0);
    expect(full.epochs.length).toBeGreaterThan(0);

    // Old boolean: a worker — no summaries.
    obs = 0;
    const worker = await parseRinexStream(
      file(),
      undefined,
      undefined,
      count,
      true
    );
    expect(worker.epochs).toHaveLength(0);
    expect(obs).toBe(n);

    // A page that only needs the observations: no summaries, still yields.
    obs = 0;
    const lean = await parseRinexStream(file(), undefined, undefined, count, {
      summaries: false,
    });
    expect(lean.epochs).toHaveLength(0);
    expect(obs).toBe(n);
    expect(lean.header.markerName).toBe(full.header.markerName);

    // Summaries kept, yields off.
    const summaries = await parseRinexStream(
      file(),
      undefined,
      undefined,
      undefined,
      {
        yieldToUi: false,
      }
    );
    expect(summaries.epochs).toHaveLength(full.epochs.length);
  });
});
