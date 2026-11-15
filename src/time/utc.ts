import {
  MILLISECONDS_GPS_TAI,
  MILLISECONDS_IN_SECOND,
} from '../constants/time';

// Leap second table: [NTP timestamp, TAI-UTC leap seconds]
// Sorted descending for reverse lookup. NTP timestamps from IETF leap-seconds.list.
// Checked against leap-seconds.list (expires 2027-06-28) and IERS Bulletin C 72
// (July 2026: no leap second at the end of December 2026).
const LEAP_SECONDS_TABLE: [number, number][] = [
  [3692217600, 37], // 1 Jan 2017
  [3644697600, 36], // 1 Jul 2015
  [3550089600, 35], // 1 Jul 2012
  [3439756800, 34], // 1 Jan 2009
  [3345062400, 33], // 1 Jan 2006
  [3124137600, 32], // 1 Jan 1999
  [3076704000, 31], // 1 Jul 1997
  [3029443200, 30], // 1 Jan 1996
  [2982009600, 29], // 1 Jul 1994
  [2950473600, 28], // 1 Jul 1993
  [2918937600, 27], // 1 Jul 1992
  [2871676800, 26], // 1 Jan 1991
  [2840140800, 25], // 1 Jan 1990
  [2776982400, 24], // 1 Jan 1988
  [2698012800, 23], // 1 Jul 1985
  [2634854400, 22], // 1 Jul 1983
  [2603318400, 21], // 1 Jul 1982
  [2571782400, 20], // 1 Jul 1981
  [2524521600, 19], // 1 Jan 1980
  [2492985600, 18], // 1 Jan 1979
  [2461449600, 17], // 1 Jan 1978
  [2429913600, 16], // 1 Jan 1977
  [2398291200, 15], // 1 Jan 1976
  [2366755200, 14], // 1 Jan 1975
  [2335219200, 13], // 1 Jan 1974
  [2303683200, 12], // 1 Jan 1973
  [2287785600, 11], // 1 Jul 1972
  [2272060800, 10], // 1 Jan 1972
];

/** Seconds from the NTP epoch (1900-01-01) to the Unix epoch (1970-01-01). */
const NTP_UNIX_OFFSET_S = 2208988800;

/** TAI−UTC in force at a UTC clock-face instant (ms since 1970, leap seconds not counted). */
function leapAtUtcMs(utcMs: number): number {
  const utcNtpSeconds = utcMs / MILLISECONDS_IN_SECOND + NTP_UNIX_OFFSET_S;
  for (const [timestamp, leapSeconds] of LEAP_SECONDS_TABLE) {
    if (utcNtpSeconds >= timestamp) return leapSeconds;
  }
  return 8;
}

/**
 * Returns the TAI-UTC leap seconds count for a given date.
 *
 * Before 1972 UTC was not an integer offset from TAI (it drifted by
 * fractions of a second); 8 s (its value at the Unix epoch) is returned for
 * those dates, so conversions before 1972 are approximate.
 * During an inserted leap second (23:59:60 UTC) the previous count applies.
 * @param date - Date in GPS time scale
 * @returns Number of TAI-UTC leap seconds
 */
export function getLeap(date: Date): number {
  const taiMs = date.getTime() + MILLISECONDS_GPS_TAI;
  for (const [timestamp, leapSeconds] of LEAP_SECONDS_TABLE) {
    const changeUtcMs =
      (timestamp - NTP_UNIX_OFFSET_S) * MILLISECONDS_IN_SECOND;
    if (taiMs - leapSeconds * MILLISECONDS_IN_SECOND >= changeUtcMs)
      return leapSeconds;
  }
  return 8;
}

/**
 * Returns the GPS-UTC leap seconds count (TAI-UTC minus 19) for a given date.
 * Negative before 1980, when GPS time did not exist yet.
 * @param date - Date in GPS time scale
 * @returns Number of GPS-UTC leap seconds
 */
export function getGpsLeap(date: Date): number {
  return getLeap(date) - MILLISECONDS_GPS_TAI / MILLISECONDS_IN_SECOND;
}

/**
 * Converts a GPS-scale Date to UTC scale (applies leap seconds).
 *
 * A Date cannot hold 23:59:60: the GPS second that falls on an inserted
 * leap second maps to 00:00:00 of the next day, like the second after it
 * (see `isLeapSecond`).
 * @param date - Date in GPS time scale
 * @returns Date in UTC time scale
 */
export function getUtcDate(date: Date): Date {
  return new Date(
    date.getTime() +
      MILLISECONDS_GPS_TAI -
      getLeap(date) * MILLISECONDS_IN_SECOND
  );
}

/**
 * Converts a UTC-scale Date to GPS scale (applies leap seconds).
 * @param utc_date - Date in UTC time scale
 * @returns Date in GPS time scale
 */
export function getDateFromUtc(utc_date: Date): Date {
  return new Date(
    utc_date.getTime() +
      leapAtUtcMs(utc_date.getTime()) * MILLISECONDS_IN_SECOND -
      MILLISECONDS_GPS_TAI
  );
}

/**
 * Whether a GPS-scale instant falls inside an inserted leap second, i.e.
 * its UTC reading is 23:59:60.xxx (which a Date cannot represent).
 * @param date - Date in GPS time scale
 */
export function isLeapSecond(date: Date): boolean {
  const next = new Date(date.getTime() + MILLISECONDS_IN_SECOND);
  return getLeap(next) > getLeap(date);
}
