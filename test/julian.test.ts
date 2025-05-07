import {
  getJulianDate,
  getDateFromJulianDate,
  getMJD,
  getDateFromMJD,
  getMJD2000,
  getDateFromMJD2000,
} from '../src/index';
import { Scale } from '../src/types/enums';

// TT scale
test('getJulianDate', () => {
  const date: Date = new Date('2000-01-01T11:59:08.816Z');
  const julian_date: number = getJulianDate(date);
  expect(julian_date).toBeCloseTo(2451545.0, 5);
});

test('getDateFromJulianDate', () => {
  const date: Date = getDateFromJulianDate(2451545.0);
  expect(date.toISOString()).toBe('2000-01-01T11:59:08.816Z');
});

test('getMJD', () => {
  const date: Date = new Date('2000-01-01T11:59:08.816Z');
  const mjd = getMJD(date);
  expect(mjd).toBeCloseTo(51544.5, 5);
});

test('getDateFromMJD', () => {
  const date: Date = getDateFromMJD(51544.5);
  expect(date.toISOString()).toBe('2000-01-01T11:59:08.816Z');
});

test('getMJD2000', () => {
  const date: Date = new Date('2000-01-01T11:59:08.816Z');
  const mjd2000: number = getMJD2000(date);
  expect(mjd2000).toBeCloseTo(0, 5);
});

test('getDateFromMJD2000', () => {
  const date: Date = getDateFromMJD2000(0);
  expect(date.toISOString()).toBe('2000-01-01T11:59:08.816Z');
});

// TAI scale
test('getJulianDate', () => {
  const date: Date = new Date('2000-01-01T11:59:41.000Z');
  const julian_date: number = getJulianDate(date, Scale.TAI);
  expect(julian_date).toBeCloseTo(2451545.0, 5);
});

test('getDateFromJulianDate', () => {
  const date: Date = getDateFromJulianDate(2451545.0, Scale.TAI);
  expect(date.toISOString()).toBe('2000-01-01T11:59:41.000Z');
});

test('getMJD', () => {
  const date: Date = new Date('2000-01-01T11:59:41.000Z');
  const mjd = getMJD(date, Scale.TAI);
  expect(mjd).toBeCloseTo(51544.5, 5);
});

test('getDateFromMJD', () => {
  const date: Date = getDateFromMJD(51544.5, Scale.TAI);
  expect(date.toISOString()).toBe('2000-01-01T11:59:41.000Z');
});

test('getMJD2000', () => {
  const date: Date = new Date('2000-01-01T11:59:41.000Z');
  const mjd2000: number = getMJD2000(date, Scale.TAI);
  expect(mjd2000).toBeCloseTo(0, 5);
});

test('getDateFromMJD2000', () => {
  const date: Date = getDateFromMJD2000(0, Scale.TAI);
  expect(date.toISOString()).toBe('2000-01-01T11:59:41.000Z');
});

// GPS scale
test('getJulianDate', () => {
  const date: Date = new Date('2000-01-01T12:00:00.000Z');
  const julian_date: number = getJulianDate(date, Scale.GPS);
  expect(julian_date).toBeCloseTo(2451545.0, 5);
});

test('getDateFromJulianDate', () => {
  const date: Date = getDateFromJulianDate(2451545.0, Scale.GPS);
  expect(date.toISOString()).toBe('2000-01-01T12:00:00.000Z');
});

test('getMJD', () => {
  const date: Date = new Date('2000-01-01T12:00:00.000Z');
  const mjd = getMJD(date, Scale.GPS);
  expect(mjd).toBeCloseTo(51544.5, 5);
});

test('getDateFromMJD', () => {
  const date: Date = getDateFromMJD(51544.5, Scale.GPS);
  expect(date.toISOString()).toBe('2000-01-01T12:00:00.000Z');
});

test('getMJD2000', () => {
  const date: Date = new Date('2000-01-01T12:00:00.000Z');
  const mjd2000: number = getMJD2000(date, Scale.GPS);
  expect(mjd2000).toBeCloseTo(0, 5);
});

test('getDateFromMJD2000', () => {
  const date: Date = getDateFromMJD2000(0, Scale.GPS);
  expect(date.toISOString()).toBe('2000-01-01T12:00:00.000Z');
});

// UTC scale
test('getJulianDate', () => {
  const date: Date = new Date('2000-01-01T12:00:13.000Z');
  const julian_date: number = getJulianDate(date, Scale.UTC);
  expect(julian_date).toBeCloseTo(2451545.0, 5);
});

test('getDateFromJulianDate', () => {
  const date: Date = getDateFromJulianDate(2451545.0, Scale.UTC);
  expect(date.toISOString()).toBe('2000-01-01T12:00:13.000Z');
});

test('getMJD', () => {
  const date: Date = new Date('2000-01-01T12:00:13.000Z');
  const mjd = getMJD(date, Scale.UTC);
  expect(mjd).toBeCloseTo(51544.5, 5);
});

test('getDateFromMJD', () => {
  const date: Date = getDateFromMJD(51544.5, Scale.UTC);
  expect(date.toISOString()).toBe('2000-01-01T12:00:13.000Z');
});

test('getMJD2000', () => {
  const date: Date = new Date('2000-01-01T12:00:13.000Z');
  const mjd2000: number = getMJD2000(date, Scale.UTC);
  expect(mjd2000).toBeCloseTo(0, 5);
});

test('getDateFromMJD2000', () => {
  const date: Date = getDateFromMJD2000(0, Scale.UTC);
  expect(date.toISOString()).toBe('2000-01-01T12:00:13.000Z');
});
