const {
  getLeap,
  getGpsLeap,
  getUtcDate,
  getDateFromUtc,
} = require('../src/index');

test('getLeap', () => {
  const gps_date = new Date('2017-01-01T00:00:31Z');
  const leap_seconds = getLeap(gps_date);
  expect(leap_seconds).toBe(37);
});

test('getLeap', () => {
  const gps_date = new Date('2017-01-01T00:00:31Z');
  const leap_seconds = getGpsLeap(gps_date);
  expect(leap_seconds).toBe(18);
});

test('getUtcDate', () => {
  const gps_date = new Date('2017-01-01T00:00:31Z');
  const utc_date = getUtcDate(gps_date);
  expect(utc_date.toISOString()).toBe('2017-01-01T00:00:13.000Z');
});

test('getDateFromUtc', () => {
  const utc_date = new Date('2017-01-01T00:00:01.000Z');
  const gps_date = getDateFromUtc(utc_date);
  expect(gps_date.toISOString()).toBe('2017-01-01T00:00:19.000Z');
});
