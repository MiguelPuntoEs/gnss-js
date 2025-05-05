import {
  DAYS_MJD2000_MJD,
  DAYS_MJD_JULIAN,
  MILLISECONDS_IN_DAY,
  START_JULIAN_TAI,
  START_TAI_TIME,
} from '../constants/time';

export function getJulianDate(date: Date): number {
  return (
    (date.getTime() - START_TAI_TIME.getTime()) / MILLISECONDS_IN_DAY +
    START_JULIAN_TAI
  );
}

export function getDateFromJulianDate(julianDate: number): Date {
  return new Date(
    (julianDate - 2436204.5) * MILLISECONDS_IN_DAY + START_TAI_TIME.getTime()
  );
}

export function getMJD(date: Date): number {
  return getJulianDate(date) - DAYS_MJD_JULIAN;
}

export function getDateFromMJD(mjd: number): Date {
  return getDateFromJulianDate(mjd + DAYS_MJD_JULIAN);
}

export function getMJD2000(date: Date): number {
  return getMJD(date) - DAYS_MJD2000_MJD;
}

export function getDateFromMJD2000(mjd2000: number): Date {
  return getDateFromMJD(mjd2000 + DAYS_MJD2000_MJD);
}
