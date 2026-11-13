import { describe, it, expect } from 'vitest';
import { parseRinexStream, writeCrx } from '../src/rinex';

/**
 * Observation-reader fixes found by the RINEX obs round-trip program. Each
 * block cites the specification record it pins.
 */

function fileFrom(content: string, name = 'test.obs'): File {
  return new File([content], name, { type: 'text/plain' });
}

interface Obs {
  time: number;
  prn: string;
  codes: string[];
  values: (number | null)[];
}

async function collect(text: string): Promise<Obs[]> {
  const out: Obs[] = [];
  await parseRinexStream(
    fileFrom(text),
    undefined,
    undefined,
    (time, prn, codes, values) =>
      out.push({ time, prn, codes, values: [...values] })
  );
  return out;
}

const V3_HEADER = `     3.04           OBSERVATION DATA    G                   RINEX VERSION / TYPE
TEST                                                        MARKER NAME
G    2 C1C L1C                                              SYS / # / OBS TYPES
  2024     1     1     0     0    0.0000000     GPS         TIME OF FIRST OBS
                                                            END OF HEADER
`;

const V2_HEADER = `     2.11           OBSERVATION DATA    G (GPS)             RINEX VERSION / TYPE
TEST                                                        MARKER NAME
     2    C1    L1                                          # / TYPES OF OBSERV
  2024     1     1     0     0    0.0000000     GPS         TIME OF FIRST OBS
                                                            END OF HEADER
`;

describe('epoch flag 1 (power failure) carries observations', () => {
  // RINEX 3.04 Table A3 / 2.11 Table A2: "Epoch flag = 0 or 1: OBSERVATION
  // records follow". Flag 1 only says the receiver lost power before it.
  const v3 = `${V3_HEADER}> 2024 01 01 00 00  0.0000000  0  1
G01  20000000.000   105000000.000
> 2024 01 01 00 00 30.0000000  1  1
G01  20000100.000   105000500.000
`;
  const v2 = `${V2_HEADER} 24  1  1  0  0  0.0000000  0  1G01
  20000000.000   105000000.000
 24  1  1  0  0 30.0000000  1  1G01
  20000100.000   105000500.000
`;

  it('RINEX 3', async () => {
    const obs = await collect(v3);
    expect(obs.map((o) => o.values[0])).toEqual([20000000, 20000100]);
  });

  it('RINEX 2', async () => {
    const obs = await collect(v2);
    expect(obs.map((o) => o.values[1])).toEqual([105000000, 105000500]);
  });

  it('Compact RINEX 3 and 1', async () => {
    for (const text of [v3, v2]) {
      const obs = await collect(writeCrx(text, { date: '01-Jan-24 00:00' }));
      expect(obs).toHaveLength(2);
      expect(obs[1]!.values[0]).toBe(20000100);
    }
  });
});
