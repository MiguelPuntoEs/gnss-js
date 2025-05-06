import { MILLISECONDS_IN_SECOND } from '../constants/time';
import { getDateFromTai, getNtpTime, getTaiDate } from './gnss';

export function getLeap(date: Date): number {
  // Date in GPS time, leap seconds are for TAI

  const ntp_time: number = getNtpTime(date);

  const leapSecondsMap: { [key: number]: number } = {
    2272060800: 10, // 1 Jan 1972
    2287785600: 11, // 1 Jul 1972
    2303683200: 12, // 1 Jan 1973
    2335219200: 13, // 1 Jan 1974
    2366755200: 14, // 1 Jan 1975
    2398291200: 15, // 1 Jan 1976
    2429913600: 16, // 1 Jan 1977
    2461449600: 17, // 1 Jan 1978
    2492985600: 18, // 1 Jan 1979
    2524521600: 19, // 1 Jan 1980
    2571782400: 20, // 1 Jul 1981
    2603318400: 21, // 1 Jul 1982
    2634854400: 22, // 1 Jul 1983
    2698012800: 23, // 1 Jul 1985
    2776982400: 24, // 1 Jan 1988
    2840140800: 25, // 1 Jan 1990
    2871676800: 26, // 1 Jan 1991
    2918937600: 27, // 1 Jul 1992
    2950473600: 28, // 1 Jul 1993
    2982009600: 29, // 1 Jul 1994
    3029443200: 30, // 1 Jan 1996
    3076704000: 31, // 1 Jul 1997
    3124137600: 32, // 1 Jan 1999
    3345062400: 33, // 1 Jan 2006
    3439756800: 34, // 1 Jan 2009
    3550089600: 35, // 1 Jul 2012
    3644697600: 36, // 1 Jul 2015
    3692217600: 37, // 1 Jan 2017
  };

  for (const [timestamp, leapSeconds] of Object.entries(
    leapSecondsMap
  ).reverse()) {
    if (ntp_time / MILLISECONDS_IN_SECOND - leapSeconds >= Number(timestamp)) {
      return leapSeconds;
    }
  }

  return 8;
}

export function getGpsLeap(date: Date): number {
  // Input date in GPS time, leap seconds for GPS time
  const leap_seconds: number = getLeap(date);

  if (leap_seconds < 0) return 0;

  return leap_seconds - 19;
}

export function getUtcDate(date: Date): Date {
  // Input date in GPS time

  const tai_date: Date = getTaiDate(date);
  const leap_seconds: number = getLeap(date);

  return new Date(tai_date.getTime() - leap_seconds * MILLISECONDS_IN_SECOND);
}

export function getDateFromUtc(utc_date: Date): Date {
  // Input date in UTC time

  const tai_date: Date = new Date(
    utc_date.getTime() + getLeap(utc_date) * MILLISECONDS_IN_SECOND
  );
  const leap_seconds: number = getLeap(getDateFromTai(tai_date));
  const gps_date: Date = getDateFromTai(
    new Date(utc_date.getTime() + leap_seconds * MILLISECONDS_IN_SECOND)
  );

  return gps_date;
}
