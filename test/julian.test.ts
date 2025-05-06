import {
  getJulianDate,
  getDateFromJulianDate,
  getMJD,
  getDateFromMJD,
  getMJD2000,
  getDateFromMJD2000,
} from '../src/index';

test('getJulianDate', () => {
  const date: Date = new Date('2024-01-01T00:00:00Z');
  const julian_date: number = getJulianDate(date);
  expect(julian_date).toBeCloseTo(2460310.5002199076, 5);
});

test('getDateFromJulianDate', () => {
  const date: Date = getDateFromJulianDate(2460310.5002199076);
  expect(date.toISOString()).toBe('2024-01-01T00:00:00.000Z');
});

test('getMJD', () => {
  const date: Date = new Date('2024-01-01T00:00:00Z');
  const mjd = getMJD(date);
  expect(mjd).toBeCloseTo(60310.00021990741, 5);
});

test('getDateFromMJD', () => {
  const date: Date = getDateFromMJD(60310.00021990761);
  expect(date.toISOString()).toBe('2024-01-01T00:00:00.000Z');
});

test('getMJD2000', () => {
  const date: Date = new Date('2024-01-01T00:00:00Z');
  const mjd: number = getMJD2000(date);
  expect(mjd).toBeCloseTo(8765.500219907612, 5);
});

test('getDateFromMJD2000', () => {
  const date: Date = getDateFromMJD2000(8765.500219907612);
  expect(date.toISOString()).toBe('2024-01-01T00:00:00.000Z');
});
