/**
 * Turns what the user filled in (ScheduledMessage) into a calendar-ready
 * event with the wa.me link embedded.
 */

import { isValidDate, isValidTime, parseDate } from './dates';
import { formatPhoneForDisplay } from './phone';
import { alignStart, toRRule, validateRecurrence } from './recurrence';
import { isValidTimeZone, wallTimeIssue, zonedTimeToUtc } from './timezone';
import type { CalendarEvent, LocalDateTime, ScheduledMessage } from './types';
import { buildWhatsAppLink } from './whatsapp';

export const DEFAULT_DURATION_MINUTES = 15;
export const MAX_REMINDER_MINUTES = 4 * 7 * 24 * 60;
/** Links longer than this may be truncated by some calendar apps. */
export const LONG_LINK_THRESHOLD = 2000;

const TITLE_SNIPPET_LENGTH = 40;
/** Start years accepted; a typo such as 20260 or 0202 is caught, and dates stay far from year-10000 overflows. */
const MIN_START_YEAR = 2000;
const MAX_START_YEAR = 2199;

export type MessageField = 'recipient' | 'message' | 'date' | 'time' | 'timeZone' | 'recurrence' | 'reminder' | 'duration';

export interface ValidationIssue {
  field: MessageField;
  message: string;
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

function recipientLabel(msg: ScheduledMessage): string {
  const name = msg.recipient.name.trim();
  if (name) return name;
  return msg.recipient.phone ? formatPhoneForDisplay(msg.recipient.phone) : '';
}

/** First line of the message, shortened to a notification-friendly length without splitting characters. */
export function messageSnippet(message: string, maxLength = TITLE_SNIPPET_LENGTH): string {
  const firstLine = message.trim().split(/\r\n|\r|\n/, 1)[0]?.trim() ?? '';
  const chars = [...firstLine];
  if (chars.length <= maxLength) return firstLine;
  return `${chars.slice(0, maxLength - 1).join('').trimEnd()}…`;
}

export function eventTitle(msg: ScheduledMessage): string {
  const who = recipientLabel(msg);
  const snippet = messageSnippet(msg.message);
  const head = who ? `💬 WhatsApp ${who}` : '💬 WhatsApp';
  return snippet ? `${head}: ${snippet}` : head;
}

export function eventDescription(msg: ScheduledMessage, link: string): string {
  const name = msg.recipient.name.trim();
  const phone = msg.recipient.phone ? formatPhoneForDisplay(msg.recipient.phone) : '';
  const to = phone ? (name ? `${name} (${phone})` : phone) : 'choose the chat in WhatsApp';
  return [
    'Tap the link to open WhatsApp with your message ready to send:',
    link,
    '',
    `To: ${to}`,
    '',
    'Message:',
    msg.message,
    '',
    'Scheduled with WhatsTime',
  ].join('\n');
}

/** The first occurrence: the start moved to the first date the repeat rule produces. */
function firstStart(msg: ScheduledMessage): LocalDateTime {
  return { date: alignStart(msg.recurrence, msg.start.date), time: msg.start.time };
}

export function toCalendarEvent(msg: ScheduledMessage, now: Date): CalendarEvent {
  const url = buildWhatsAppLink(msg.recipient.phone, msg.message);
  const start = firstStart(msg);
  return {
    uid: `${msg.id}@whatstime`,
    title: eventTitle(msg),
    description: eventDescription(msg, url),
    url,
    start,
    timeZone: msg.timeZone,
    durationMinutes: msg.durationMinutes,
    reminderMinutesBefore: msg.reminderMinutesBefore,
    rrule: toRRule(msg.recurrence, start, msg.timeZone),
    dtstamp: now,
  };
}

/** The instant the first reminder fires. */
export function firstReminderAt(msg: ScheduledMessage): Date {
  return new Date(zonedTimeToUtc(firstStart(msg), msg.timeZone).getTime() - msg.reminderMinutesBefore * 60_000);
}

/** A note when the first start falls in a DST gap or in the repeated hour of a fall-back, else null. */
function wallTimeWarning(msg: ScheduledMessage): string | null {
  const { time } = msg.start;
  const issue = wallTimeIssue(firstStart(msg), msg.timeZone);
  if (issue?.kind === 'gap') {
    return `${time} doesn't exist on that day because the clocks go forward. The reminder will be at ${issue.actual}.`;
  }
  if (issue?.kind === 'repeated') {
    return `${time} happens twice on that day because the clocks go back. The first one (summer time) is used.`;
  }
  return null;
}

function isYearInRange(year: number): boolean {
  return year >= MIN_START_YEAR && year <= MAX_START_YEAR;
}

export function validateScheduledMessage(msg: ScheduledMessage, now: Date): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (msg.recipient.phone && !/^[1-9]\d{6,14}$/.test(msg.recipient.phone)) {
    errors.push({ field: 'recipient', message: 'That phone number does not look right.' });
  }
  if (!msg.message.trim()) {
    errors.push({ field: 'message', message: 'Write the message you want to send.' });
  }
  if (!isValidDate(msg.start.date)) errors.push({ field: 'date', message: 'Pick a date.' });
  else if (!isYearInRange(parseDate(msg.start.date).year)) errors.push({ field: 'date', message: 'Check the year.' });
  if (!isValidTime(msg.start.time)) errors.push({ field: 'time', message: 'Pick a time.' });
  if (!isValidTimeZone(msg.timeZone)) errors.push({ field: 'timeZone', message: 'Unknown time zone.' });
  if (
    !Number.isInteger(msg.reminderMinutesBefore) ||
    msg.reminderMinutesBefore < 0 ||
    msg.reminderMinutesBefore > MAX_REMINDER_MINUTES
  ) {
    errors.push({ field: 'reminder', message: 'Choose when the reminder should go off.' });
  }
  if (!Number.isInteger(msg.durationMinutes) || msg.durationMinutes < 1 || msg.durationMinutes > 24 * 60) {
    errors.push({ field: 'duration', message: 'Event length must be between 1 minute and 24 hours.' });
  }
  if (errors.some((e) => e.field === 'date')) return { errors, warnings };

  for (const problem of validateRecurrence(msg.recurrence, msg.start.date)) {
    errors.push({ field: 'recurrence', message: problem });
  }
  if (errors.length > 0) return { errors, warnings };

  if (firstReminderAt(msg).getTime() <= now.getTime()) {
    const issue = { field: 'date' as const, message: 'That time has already passed.' };
    if (msg.recurrence.frequency === 'none') errors.push(issue);
    else warnings.push({ ...issue, message: 'The first reminder is in the past; later repeats will still remind you.' });
  }
  const wallTime = wallTimeWarning(msg);
  if (wallTime) warnings.push({ field: 'time', message: wallTime });
  if (buildWhatsAppLink(msg.recipient.phone, msg.message).length > LONG_LINK_THRESHOLD) {
    warnings.push({ field: 'message', message: 'Very long messages may be cut off by some calendar apps.' });
  }
  return { errors, warnings };
}
