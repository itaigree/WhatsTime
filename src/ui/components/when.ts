/** The "When" card: date + time inputs, quick picks and the time-zone line. */

import { addDays, formatTime, isValidDate, isValidTime, isoWeekdayIndex } from '../../core/dates';
import { formatOffset, offsetMinutesAt, utcToZoned, zonedTimeToUtc } from '../../core/timezone';
import type { LocalDateTime } from '../../core/types';
import { h, uid } from '../dom';
import { timeLabel } from '../format';
import { errorSlot, field } from './field';

export interface WhenSection {
  readonly element: HTMLElement;
  get(): LocalDateTime;
  set(value: LocalDateTime): void;
  /** Show `message` under the inputs, marking the named ones invalid; returns the input to focus. */
  showError(message: string, fields: readonly ('date' | 'time')[]): HTMLElement;
  clearErrors(): void;
}

/** Next full hour today, or tomorrow 09:00 when that would be after 22:00. */
export function defaultStart(now: Date, timeZone: string): LocalDateTime {
  const local = utcToZoned(now, timeZone);
  const nextHour = Number(local.time.slice(0, 2)) + 1;
  if (nextHour > 22) return { date: addDays(local.date, 1), time: '09:00' };
  return { date: local.date, time: formatTime(nextHour, 0) };
}

/** True when the wall time is valid and still ahead of `now` in `timeZone`. */
export function isFuture(value: LocalDateTime, now: Date, timeZone: string): boolean {
  return (
    isValidDate(value.date) && isValidTime(value.time) && zonedTimeToUtc(value, timeZone).getTime() > now.getTime()
  );
}

interface QuickPick {
  label: string;
  value: () => LocalDateTime;
}

function quickPicks(timeZone: string): QuickPick[] {
  const today = (): string => utcToZoned(new Date(), timeZone).date;
  const picks: QuickPick[] = [
    {
      label: 'In 1 hour',
      value: () => {
        const later = utcToZoned(new Date(Date.now() + 3_600_000), timeZone);
        return { date: later.date, time: later.time };
      },
    },
  ];
  if (utcToZoned(new Date(), timeZone).time < '20:00') {
    picks.push({ label: `Tonight ${timeLabel('20:00')}`, value: () => ({ date: today(), time: '20:00' }) });
  }
  picks.push(
    { label: `Tomorrow ${timeLabel('09:00')}`, value: () => ({ date: addDays(today(), 1), time: '09:00' }) },
    {
      label: `Next Monday ${timeLabel('09:00')}`,
      value: () => {
        const date = today();
        return { date: addDays(date, 7 - isoWeekdayIndex(date)), time: '09:00' };
      },
    },
  );
  return picks;
}

export function createWhenSection(options: { timeZone: string; onChange: () => void }): WhenSection {
  const { timeZone, onChange } = options;
  const dateInput = h('input', { type: 'date', required: true, min: utcToZoned(new Date(), timeZone).date });
  const timeInput = h('input', { type: 'time', required: true });
  const dateField = field({ label: 'Date', control: dateInput });
  const timeField = field({ label: 'Time', control: timeInput });
  const error = errorSlot();
  const zoneLine = h('p', { class: 'hint zone-line' });

  const changed = (): void => {
    error.clear();
    updateZone();
    onChange();
  };
  dateInput.addEventListener('input', changed);
  timeInput.addEventListener('input', changed);

  const picksLabelId = uid('picks');
  const titleId = uid('when');
  const element = h(
    'section',
    { class: 'card', 'aria-labelledby': titleId },
    h('h2', { class: 'card-title', id: titleId }, 'When'),
    h('div', { class: 'grid-2' }, dateField.element, timeField.element),
    error.element,
    h('p', { class: 'visually-hidden', id: picksLabelId }, 'Quick picks'),
    h(
      'div',
      { class: 'chips quick-picks', role: 'group', 'aria-labelledby': picksLabelId },
      quickPicks(timeZone).map((pick) =>
        h(
          'button',
          {
            type: 'button',
            class: 'chip',
            onClick: () => {
              set(pick.value());
              error.clear();
              onChange();
            },
          },
          pick.label,
        ),
      ),
    ),
    zoneLine,
  );

  function updateZone(): void {
    const value = get();
    const at = isValidDate(value.date) && isValidTime(value.time) ? zonedTimeToUtc(value, timeZone) : new Date();
    zoneLine.textContent = `Time zone: ${timeZone} (${formatOffset(offsetMinutesAt(timeZone, at.getTime()))})`;
  }

  function get(): LocalDateTime {
    return { date: dateInput.value, time: timeInput.value.slice(0, 5) };
  }

  function set(value: LocalDateTime): void {
    dateInput.value = value.date;
    timeInput.value = value.time;
    updateZone();
  }

  function showError(message: string, fields: readonly ('date' | 'time')[]): HTMLElement {
    const inputs = fields.map((f) => (f === 'date' ? dateInput : timeInput));
    error.show(message, inputs.length > 0 ? inputs : [dateInput]);
    return inputs[0] ?? dateInput;
  }

  updateZone();
  return { element, get, set, showError, clearErrors: () => error.clear() };
}
