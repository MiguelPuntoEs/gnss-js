import { MILLISECONDS_IN_SECOND } from '../constants/time';

/**
 * Formats a Date as a RINEX epoch string (e.g. "> 2024 01 15 12 00 00.0000000").
 * @param date - Date in GPS time scale
 * @returns RINEX-formatted epoch string
 */
export function getRINEX(date: Date): string {
  const seconds = date.getUTCSeconds();
  const milliseconds = date.getUTCMilliseconds();
  const fractionalSeconds = (milliseconds / MILLISECONDS_IN_SECOND)
    .toFixed(7)
    .slice(1);

  const formatted = `> ${date.getUTCFullYear()} ${String(
    date.getUTCMonth() + 1
  ).padStart(2, '0')} ${String(date.getUTCDate()).padStart(2, '0')} ${String(
    date.getUTCHours()
  ).padStart(2, '0')} ${String(date.getUTCMinutes()).padStart(
    2,
    '0'
  )} ${String(seconds).padStart(2, '0')}${fractionalSeconds}`;
  return formatted;
}

const RINEX_EPOCH =
  /^\s*>?\s*(\d{2}|\d{4})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2}(?:\.\d*)?)(?:\s.*)?$/;

/**
 * Parses a RINEX epoch string into a Date: the RINEX 3/4 record line
 * ("> 2024 01 15 12 00 00.0000000", flag and satellite count allowed after
 * it) or a RINEX 2 epoch (" 24  1 15 12  0  0.0000000", two-digit year:
 * 80–99 → 19xx, 00–79 → 20xx). Any number of decimals is read.
 * @param rinex - RINEX-formatted epoch string
 * @returns Date in GPS time scale, or an Invalid Date when the string is not
 *   an epoch or a field is out of range
 */
export function getDateFromRINEX(rinex: string): Date {
  const m = RINEX_EPOCH.exec(rinex);
  if (!m) return new Date(NaN);
  const [year2or4, month, day, hour, minute] = m.slice(1, 6).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const seconds = Number(m[6]);
  const year =
    m[1]!.length === 2 ? year2or4 + (year2or4 >= 80 ? 1900 : 2000) : year2or4;
  const ms =
    Date.UTC(year, month - 1, day, hour, minute) +
    Math.round(seconds * MILLISECONDS_IN_SECOND);
  const date = new Date(ms);
  if (
    month < 1 ||
    month > 12 ||
    date.getUTCDate() !== day ||
    date.getUTCMonth() !== month - 1 ||
    hour > 23 ||
    minute > 59 ||
    seconds >= 60
  )
    return new Date(NaN);
  return date;
}
