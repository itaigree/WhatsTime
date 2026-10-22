/**
 * Time-zone conversions built only on Intl (which ships the IANA database),
 * so no tz data needs to be bundled.
 */

import { formatDate, formatTime, parseDate, parseTime, utcMs } from './dates';
import type { LocalDateTime } from './types';

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      era: 'short',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** IANA zone names only; offset zones such as '+05:30' are rejected because calendars cannot use them. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || /^[+-]/.test(timeZone)) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function getDeviceTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isValidTimeZone(tz) ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(timeZone: string, instantMs: number): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const era = parts.find((p) => p.type === 'era')?.value;
  let year = get('year');
  if (era === 'BC' || era === 'B') year = 1 - year;
  return {
    year,
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** UTC offset (local minus UTC) in minutes for the given instant. */
export function offsetMinutesAt(timeZone: string, instantMs: number): number {
  const p = zonedParts(timeZone, instantMs);
  const asUtc = utcMs(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(instantMs / 1000) * 1000;
  return Math.round((asUtc - truncated) / 60_000);
}

/** Wall-clock date/time in a zone for an instant. */
export function utcToZoned(instant: Date, timeZone: string): LocalDateTime & { second: number } {
  const p = zonedParts(timeZone, instant.getTime());
  return {
    date: formatDate({ year: p.year, month: p.month, day: p.day }),
    time: formatTime(p.hour, p.minute),
    second: p.second,
  };
}

/**
 * Convert a wall-clock time in a zone to an instant, following RFC 5545
 * section 3.3.5: an ambiguous time (DST fall-back) resolves to the first
 * occurrence, and a non-existent time (DST spring-forward gap) is interpreted
 * with the offset from before the gap, which moves it forward by the gap size.
 */
export function zonedTimeToUtc(local: LocalDateTime, timeZone: string, second = 0): Date {
  const { year, month, day } = parseDate(local.date);
  const { hour, minute } = parseTime(local.time);
  const naive = utcMs(year, month - 1, day, hour, minute, second);
  const before = offsetMinutesAt(timeZone, naive - 36 * 3_600_000);
  const after = offsetMinutesAt(timeZone, naive + 36 * 3_600_000);
  const candidates = [...new Set([naive - before * 60_000, naive - after * 60_000])].sort((a, b) => a - b);
  for (const utc of candidates) {
    const p = zonedParts(timeZone, utc);
    if (
      p.year === year &&
      p.month === month &&
      p.day === day &&
      p.hour === hour &&
      p.minute === minute &&
      p.second === second
    ) {
      return new Date(utc);
    }
  }
  return new Date(naive - before * 60_000);
}

/** e.g. 'GMT+03:00' or 'GMT+05:30'. */
export function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `GMT${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
