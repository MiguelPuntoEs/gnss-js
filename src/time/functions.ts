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
 */
export function getDateFromDayOfYear(dayOfYear: number, date: Date): Date {
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
  if (dayOfWeek < 0 || dayOfWeek > 6)
    throw new Error('Day of week must be a value between 0 and 7');

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
  // ISO week
  const target: Date = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  );

  // Set to nearest Thursday: current date + 4 - current day number
  // (Monday is 1, Sunday is 7 for ISO)
  const dayNr = (target.getUTCDay() + 6) % 7; // 0=Monday, ..., 6=Sunday
  target.setUTCDate(target.getUTCDate() - dayNr + 3);

  // First Thursday of the year
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const dayDiff = (target.getTime() - firstThursday.getTime()) / (86400 * 1000); // days since Jan 4
  return 1 + Math.floor(dayDiff / 7) + 1;
}
