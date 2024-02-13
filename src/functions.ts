import { error } from "console";
import {
  ALPHABET,
  MILLISECONDS_IN_DAY,
  MILLISECONDS_IN_HOUR,
  MILLISECONDS_IN_MINUTE,
  MILLISECONDS_IN_SECOND,
  MILLISECONDS_IN_WEEK,
  START_BDS_TIME,
  START_GAL_TIME,
  START_GLO_LEAP,
  START_GPS_TIME,
  START_JULIAN_CALENDAR_UNIX_SECONDS,
  START_MJD_UNIX_SECONDS,
  START_UNIX_TIME,
} from "./constants";
import { TimeDifference } from "./types";

export default function isValidDate(d: Date): boolean {
  return d instanceof Date && !Number.isNaN(d);
}

export function getLeapSeconds(date: Date): number {
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 3692217600000) {
    return 37;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 3644697600000) {
    return 36;
  }

  if (date.getTime() >= Date.UTC(1900, 0, 1) + 3550089600000) {
    return 35;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 3439756800000) {
    return 34;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 3345062400000) {
    return 33;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 3124137600000) {
    return 32;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 3076704000000) {
    return 31;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 3029443200000) {
    return 30;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2982009600000) {
    return 29;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2950473600000) {
    return 28;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2918937600000) {
    return 27;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2871676800000) {
    return 26;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2840140800000) {
    return 25;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2776982400000) {
    return 24;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2698012800000) {
    return 23;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2634854400000) {
    return 22;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2603318400000) {
    return 21;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2571782400000) {
    return 20;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2524521600000) {
    return 19;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2492985600000) {
    return 18;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2461449600000) {
    return 17;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2429913600000) {
    return 16;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2398291200000) {
    return 15;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2366755200000) {
    return 14;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2335219200000) {
    return 13;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2303683200000) {
    return 12;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2287785600000) {
    return 11;
  }
  if (date.getTime() >= Date.UTC(1900, 0, 1) + 2272060800000) {
    return 10;
  }
  return 0;
}

export function getGpsTime(date: Date): number {
  return date.getTime() - START_GPS_TIME.getTime();
}

export function getGalTime(date: Date): number {
  return date.getTime() - START_GAL_TIME.getTime();
}

export function getBdsTime(date: Date): number {
  return date.getTime() - START_BDS_TIME.getTime();
}

export function getUnixTime(date: Date): number {
  return date.getTime() - START_UNIX_TIME.getTime();
}

export function getWeekNumber(date: Date): number {
  return Math.floor(getGpsTime(date) / MILLISECONDS_IN_WEEK);
}

export function getTimeOfWeek(date: Date): number {
  return Math.floor(
    (getGpsTime(date) % MILLISECONDS_IN_WEEK) / MILLISECONDS_IN_SECOND
  );
}

export function getTimeOfDay(date: Date): number {
  return Math.floor(
    (date.getTime() -
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        0,
        0,
        0
      )) /
      MILLISECONDS_IN_SECOND
  );
}

export function getDateFromTimeOfDay(
  timeOfDay: number,
  dateRaw: Date
): Date | undefined {
  const date = new Date(
    Date.UTC(
      dateRaw.getUTCFullYear(),
      dateRaw.getUTCMonth(),
      dateRaw.getUTCDate(),
      0,
      0,
      0
    ) +
      timeOfDay * MILLISECONDS_IN_SECOND
  );

  if (!isValidDate(date)) return undefined;

  return date;
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

export function getDateFromGpsData(
  weekNumber: number,
  timeOfWeek: number
): Date | undefined {
  const date = new Date(
    weekNumber * MILLISECONDS_IN_WEEK +
      timeOfWeek * MILLISECONDS_IN_SECOND +
      START_GPS_TIME.getTime()
  );

  if (!isValidDate(date)) return undefined;

  return date;
}

export function getDateFromGpsTime(gpsTime: number): Date | undefined {
  const date = new Date(
    gpsTime * MILLISECONDS_IN_SECOND + START_GPS_TIME.getTime()
  );

  if (!isValidDate(date)) return undefined;

  return date;
}

export function getDateFromGalTime(galTime: number): Date | undefined {
  const date = new Date(
    galTime * MILLISECONDS_IN_SECOND + START_GAL_TIME.getTime()
  );

  if (!isValidDate(date)) return undefined;

  return date;
}

export function getDateFromBdsTime(bdsTime: number): Date | undefined {
  const date = new Date(
    bdsTime * MILLISECONDS_IN_SECOND + START_BDS_TIME.getTime()
  );

  if (!isValidDate(date)) return undefined;

  return date;
}

export function getDateFromUnixTime(unixTime: number): Date | undefined {
  const date = new Date(
    unixTime * MILLISECONDS_IN_SECOND + START_UNIX_TIME.getTime()
  );

  if (!isValidDate(date)) return undefined;

  return date;
}

export function getDateFromGloN(
  n4: number,
  na: number,
  tod: number
): Date | undefined {
  const date = new Date(START_GLO_LEAP);
  date.setFullYear(date.getUTCFullYear() + n4 * 4);
  date.setTime(
    date.getTime() +
      (na - 1) * MILLISECONDS_IN_DAY +
      tod * MILLISECONDS_IN_SECOND
  );

  if (!isValidDate(date)) return undefined;

  return date;
}

export function getDateFromDayOfYear(dayOfYear: number, date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      0,
      1,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds()
    ) +
      (dayOfYear - 1) * MILLISECONDS_IN_DAY
  );
}

