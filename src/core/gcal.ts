/**
 * Google Calendar "event template" links. Google's template cannot set the
 * reminder, so the event gets the user's default notification.
 */

import { toIcsLocal, toIcsUtc } from './dates';
import { utcToZoned, zonedTimeToUtc } from './timezone';
import type { CalendarEvent, LocalDateTime } from './types';

const GCAL_RENDER = 'https://calendar.google.com/calendar/render';

const UTC_ZONE = /^(?:etc\/)?(?:utc|uct|universal|zulu|greenwich|gmt(?:[+-]?0)?)$/i;

/** True for IANA names that are always UTC+0 with no DST ('UTC', 'Etc/UTC', 'GMT', 'Etc/GMT+0', ...). */
export function isUtcZone(timeZone: string): boolean {
  return UTC_ZONE.test(timeZone);
}

function eventInstants(event: CalendarEvent): { start: Date; end: Date } {
  const start = zonedTimeToUtc(event.start, event.timeZone);
  return { start, end: new Date(start.getTime() + event.durationMinutes * 60_000) };
}

function icsLocal(value: LocalDateTime): string {
  return toIcsLocal(value.date, value.time);
}

/**
 * The `dates` value: local wall times 'YYYYMMDDTHHMMSS/YYYYMMDDTHHMMSS' in the event's zone, with the end
 * computed via UTC so DST is respected. Like the .ics, a one-off start inside a DST gap is written as the wall
 * time it resolves to. Uses the UTC 'Z' form for UTC zones, and also when the end falls in the second pass of a
 * repeated DST fall-back hour, since that wall time would be read back as the first pass.
 */
function datesParam(event: CalendarEvent): string {
  const { start, end } = eventInstants(event);
  if (!isUtcZone(event.timeZone)) {
    const localStart = event.rrule ? event.start : utcToZoned(start, event.timeZone);
    const localEnd = utcToZoned(end, event.timeZone);
    const endReadsBack = zonedTimeToUtc(localEnd, event.timeZone, localEnd.second).getTime() === end.getTime();
    if (endReadsBack) return `${icsLocal(localStart)}/${icsLocal(localEnd)}`;
  }
  return `${toIcsUtc(start)}/${toIcsUtc(end)}`;
}

/**
 * Google Calendar template link:
 * https://calendar.google.com/calendar/render?action=TEMPLATE&text=..&dates=<start>/<end>&ctz=<tz>
 *   &details=..&recur=RRULE:..
 * `recur` is present only when the event repeats. Throws RangeError when the start date/time is invalid.
 */
export function buildGoogleCalendarUrl(event: CalendarEvent): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: datesParam(event),
    ctz: event.timeZone,
    details: event.description,
  });
  if (event.rrule) params.set('recur', `RRULE:${event.rrule}`);
  return `${GCAL_RENDER}?${params.toString()}`;
}
