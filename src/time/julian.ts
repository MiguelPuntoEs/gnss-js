import {
  DAYS_MJD2000_MJD,
  DAYS_MJD_JULIAN,
  MILLISECONDS_IN_DAY,
  MILLISECONDS_TT_TAI,
  START_JULIAN_TAI,
  START_TAI_TIME,
} from '../constants/time';
import { Scale } from '../types/enums';

export function getJulianDate(date: Date, scale: Scale = Scale.TT): number {
  if (scale === Scale.TAI) {
    return (
      (date.getTime() - START_TAI_TIME.getTime()) / MILLISECONDS_IN_DAY +
      START_JULIAN_TAI 
    );
  }

  // Scale = TT
  return (
    (date.getTime() - START_TAI_TIME.getTime() + MILLISECONDS_TT_TAI) / MILLISECONDS_IN_DAY +
    START_JULIAN_TAI 
  );
}

export function getDateFromJulianDate(julianDate: number, scale: Scale = Scale.TT): Date {
  if (scale === Scale.TAI) {
      return new Date(
        (julianDate - START_JULIAN_TAI) * MILLISECONDS_IN_DAY + START_TAI_TIME.getTime()
      );

  }

  // Scale = TT
  return new Date(
    (julianDate - START_JULIAN_TAI) * MILLISECONDS_IN_DAY + START_TAI_TIME.getTime() - MILLISECONDS_TT_TAI
  );
}

export function getMJD(date: Date, scale: Scale = Scale.TT): number {
  return getJulianDate(date, scale) - DAYS_MJD_JULIAN;
}

export function getDateFromMJD(mjd: number, scale: Scale = Scale.TT): Date {
  return getDateFromJulianDate(mjd + DAYS_MJD_JULIAN, scale);
}

export function getMJD2000(date: Date, scale: Scale = Scale.TT): number {
  return getMJD(date, scale) - DAYS_MJD2000_MJD;
}

export function getDateFromMJD2000(mjd2000: number, scale: Scale = Scale.TT): Date {
  return getDateFromMJD(mjd2000 + DAYS_MJD2000_MJD, scale);
}