export function getDayOfYear(date: Date): number {
  return (
    Math.floor(
      (date.getTime() - Date.UTC(date.getUTCFullYear())) / MILLISECONDS_IN_DAY
    ) + 1
  );
}

// @TODO
// export function getDateFromWeekOfYear(weekOfYear: number, date: Date): Date {
//   return new Date(
//     Date.UTC(
//       date.getUTCFullYear(),
//       0,
//       1,
//       date.getUTCHours(),
//       date.getUTCMinutes(),
//       date.getUTCSeconds(),
//       date.getUTCMilliseconds()
//     ) +
//       (weekOfYear - 1) * MILLISECONDS_IN_WEEK +
//   );
// }

// export function getWeekOfYear(date: Date): number {
//   return (
//     Math.floor(
//       (date.getTime() - Date.UTC(date.getUTCFullYear())) / MILLISECONDS_IN_WEEK
//     ) + 1
//   );
// }

// export function getDateFromWeekOfYear(
//   weekOfYear: number,
//   dateUTC: string,
//   timeUTC: string
// ): Date | undefined {
//   const date = moment.utc(`${dateUTC} ${timeUTC}`, "YYYY-MM-DD HH:mm:ss");

//   if (!isValidDate(date)) return undefined;

//   return date;
// }

export function getDayOfWeek(date: Date): number {
  return date.getUTCDay();
}

export function getDateFromDayOfWeek(
  dayOfWeek: number,
  dateRaw: Date
): Date | undefined {
  if (dayOfWeek < 0 || dayOfWeek > 6)
    throw new Error("Day of week must be a value between 0 and 7");
  const date = new Date(
    dateRaw.getTime() + (dayOfWeek - dateRaw.getUTCDay()) * MILLISECONDS_IN_DAY
  );

  // const date = moment
  //   .utc(`${dateUTC} ${timeUTC}`, "YYYY-MM-DD HH:mm:ss")
  //   .day(dayOfWeekParsed)
  //   .toDate();

  if (!isValidDate(date)) return undefined;

  return date;
}

export function getDateFromHourCode(
  hourCode: string,
  date: Date
): Date | undefined {
  const hour = ALPHABET.indexOf(hourCode);
  if (hour !== -1) {
    const newDate = new Date(date.getTime());
    newDate.setUTCHours(hour);
    return newDate;
  }
  return undefined;
}

export function getHourCode(date: Date): string {
  return ALPHABET[date.getUTCHours()];
}

export function getJulianDate(date: Date): number {
  return (
    date.getTime() / MILLISECONDS_IN_DAY + START_JULIAN_CALENDAR_UNIX_SECONDS
  );
}
export function getDateFromJulianDate(julianDate: number): Date | undefined {
  const date = new Date(
    (julianDate - START_JULIAN_CALENDAR_UNIX_SECONDS) * MILLISECONDS_IN_DAY
  );

  if (!isValidDate(date)) return undefined;

  return date;
}

export function getMJD(date: Date): number {
  return date.getTime() / MILLISECONDS_IN_DAY + START_MJD_UNIX_SECONDS;
}

