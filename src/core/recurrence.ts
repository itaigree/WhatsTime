/**
 * Repeat rules: RFC 5545 RRULE generation, occurrence expansion and
 * human-readable summaries. Pure; works on 'YYYY-MM-DD' strings.
 */

import {
  addDays,
  compareDates,
  daysInMonth,
  formatDate,
  isValidDate,
  isoWeekdayIndex,
  parseDate,
  toIcsUtc,
} from './dates';
import { offsetMinutesAt, utcToZoned, zonedTimeToUtc } from './timezone';
import type { Frequency, LocalDateTime, MonthlyMode, Recurrence, RecurrenceEnd, Weekday } from './types';

export const WEEKDAYS: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

type RepeatingFrequency = Exclude<Frequency, 'none'>;

const RRULE_FREQ: Record<RepeatingFrequency, string> = {
  daily: 'DAILY',
  weekly: 'WEEKLY',
  monthly: 'MONTHLY',
  yearly: 'YEARLY',
};

const MONTHLY_MODES: readonly MonthlyMode[] = ['dayOfMonth', 'nthWeekday', 'lastWeekday', 'lastDay'];
const SHORT_DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LONG_DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WORKWEEK = 'MO,TU,WE,TH,FR';

/** Upper bound on periods scanned per expansion, so any input terminates quickly. */
const MAX_PERIODS = 5000;
const MAX_YEAR = 9999;
const MAX_INTERVAL = 999;
const MAX_COUNT = 1000;
const DAY_MS = 86_400_000;
/** Latest UNTIL that still fits the 'YYYYMMDDTHHMMSSZ' form. */
const LAST_UNTIL_MS = Date.UTC(9999, 11, 31, 23, 59, 59);

/** A repeat rule resolved against its start date: which dates each period offers. */
type Pattern =
  | { frequency: 'daily' }
  | { frequency: 'weekly'; weekdays: number[] }
  | { frequency: 'monthly'; dayIn: (year: number, month: number) => number | null }
  | { frequency: 'yearly'; month: number; day: number };

/** frequency 'none', interval 1, no weekdays, monthly by day of month, never ends. */
export function defaultRecurrence(): Recurrence {
  return { frequency: 'none', interval: 1, weekdays: [], monthlyMode: 'dayOfMonth', end: { type: 'never' } };
}

/** RFC 5545 weekday code of a 'YYYY-MM-DD' date. Throws RangeError for an invalid date. */
export function weekdayOf(date: string): Weekday {
  return WEEKDAYS[isoWeekdayIndex(date)] as Weekday;
}

/**
 * Monthly modes that make sense for this start date, in display order. dayOfMonth always; nthWeekday when
 * ceil(day/7) <= 4; lastWeekday when day > daysInMonth - 7; lastDay when day === daysInMonth.
 */
export function availableMonthlyModes(date: string): MonthlyMode[] {
  if (!isValidDate(date)) return ['dayOfMonth'];
  const { year, month, day } = parseDate(date);
  const lastDay = daysInMonth(year, month);
  const modes: MonthlyMode[] = ['dayOfMonth'];
  if (Math.ceil(day / 7) <= 4) modes.push('nthWeekday');
  if (day > lastDay - 7) modes.push('lastWeekday');
  if (day === lastDay) modes.push('lastDay');
  return modes;
}

/**
 * First date >= startDate that the rule produces (RFC 5545 requires DTSTART to match the RRULE).
 * Returns startDate unchanged for 'none' or an invalid date.
 */
export function alignStart(rec: Recurrence, startDate: string): string {
  if (!isValidDate(startDate)) return startDate;
  const pattern = patternFor(rec, startDate);
  if (!pattern) return startDate;
  const first = matchingDates(pattern, startDate, 1).next();
  return first.done ? startDate : first.value;
}

/**
 * RRULE value without the 'RRULE:' prefix, or null for frequency 'none'. Part order: FREQ, INTERVAL (if > 1),
 * BYDAY / BYMONTH / BYMONTHDAY, COUNT or UNTIL. UNTIL is the UTC instant of 23:59:59 local time on the until-date
 * in `timeZone` (the later one when the clocks fall back at midnight). A Feb 29 yearly rule spells out
 * BYMONTH=2;BYMONTHDAY=29 so every client skips non-leap years.
 * Throws RangeError for an invalid start date or time zone.
 */
export function toRRule(rec: Recurrence, start: LocalDateTime, timeZone: string): string | null {
  if (!isRepeating(rec.frequency)) return null;
  const parts = [`FREQ=${RRULE_FREQ[rec.frequency]}`];
  const interval = normalizeInterval(rec.interval);
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  const by = byRule(rec, rec.frequency, start.date);
  if (by) parts.push(by);
  const end = endRule(normalizeEnd(rec.end), timeZone);
  if (end) parts.push(end);
  return parts.join(';');
}

