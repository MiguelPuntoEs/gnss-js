import {
  RINEX_CODES,
  MILLISECONDS_IN_DAY,
  MILLISECONDS_IN_SECOND,
} from '../constants/time';
import { HourCode } from '../types/time';

export function getTimeOfDay(date: Date): number {
  return (
    (date.getTime() -
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        0,
        0,
        0
      )) /
    MILLISECONDS_IN_SECOND
  );
}

export function getDateFromTimeOfDay(timeOfDay: number, dateRaw: Date): Date {
  const date = new Date(
    Date.UTC(
      dateRaw.getUTCFullYear(),
      dateRaw.getUTCMonth(),
      dateRaw.getUTCDate(),
      0,
      0,
      0
    ) +
      timeOfDay * MILLISECONDS_IN_SECOND
  );

  return date;
}

export function getDayOfYear(date: Date): number {
  return (
    Math.floor(
      (date.getTime() - Date.UTC(date.getUTCFullYear())) / MILLISECONDS_IN_DAY
    ) + 1
  );
}

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

export function getDayOfWeek(date: Date): number {
  return date.getUTCDay();
}

export function getDateFromDayOfWeek(dayOfWeek: number, dateRaw: Date): Date {
  if (dayOfWeek < 0 || dayOfWeek > 6)
    throw new Error('Day of week must be a value between 0 and 7');

  return new Date(
    dateRaw.getTime() + (dayOfWeek - dateRaw.getUTCDay()) * MILLISECONDS_IN_DAY
  );
}

export function getDateFromHourCode(hourCode: HourCode, date: Date): Date {
  const hour = RINEX_CODES.indexOf(hourCode);
  if (hour === -1)
    throw new Error('Hour code must be a lowercase letter between a and x');

  const newDate = new Date(date.getTime());
  newDate.setUTCHours(hour);
  return newDate;
}

export function getHourCode(date: Date): HourCode {
  return RINEX_CODES[date.getUTCHours()];
}

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
