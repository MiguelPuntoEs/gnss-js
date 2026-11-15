import {
  DAYS_MJD2000_MJD,
  DAYS_MJD_JULIAN,
  MILLISECONDS_GPS_TAI,
  MILLISECONDS_IN_DAY,
  MILLISECONDS_TT_TAI,
  START_JULIAN_TAI,
  START_TAI_TIME,
} from '../constants/time';
import { Scale } from '../types/enums';
import { getDateFromUtc, getUtcDate } from './utc';

/** Julian Date of 1970-01-01T00:00:00 (the Unix epoch). */
const JULIAN_UNIX_EPOCH = 2440587.5;

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
    return getUtcDate(date).getTime() / MILLISECONDS_IN_DAY + JULIAN_UNIX_EPOCH;
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
  // Round to the millisecond: a JD near 2.46e6 carries ~40 µs of float
  // noise, and new Date() would truncate it to the millisecond below.
  if (scale === Scale.UTC) {
    return getDateFromUtc(
      new Date(
        Math.round((julianDate - JULIAN_UNIX_EPOCH) * MILLISECONDS_IN_DAY)
      )
    );
  }

  // TAI clock face, then shifted to GPS (TAI − 19 s) or from TT (TAI + 32.184 s)
  const shiftMs =
    scale === Scale.TAI
      ? 0
      : scale === Scale.GPS
        ? MILLISECONDS_GPS_TAI
        : -MILLISECONDS_TT_TAI;
  return new Date(
    Math.round(
      (julianDate - START_JULIAN_TAI) * MILLISECONDS_IN_DAY +
        START_TAI_TIME.getTime() +
        shiftMs
    )
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
