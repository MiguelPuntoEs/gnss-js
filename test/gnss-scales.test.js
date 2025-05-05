const {
  getGpsTime,
  getDateFromGpsTime,
  getGalTime,
  getDateFromGalTime,
  getBdsTime,
  getDateFromBdsTime,
  getUnixTime,
  getDateFromUnixTime,
  getTAIDate,
  getTTDate,
  getDateFromTAI,
  getDateFromTT,
} = require('../src/index');

test('getGpsTime', () => {
  const gps_time = getGpsTime(new Date('1980-01-06T00:00:00Z'));
  expect(gps_time).toBe(0);
});

test('getGalTime', () => {
  const gal_time = getGalTime(new Date('1999-08-22T00:00:00Z'));
  expect(gal_time).toBe(0);
});

test('getBdsTime', () => {
  const bds_time = getBdsTime(new Date('2006-01-01T00:00:00Z'));
  expect(bds_time).toBe(0);
});

test('getUnixTime', () => {
  const unix_time = getUnixTime(new Date('1970-01-01T00:00:00Z'));
  expect(unix_time).toBe(0);
});

test('getDateFromGpsTime', () => {
  const date = getDateFromGpsTime(0);
  expect(date.getTime()).toBe(new Date('1980-01-06T00:00:00Z').getTime());
});

test('getDateFromGalTime', () => {
  const date = getDateFromGalTime(0);
  expect(date.getTime()).toBe(new Date('1999-08-22T00:00:00Z').getTime());
});

test('getDateFromBdsTime', () => {
  const date = getDateFromBdsTime(0);
  expect(date.getTime()).toBe(new Date('2006-01-01T00:00:00Z').getTime());
});

test('getDateFromUnixTime', () => {
  const date = getDateFromUnixTime(0);
  expect(date.getTime()).toBe(new Date('1970-01-01T00:00:00Z').getTime());
});

test('getTAIDate', () => {
  const date = getDateFromGpsTime(0);
  const tai_date = getTAIDate(date);
  expect(tai_date.getTime()).toBe(new Date('1980-01-06T00:00:19Z').getTime());
});

test('getDateFromTAI', () => {
  const date = getDateFromTAI(new Date('1980-01-06T00:00:19Z'));
  expect(getGpsTime(date)).toBe(0);
});

test('getTTDate', () => {
  const date = getDateFromGpsTime(0);
  const tt_date = getTTDate(date);
  expect(tt_date.getTime()).toBe(
    new Date('1980-01-06T00:00:51.184Z').getTime()
  );
});

test('getDateFromTT', () => {
  const date = getDateFromTT(new Date('1980-01-06T00:00:51.184Z'));
  expect(getGpsTime(date)).toBe(0);
});
