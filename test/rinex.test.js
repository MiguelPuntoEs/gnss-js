const { getRINEX, getDateFromRINEX } = require('../src/index');

test('getRINEX', () => {
  const rinex = getRINEX(new Date('1980-01-06T00:00:00Z'));
  expect(rinex).toBe('> 1980 01 06 00 00 00.0000000');
});

test('getDateFromRINEX', () => {
  const date = getDateFromRINEX('> 1980 01 06 00 00 00.0000000');
  expect(date.getTime()).toBe(new Date('1980-01-06T00:00:00Z').getTime());
});
