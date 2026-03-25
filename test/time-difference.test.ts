import {
  getTimeDifference,
  getSecondsFromTimeDifference,
  getMinutesFromTimeDifference,
  getHoursFromTimeDifference,
  getTotalDaysFromTimeDifference,
  getTimeDifferenceFromSeconds,
  getTimeDifferenceFromMinutes,
  getTimeDifferenceFromHours,
  getTimeDifferenceFromDays,
  getTimeDifferenceFromObject,
} from '../src/index';

test('getTimeDifference', () => {
  const start = new Date('2006-01-01T00:00:00Z');
  const end = new Date('2006-01-02T03:25:45Z');
  // 1 day + 3h + 25m + 45s = 98745000 ms
  expect(getTimeDifference(start, end)).toBe(98745000);
});

test('getSecondsFromTimeDifference', () => {
  // 98745000 ms = 1d 3h 25m 45s → seconds component = 45
  expect(getSecondsFromTimeDifference(98745000)).toBe(45);
});

test('getMinutesFromTimeDifference', () => {
  // 98745000 ms = 1d 3h 25m 45s → minutes component = 25
  expect(getMinutesFromTimeDifference(98745000)).toBe(25);
});

test('getHoursFromTimeDifference', () => {
  // 98745000 ms = 1d 3h 25m 45s → hours component = 3
  expect(getHoursFromTimeDifference(98745000)).toBe(3);
});

test('getTotalDaysFromTimeDifference', () => {
  // 98745000 ms = 1d 3h 25m 45s → days = 1
  expect(getTotalDaysFromTimeDifference(98745000)).toBe(1);
});

test('getTimeDifferenceFromSeconds', () => {
  expect(getTimeDifferenceFromSeconds(45)).toBe(45000);
});

test('getTimeDifferenceFromMinutes', () => {
  expect(getTimeDifferenceFromMinutes(25)).toBe(1500000);
});

test('getTimeDifferenceFromHours', () => {
  expect(getTimeDifferenceFromHours(3)).toBe(10800000);
});

test('getTimeDifferenceFromDays', () => {
  expect(getTimeDifferenceFromDays(1)).toBe(86400000);
});

test('getTimeDifferenceFromObject', () => {
  const result = getTimeDifferenceFromObject({
    seconds: 45,
    minutes: 25,
    hours: 3,
    days: 1,
  });
  expect(result).toBe(98745000);
});
