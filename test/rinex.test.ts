import { getRINEX, getDateFromRINEX } from '../src/index';

test('getRINEX', () => {
  const rinex: string = getRINEX(new Date('1980-01-06T00:00:00Z'));
  expect(rinex).toBe('> 1980 01 06 00 00 00.0000000');
});

test('getDateFromRINEX', () => {
  const date: Date = getDateFromRINEX('> 1980 01 06 00 00 00.0000000');
  expect(date.getTime()).toBe(new Date('1980-01-06T00:00:00Z').getTime());
});
