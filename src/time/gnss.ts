import {
  MILLISECONDS_GPS_TAI,
  MILLISECONDS_IN_DAY,
  MILLISECONDS_IN_SECOND,
  MILLISECONDS_IN_WEEK,
  MILLISECONDS_TT_TAI,
  START_BDS_TIME,
  START_GAL_TIME,
  START_GLO_LEAP,
  START_GPS_TIME,
  START_NTP_TIME,
  START_UNIX_TIME,
} from '../constants/time';
import { getTimeDifference } from './time-difference';
import { getDateFromUtc, getUtcDate } from './utc';

export function getGpsTime(date: Date): number {
  return date.getTime() - START_GPS_TIME.getTime();
}

export function getDateFromGpsTime(gpsTime: number): Date {
  return new Date(gpsTime + START_GPS_TIME.getTime());
}

export function getGalTime(date: Date): number {
  return date.getTime() - START_GAL_TIME.getTime();
}

export function getDateFromGalTime(galTime: number): Date {
  return new Date(galTime + START_GAL_TIME.getTime());
}

export function getBdsTime(date: Date): number {
  return date.getTime() - START_BDS_TIME.getTime();
}

export function getDateFromBdsTime(bdsTime: number): Date {
  return new Date(bdsTime + START_BDS_TIME.getTime());
}

export function getUnixTime(date: Date): number {
  // Input date in GPS time
  const utc_date: Date = getUtcDate(date);
  return utc_date.getTime();
}

export function getDateFromUnixTime(unixTime: number): Date {
  return getDateFromUtc(new Date(unixTime));
}

export function getWeekNumber(date: Date): number {
  return Math.floor(getGpsTime(date) / MILLISECONDS_IN_WEEK);
}

export function getTimeOfWeek(date: Date): number {
  return (getGpsTime(date) % MILLISECONDS_IN_WEEK) / MILLISECONDS_IN_SECOND;
}

export function getDateFromGpsData(
  weekNumber: number,
  timeOfWeek: number
): Date {
  return new Date(
    weekNumber * MILLISECONDS_IN_WEEK +
      timeOfWeek * MILLISECONDS_IN_SECOND +
      START_GPS_TIME.getTime()
  );
}

export function getTaiDate(date: Date): Date {
  return new Date(date.getTime() + MILLISECONDS_GPS_TAI);
}

export function getDateFromTai(tai_date: Date): Date {
  return new Date(tai_date.getTime() - MILLISECONDS_GPS_TAI);
}

export function getTtDate(date: Date): Date {
  return new Date(date.getTime() + MILLISECONDS_GPS_TAI + MILLISECONDS_TT_TAI);
}

export function getDateFromTt(tt_date: Date): Date {
  return new Date(
    tt_date.getTime() - MILLISECONDS_GPS_TAI - MILLISECONDS_TT_TAI
  );
}

export function getGloN4(date: Date): number {
  return Math.floor((date.getUTCFullYear() - START_GLO_LEAP.getFullYear()) / 4);
}

export function getGloNA(date: Date): number {
  const n4 = getGloN4(date);

  const init4YearPeriod = new Date(START_GLO_LEAP);
  init4YearPeriod.setUTCFullYear(init4YearPeriod.getUTCFullYear() + n4 * 4);

  return (
    Math.floor(getTimeDifference(init4YearPeriod, date) / MILLISECONDS_IN_DAY) +
    1
  );
}

export function getDateFromGloN(n4: number, na: number, tod: number): Date {
  const date = new Date(START_GLO_LEAP);
  date.setFullYear(date.getUTCFullYear() + n4 * 4);
  date.setTime(
    date.getTime() +
      (na - 1) * MILLISECONDS_IN_DAY +
      tod * MILLISECONDS_IN_SECOND
  );

  return date;
}

export function getNtpTime(date: Date): number {
  // Input date in GPS time
  return getTaiDate(date).getTime() - START_NTP_TIME.getTime();
}
