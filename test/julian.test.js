const {
  getJulianDate,
  getDateFromJulianDate,
  getMJD,
  getDateFromMJD,
  getMJD2000,
  getDateFromMJD2000,
} = require('../src/index');

test('getJulianDate', () => {
  date = new Date('2024-01-01T00:00:00Z');
  const julian_date = getJulianDate(date);
  expect(julian_date).toBeCloseTo(2460310.5002199076, 5);
});

test('getDateFromJulianDate', () => {
  date = getDateFromJulianDate(2460310.5002199076);
  expect(date.toISOString()).toBe('2024-01-01T00:00:00.000Z');
});

test('getMJD', () => {
  date = new Date('2024-01-01T00:00:00Z');
  const mjd = getMJD(date);
  expect(mjd).toBeCloseTo(60310.00021990741, 5);
});

test('getDateFromMJD', () => {
  date = getDateFromMJD(60310.00021990761);
  expect(date.toISOString()).toBe('2024-01-01T00:00:00.000Z');
});

test('getMJD2000', () => {
  date = new Date('2024-01-01T00:00:00Z');
  const mjd = getMJD2000(date);
  expect(mjd).toBeCloseTo(8765.500219907612, 5);
});

test('getDateFromMJD2000', () => {
  date = getDateFromMJD2000(8765.500219907612);
  expect(date.toISOString()).toBe('2024-01-01T00:00:00.000Z');
});
