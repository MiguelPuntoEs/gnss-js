import {
  MILLISECONDS_IN_DAY,
  MILLISECONDS_IN_HOUR,
  MILLISECONDS_IN_MINUTE,
  MILLISECONDS_IN_SECOND,
} from '../constants/time';
import { TimeDifference } from '../types/time';

/**
 * Returns the time difference between two dates in milliseconds.
 * @param startDate - Start date
 * @param finalDate - End date
 * @returns Difference (finalDate - startDate) in milliseconds
 */
export function getTimeDifference(startDate: Date, finalDate: Date): number {
  return Math.floor(finalDate.getTime() - startDate.getTime());
}

/**
 * Extracts the seconds component (0-59) from a time difference.
 * @param timeDifference - Time difference in milliseconds
 * @returns Seconds component (0-59)
 */
export function getSecondsFromTimeDifference(timeDifference: number): number {
  return Math.floor(
    (timeDifference % MILLISECONDS_IN_MINUTE) / MILLISECONDS_IN_SECOND
  );
}

/**
 * Extracts the minutes component (0-59) from a time difference.
 * @param timeDifference - Time difference in milliseconds
 * @returns Minutes component (0-59)
 */
export function getMinutesFromTimeDifference(timeDifference: number): number {
  return Math.floor(
    (timeDifference % MILLISECONDS_IN_HOUR) / MILLISECONDS_IN_MINUTE
  );
}

/**
 * Extracts the hours component (0-23) from a time difference.
 * @param timeDifference - Time difference in milliseconds
 * @returns Hours component (0-23)
 */
export function getHoursFromTimeDifference(timeDifference: number): number {
  return Math.floor(
    (timeDifference % MILLISECONDS_IN_DAY) / MILLISECONDS_IN_HOUR
  );
}

/**
 * Returns the total number of whole days in a time difference.
 * @param timeDifference - Time difference in milliseconds
 * @returns Total whole days
 */
export function getTotalDaysFromTimeDifference(timeDifference: number): number {
  return Math.floor(timeDifference / MILLISECONDS_IN_DAY);
}

/**
 * Converts seconds to a time difference in milliseconds.
 * @param seconds - Duration in seconds
 * @returns Time difference in milliseconds
 */
export function getTimeDifferenceFromSeconds(seconds: number): number {
  return seconds * MILLISECONDS_IN_SECOND;
}
/**
 * Converts minutes to a time difference in milliseconds.
 * @param minutes - Duration in minutes
 * @returns Time difference in milliseconds
 */
export function getTimeDifferenceFromMinutes(minutes: number): number {
  return minutes * MILLISECONDS_IN_MINUTE;
}
/**
 * Converts hours to a time difference in milliseconds.
 * @param hours - Duration in hours
 * @returns Time difference in milliseconds
 */
export function getTimeDifferenceFromHours(hours: number): number {
  return hours * MILLISECONDS_IN_HOUR;
}
/**
 * Converts days to a time difference in milliseconds.
 * @param days - Duration in days
 * @returns Time difference in milliseconds
 */
export function getTimeDifferenceFromDays(days: number): number {
  return days * MILLISECONDS_IN_DAY;
}

/**
 * Converts a TimeDifference object (days, hours, minutes, seconds) to milliseconds.
 * @param timeDifferenceObject - Object with days, hours, minutes, and seconds fields
 * @returns Time difference in milliseconds
 */
export function getTimeDifferenceFromObject(
  timeDifferenceObject: TimeDifference
): number {
  const { seconds, minutes, hours, days }: TimeDifference =
    timeDifferenceObject;

  return (
    getTimeDifferenceFromSeconds(seconds) +
    getTimeDifferenceFromMinutes(minutes) +
    getTimeDifferenceFromHours(hours) +
    getTimeDifferenceFromDays(days)
  );
}
