/** When a saved message next reminds the user. */

import { occurrences } from '../core/recurrence';
import { utcToZoned, zonedTimeToUtc } from '../core/timezone';
import type { LocalDateTime, ScheduledMessage } from '../core/types';

export interface NextReminder {
  /** The occurrence as it happens on the clock in the message's zone (a time skipped by DST is moved forward). */
  event: LocalDateTime;
  /** When the calendar notifies, on the clock in the message's zone. */
  reminder: LocalDateTime;
  /** The reminder instant (ms since the epoch). */
  at: number;
}

function wallTime(instant: number, timeZone: string): LocalDateTime {
  const { date, time } = utcToZoned(new Date(instant), timeZone);
  return { date, time };
}

/**
 * The first occurrence whose reminder is still ahead of `now`, or null when every reminder has gone off (or the record
 * cannot be expanded). The search widens only for long-running rules.
 */
export function nextReminder(msg: ScheduledMessage, now: Date): NextReminder | null {
  const offset = msg.reminderMinutesBefore * 60_000;
  try {
    for (const limit of [50, 500, 5000]) {
      const dates = occurrences(msg.recurrence, msg.start, limit);
      for (const date of dates) {
        const eventAt = zonedTimeToUtc({ date, time: msg.start.time }, msg.timeZone).getTime();
        const at = eventAt - offset;
        if (at > now.getTime()) {
          return { event: wallTime(eventAt, msg.timeZone), reminder: wallTime(at, msg.timeZone), at };
        }
      }
      if (dates.length < limit) return null;
    }
  } catch {
    // A record that cannot be expanded counts as done.
  }
  return null;
}
