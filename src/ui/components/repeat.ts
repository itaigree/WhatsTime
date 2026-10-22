/** The "Repeat" card: frequency, interval, weekdays, monthly mode, end, and a live preview. */

import { addDays, isValidDate, isValidTime, parseDate } from '../../core/dates';
import {
  WEEKDAYS,
  alignStart,
  availableMonthlyModes,
  defaultRecurrence,
  describeRecurrence,
  occurrences,
  validateRecurrence,
  weekdayOf,
} from '../../core/recurrence';
import { utcToZoned, zonedTimeToUtc } from '../../core/timezone';
import type { Frequency, LocalDateTime, MonthlyMode, Recurrence, RecurrenceEnd, Weekday } from '../../core/types';
import { h, uid } from '../dom';
import { dayLabel, userLanguage } from '../format';
import { icon } from '../icons';
import { LONG_DAY_NAMES, SHORT_DAY_NAMES, firstDayOfWeek, weekStartingOn, workweek } from '../week';
import { errorSlot, field, selectControl } from './field';

const FREQUENCIES: readonly { value: Frequency; label: string; unit: string }[] = [
  { value: 'none', label: 'Does not repeat', unit: '' },
  { value: 'daily', label: 'Daily', unit: 'day' },
  { value: 'weekly', label: 'Weekly', unit: 'week' },
  { value: 'monthly', label: 'Monthly', unit: 'month' },
  { value: 'yearly', label: 'Yearly', unit: 'year' },
];

const PREVIEW_COUNT = 5;
const DEFAULT_COUNT = 10;
/** Suggested end date when the user picks "On" without one: about three months after the start. */
const DEFAULT_UNTIL_DAYS = 91;

/** What the preview needs from the rest of the form. */
export interface RepeatContext {
  start: LocalDateTime;
  timeZone: string;
  reminderMinutes: number;
}

export interface RepeatSection {
  readonly element: HTMLElement;
  get(): Recurrence;
  set(rec: Recurrence, context: RepeatContext): void;
  /** The start, time zone or reminder changed. */
  update(context: RepeatContext): void;
  /** Show core validation problems next to the inputs they concern; returns the input to focus. */
  showErrors(messages: readonly string[]): HTMLElement;
  clearErrors(): void;
}

function ordinal(n: number): string {
  return `${n}${['th', 'st', 'nd', 'rd'][n] ?? 'th'}`;
}

function monthlyLabel(mode: MonthlyMode, date: string): string {
  const { day } = parseDate(date);
  const weekday = LONG_DAY_NAMES[weekdayOf(date)];
  switch (mode) {
    case 'dayOfMonth':
      return `On day ${day}`;
    case 'nthWeekday':
      return `On the ${ordinal(Math.ceil(day / 7))} ${weekday}`;
    case 'lastWeekday':
      return `On the last ${weekday}`;
    case 'lastDay':
      return 'On the last day';
  }
}

const isWholeNumberIn = (value: number, min: number, max: number): boolean =>
  Number.isInteger(value) && value >= min && value <= max;

/** '' -> NaN so an empty box fails validation instead of silently becoming 0. */
const numberValue = (input: HTMLInputElement): number => (input.value.trim() === '' ? NaN : Number(input.value));

/** The date the reminder goes off for an occurrence on `date` (a "1 day before" reminder moves it back). */
function reminderDate(date: string, context: RepeatContext): string {
  if (!isValidTime(context.start.time) || context.reminderMinutes === 0) return date;
  const at = zonedTimeToUtc({ date, time: context.start.time }, context.timeZone).getTime();
  return utcToZoned(new Date(at - context.reminderMinutes * 60_000), context.timeZone).date;
}