export function getDateFromMJD(mjd: number): Date | undefined {
  if (Number.isNaN(mjd)) return undefined;

  const date = new Date((mjd - START_MJD_UNIX_SECONDS) * MILLISECONDS_IN_DAY);

  if (!isValidDate(date)) return undefined;

  return date;
}

export function getDateFromMJD2000(mjd2000: number): Date | undefined {
  const date = new Date(
    (mjd2000 - START_MJD_UNIX_SECONDS + 51544) * MILLISECONDS_IN_DAY
  );

  if (!isValidDate(date)) return undefined;

  return date;
}

// export function getDateFromUTC(dateUTC, timeUTC) {
//   const date = moment
//     .utc(`${dateUTC} ${timeUTC}`, "YYYY-MM-DD HH:mm:ss")
//     .toDate();

//   if (!isValidDate(date)) return undefined;

//   return date;
// }

export function getDateFromRINEX(rinex: string): Date | undefined {
  const year = Number.parseInt(rinex.substring(2, 6));
  const month = Number.parseInt(rinex.substring(7, 9)) - 1;
  const day = Number.parseInt(rinex.substring(10, 12));
  const hour = Number.parseInt(rinex.substring(13, 15));
  const minute = Number.parseInt(rinex.substring(16, 18));
  const second = Number.parseInt(rinex.substring(19, 21));
  const millisecond = Number.parseInt(rinex.substring(22, 29)) / 1e4;

  const date = new Date(
    Date.UTC(year, month, day, hour, minute, second, millisecond)
  );

  if (!isValidDate(date)) return undefined;

  return date;
}

export function getLeapSecondsFromTAI(date: Date): number {
  const leapsTAI = getLeapSeconds(date);
  const dateUTC = new Date(date.getTime() - leapsTAI * MILLISECONDS_IN_SECOND);

  const leapsUTC = getLeapSeconds(dateUTC);

  const dateTAI = new Date(date.getTime() + leapsUTC * MILLISECONDS_IN_SECOND);

  if (dateTAI.getTime() === date.getTime()) {
    return leapsTAI;
  }

  if (dateTAI.getTime() < date.getTime()) {
    return leapsTAI - 1;
  }

  return 0;
}

export function getTimeDifference(startDate: Date, finalDate: Date): number {
  return Math.floor(finalDate.getTime() - startDate.getTime());
}

export function getSecondsFromTimeDifference(
  timeDifference: number
): number | undefined {
  if (Number.isNaN(timeDifference)) return undefined;
  return Math.floor(
    (timeDifference % MILLISECONDS_IN_MINUTE) / MILLISECONDS_IN_SECOND
  );
}
export function getMinutesFromTimeDifference(
  timeDifference: number
): number | undefined {
  if (Number.isNaN(timeDifference)) return undefined;
  return Math.floor(
    (timeDifference % MILLISECONDS_IN_HOUR) / MILLISECONDS_IN_MINUTE
  );
}
export function getHoursFromTimeDifference(
  timeDifference: number
): number | undefined {
  if (Number.isNaN(timeDifference)) return undefined;
  return Math.floor(
    (timeDifference % MILLISECONDS_IN_DAY) / MILLISECONDS_IN_HOUR
  );
}

export function getTotalDaysFromTimeDifference(
  timeDifference: number
): number | undefined {
  if (Number.isNaN(timeDifference)) return undefined;
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
): number | undefined {
  const { seconds, minutes, hours, days } = timeDifferenceObject;

  if (
    Number.isNaN(seconds) ||
    Number.isNaN(minutes) ||
    Number.isNaN(hours) ||
    Number.isNaN(days)
  )
    return undefined;

  return (
    getTimeDifferenceFromSeconds(seconds) +
    getTimeDifferenceFromMinutes(minutes) +
    getTimeDifferenceFromHours(hours) +
    getTimeDifferenceFromDays(days)
  );
}

export function getRINEX(date: Date): string {
  return (
    "> " +
    date.getUTCFullYear() +
    " " +
    (date.getUTCMonth() + 1).toString().padStart(2, "0") +
    " " +
    date.getUTCDate().toString().padStart(2, "0") +
    " " +
    date.getUTCHours().toString().padStart(2, "0") +
    " " +
    date.getUTCMinutes().toString().padStart(2, "0") +
    " " +
    (date.getUTCMilliseconds() / MILLISECONDS_IN_SECOND + date.getUTCSeconds())
      .toFixed(7)
      .padStart(2, "0")
  );
}
