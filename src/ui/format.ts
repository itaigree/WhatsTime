/** User-facing formatting of dates, times, reminders, recipients and countries (English UI). */

import { isValidDate, isValidTime, parseDate, parseTime } from '../core/dates';
import { formatPhoneForDisplay, listCountries } from '../core/phone';
import type { LocalDateTime, Recipient } from '../core/types';

export const REMINDER_OPTIONS: readonly { minutes: number; label: string }[] = [
  { minutes: 0, label: 'At the time of the message' },
  { minutes: 5, label: '5 minutes before' },
  { minutes: 10, label: '10 minutes before' },
  { minutes: 15, label: '15 minutes before' },
  { minutes: 30, label: '30 minutes before' },
  { minutes: 60, label: '1 hour before' },
  { minutes: 120, label: '2 hours before' },
  { minutes: 1440, label: '1 day before' },
];

export const DURATION_OPTIONS: readonly { minutes: number; label: string }[] = [
  { minutes: 5, label: '5 minutes' },
  { minutes: 10, label: '10 minutes' },
  { minutes: 15, label: '15 minutes' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: '1 hour' },
];

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** 'At the time of the message', '10 minutes before', '1 hour 30 minutes before', ... */
export function reminderLabel(minutes: number): string {
  const known = REMINDER_OPTIONS.find((option) => option.minutes === minutes);
  if (known) return known.label;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts = [days && plural(days, 'day'), hours && plural(hours, 'hour'), mins && plural(mins, 'minute')];
  return `${parts.filter(Boolean).join(' ')} before`;
}

/** navigator.language as a valid BCP 47 tag, or '' (some systems report tags like 'en-US@posix' that Intl rejects). */
export function userLanguage(): string {
  try {
    return Intl.getCanonicalLocales(navigator.language ? [navigator.language] : [])[0] ?? '';
  } catch {
    return '';
  }
}

/** English formatting that follows the user's English variant (en-US: 'Oct 22, 9:00 AM'), else en-GB. */
export function uiLocale(): string {
  const language = userLanguage();
  return /^en(-|$)/i.test(language) ? language : 'en-GB';
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = uiLocale();
  const key = locale + JSON.stringify(options);
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
    formatters.set(key, f);
  }
  return f;
}

/** Wall-clock values are formatted as if in UTC so no zone conversion sneaks in. */
function wallClock(date: string, time = '00:00'): Date {
  const { year, month, day } = parseDate(date);
  const { hour, minute } = parseTime(isValidTime(time) ? time : '00:00');
  const d = new Date(Date.UTC(2000, month - 1, day, hour, minute));
  d.setUTCFullYear(year);
  return d;
}

const thisYear = (): number => new Date().getFullYear();

let hourStyle: 'numeric' | '2-digit' | undefined;

/** '09:00' in 24-hour locales (Intl would give '9:00'), '9:00 AM' in 12-hour ones. */
function hourOption(): 'numeric' | '2-digit' {
  if (!hourStyle) {
    const cycle = new Intl.DateTimeFormat(uiLocale(), { hour: 'numeric' }).resolvedOptions().hourCycle;
    hourStyle = cycle === 'h23' || cycle === 'h24' ? '2-digit' : 'numeric';
  }
  return hourStyle;
}

/** 'Thu, 22 Oct' (with the year when it is not this year). */
export function dayLabel(date: string): string {
  if (!isValidDate(date)) return date;
  const withYear = parseDate(date).year !== thisYear();
  return formatter({ weekday: 'short', day: 'numeric', month: 'short', ...(withYear && { year: 'numeric' }) }).format(
    wallClock(date),
  );
}

/** '09:00' or '9:00 AM' depending on the locale. */
export function timeLabel(time: string): string {
  if (!isValidTime(time)) return time;
  return formatter({ hour: hourOption(), minute: '2-digit' }).format(wallClock('2000-01-01', time));
}

/** 'Thu, 22 Oct, 09:00' (with the year when it is not this year). */
export function dayTimeLabel({ date, time }: LocalDateTime): string {
  if (!isValidDate(date) || !isValidTime(time)) return `${date} ${time}`.trim();
  const withYear = parseDate(date).year !== thisYear();
  return formatter({
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: hourOption(),
    minute: '2-digit',
    ...(withYear && { year: 'numeric' }),
  }).format(wallClock(date, time));
}

/** 'Thursday 22 October 2026 at 09:00'. */
export function longDayTimeLabel({ date, time }: LocalDateTime): string {
  if (!isValidDate(date) || !isValidTime(time)) return `${date} ${time}`.trim();
  return formatter({
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: hourOption(),
    minute: '2-digit',
  }).format(wallClock(date, time));
}

/** Name, else formatted number, else the "pick the chat yourself" wording. */
export function recipientLabel(recipient: Recipient): string {
  const name = recipient.name.trim();
  if (name) return name;
  return recipient.phone ? formatPhoneForDisplay(recipient.phone) : 'Choose chat in WhatsApp';
}

let countries: { code: string; name: string; callingCode: string }[] | null = null;

export function countryList(): { code: string; name: string; callingCode: string }[] {
  countries ??= listCountries('en');
  return countries;
}

export function countryInfo(code: string): { code: string; name: string; callingCode: string } | undefined {
  return countryList().find((country) => country.code === code);
}
