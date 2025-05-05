import {
  MILLISECONDS_IN_DAY,
  MILLISECONDS_IN_HOUR,
  MILLISECONDS_IN_MINUTE,
  MILLISECONDS_IN_SECOND,
} from '../constants/time';
import { TimeDifference } from '../types/time';

export function getTimeDifference(startDate: Date, finalDate: Date): number {
  return Math.floor(finalDate.getTime() - startDate.getTime());
}

export function getSecondsFromTimeDifference(timeDifference: number): number {
  return Math.floor(
    (timeDifference % MILLISECONDS_IN_MINUTE) / MILLISECONDS_IN_SECOND
  );
}

export function getMinutesFromTimeDifference(timeDifference: number): number {
  return Math.floor(
    (timeDifference % MILLISECONDS_IN_HOUR) / MILLISECONDS_IN_MINUTE
  );
}

export function getHoursFromTimeDifference(timeDifference: number): number {
  return Math.floor(
    (timeDifference % MILLISECONDS_IN_DAY) / MILLISECONDS_IN_HOUR
  );
}

export function getTotalDaysFromTimeDifference(timeDifference: number): number {
  return Math.floor(timeDifference / MILLISECONDS_IN_DAY);
}

export function getTimeDifferenceFromSeconds(seconds: number): number {
  return seconds * MILLISECONDS_IN_SECOND;
}
export function getTimeDifferenceFromMinutes(minutes: number): number {
  return minutes * MILLISECONDS_IN_MINUTE;
}
export function getTimeDifferenceFromHours(hours: number): number {
  return hours * MILLISECONDS_IN_HOUR;
}
export function getTimeDifferenceFromDays(days: number): number {
  return days * MILLISECONDS_IN_DAY;
}

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
