import { describe, it, expect } from 'vitest';
import { parseSp3 } from '../src/rinex';

describe('parseSp3 agency', () => {
  it('reads the producing agency from the first header line', () => {
    const text =
      '#dP2024  1 15  0  0  0.00000000     289 ORBIT ITRF  BHN ESOC                    \n' +
      '## 2297      0.00000000   300.00000000 60324 0.0000000000000\n';
    expect(parseSp3(text).agency).toBe('ESOC');
  });
});
