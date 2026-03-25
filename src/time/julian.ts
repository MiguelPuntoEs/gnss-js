import {
  DAYS_MJD2000_MJD,
  DAYS_MJD_JULIAN,
  MILLISECONDS_GPS_TAI,
  MILLISECONDS_IN_DAY,
  MILLISECONDS_IN_SECOND,
  MILLISECONDS_TT_TAI,
  START_JULIAN_TAI,
  START_TAI_TIME,
} from '../constants/time';
import { Scale } from '../types/enums';
import { getDateFromTai } from './gnss';
import { getLeap } from './utc';

/**
 * Returns the Julian Date for a given Date and time scale.
 * @param date - Date in GPS time scale
 * @param scale - Time scale for the output (default: TT)
 * @returns Julian Date in fractional days
 */
export function getJulianDate(date: Date, scale: Scale = Scale.TT): number {
  if (scale === Scale.TAI) {
    return (
      (date.getTime() - START_TAI_TIME.getTime()) / MILLISECONDS_IN_DAY +
      START_JULIAN_TAI
    );
  }

  if (scale === Scale.GPS) {
    return (
      (date.getTime() - START_TAI_TIME.getTime() - MILLISECONDS_GPS_TAI) /
        MILLISECONDS_IN_DAY +
      START_JULIAN_TAI
    );
  }

  if (scale === Scale.UTC) {
    return (
      (date.getTime() -
        START_TAI_TIME.getTime() -
        getLeap(date) * MILLISECONDS_IN_SECOND) /
        MILLISECONDS_IN_DAY +
      START_JULIAN_TAI
    );
  }

  // Scale = TT
  return (
    (date.getTime() - START_TAI_TIME.getTime() + MILLISECONDS_TT_TAI) /
      MILLISECONDS_IN_DAY +
    START_JULIAN_TAI
  );
}

/**
 * Converts a Julian Date to a Date.
 * @param julianDate - Julian Date in fractional days
 * @param scale - Time scale of the input Julian Date (default: TT)
 * @returns Date in GPS time scale
 */
export function getDateFromJulianDate(
  julianDate: number,
  scale: Scale = Scale.TT
): Date {
  if (scale === Scale.TAI) {
    return new Date(
      (julianDate - START_JULIAN_TAI) * MILLISECONDS_IN_DAY +
        START_TAI_TIME.getTime()
    );
  }

  if (scale === Scale.GPS) {
    return new Date(
      (julianDate - START_JULIAN_TAI) * MILLISECONDS_IN_DAY +
        START_TAI_TIME.getTime() +
        MILLISECONDS_GPS_TAI
    );
  }

  if (scale === Scale.UTC) {
    const utc_date: Date = new Date(
      (julianDate - START_JULIAN_TAI) * MILLISECONDS_IN_DAY +
        START_TAI_TIME.getTime()
    );
    const tai_date: Date = new Date(
      utc_date.getTime() + getLeap(utc_date) * MILLISECONDS_IN_SECOND
    );
    const leap_seconds: number = getLeap(getDateFromTai(tai_date));

    return new Date(utc_date.getTime() + leap_seconds * MILLISECONDS_IN_SECOND);
  }

  // Scale = TT
  return new Date(
    (julianDate - START_JULIAN_TAI) * MILLISECONDS_IN_DAY +
      START_TAI_TIME.getTime() -
      MILLISECONDS_TT_TAI
  );
}

/**
 * Returns the Modified Julian Date for a given Date and time scale.
 * @param date - Date in GPS time scale
 * @param scale - Time scale for the output (default: TT)
 * @returns Modified Julian Date in fractional days
 */
export function getMJD(date: Date, scale: Scale = Scale.TT): number {
  return getJulianDate(date, scale) - DAYS_MJD_JULIAN;
}

/**
 * Converts a Modified Julian Date to a Date.
 * @param mjd - Modified Julian Date in fractional days
 * @param scale - Time scale of the input MJD (default: TT)
 * @returns Date in GPS time scale
 */
export function getDateFromMJD(mjd: number, scale: Scale = Scale.TT): Date {
  return getDateFromJulianDate(mjd + DAYS_MJD_JULIAN, scale);
}

/**
 * Returns the MJD2000 (Modified Julian Date referenced to J2000.0) for a given Date.
 * @param date - Date in GPS time scale
 * @param scale - Time scale for the output (default: TT)
 * @returns MJD2000 in fractional days
 */
export function getMJD2000(date: Date, scale: Scale = Scale.TT): number {
  return getMJD(date, scale) - DAYS_MJD2000_MJD;
}

/**
 * Converts an MJD2000 value to a Date.
 * @param mjd2000 - MJD2000 in fractional days
 * @param scale - Time scale of the input MJD2000 (default: TT)
 * @returns Date in GPS time scale
 */
export function getDateFromMJD2000(
  mjd2000: number,
  scale: Scale = Scale.TT
): Date {
  return getDateFromMJD(mjd2000 + DAYS_MJD2000_MJD, scale);
}
