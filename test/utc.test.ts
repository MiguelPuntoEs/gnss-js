import { getLeap, getGpsLeap, getUtcDate, getDateFromUtc } from '../src/index';

test('getLeap', () => {
  const gps_date: Date = new Date('2017-01-01T00:00:31Z');
  const leap_seconds: number = getLeap(gps_date);
  expect(leap_seconds).toBe(37);
});

test('getGpsLeap', () => {
  const gps_date: Date = new Date('2017-01-01T00:00:31Z');
  const leap_seconds: number = getGpsLeap(gps_date);
  expect(leap_seconds).toBe(18);
});

test('getUtcDate', () => {
  const gps_date: Date = new Date('2017-01-01T00:00:31Z');
  const utc_date: Date = getUtcDate(gps_date);
  expect(utc_date.toISOString()).toBe('2017-01-01T00:00:13.000Z');
});

test('getDateFromUtc', () => {
  const utc_date: Date = new Date('2017-01-01T00:00:01.000Z');
  const gps_date: Date = getDateFromUtc(utc_date);
  expect(gps_date.toISOString()).toBe('2017-01-01T00:00:19.000Z');
});
