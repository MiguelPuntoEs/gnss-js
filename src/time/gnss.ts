import {
  MILLISECONDS_GPS_TAI,
  MILLISECONDS_IN_DAY,
  MILLISECONDS_IN_WEEK,
  MILLISECONDS_TT_TAI,
  START_BDS_TIME,
  START_GAL_TIME,
  START_GLO_LEAP,
  START_GPS_TIME,
  START_NTP_TIME,
} from '../constants/time';
import { getTimeDifference } from './time-difference';
import { getDateFromUtc, getUtcDate } from './utc';

/**
 * Returns GPS time elapsed since the GPS epoch (6 Jan 1980) in milliseconds.
 * @param date - Date in GPS time scale
 * @returns GPS time in milliseconds
 */
export function getGpsTime(date: Date): number {
  return date.getTime() - START_GPS_TIME.getTime();
}

/**
 * Converts GPS time to a Date.
 * @param gpsTime - GPS time in milliseconds since GPS epoch
 * @returns Date in GPS time scale
 */
export function getDateFromGpsTime(gpsTime: number): Date {
  return new Date(gpsTime + START_GPS_TIME.getTime());
}

/**
 * Returns Galileo time elapsed since the Galileo epoch in milliseconds.
 * @param date - Date in GPS time scale
 * @returns Galileo time in milliseconds
 */
export function getGalTime(date: Date): number {
  return date.getTime() - START_GAL_TIME.getTime();
}

/**
 * Converts Galileo time to a Date.
 * @param galTime - Galileo time in milliseconds since Galileo epoch
 * @returns Date in GPS time scale
 */
export function getDateFromGalTime(galTime: number): Date {
  return new Date(galTime + START_GAL_TIME.getTime());
}

/**
 * Returns BeiDou time elapsed since the BDS epoch in milliseconds.
 * @param date - Date in GPS time scale
 * @returns BeiDou time in milliseconds
 */
export function getBdsTime(date: Date): number {
  return date.getTime() - START_BDS_TIME.getTime();
}

/**
 * Converts BeiDou time to a Date.
 * @param bdsTime - BeiDou time in milliseconds since BDS epoch
 * @returns Date in GPS time scale
 */
export function getDateFromBdsTime(bdsTime: number): Date {
  return new Date(bdsTime + START_BDS_TIME.getTime());
}

/**
 * Converts a GPS-scale date to Unix time in milliseconds (applies leap seconds).
 * @param date - Date in GPS time scale
 * @returns Unix time in milliseconds
 */
export function getUnixTime(date: Date): number {
  const utc_date: Date = getUtcDate(date);
  return utc_date.getTime();
}

/**
 * Converts Unix time to a GPS-scale Date (applies leap seconds).
 * @param unixTime - Unix time in milliseconds
 * @returns Date in GPS time scale
 */
export function getDateFromUnixTime(unixTime: number): Date {
  return getDateFromUtc(new Date(unixTime));
}

/**
 * Returns the GPS week number.
 * @param date - Date in GPS time scale
 * @returns GPS week number (continuous, not rolled over)
 */
export function getWeekNumber(date: Date): number {
  return Math.floor(getGpsTime(date) / MILLISECONDS_IN_WEEK);
}

/** Returns GPS time-of-week in milliseconds. */
export function getTimeOfWeek(date: Date): number {
  return getGpsTime(date) % MILLISECONDS_IN_WEEK;
}

/** Reconstruct a Date from GPS week number and time-of-week in milliseconds. */
export function getDateFromGpsData(
  weekNumber: number,
  timeOfWeek: number
): Date {
  return new Date(
    weekNumber * MILLISECONDS_IN_WEEK + timeOfWeek + START_GPS_TIME.getTime()
  );
}

/**
 * Converts a GPS-scale Date to TAI scale.
 * @param date - Date in GPS time scale
 * @returns Date in TAI time scale
 */
export function getTaiDate(date: Date): Date {
  return new Date(date.getTime() + MILLISECONDS_GPS_TAI);
}

/**
 * Converts a TAI-scale Date to GPS scale.
 * @param tai_date - Date in TAI time scale
 * @returns Date in GPS time scale
 */
export function getDateFromTai(tai_date: Date): Date {
  return new Date(tai_date.getTime() - MILLISECONDS_GPS_TAI);
}

/**
 * Converts a GPS-scale Date to TT (Terrestrial Time) scale.
 * @param date - Date in GPS time scale
 * @returns Date in TT time scale
 */
export function getTtDate(date: Date): Date {
  return new Date(date.getTime() + MILLISECONDS_GPS_TAI + MILLISECONDS_TT_TAI);
}

/**
 * Converts a TT-scale Date to GPS scale.
 * @param tt_date - Date in TT time scale
 * @returns Date in GPS time scale
 */
export function getDateFromTt(tt_date: Date): Date {
  return new Date(
    tt_date.getTime() - MILLISECONDS_GPS_TAI - MILLISECONDS_TT_TAI
  );
}

/**
 * Returns the GLONASS four-year interval number (N4) since 1996.
 * @param date - Date in GPS time scale
 * @returns GLONASS N4 period number (0-based)
 */
export function getGloN4(date: Date): number {
  return Math.floor((date.getUTCFullYear() - START_GLO_LEAP.getFullYear()) / 4);
}

/**
 * Returns the GLONASS day number (NA) within the current four-year interval.
 * @param date - Date in GPS time scale
 * @returns Day number within the N4 period (1-based)
 */
export function getGloNA(date: Date): number {
  const n4 = getGloN4(date);

  const init4YearPeriod = new Date(START_GLO_LEAP);
  init4YearPeriod.setUTCFullYear(init4YearPeriod.getUTCFullYear() + n4 * 4);

  return (
    Math.floor(getTimeDifference(init4YearPeriod, date) / MILLISECONDS_IN_DAY) +
    1
  );
}

/** Reconstruct a Date from GLONASS N4 (4-year period), NA (day number), and time-of-day in milliseconds. */
export function getDateFromGloN(n4: number, na: number, tod: number): Date {
  const date = new Date(START_GLO_LEAP);
  date.setFullYear(date.getUTCFullYear() + n4 * 4);
  date.setTime(date.getTime() + (na - 1) * MILLISECONDS_IN_DAY + tod);

  return date;
}

/**
 * Converts a GPS-scale Date to NTP time in milliseconds since the NTP epoch.
 * @param date - Date in GPS time scale
 * @returns NTP time in milliseconds
 */
export function getNtpTime(date: Date): number {
  return getTaiDate(date).getTime() - START_NTP_TIME.getTime();
}