/**
 * Dates ('YYYY-MM-DD') of the first `limit` occurrences, beginning with alignStart(rec, start.date), honouring
 * interval, weekdays, monthly mode, Feb 29 (leap years only), COUNT and UNTIL (inclusive). For 'none' returns
 * [start.date]. Returns [] for an invalid start date.
 */
export function occurrences(rec: Recurrence, start: LocalDateTime, limit: number): string[] {
  if (!isValidDate(start.date) || !(limit >= 1)) return [];
  const pattern = patternFor(rec, start.date);
  if (!pattern) return [start.date];
  const end = normalizeEnd(rec.end);
  const wanted = Math.floor(limit);
  const max = end.type === 'count' ? Math.min(wanted, end.count) : wanted;
  const first = alignStart(rec, start.date);
  const result: string[] = [];
  for (const date of matchingDates(pattern, first, normalizeInterval(rec.interval))) {
    if (end.type === 'until' && compareDates(date, end.date) > 0) break;
    result.push(date);
    if (result.length >= max) break;
  }
  return result;
}

/**
 * Human-readable English summary, e.g. 'Every 2 weeks on Mon, Wed', 'Every month on the last Friday',
 * 'Every year on Feb 29 (leap years only), 10 times', 'Every day, until Dec 31, 2026'.
 */
export function describeRecurrence(rec: Recurrence, startDate: string): string {
  if (!isRepeating(rec.frequency)) return 'Does not repeat';
  return describeRule(rec, rec.frequency, startDate) + describeEnd(normalizeEnd(rec.end));
}

/** Problems as short English sentences; [] when valid. */
export function validateRecurrence(rec: Recurrence, startDate: string): string[] {
  if (rec.frequency === 'none') return [];
  if (!isRepeating(rec.frequency)) return ['Choose how often the message repeats.'];
  const problems: string[] = [];
  if (!isIntegerInRange(rec.interval, 1, MAX_INTERVAL)) {
    problems.push(`Repeat interval must be a whole number from 1 to ${MAX_INTERVAL}.`);
  }
  if (rec.frequency === 'weekly' && rec.weekdays.some((day) => !WEEKDAYS.includes(day))) {
    problems.push('Choose days of the week from Monday to Sunday.');
  }
  if (rec.frequency === 'monthly' && isValidDate(startDate) && !availableMonthlyModes(startDate).includes(rec.monthlyMode)) {
    problems.push('This monthly option does not fit the start date. Choose another one.');
  }
  return [...problems, ...validateEnd(rec, startDate)];
}

function validateEnd(rec: Recurrence, startDate: string): string[] {
  const { end } = rec;
  if (end.type === 'count' && !isIntegerInRange(end.count, 1, MAX_COUNT)) {
    return [`Number of times must be a whole number from 1 to ${MAX_COUNT}.`];
  }
  if (end.type !== 'until') return [];
  if (!isValidDate(end.date)) return ['End date is not a valid date.'];
  if (!isValidDate(startDate)) return [];
  const first = alignStart(rec, startDate);
  if (compareDates(end.date, first) < 0) {
    return [`End date cannot be before the first occurrence (${formatHumanDate(first)}).`];
  }
  return [];
}

function isRepeating(frequency: string): frequency is RepeatingFrequency {
  return Object.hasOwn(RRULE_FREQ, frequency);
}

function isIntegerInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** Whole number in 1..MAX_INTERVAL (so the RRULE never shows exponent notation such as '1e+21'). */
function normalizeInterval(interval: number): number {
  return Number.isFinite(interval) && interval >= 1 ? Math.min(Math.floor(interval), MAX_INTERVAL) : 1;
}

/** Invalid end values fall back to 'never' so RRULE generation and expansion always agree. */
function normalizeEnd(end: RecurrenceEnd): RecurrenceEnd {
  if (end.type === 'count' && Number.isFinite(end.count)) {
    return { type: 'count', count: Math.min(Math.max(1, Math.floor(end.count)), Number.MAX_SAFE_INTEGER) };
  }
  if (end.type === 'until' && isValidDate(end.date)) return end;
  return { type: 'never' };
}

/** Selected weekdays in MO..SU order without duplicates, or the start date's weekday when none are selected. */
function selectedWeekdays(rec: Recurrence, startDate: string): Weekday[] {
  const chosen = WEEKDAYS.filter((day) => rec.weekdays.includes(day));
  return chosen.length > 0 ? chosen : [weekdayOf(startDate)];
}

