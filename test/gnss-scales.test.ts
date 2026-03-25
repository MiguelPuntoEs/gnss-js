import { expect, test } from 'vitest';
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
  getGloN4,
  getGloNA,
  getDateFromGloN,
  getNtpTime,
  getTimeOfWeek,
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
  const bds_time: number = getBdsTime(new Date('2006-01-01T00:00:14Z'));
  expect(bds_time).toBe(0);
});

test('getDateFromBdsTime', () => {
  const date: Date = getDateFromBdsTime(0);
  expect(date.getTime()).toBe(new Date('2006-01-01T00:00:14Z').getTime());
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

test('getTimeOfWeek', () => {
  // GPS epoch: TOW = 0
  expect(getTimeOfWeek(new Date('1980-01-06T00:00:00Z'))).toBe(0);
  // 1 day + 1 hour into the week = 90000000 milliseconds
  expect(getTimeOfWeek(new Date('1980-01-07T01:00:00Z'))).toBe(90000000);
});

test('getGloN4', () => {
  // GLONASS leap epoch is 1996-01-01
  // 1996-01-01 → N4 = 0 (first 4-year period)
  expect(getGloN4(new Date('1996-01-01T00:00:00Z'))).toBe(0);
  // 2000-01-01 → N4 = 1
  expect(getGloN4(new Date('2000-01-01T00:00:00Z'))).toBe(1);
  // 2024-03-15 → N4 = 7 (2024-1996=28, 28/4=7)
  expect(getGloN4(new Date('2024-03-15T00:00:00Z'))).toBe(7);
});

test('getGloNA', () => {
  // 1996-01-01 → NA = 1 (first day of the 4-year period)
  expect(getGloNA(new Date('1996-01-01T00:00:00Z'))).toBe(1);
  // 1996-01-02 → NA = 2
  expect(getGloNA(new Date('1996-01-02T00:00:00Z'))).toBe(2);
  // 1996-12-31 → NA = 366 (1996 is a leap year)
  expect(getGloNA(new Date('1996-12-31T00:00:00Z'))).toBe(366);
});

test('getDateFromGloN', () => {
  // N4=0, NA=1, TOD=0 → 1996-01-01T00:00:00Z
  const date = getDateFromGloN(0, 1, 0);
  expect(date.toISOString()).toBe('1996-01-01T00:00:00.000Z');
  // N4=1, NA=1, TOD=3600000ms (1 hour) → 2000-01-01T01:00:00Z
  const date2 = getDateFromGloN(1, 1, 3600000);
  expect(date2.toISOString()).toBe('2000-01-01T01:00:00.000Z');
});

test('getNtpTime', () => {
  // At GPS epoch (1980-01-06T00:00:00Z), TAI = 1980-01-06T00:00:19Z
  // NTP epoch = 1900-01-01T00:00:00Z
  // NTP time = TAI - NTP epoch
  const ntp = getNtpTime(new Date('1980-01-06T00:00:00Z'));
  const expected =
    new Date('1980-01-06T00:00:19Z').getTime() -
    new Date('1900-01-01T00:00:00Z').getTime();
  expect(ntp).toBe(expected);
});
