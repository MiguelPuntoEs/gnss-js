import { MILLISECONDS_IN_SECOND } from '../constants/time';

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

export function getDateFromRINEX(rinex: string): Date {
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

  return date;
}
