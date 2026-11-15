import { RINEX_CODES, MILLISECONDS_IN_DAY } from '../constants/time';
import { HourCode } from '../types/time';

/** Returns milliseconds elapsed since the start of the UTC day. */
export function getTimeOfDay(date: Date): number {
  return (
    date.getTime() -
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      0,
      0,
      0
    )
  );
}

/** Reconstruct a Date from time-of-day in milliseconds and a reference date. */
export function getDateFromTimeOfDay(timeOfDay: number, dateRaw: Date): Date {
  return new Date(
    Date.UTC(
      dateRaw.getUTCFullYear(),
      dateRaw.getUTCMonth(),
      dateRaw.getUTCDate(),
      0,
      0,
      0
    ) + timeOfDay
  );
}

/**
 * Returns the day-of-year (1-366) for a given date.
 * @param date - Date in GPS time scale
 * @returns Day-of-year number (1-based)
 */
export function getDayOfYear(date: Date): number {
  return (
    Math.floor(
      (date.getTime() - Date.UTC(date.getUTCFullYear())) / MILLISECONDS_IN_DAY
    ) + 1
  );
}

/**
 * Reconstructs a Date from a day-of-year and a reference date (preserves time-of-day).
 * @param dayOfYear - Day-of-year number (1-based)
 * @param date - Reference date in GPS time scale (year and time-of-day are used)
 * @returns Date in GPS time scale
 * @throws RangeError when dayOfYear is not a day of the reference year
 */
export function getDateFromDayOfYear(dayOfYear: number, date: Date): Date {
  const year = date.getUTCFullYear();
  const daysInYear =
    (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / MILLISECONDS_IN_DAY;
  if (!Number.isInteger(dayOfYear) || dayOfYear < 1 || dayOfYear > daysInYear)
    throw new RangeError(
      `Day of year must be an integer between 1 and ${daysInYear}`
    );
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      0,
      1,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds()
    ) +
      (dayOfYear - 1) * MILLISECONDS_IN_DAY
  );
}

/**
 * Returns the UTC day of the week (0 = Sunday, 6 = Saturday).
 * @param date - Date in GPS time scale
 * @returns Day of week (0-6)
 */
export function getDayOfWeek(date: Date): number {
  return date.getUTCDay();
}

/**
 * Reconstructs a Date by shifting a reference date to the given day of the week.
 * @param dayOfWeek - Day of week (0 = Sunday, 6 = Saturday)
 * @param dateRaw - Reference date in GPS time scale
 * @returns Date in GPS time scale
 */
export function getDateFromDayOfWeek(dayOfWeek: number, dateRaw: Date): Date {
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6)
    throw new RangeError('Day of week must be an integer between 0 and 6');

  return new Date(
    dateRaw.getTime() + (dayOfWeek - dateRaw.getUTCDay()) * MILLISECONDS_IN_DAY
  );
}

/**
 * Reconstructs a Date by setting the hour from a RINEX hour code ('a'-'x').
 * @param hourCode - RINEX hour code letter ('a' = 00h, 'x' = 23h)
 * @param date - Reference date in GPS time scale
 * @returns Date in GPS time scale with the specified hour
 */
export function getDateFromHourCode(hourCode: HourCode, date: Date): Date {
  const hour = RINEX_CODES.indexOf(hourCode);
  if (hour === -1)
    throw new Error('Hour code must be a lowercase letter between a and x');

  const newDate = new Date(date.getTime());
  newDate.setUTCHours(hour);
  return newDate;
}

/**
 * Returns the RINEX hour code ('a'-'x') for a given date.
 * @param date - Date in GPS time scale
 * @returns RINEX hour code letter ('a' = 00h, 'x' = 23h)
 */
export function getHourCode(date: Date): HourCode {
  return RINEX_CODES[date.getUTCHours()];
}

/**
 * Returns the ISO 8601 week number of the year (1-53).
 * @param date - Date in GPS time scale
 * @returns ISO week number
 */
export function getWeekOfYear(date: Date): number {
  // ISO week of the calendar date held in the UTC fields
  const target: Date = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );

  // Move to the Thursday of the same ISO week (Monday-first): its calendar
  // year is the ISO week-year, and its ordinal day fixes the week number
  const dayNr = (target.getUTCDay() + 6) % 7; // 0=Monday, ..., 6=Sunday
  target.setUTCDate(target.getUTCDate() - dayNr + 3);

  const yearStart = Date.UTC(target.getUTCFullYear(), 0, 1);
  const dayOfYear = (target.getTime() - yearStart) / MILLISECONDS_IN_DAY; // 0-based
  return Math.floor(dayOfYear / 7) + 1;
}