function monthlyMode(mode: string): MonthlyMode {
  return MONTHLY_MODES.includes(mode as MonthlyMode) ? (mode as MonthlyMode) : 'dayOfMonth';
}

function byRule(rec: Recurrence, frequency: RepeatingFrequency, startDate: string): string | null {
  switch (frequency) {
    case 'weekly':
      return `BYDAY=${selectedWeekdays(rec, startDate).join(',')}`;
    case 'monthly':
      return monthlyByRule(monthlyMode(rec.monthlyMode), startDate);
    case 'yearly':
      return isFeb29(startDate) ? 'BYMONTH=2;BYMONTHDAY=29' : null;
    default:
      return null;
  }
}

function monthlyByRule(mode: MonthlyMode, startDate: string): string {
  const { day } = parseDate(startDate);
  switch (mode) {
    case 'nthWeekday':
      return `BYDAY=${Math.ceil(day / 7)}${weekdayOf(startDate)}`;
    case 'lastWeekday':
      return `BYDAY=-1${weekdayOf(startDate)}`;
    case 'lastDay':
      return 'BYMONTHDAY=-1';
    case 'dayOfMonth':
      return `BYMONTHDAY=${day}`;
  }
}

function endRule(end: RecurrenceEnd, timeZone: string): string | null {
  if (end.type === 'count') return `COUNT=${end.count}`;
  if (end.type === 'never') return null;
  return `UNTIL=${toIcsUtc(untilInstant(end.date, timeZone))}`;
}

/**
 * The instant of 23:59:59 local time on `date`. Where the clocks fall back at midnight (Asia/Beirut, America/Santiago,
 * Africa/Cairo) that wall time happens twice; the later one is used so an occurrence late on the until-date stays
 * inside UNTIL however a client resolves the repeated hour (ical.js picks the second occurrence), while the next
 * local day is still excluded. Capped at the end of year 9999 so it always fits 'YYYYMMDDTHHMMSSZ'.
 */
function untilInstant(date: string, timeZone: string): Date {
  const first = zonedTimeToUtc({ date, time: '23:59' }, timeZone, 59).getTime();
  let last = first;
  const fallBackMs = (offsetMinutesAt(timeZone, first) - offsetMinutesAt(timeZone, first + DAY_MS)) * 60_000;
  if (fallBackMs > 0) {
    const repeated = utcToZoned(new Date(first + fallBackMs), timeZone);
    if (repeated.date === date && repeated.time === '23:59' && repeated.second === 59) last = first + fallBackMs;
  }
  return new Date(Math.min(last, LAST_UNTIL_MS));
}

function isFeb29(date: string): boolean {
  return date.endsWith('-02-29');
}

function patternFor(rec: Recurrence, startDate: string): Pattern | null {
  if (!isRepeating(rec.frequency)) return null;
  switch (rec.frequency) {
    case 'daily':
      return { frequency: 'daily' };
    case 'weekly':
      return { frequency: 'weekly', weekdays: selectedWeekdays(rec, startDate).map((day) => WEEKDAYS.indexOf(day)) };
    case 'monthly':
      return { frequency: 'monthly', dayIn: monthlyDayPicker(monthlyMode(rec.monthlyMode), startDate) };
    case 'yearly': {
      const { month, day } = parseDate(startDate);
      return { frequency: 'yearly', month, day };
    }
  }
}

/** For a monthly mode, a function giving the matching day of a given month, or null when that month has none. */
function monthlyDayPicker(mode: MonthlyMode, startDate: string): (year: number, month: number) => number | null {
  const { day } = parseDate(startDate);
  const weekday = isoWeekdayIndex(startDate);
  switch (mode) {
    case 'nthWeekday':
      return (year, month) => nthWeekdayOfMonth(year, month, weekday, Math.ceil(day / 7));
    case 'lastWeekday':
      return (year, month) => lastWeekdayOfMonth(year, month, weekday);
    case 'lastDay':
      return (year, month) => daysInMonth(year, month);
    case 'dayOfMonth':
      return (year, month) => (day <= daysInMonth(year, month) ? day : null);
  }
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): number | null {
  const firstWeekday = isoWeekdayIndex(formatDate({ year, month, day: 1 }));
  const day = 1 + ((weekday - firstWeekday + 7) % 7) + 7 * (n - 1);
  return day <= daysInMonth(year, month) ? day : null;
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): number {
  const lastDay = daysInMonth(year, month);
  const lastWeekday = isoWeekdayIndex(formatDate({ year, month, day: lastDay }));
  return lastDay - ((lastWeekday - weekday + 7) % 7);
}

