import { describe, it, expect } from 'vitest';
import { parseSp3 } from '../src/rinex';

// SP3-c §"Discussion", line 24: "Bad or absent clock values are to be set to
// _999999.999999. The six integer nines are required, whereas the fractional
// part nines are optional." A reader must therefore treat 999999.000000 (and
// 999999.9) as the sentinel too, not as a 0.999999 s clock offset.
const file = (clk: string) =>
  [
    '#dP2024  1  1  0  0  0.00000000       1 ORBIT IGS20 FIT  TST',
    '## 2295  86400.00000000   300.00000000 60310 0.0000000000000',
    '+    2   G01G02',
    '%c G  cc GPS ccc cccc cccc cccc cccc ccccc ccccc ccccc ccccc',
    '*  2024  1  1  0  0  0.00000000',
    `PG01 -22826.376664 -13657.462702   1852.531327 ${clk}`,
    'PG02   -961.884096 -16463.460843  21312.144950    -56.106049',
    'EOF',
  ].join('\n');

describe('SP3 bad-clock sentinel', () => {
  for (const clk of ['999999.999999', '999999.000000', '999999.9     ']) {
    it(`"${clk.trim()}" is a bad clock`, () => {
      const sp3 = parseSp3(file(clk));
      expect(sp3.satellites['G01']![0]!.clk).toBeNull();
      // the position on the same line is still good
      expect(sp3.satellites['G01']![0]!.x).toBeCloseTo(-22826376.664, 3);
      expect(sp3.satellites['G02']![0]!.clk).toBeCloseTo(-56.106049e-6, 12);
    });
  }
});
