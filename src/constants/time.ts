import { HourCode } from '../types/time';

export const SECONDS_IN_WEEK: number = 604800;
export const SECONDS_IN_DAY: number = 86400;
export const SECONDS_IN_HOUR: number = 3600;
export const SECONDS_IN_MINUTE: number = 60;
export const MILLISECONDS_IN_WEEK: number = 604800000;
export const MILLISECONDS_IN_DAY: number = 86400000;
export const MILLISECONDS_IN_HOUR: number = 3600000;
export const MILLISECONDS_IN_MINUTE: number = 60000;
export const MILLISECONDS_IN_SECOND: number = 1000;
export const MILLISECONDS_TT_TAI: number = 32184;
export const MILLISECONDS_GPS_TAI: number = 19000;
export const START_GPS_TIME: Date = new Date('1980-01-06T00:00:00Z'); // GPS scale = UTC
export const START_GAL_TIME: Date = new Date('1999-08-22T00:00:00Z'); // In GPS scale (!)
export const START_BDS_TIME: Date = new Date('2006-01-01T00:00:13Z');
export const START_UNIX_TIME: Date = new Date('1969-12-31T23:59:49Z'); // GPS scale!
export const START_NTP_TIME: Date = new Date('1900-01-01T00:00:00Z');
export const START_GLO_LEAP = new Date('1996-01-01T00:00:00Z');
export const START_TAI_TIME: Date = new Date('1957-12-31T23:59:41Z'); // In GPS scale (!), in TAI scale it is 1958-01-01T00:00:00Z
export const RINEX_CODES: HourCode[] = [
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  's',
  't',
  'u',
  'v',
  'w',
  'x',
];
export const START_JULIAN_TAI = 2436204.5; // 1958-01-01T00:00:00Z
export const DAYS_MJD_JULIAN = 2400000.5;
export const DAYS_MJD2000_MJD = 51544.5;

export const START_MJD_UNIX_SECONDS = 40587.0;
