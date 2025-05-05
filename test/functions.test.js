const {
  getHourCode,
  getDayOfYear,
  getDateFromHourCode,
  getDayOfWeek,
  getDateFromDayOfWeek,
  getTimeOfDay,
  getDateFromTimeOfDay,
  getDateFromDayOfYear,
  getWeekOfYear,
} = require('../src/index');

test('getTimeOfDay', () => {
  const date = new Date('1980-01-06T23:09:00Z');
  const time_of_day = getTimeOfDay(date);
  expect(time_of_day).toBe(83340);
});

test('getDateFromTimeOfDay', () => {
  const date = new Date('1980-01-06T00:00:00Z');
  const new_date = getDateFromTimeOfDay(83340, date);
  expect(new_date.toISOString()).toBe('1980-01-06T23:09:00.000Z');
});

test('getDayOfYear', () => {
  const date = new Date('1980-01-06T23:09:00Z');
  const day_of_year = getDayOfYear(date);
  expect(day_of_year).toBe(6);
});

test('getDateFromDayOfYear', () => {
  const date = new Date('1980-01-06T00:00:00Z');
  const new_date = getDateFromDayOfYear(100, date);
  expect(new_date.toISOString()).toBe('1980-04-09T00:00:00.000Z');
});

test('getHourCode', () => {
  const date = new Date('1980-01-06T00:00:00Z');
  const hour_code = getHourCode(date);
  expect(hour_code).toBe('a');
});

test('getDateFromHourCode', () => {
  const date = new Date('1980-01-06T00:00:00Z');
  const new_date = getDateFromHourCode('c', date);
  expect(new_date.toISOString()).toBe('1980-01-06T02:00:00.000Z');
});

test('getDayOfWeek', () => {
  const date = new Date('1980-01-06T00:00:00Z');
  expect(getDayOfWeek(date)).toBe(0);
});

test('getDateFromDayOfWeek', () => {
  const date = new Date('1980-01-06T00:00:00Z');
  const new_date = getDateFromDayOfWeek(1, date);
  expect(new_date.toISOString()).toBe('1980-01-07T00:00:00.000Z');
});

test('getWeekOfYear', () => {
  const date = new Date('2025-05-05T00:00:00Z');
  expect(getWeekOfYear(date)).toBe(19);
});

// test('getDateFromDayOfWeek', () => {
//     const date = new Date('1980-01-06T00:00:00Z')
//     const new_date = getDateFromDayOfWeek(1, date);
//     expect(new_date.toISOString()).toBe('1980-01-07T00:00:00.000Z');
// });
