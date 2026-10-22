/**
 * Calendar-date helpers that work on 'YYYY-MM-DD' strings. All arithmetic is
 * done in UTC so the host machine's time zone never leaks in.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

export interface DateParts {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
}

export function isValidDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function isValidTime(value: string): boolean {
  const m = TIME_RE.exec(value);
  if (!m) return false;
  return Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

export function parseDate(value: string): DateParts {
  if (!isValidDate(value)) throw new RangeError(`Invalid date: ${value}`);
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return { year, month, day };
}

export function parseTime(value: string): { hour: number; minute: number } {
  if (!isValidTime(value)) throw new RangeError(`Invalid time: ${value}`);
  const [hour, minute] = value.split(':').map(Number) as [number, number];
  return { hour, minute };
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

export function formatDate({ year, month, day }: DateParts): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

export function formatTime(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Date.UTC that does not map years 0-99 to 1900-1999. */
export function utcMs(year: number, monthIndex: number, day: number, hour = 0, minute = 0, second = 0): number {
  const d = new Date(0);
  d.setUTCFullYear(year, monthIndex, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(utcMs(year, month, 0)).getUTCDate();
}

function toUtcMs(value: string): number {
  const { year, month, day } = parseDate(value);
  return utcMs(year, month - 1, day);
}

function fromUtcMs(ms: number): string {
  const d = new Date(ms);
  return formatDate({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

export function addDays(value: string, days: number): string {
  return fromUtcMs(toUtcMs(value) + days * 86_400_000);
}

/** Whole days from a to b (b - a). */
export function diffDays(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / 86_400_000);
}

/** ISO weekday index: 0 = Monday ... 6 = Sunday. */
export function isoWeekdayIndex(value: string): number {
  return (new Date(toUtcMs(value)).getUTCDay() + 6) % 7;
}

/** Negative if a < b, 0 if equal, positive if a > b. Works because the format is zero-padded. */
export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compact iCalendar form: '2026-10-22' + '09:05' -> '20261022T090500'. */
export function toIcsLocal(date: string, time: string): string {
  return `${date.replaceAll('-', '')}T${time.replace(':', '')}00`;
}

/** Compact iCalendar UTC form: '20261022T070500Z'. */
export function toIcsUtc(instant: Date): string {
  return instant.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
