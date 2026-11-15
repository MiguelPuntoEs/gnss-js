import { expect, test } from 'vitest';
import {
  getHourCode,
  getDayOfYear,
  getDateFromHourCode,
  getDayOfWeek,
  getDateFromDayOfWeek,
  getTimeOfDay,
  getDateFromTimeOfDay,
  getDateFromDayOfYear,
  getWeekOfYear,
  HourCode,
} from '../src/index';

test('getTimeOfDay', () => {
  const date: Date = new Date('1980-01-06T23:09:00Z');
  const time_of_day: number = getTimeOfDay(date);
  expect(time_of_day).toBe(83340000); // 23h 09m 00s in milliseconds
});

test('getDateFromTimeOfDay', () => {
  const date: Date = new Date('1980-01-06T00:00:00Z');
  const new_date: Date = getDateFromTimeOfDay(83340000, date);
  expect(new_date.toISOString()).toBe('1980-01-06T23:09:00.000Z');
});

test('getDayOfYear', () => {
  const date: Date = new Date('1980-01-06T23:09:00Z');
  const day_of_year: number = getDayOfYear(date);
  expect(day_of_year).toBe(6);
});

test('getDateFromDayOfYear', () => {
  const date: Date = new Date('1980-01-06T00:00:00Z');
  const new_date: Date = getDateFromDayOfYear(100, date);
  expect(new_date.toISOString()).toBe('1980-04-09T00:00:00.000Z');
});

test('getHourCode', () => {
  const date: Date = new Date('1980-01-06T00:00:00Z');
  const hour_code: HourCode = getHourCode(date);
  expect(hour_code).toBe('a');
});

test('getDateFromHourCode', () => {
  const date: Date = new Date('1980-01-06T00:00:00Z');
  const new_date: Date = getDateFromHourCode('c', date);
  expect(new_date.toISOString()).toBe('1980-01-06T02:00:00.000Z');
});

test('getDayOfWeek', () => {
  const date: Date = new Date('1980-01-06T00:00:00Z');
  expect(getDayOfWeek(date)).toBe(0);
});

test('getDateFromDayOfWeek', () => {
  const date: Date = new Date('1980-01-06T00:00:00Z');
  const new_date: Date = getDateFromDayOfWeek(1, date);
  expect(new_date.toISOString()).toBe('1980-01-07T00:00:00.000Z');
});

test('getWeekOfYear', () => {
  const date: Date = new Date('2025-05-05T00:00:00Z');
  expect(getWeekOfYear(date)).toBe(19);
});

test('getWeekOfYear: ISO 8601 weeks in every kind of year', () => {
  const cases: [string, number][] = [
    ['2021-01-04T12:00:00Z', 1], // 4 Jan on Monday
    ['2021-01-03T12:00:00Z', 53], // still the last week of 2020
    ['2022-01-04T12:00:00Z', 1], // Tuesday
    ['2023-01-02T12:00:00Z', 1], // Wednesday
    ['2024-01-01T12:00:00Z', 1], // Thursday
    ['2024-12-23T12:00:00Z', 52],
    ['2024-12-30T12:00:00Z', 1], // already week 1 of 2025
    ['2026-11-15T23:59:59Z', 46], // Sunday ends the week
    ['2026-11-16T00:00:00Z', 47],
    ['2026-12-28T12:00:00Z', 53], // 53-week year
    ['2027-01-04T12:00:00Z', 1],
    ['2027-12-27T12:00:00Z', 52], // 2027 has 52 weeks
  ];
  for (const [iso, week] of cases) {
    expect(getWeekOfYear(new Date(iso)), iso).toBe(week);
  }
});

test('getWeekOfYear: Thursday rule for every day 1980–2100', () => {
  // ISO week-year = year of the week's Thursday; week 1 holds 4 January
  for (let t = Date.UTC(1980, 0, 1); t < Date.UTC(2101, 0, 1); t += 86400000) {
    const d = new Date(t);
    const thursday = new Date(t + (3 - ((d.getUTCDay() + 6) % 7)) * 86400000);
    const jan4 = Date.UTC(thursday.getUTCFullYear(), 0, 4);
    const jan4Monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 86400000;
    const expected =
      Math.floor((thursday.getTime() - jan4Monday) / (7 * 86400000)) + 1;
    expect(getWeekOfYear(d)).toBe(expected);
  }
});
