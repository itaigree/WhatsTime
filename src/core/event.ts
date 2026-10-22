/**
 * Turns what the user filled in (ScheduledMessage) into a calendar-ready
 * event with the wa.me link embedded.
 */

import { isValidDate, isValidTime } from './dates';
import { formatPhoneForDisplay } from './phone';
import { alignStart, toRRule, validateRecurrence } from './recurrence';
import { isValidTimeZone, zonedTimeToUtc } from './timezone';
import type { CalendarEvent, ScheduledMessage } from './types';
import { buildWhatsAppLink } from './whatsapp';

export const DEFAULT_DURATION_MINUTES = 15;
export const MAX_REMINDER_MINUTES = 4 * 7 * 24 * 60;
/** Links longer than this may be truncated by some calendar apps. */
export const LONG_LINK_THRESHOLD = 2000;

const TITLE_SNIPPET_LENGTH = 40;

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

export function toCalendarEvent(msg: ScheduledMessage, now: Date): CalendarEvent {
  const url = buildWhatsAppLink(msg.recipient.phone, msg.message);
  const start = { date: alignStart(msg.recurrence, msg.start.date), time: msg.start.time };
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
  const start = { date: alignStart(msg.recurrence, msg.start.date), time: msg.start.time };
  return new Date(zonedTimeToUtc(start, msg.timeZone).getTime() - msg.reminderMinutesBefore * 60_000);
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
  if (buildWhatsAppLink(msg.recipient.phone, msg.message).length > LONG_LINK_THRESHOLD) {
    warnings.push({ field: 'message', message: 'Very long messages may be cut off by some calendar apps.' });
  }
  return { errors, warnings };
}
