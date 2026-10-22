/**
 * Google Calendar "event template" links. Google's template cannot set the
 * reminder, so the event gets the user's default notification.
 */

import { toIcsLocal, toIcsUtc } from './dates';
import { utcToZoned, zonedTimeToUtc } from './timezone';
import type { CalendarEvent, LocalDateTime } from './types';

const GCAL_RENDER = 'https://calendar.google.com/calendar/render';

/**
 * Longest template link built when it can be helped. Google answers request URLs much longer than this (around
 * 8 KB) with an error page instead of the event form, and a long Hebrew or emoji message gets there quickly: the
 * description holds the message twice, once inside the already percent-encoded wa.me link, which is encoded again.
 */
export const GOOGLE_CALENDAR_URL_MAX_LENGTH = 8000;

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
 * `details` for a link that would be too long: the longest start of the description (cut between code points,
 * marked with '…') that still contains the whole wa.me link, which carries the full message. When even that does
 * not fit, the link alone, as the shortest details that still work.
 */
function shortenedDetails(event: CalendarEvent, fits: (details: string) => boolean): string {
  const { description, url } = event;
  const chars = [...description];
  const linkAt = url ? description.indexOf(url) : -1;
  const linkEnd = linkAt < 0 ? 0 : [...description.slice(0, linkAt + url.length)].length;
  // Never glue the ellipsis to the end of the link, where a linkifier could take it as part of the URL.
  const cut = (n: number): string => chars.slice(0, n).join('') + (linkAt >= 0 && n === linkEnd ? '\n…' : '…');
  if (!fits(cut(linkEnd))) return linkAt < 0 ? cut(0) : url;
  let keep = linkEnd; // cut(keep) fits; the predicate is monotonic from here on
  let tooMany = chars.length;
  while (tooMany - keep > 1) {
    const mid = Math.floor((keep + tooMany) / 2);
    if (fits(cut(mid))) keep = mid;
    else tooMany = mid;
  }
  return cut(keep);
}

/**
 * Google Calendar template link:
 * https://calendar.google.com/calendar/render?action=TEMPLATE&text=..&dates=<start>/<end>&ctz=<tz>
 *   &crm=AVAILABLE&trp=false&details=..&recur=RRULE:..
 * crm (current) and trp (older) both mark the event 'Free', like TRANSP:TRANSPARENT in the .ics, so a reminder does
 * not block the user's time. `recur` is present only when the event repeats. `details` is shortened when the link
 * would otherwise exceed GOOGLE_CALENDAR_URL_MAX_LENGTH, always keeping the wa.me link whole. Throws RangeError when
 * the start date/time is invalid.
 */
export function buildGoogleCalendarUrl(event: CalendarEvent): string {
  const dates = datesParam(event);
  const build = (details: string): string => {
    const params = new URLSearchParams({ action: 'TEMPLATE', text: event.title, dates, ctz: event.timeZone });
    params.set('crm', 'AVAILABLE');
    params.set('trp', 'false');
    params.set('details', details);
    if (event.rrule) params.set('recur', `RRULE:${event.rrule}`);
    return `${GCAL_RENDER}?${params.toString()}`;
  };
  const full = build(event.description);
  if (full.length <= GOOGLE_CALENDAR_URL_MAX_LENGTH) return full;
  return build(shortenedDetails(event, (details) => build(details).length <= GOOGLE_CALENDAR_URL_MAX_LENGTH));
}
