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

describe('RINEX 2 epoch with a receiver clock offset', () => {
  // RINEX 2.11 Table A2: satellite list 12(A1,I2) in columns 33–68, then the
  // optional receiver clock offset F12.9 in columns 69–80. Read as more
  // satellites ("  -", "0.0", …) it threw the whole epoch out of step.
  const sats = 'G01G02G03G04G05G06G07G08G09G10G11G12';
  const lines = Array.from(
    { length: 12 },
    (_, i) => `  ${20000000 + i}.000   ${105000000 + i}.000`
  ).join('\n');
  const text = `${V2_HEADER} 24  1  1  0  0  0.0000000  0 12${sats}  -0.000123456
${lines}
 24  1  1  0  0 30.0000000  0  1G05
  20000100.000   105000500.000
`;

  it('reads every satellite of both epochs', async () => {
    const obs = await collect(text);
    expect(obs).toHaveLength(13);
    expect(obs[11]).toMatchObject({
      prn: 'G12',
      values: [20000011, 105000011],
    });
    expect(obs[12]).toMatchObject({
      prn: 'G05',
      values: [20000100, 105000500],
    });
  });
});

describe('SYS / SCALE FACTOR', () => {
  // RINEX 3.04 Table A2: "Factor to divide stored observations with before
  // use (1,10,100,1000)". A phase stored ×10 keeps a fourth decimal.
  const text = `     3.04           OBSERVATION DATA    G                   RINEX VERSION / TYPE
TEST                                                        MARKER NAME
G    3 C1C L1C S1C                                          SYS / # / OBS TYPES
G   10  1 L1C                                               SYS / SCALE FACTOR
G  100  1 S1C                                               SYS / SCALE FACTOR
  2024     1     1     0     0    0.0000000     GPS         TIME OF FIRST OBS
                                                            END OF HEADER
> 2024 01 01 00 00  0.0000000  0  1
G01  20000000.123  1050000001.234        4525.000
`;

  it('divides stored values by the factor (RINEX 3 and Compact RINEX 3)', async () => {
    for (const t of [text, writeCrx(text, { date: '01-Jan-24 00:00' })]) {
      const [o] = await collect(t);
      expect(o!.values[0]).toBeCloseTo(20000000.123, 6);
      expect(o!.values[1]).toBeCloseTo(105000000.1234, 6);
      expect(o!.values[2]).toBeCloseTo(45.25, 9);
    }
  });
});