/** Dates >= `from` produced by the pattern, with periods counted from the one containing `from`. */
function* matchingDates(pattern: Pattern, from: string, interval: number): Generator<string> {
  for (let period = 0; period < MAX_PERIODS; period++) {
    const dates = periodDates(pattern, from, period * interval);
    if (!dates) return;
    for (const date of dates) {
      if (compareDates(date, from) >= 0) yield date;
    }
  }
}

/** Candidate dates of the period `offset` units after the one containing `from`; null past year 9999. */
function periodDates(pattern: Pattern, from: string, offset: number): string[] | null {
  switch (pattern.frequency) {
    case 'daily':
      return inRange([addDays(from, offset)]);
    case 'weekly': {
      const weekStart = addDays(from, 7 * offset - isoWeekdayIndex(from));
      if (!isValidDate(weekStart)) return null;
      return inRange(pattern.weekdays.map((weekday) => addDays(weekStart, weekday)));
    }
    case 'monthly':
      return monthlyPeriod(pattern.dayIn, from, offset);
    case 'yearly':
      return yearlyPeriod(pattern.month, pattern.day, parseDate(from).year + offset);
  }
}

function inRange(dates: string[]): string[] | null {
  const valid = dates.filter(isValidDate);
  return valid.length > 0 ? valid : null;
}

function monthlyPeriod(dayIn: (year: number, month: number) => number | null, from: string, offset: number): string[] | null {
  const start = parseDate(from);
  const monthIndex = start.month - 1 + offset;
  const year = start.year + Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  if (year > MAX_YEAR) return null;
  const day = dayIn(year, month);
  return day === null ? [] : [formatDate({ year, month, day })];
}

function yearlyPeriod(month: number, day: number, year: number): string[] | null {
  if (year > MAX_YEAR) return null;
  return day <= daysInMonth(year, month) ? [formatDate({ year, month, day })] : [];
}

function describeRule(rec: Recurrence, frequency: RepeatingFrequency, startDate: string): string {
  const interval = normalizeInterval(rec.interval);
  const hasStart = isValidDate(startDate);
  switch (frequency) {
    case 'daily':
      return every(interval, 'day');
    case 'weekly':
      return describeWeekly(rec, interval, startDate);
    case 'monthly':
      return hasStart ? describeMonthly(monthlyMode(rec.monthlyMode), interval, startDate) : every(interval, 'month');
    case 'yearly':
      return hasStart ? describeYearly(interval, startDate) : every(interval, 'year');
  }
}

function every(interval: number, unit: string): string {
  return interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`;
}

function describeWeekly(rec: Recurrence, interval: number, startDate: string): string {
  const chosen = WEEKDAYS.filter((day) => rec.weekdays.includes(day));
  const days = chosen.length > 0 || !isValidDate(startDate) ? chosen : [weekdayOf(startDate)];
  if (days.length === 0) return every(interval, 'week');
  if (interval === 1 && days.join(',') === WORKWEEK) return 'Every weekday';
  return `${every(interval, 'week')} on ${days.map((day) => SHORT_DAY_NAMES[WEEKDAYS.indexOf(day)]).join(', ')}`;
}

function describeMonthly(mode: MonthlyMode, interval: number, startDate: string): string {
  const prefix = every(interval, 'month');
  const { day } = parseDate(startDate);
  const weekdayName = LONG_DAY_NAMES[isoWeekdayIndex(startDate)];
  switch (mode) {
    case 'nthWeekday':
      return `${prefix} on the ${ordinal(Math.ceil(day / 7))} ${weekdayName}`;
    case 'lastWeekday':
      return `${prefix} on the last ${weekdayName}`;
    case 'lastDay':
      return `${prefix} on the last day`;
    case 'dayOfMonth':
      return day > 28 ? `${prefix} on day ${day} (months without a ${ordinal(day)} are skipped)` : `${prefix} on day ${day}`;
  }
}

function describeYearly(interval: number, startDate: string): string {
  const { month, day } = parseDate(startDate);
  const text = `${every(interval, 'year')} on ${MONTH_NAMES[month - 1]} ${day}`;
  return isFeb29(startDate) ? `${text} (leap years only)` : text;
}

function describeEnd(end: RecurrenceEnd): string {
  if (end.type === 'count') return end.count === 1 ? ', once' : `, ${end.count} times`;
  if (end.type === 'until') return `, until ${formatHumanDate(end.date)}`;
  return '';
}

/** '2026-12-31' -> 'Dec 31, 2026'. */
function formatHumanDate(date: string): string {
  const { year, month, day } = parseDate(date);
  return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
}

function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}
