/**
 * RFC 5545 (.ics) serialisation of a CalendarEvent, with an embedded
 * VTIMEZONE so every client computes the same instants.
 */

import { parseDate, toIcsLocal, toIcsUtc } from './dates';
import { offsetMinutesAt, utcToZoned, zonedTimeToUtc } from './timezone';
import type { CalendarEvent, LocalDateTime } from './types';
import { buildVTimezone } from './vtimezone';

const PRODID = '-//WhatsTime//Scheduled WhatsApp Reminder//EN';
const CRLF = '\r\n';
const MAX_LINE_OCTETS = 75;
/** The VTIMEZONE covers at least this many years after the start. */
const VTIMEZONE_MIN_YEARS = 10;
/** ...and at most this many, however distant the UNTIL date (regular rules keep going after it anyway). */
const VTIMEZONE_MAX_YEARS = 50;
const UTC_ZONE_RE = /^(?:etc\/)?(?:utc|uct|universal|zulu|greenwich|gmt(?:[+-]?0)?)$/i;
/** Far enough from an instant to see the offsets on both sides of any nearby change (as zonedTimeToUtc does). */
const NEIGHBOUR_MS = 36 * 3_600_000;

/** RFC 5545 TEXT escaping: backslash, ';', ',' and newlines (as '\n'); other control characters are dropped. */
export function escapeText(value: string): string {
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[\\;,]/g, (ch) => `\\${ch}`)
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Folds a content line into chunks of at most 75 UTF-8 octets joined by CRLF + space, never splitting a code point
 * (the leading space of a continuation line counts towards its 75).
 */
export function foldLine(line: string): string {
  const chunks: string[] = [];
  let chunk = '';
  let octets = 0;
  let limit = MAX_LINE_OCTETS;
  for (const char of line) {
    const size = utf8Length(char);
    if (octets + size > limit) {
      chunks.push(chunk);
      chunk = '';
      octets = 0;
      limit = MAX_LINE_OCTETS - 1;
    }
    chunk += char;
    octets += size;
  }
  chunks.push(chunk);
  return chunks.join(`${CRLF} `);
}

/** A complete VCALENDAR (VTIMEZONE + VEVENT + VALARM) with CRLF line endings, ending in CRLF. */
export function buildIcs(event: CalendarEvent): string {
  const utc = isUtcZone(event.timeZone);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...(utc ? [] : buildVTimezone(event.timeZone, ...vtimezoneYears(event))),
    ...eventLines(event, utc),
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/** Safe ASCII file name from the title's recipient part (up to the first ':') and the start date. */
export function icsFileName(event: CalendarEvent): string {
  const label = event.title.split(':', 1)[0] ?? '';
  const slug = label
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${slug || 'whatsapp-reminder'}-${event.start.date}.ics`;
}

function isUtcZone(timeZone: string): boolean {
  return UTC_ZONE_RE.test(timeZone);
}

function vtimezoneYears(event: CalendarEvent): [number, number] {
  const startYear = parseDate(event.start.date).year;
  const untilYear = Number(/UNTIL=(\d{4})/.exec(event.rrule ?? '')?.[1] ?? 0);
  const toYear = Math.max(startYear + VTIMEZONE_MIN_YEARS, Math.min(untilYear, startYear + VTIMEZONE_MAX_YEARS));
  return [startYear, toYear];
}

function eventLines(event: CalendarEvent, utc: boolean): string[] {
  return [
    'BEGIN:VEVENT',
    `UID:${escapeText(event.uid)}`,
    `DTSTAMP:${toIcsUtc(event.dtstamp)}`,
    ...timingLines(event, utc),
    ...(event.rrule ? [`RRULE:${event.rrule}`] : []),
    `SUMMARY:${escapeText(event.title)}`,
    `DESCRIPTION:${escapeText(event.description)}`,
    ...(event.url ? [`URL:${event.url.replace(/[\x00-\x1F\x7F]/g, '')}`] : []),
    'TRANSP:TRANSPARENT',
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeText(event.title)}`,
    `TRIGGER:${formatTrigger(event.reminderMinutesBefore)}`,
    'END:VALARM',
    'END:VEVENT',
  ];
}

/**
 * DTSTART and DTEND (end = start + duration, computed in UTC). A one-off start inside a DST gap is written as the
 * wall time it resolves to, so clients cannot disagree about it. Wall times in the repeated hour of a fall-back are
 * read as the earlier instant by RFC 5545 clients and as the later one by others (ical.js), so a one-off start and
 * any end there are written in UTC instead.
 */
function timingLines(event: CalendarEvent, utc: boolean): string[] {
  const { timeZone } = event;
  const start = zonedTimeToUtc(event.start, timeZone);
  const end = new Date(start.getTime() + event.durationMinutes * 60_000);
  if (utc || (!event.rrule && wallTimeRepeats(start, timeZone))) {
    return [`DTSTART:${toIcsUtc(start)}`, `DTEND:${toIcsUtc(end)}`];
  }
  const tzid = `TZID=${paramValue(timeZone)}`;
  const startLocal = event.rrule ? event.start : utcToZoned(start, timeZone);
  return [
    `DTSTART;${tzid}:${icsLocal(startLocal)}`,
    wallTimeRepeats(end, timeZone) ? `DTEND:${toIcsUtc(end)}` : `DTEND;${tzid}:${icsLocal(utcToZoned(end, timeZone))}`,
  ];
}

/** Whether the wall time of `instant` also occurs at another instant (the repeated hour of a fall-back). */
function wallTimeRepeats(instant: Date, timeZone: string): boolean {
  const t = instant.getTime();
  const offset = offsetMinutesAt(timeZone, t);
  return [t - NEIGHBOUR_MS, t + NEIGHBOUR_MS].some((probe) => {
    const other = offsetMinutesAt(timeZone, probe);
    return other !== offset && offsetMinutesAt(timeZone, t + (offset - other) * 60_000) === other;
  });
}

/** A parameter value, quoted when it holds a character RFC 5545 allows only inside quotes (e.g. TZID="+05:30"). */
function paramValue(value: string): string {
  return /[:;,]/.test(value) ? `"${value}"` : value;
}

function icsLocal(value: LocalDateTime): string {
  return toIcsLocal(value.date, value.time);
}

/** 'PT0S' at the event time, otherwise a negative duration: '-PT10M', '-PT1H', '-P1D', '-PT1H30M', '-P1DT2H'. */
function formatTrigger(minutesBefore: number): string {
  const total = Number.isFinite(minutesBefore) ? Math.max(0, Math.round(minutesBefore)) : 0;
  if (total === 0) return 'PT0S';
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const time = `${hours ? `${hours}H` : ''}${minutes ? `${minutes}M` : ''}`;
  return `-P${days ? `${days}D` : ''}${time ? `T${time}` : ''}`;
}

function utf8Length(char: string): number {
  const cp = char.codePointAt(0) ?? 0;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}
