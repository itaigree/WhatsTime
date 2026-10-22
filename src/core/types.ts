/**
 * Shared domain types. Everything in src/core is pure (no DOM access) so it
 * can be unit-tested in Node.
 */

/** A wall-clock date and time with no zone attached. */
export interface LocalDateTime {
  /** 'YYYY-MM-DD' */
  date: string;
  /** 'HH:MM' (24h) */
  time: string;
}

export type Frequency = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

/** RFC 5545 weekday codes, Monday first. */
export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

/**
 * How a monthly repeat is anchored to the start date.
 * - dayOfMonth:  same day number every month (months without that day are skipped, per RFC 5545)
 * - nthWeekday:  e.g. "3rd Tuesday" (n = ceil(day / 7); only offered for n <= 4)
 * - lastWeekday: e.g. "last Friday" (only offered when the start date is in the last 7 days of its month)
 * - lastDay:     last day of every month (only offered when the start date is the last day of its month)
 */
export type MonthlyMode = 'dayOfMonth' | 'nthWeekday' | 'lastWeekday' | 'lastDay';

export type RecurrenceEnd =
  | { type: 'never' }
  /** Total number of occurrences, including the first one. >= 1 */
  | { type: 'count'; count: number }
  /** Last allowed local date, inclusive: 'YYYY-MM-DD' */
  | { type: 'until'; date: string };

export interface Recurrence {
  frequency: Frequency;
  /** Repeat every N units (days/weeks/months/years). >= 1 */
  interval: number;
  /** Weekly only. Empty means "the weekday of the start date". */
  weekdays: Weekday[];
  /** Monthly only. */
  monthlyMode: MonthlyMode;
  /**
   * First day of the week (RFC 5545 WKST) used to group days for weekly rules with interval > 1, e.g. 'SU' in
   * Israel so "every 2 weeks on Sun and Tue" keeps Sunday and the following Tuesday together. Default 'MO'.
   */
  weekStart?: Weekday;
  end: RecurrenceEnd;
}

export interface Recipient {
  /** Display name; may be empty. */
  name: string;
  /**
   * International number as digits only, no '+' and no leading zeros,
   * e.g. '972501234567'. Empty string means "no fixed recipient": the link
   * opens WhatsApp's chat picker (useful for groups).
   */
  phone: string;
}

/** What the user fills in. Persisted in history. */
export interface ScheduledMessage {
  id: string;
  recipient: Recipient;
  message: string;
  start: LocalDateTime;
  /** IANA zone the start time is expressed in, e.g. 'Asia/Jerusalem'. */
  timeZone: string;
  /** 0 = at the time of the event. */
  reminderMinutesBefore: number;
  /** Length of the calendar event. */
  durationMinutes: number;
  recurrence: Recurrence;
  /** ISO 8601 UTC timestamp. */
  createdAt: string;
}

/** A calendar-ready event derived from a ScheduledMessage. */
export interface CalendarEvent {
  uid: string;
  title: string;
  /** Plain text, may contain newlines. */
  description: string;
  /** The wa.me link. */
  url: string;
  /** First occurrence (already aligned to the recurrence rule). */
  start: LocalDateTime;
  timeZone: string;
  durationMinutes: number;
  reminderMinutesBefore: number;
  /** RRULE value without the 'RRULE:' prefix, or null for a one-off event. */
  rrule: string | null;
  /** Creation timestamp, used for DTSTAMP. */
  dtstamp: Date;
}

export interface Settings {
  /** ISO 3166-1 alpha-2 region used to interpret numbers without a country code, e.g. 'IL'. */
  defaultCountry: string;
  defaultReminderMinutesBefore: number;
  defaultDurationMinutes: number;
}

export interface SavedContact {
  name: string;
  phone: string;
  /** ISO timestamp of last use. */
  lastUsed: string;
}
