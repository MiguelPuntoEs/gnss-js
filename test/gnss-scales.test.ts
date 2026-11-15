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
  // GLONASS ICD 5.1 / RTCM DF134: N4 = 1 for 1996–1999
  expect(getGloN4(new Date('1996-01-01T00:00:00Z'))).toBe(1);
  expect(getGloN4(new Date('1999-12-31T23:59:59Z'))).toBe(1);
  expect(getGloN4(new Date('2000-01-01T00:00:00Z'))).toBe(2);
  expect(getGloN4(new Date('2024-03-15T00:00:00Z'))).toBe(8);
  expect(getGloN4(new Date('2027-06-01T00:00:00Z'))).toBe(8);
  expect(getGloN4(new Date('2028-01-01T00:00:00Z'))).toBe(9);
});

test('getGloNA', () => {
  // 1996-01-01 → NA = 1 (first day of the 4-year period)
  expect(getGloNA(new Date('1996-01-01T00:00:00Z'))).toBe(1);
  // 1996-01-02 → NA = 2
  expect(getGloNA(new Date('1996-01-02T00:00:00Z'))).toBe(2);
  // 1996-12-31 → NA = 366 (1996 is a leap year)
  expect(getGloNA(new Date('1996-12-31T00:00:00Z'))).toBe(366);
  // last day of an interval: 366 + 3 × 365
  expect(getGloNA(new Date('2027-12-31T12:00:00Z'))).toBe(1461);
});

test('getDateFromGloN', () => {
  // N4=1, NA=1, TOD=0 → 1996-01-01T00:00:00Z
  const date = getDateFromGloN(1, 1, 0);
  expect(date.toISOString()).toBe('1996-01-01T00:00:00.000Z');
  // N4=2, NA=1, TOD=3600000ms (1 hour) → 2000-01-01T01:00:00Z
  const date2 = getDateFromGloN(2, 1, 3600000);
  expect(date2.toISOString()).toBe('2000-01-01T01:00:00.000Z');
});

test('getNtpTime', () => {
  // NTP counts UTC seconds since 1900 (RFC 5905). At the GPS epoch
  // GPS = UTC, so NTP time = 1980-01-06T00:00:00 − 1900-01-01.
  const ntp = getNtpTime(new Date('1980-01-06T00:00:00Z'));
  const expected =
    new Date('1980-01-06T00:00:00Z').getTime() -
    new Date('1900-01-01T00:00:00Z').getTime();
  expect(ntp).toBe(expected);
  // 2026: GPS = UTC + 18 s
  expect(getNtpTime(new Date('2026-11-15T00:00:18Z')) / 1000).toBe(4003689600);
});