export function createRepeatSection(options: { region: string; onChange: () => void }): RepeatSection {
  const { onChange } = options;
  let context: RepeatContext | null = null;
  let monthlyMode: MonthlyMode = 'dayOfMonth';
  const selectedDays = new Set<Weekday>();

  const frequencySelect = selectControl(
    FREQUENCIES.map((f) => ({ value: f.value, label: f.label })),
    'none',
  );
  const frequencyField = field({ label: 'Repeat', control: frequencySelect, labelClass: 'card-title' });

  // Every [n] unit(s)
  const intervalInput = h('input', {
    type: 'number',
    inputmode: 'numeric',
    min: 1,
    max: 999,
    step: 1,
    value: '1',
    class: 'input-number',
  });
  intervalInput.id = uid('interval');
  const unitText = h('span', { class: 'unit', id: uid('unit') });
  intervalInput.setAttribute('aria-describedby', unitText.id);
  const intervalRow = h(
    'div',
    { class: 'inline-field' },
    h('label', { for: intervalInput.id }, 'Every'),
    intervalInput,
    unitText,
  );

  // Weekly: toggle buttons in the user's week order, plus a working-week shortcut.
  const dayButtons = new Map<Weekday, HTMLButtonElement>();
  const daysHint = h('p', { class: 'hint', 'aria-live': 'polite' });
  for (const day of weekStartingOn(firstDayOfWeek(userLanguage()))) {
    dayButtons.set(
      day,
      h(
        'button',
        {
          type: 'button',
          class: 'day-toggle',
          'aria-pressed': false,
          'aria-label': LONG_DAY_NAMES[day],
          onClick: () => toggleDay(day),
        },
        SHORT_DAY_NAMES[day],
      ),
    );
  }
  const week = workweek(options.region);
  const daysLabelId = uid('days');
  const weeklyBlock = h(
    'div',
    { class: 'weekly' },
    h(
      'div',
      { class: 'row-between' },
      h('p', { class: 'subhead', id: daysLabelId }, 'Repeat on'),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-text btn-small',
          onClick: () => {
            setDays(week.days);
            changed();
          },
        },
        week.label,
      ),
    ),
    h('div', { class: 'day-toggles', role: 'group', 'aria-labelledby': daysLabelId }, [...dayButtons.values()]),
    daysHint,
  );

  // Monthly: which day of the month.
  const monthlyName = uid('monthly');
  const monthlyOptions = h('div', { class: 'radio-list' });
  const monthlyBlock = h(
    'fieldset',
    { class: 'fieldset' },
    h('legend', { class: 'subhead' }, 'Day of the month'),
    monthlyOptions,
  );

  // Ends: never / on a date / after n times.
  const endName = uid('end');
  const endRadio = (value: RecurrenceEnd['type']): HTMLInputElement =>
    h('input', { type: 'radio', name: endName, value, checked: value === 'never', onChange: endChanged });
  const neverRadio = endRadio('never');
  const untilRadio = endRadio('until');
  const countRadio = endRadio('count');
  const untilInput = h('input', { type: 'date', 'aria-label': 'End date', onInput: () => chooseEnd(untilRadio) });
  const countInput = h('input', {
    type: 'number',
    inputmode: 'numeric',
    min: 1,
    max: 1000,
    step: 1,
    value: String(DEFAULT_COUNT),
    class: 'input-number',
    'aria-label': 'Number of times',
    onInput: () => chooseEnd(countRadio),
  });
  const endsBlock = h(
    'fieldset',
    { class: 'fieldset' },
    h('legend', { class: 'subhead' }, 'Ends'),
    h(
      'div',
      { class: 'radio-list' },
      h('label', { class: 'radio-row' }, neverRadio, h('span', null, 'Never')),
      h(
        'div',
        { class: 'radio-row' },
        h('label', { class: 'radio-label' }, untilRadio, h('span', null, 'On')),
        untilInput,
      ),
      h(
        'div',
        { class: 'radio-row' },
        h('label', { class: 'radio-label' }, countRadio, h('span', null, 'After')),
        countInput,
        h('span', { class: 'unit', 'aria-hidden': 'true' }, 'times'),
      ),
    ),
  );

  const error = errorSlot();
  const summaryText = h('p', { class: 'summary-title' });
  const startNote = h('p', { class: 'summary-line' });
  const nextText = h('p', { class: 'summary-line' });
  const summary = h('div', { class: 'summary' }, icon('repeat'), h('div', null, summaryText, startNote, nextText));
  const details = h('div', { class: 'stack repeat-details' }, intervalRow, weeklyBlock, monthlyBlock, endsBlock);

  const element = h('section', { class: 'card' }, frequencyField.element, details, error.element, summary);
  frequencySelect.addEventListener('change', () => {
    if (frequency() === 'weekly' && selectedDays.size === 0 && context && isValidDate(context.start.date)) {
      setDays([weekdayOf(context.start.date)]);
    }
    changed();
  });
  intervalInput.addEventListener('input', changed);

  function frequency(): Frequency {
    const value = frequencySelect.value;
    return FREQUENCIES.find((f) => f.value === value)?.value ?? 'none';
  }

  function changed(): void {
    error.clear();
    render();
    onChange();
  }

  function chooseEnd(radio: HTMLInputElement): void {
    radio.checked = true;
    changed();
  }

  function endChanged(): void {
    const startDate = context?.start.date ?? '';
    if (untilRadio.checked && !untilInput.value && isValidDate(startDate)) {
      untilInput.value = addDays(startDate, DEFAULT_UNTIL_DAYS);
    }
    changed();
  }

  function setDays(days: readonly Weekday[]): void {
    selectedDays.clear();
    for (const day of days) selectedDays.add(day);
    daysHint.textContent = '';
  }

  function toggleDay(day: Weekday): void {
    if (selectedDays.has(day)) {
      if (selectedDays.size === 1) {
        daysHint.textContent = 'Keep at least one day selected.';
        return;
      }
      selectedDays.delete(day);
    } else {
      selectedDays.add(day);
    }
    daysHint.textContent = '';
    changed();
  }

  function end(): RecurrenceEnd {
    if (untilRadio.checked) return { type: 'until', date: untilInput.value };
    if (countRadio.checked) return { type: 'count', count: numberValue(countInput) };
    return { type: 'never' };
  }

  function get(): Recurrence {
    const freq = frequency();
    return {
      frequency: freq,
      interval: numberValue(intervalInput),
      weekdays: freq === 'weekly' ? WEEKDAYS.filter((day) => selectedDays.has(day)) : [],
      monthlyMode,
      end: end(),
    };
  }

  function renderMonthly(date: string): void {
    const modes = availableMonthlyModes(date);
    if (!modes.includes(monthlyMode)) monthlyMode = 'dayOfMonth';
    monthlyOptions.replaceChildren(
      ...modes.map((mode) =>
        h(
          'label',
          { class: 'radio-row' },
          h('input', {
            type: 'radio',
            name: monthlyName,
            value: mode,
            checked: mode === monthlyMode,
            onChange: () => {
              monthlyMode = mode;
              changed();
            },
          }),
          h('span', null, isValidDate(date) ? monthlyLabel(mode, date) : 'On the same day'),
        ),
      ),
    );
  }

  function render(): void {
    const freq = frequency();
    const repeating = freq !== 'none';
    details.hidden = !repeating;
    weeklyBlock.hidden = freq !== 'weekly';
    monthlyBlock.hidden = freq !== 'monthly';
    const interval = numberValue(intervalInput);
    const unit = FREQUENCIES.find((f) => f.value === freq)?.unit ?? '';
    unitText.textContent = interval === 1 ? unit : `${unit}s`;
    for (const [day, button] of dayButtons) button.setAttribute('aria-pressed', String(selectedDays.has(day)));
    renderSummary();
  }

  function renderSummary(): void {
    const rec = get();
    const start = context?.start;
    if (
      !context ||
      !start ||
      rec.frequency === 'none' ||
      !isValidDate(start.date) ||
      validateRecurrence(rec, start.date).length > 0
    ) {
      summary.hidden = true;
      return;
    }
    summary.hidden = false;
    const first = alignStart(rec, start.date);
    summaryText.textContent = describeRecurrence(rec, first);
    startNote.textContent = first === start.date ? '' : `Starts ${dayLabel(first)}, the first matching day.`;
    startNote.hidden = first === start.date;
    const ctx = context;
    const dates = occurrences(rec, start, PREVIEW_COUNT).map((date) => dayLabel(reminderDate(date, ctx)));
    nextText.textContent = `Next reminders: ${dates.join(' · ')}`;
  }

  function update(next: RepeatContext): void {
    const previousDate = context?.start.date;
    context = next;
    const date = next.start.date;
    if (isValidDate(date) && date !== previousDate) {
      // A weekly selection that only ever followed the start date keeps following it.
      const onlyDay = selectedDays.size === 1 ? [...selectedDays][0] : undefined;
      if (previousDate && isValidDate(previousDate) && onlyDay === weekdayOf(previousDate)) setDays([weekdayOf(date)]);
      if (selectedDays.size === 0) setDays([weekdayOf(date)]);
      renderMonthly(date);
      untilInput.min = date;
    }
    render();
  }

  function set(rec: Recurrence, next: RepeatContext): void {
    const defaults = defaultRecurrence();
    frequencySelect.value = FREQUENCIES.some((f) => f.value === rec.frequency) ? rec.frequency : defaults.frequency;
    intervalInput.value = String(rec.interval);
    monthlyMode = rec.monthlyMode;
    setDays(rec.weekdays);
    neverRadio.checked = rec.end.type === 'never';
    untilRadio.checked = rec.end.type === 'until';
    countRadio.checked = rec.end.type === 'count';
    untilInput.value = rec.end.type === 'until' ? rec.end.date : '';
    countInput.value = String(rec.end.type === 'count' ? rec.end.count : DEFAULT_COUNT);
    context = null;
    update(next);
    error.clear();
  }

  function showErrors(messages: readonly string[]): HTMLElement {
    const rec = get();
    const targets: HTMLElement[] = [];
    if (!isWholeNumberIn(rec.interval, 1, 999)) targets.push(intervalInput);
    if (rec.end.type === 'count' && !isWholeNumberIn(rec.end.count, 1, 1000)) targets.push(countInput);
    if (rec.end.type === 'until') {
      const startDate = context?.start.date ?? '';
      const first = isValidDate(startDate) ? alignStart(rec, startDate) : '';
      if (!isValidDate(rec.end.date) || rec.end.date < first) targets.push(untilInput);
    }
    if (targets.length === 0) targets.push(frequencySelect);
    error.show(messages.join(' '), targets);
    return targets[0] ?? frequencySelect;
  }

  render();
  return { element, get, set, update, showErrors, clearErrors: () => error.clear() };
}
