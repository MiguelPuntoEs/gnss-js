import {
  getGpsTime,
  getDateFromGpsTime,
  getGalTime,
  getDateFromGalTime,
  getBdsTime,
  getDateFromBdsTime,
  getUnixTime,
  getDateFromUnixTime,
  getTaiDate,
  getTtDate,
  getDateFromTai,
  getDateFromTt,
  getWeekNumber,
  getDateFromGpsData,
} from '../src/index';

test('getGpsTime', () => {
  const gps_time: number = getGpsTime(new Date('1980-01-06T00:00:00Z'));
  expect(gps_time).toBe(0);
});

test('getDateFromGpsTime', () => {
  const date: Date = getDateFromGpsTime(0);
  expect(date.getTime()).toBe(new Date('1980-01-06T00:00:00Z').getTime());
});

test('getWeekNumber', () => {
  const week_no: number = getWeekNumber(new Date('1980-01-06T00:00:00Z'));
  expect(week_no).toBe(0);
});

test('getTimeOfWeek', () => {
  const tow: number = getWeekNumber(new Date('1980-01-06T00:00:00Z'));
  expect(tow).toBe(0);
});

test('getDateFromGpsData', () => {
  const date: Date = getDateFromGpsData(0, 0);
  expect(date.getTime()).toBe(new Date('1980-01-06T00:00:00Z').getTime());
});

test('getGalTime', () => {
  const gal_time: number = getGalTime(new Date('1999-08-22T00:00:00Z'));
  expect(gal_time).toBe(0);
});

test('getDateFromGalTime', () => {
  const date: Date = getDateFromGalTime(0);
  expect(date.getTime()).toBe(new Date('1999-08-22T00:00:00Z').getTime());
});

test('getBdsTime', () => {
  const bds_time: number = getBdsTime(new Date('2006-01-01T00:00:13Z'));
  expect(bds_time).toBe(0);
});

test('getDateFromBdsTime', () => {
  const date: Date = getDateFromBdsTime(0);
  expect(date.getTime()).toBe(new Date('2006-01-01T00:00:13Z').getTime());
});

test('getUnixTime', () => {
  const unix_time = getUnixTime(new Date('2025-01-01T00:00:18Z'));
  expect(unix_time).toBe(1735689600000);
});

test('getDateFromUnixTime', () => {
  const date: Date = getDateFromUnixTime(0);
  expect(date.toISOString()).toBe('1969-12-31T23:59:49.000Z');
});

test('getTaiDate', () => {
  const date: Date = getDateFromGpsTime(0);
  const tai_date: Date = getTaiDate(date);
  expect(tai_date.getTime()).toBe(new Date('1980-01-06T00:00:19Z').getTime());
});

test('getDateFromTai', () => {
  const date: Date = getDateFromTai(new Date('1980-01-06T00:00:19Z'));
  expect(getGpsTime(date)).toBe(0);
});

test('getTtDate', () => {
  const date: Date = getDateFromGpsTime(0);
  const tt_date: Date = getTtDate(date);
  expect(tt_date.getTime()).toBe(
    new Date('1980-01-06T00:00:51.184Z').getTime()
  );
});

test('getDateFromTt', () => {
  const date: Date = getDateFromTt(new Date('1980-01-06T00:00:51.184Z'));
  expect(getGpsTime(date)).toBe(0);
});
