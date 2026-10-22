/**
 * Round-2 review fixes in src/core: week start (WKST) for weekly rules, the start-year and until-date bounds,
 * DST wall-time warnings, and storage of weekStart / out-of-range intervals and counts.
 */
import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/core/dates';
import { toCalendarEvent, validateScheduledMessage } from '../../src/core/event';
import { buildGoogleCalendarUrl } from '../../src/core/gcal';
import { buildIcs } from '../../src/core/ics';
import {
  WEEKDAYS,
  alignStart,
  defaultRecurrence,
  describeRecurrence,
  occurrences,
  toRRule,
  validateRecurrence,
  weekdayOf,
} from '../../src/core/recurrence';
import { createStore, sanitizeRecurrence } from '../../src/core/storage';
import type { KeyValueStore } from '../../src/core/storage';
import type { LocalDateTime, Recurrence, RecurrenceEnd, ScheduledMessage, Weekday } from '../../src/core/types';
import { buildVTimezone } from '../../src/core/vtimezone';

type IcalZone = InstanceType<typeof ICAL.Timezone>;

const NOW = new Date('2026-10-22T10:00:00Z');
const rule = (partial: Partial<Recurrence>): Recurrence => ({ ...defaultRecurrence(), ...partial });
const at = (date: string, time = '09:00'): LocalDateTime => ({ date, time });

function makeMessage(
  overrides: Partial<ScheduledMessage> = {},
  recurrence: Partial<Recurrence> = {},
): ScheduledMessage {
  return {
    id: 'abc-123',
    recipient: { name: 'Mom', phone: '972501234567' },
    message: 'Hi',
    start: { date: '2026-10-25', time: '09:00' },
    timeZone: 'Asia/Jerusalem',
    reminderMinutesBefore: 0,
    durationMinutes: 15,
    recurrence: rule(recurrence),
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

const zoneCache = new Map<string, IcalZone>();

function icalZone(tzid: string): IcalZone {
  const cached = zoneCache.get(tzid);
  if (cached) return cached;
  const lines = ['BEGIN:VCALENDAR', ...buildVTimezone(tzid, 2020, 2040), 'END:VCALENDAR'];
  const calendar = new ICAL.Component(ICAL.parse(lines.join('\r\n')));
  const zone = new ICAL.Timezone(calendar.getFirstSubcomponent('vtimezone'));
  zoneCache.set(tzid, zone);
  return zone;
}

/** Local dates of the first `n` instances ical.js expands for `rrule` with DTSTART at `start` in `tzid`. */
function icalDates(rrule: string, start: LocalDateTime, tzid: string, n: number): string[] {
  const [year, month, day] = start.date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = start.time.split(':').map(Number) as [number, number];
  const dtstart = ICAL.Time.fromData({ year, month, day, hour, minute, second: 0, isDate: false }, icalZone(tzid));
  const iterator = ICAL.Recur.fromString(rrule).iterator(dtstart);
  const dates: string[] = [];
  for (let i = 0; i < n; i++) {
    const next = iterator.next();
    if (!next) break;
    dates.push(next.toString().slice(0, 10));
  }
  return dates;
}

describe('weekStart: toRRule', () => {
  const start = at('2026-10-25');
  const weekly = (partial: Partial<Recurrence>) => rule({ frequency: 'weekly', weekdays: ['SU', 'TU'], ...partial });

  it('adds WKST right after BYDAY for a weekly rule with interval > 1 and a non-Monday week start', () => {
    expect(toRRule(weekly({ interval: 2, weekStart: 'SU' }), start, 'Asia/Jerusalem')).toBe(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;WKST=SU',
    );
    expect(toRRule(weekly({ interval: 3, weekStart: 'SA', end: { type: 'count', count: 5 } }), start, 'UTC')).toBe(
      'FREQ=WEEKLY;INTERVAL=3;BYDAY=TU,SU;WKST=SA;COUNT=5',
    );
    const until: RecurrenceEnd = { type: 'until', date: '2026-12-31' };
    expect(toRRule(weekly({ interval: 2, weekStart: 'SU', end: until }), start, 'Asia/Jerusalem')).toBe(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;WKST=SU;UNTIL=20261231T215959Z',
    );
  });

  it('keeps the existing RRULE when the week start cannot change the expansion', () => {
    const plain = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU';
    expect(toRRule(weekly({ interval: 2 }), start, 'UTC')).toBe(plain);
    expect(toRRule(weekly({ interval: 2, weekStart: 'MO' }), start, 'UTC')).toBe(plain);
    expect(toRRule(weekly({ interval: 1, weekStart: 'SU' }), start, 'UTC')).toBe('FREQ=WEEKLY;BYDAY=TU,SU');
    expect(toRRule(rule({ frequency: 'daily', interval: 2, weekStart: 'SU' }), start, 'UTC')).toBe(
      'FREQ=DAILY;INTERVAL=2',
    );
    const monthly = rule({ frequency: 'monthly', interval: 2, weekStart: 'SU', monthlyMode: 'lastWeekday' });
    expect(toRRule(monthly, start, 'UTC')).toBe('FREQ=MONTHLY;INTERVAL=2;BYDAY=-1SU');
    expect(toRRule(rule({ frequency: 'yearly', interval: 2, weekStart: 'SU' }), start, 'UTC')).toBe(
      'FREQ=YEARLY;INTERVAL=2',
    );
  });

  it('ignores an invalid week start (Monday weeks), so the RRULE and occurrences still agree', () => {
    const rec = weekly({ interval: 2, weekStart: 'XX' as Weekday });
    expect(toRRule(rec, start, 'UTC')).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU');
    expect(occurrences(rec, start, 4)).toEqual(['2026-10-25', '2026-11-03', '2026-11-08', '2026-11-17']);
  });
});

describe('weekStart: occurrences, alignStart and describeRecurrence', () => {
  it('keeps Sunday with the following Tuesday in Sunday-start weeks (he-IL example)', () => {
    const rec = rule({ frequency: 'weekly', interval: 2, weekdays: ['SU', 'TU'], weekStart: 'SU' });
    expect(occurrences(rec, at('2026-10-25'), 5)).toEqual([
      '2026-10-25',
      '2026-10-27',
      '2026-11-08',
      '2026-11-10',
      '2026-11-22',
    ]);
    expect(describeRecurrence(rec, '2026-10-25')).toBe('Every 2 weeks on Sun, Tue');
  });

  it('pairs Sunday with the previous days in Monday-start weeks (the default)', () => {
    const rec = rule({ frequency: 'weekly', interval: 2, weekdays: ['SU', 'TU'] });
    expect(occurrences(rec, at('2026-10-25'), 5)).toEqual([
      '2026-10-25',
      '2026-11-03',
      '2026-11-08',
      '2026-11-17',
      '2026-11-22',
    ]);
    expect(describeRecurrence(rec, '2026-10-25')).toBe('Every 2 weeks on Tue, Sun');
    expect(describeRecurrence({ ...rec, weekStart: 'MO' }, '2026-10-25')).toBe('Every 2 weeks on Tue, Sun');
  });

  it('splits a Saturday + Sunday pair across Sunday-start weeks', () => {
    const rec = rule({ frequency: 'weekly', interval: 2, weekdays: ['SA', 'SU'], weekStart: 'SU' });
    expect(occurrences(rec, at('2026-10-24'), 4)).toEqual(['2026-10-24', '2026-11-01', '2026-11-07', '2026-11-15']);
    expect(occurrences({ ...rec, weekStart: 'MO' }, at('2026-10-24'), 4)).toEqual([
      '2026-10-24',
      '2026-10-25',
      '2026-11-07',
      '2026-11-08',
    ]);
  });

  it('does not change the aligned start or interval-1 rules', () => {
    for (const weekStart of WEEKDAYS) {
      const rec = rule({ frequency: 'weekly', interval: 3, weekdays: ['TU', 'TH'], weekStart });
      expect(alignStart(rec, '2026-10-25')).toBe('2026-10-27');
      expect(occurrences({ ...rec, interval: 1 }, at('2026-10-25'), 4)).toEqual([
        '2026-10-27',
        '2026-10-29',
        '2026-11-03',
        '2026-11-05',
      ]);
    }
  });

  it('lists days in week order from the week start', () => {
    const rec = rule({ frequency: 'weekly', weekdays: ['MO', 'SA', 'SU', 'WE'] });
    expect(describeRecurrence({ ...rec, weekStart: 'SU' }, '2026-10-25')).toBe('Every week on Sun, Mon, Wed, Sat');
    expect(describeRecurrence({ ...rec, weekStart: 'SA' }, '2026-10-25')).toBe('Every week on Sat, Sun, Mon, Wed');
    expect(describeRecurrence({ ...rec, weekStart: 'MO' }, '2026-10-25')).toBe('Every week on Mon, Wed, Sat, Sun');
    expect(describeRecurrence({ ...rec, weekdays: [], weekStart: 'SU' }, '2026-10-25')).toBe('Every week on Sun');
  });

  it('still says "Every weekday" whatever the week start', () => {
    for (const weekStart of WEEKDAYS) {
      const rec = rule({ frequency: 'weekly', weekdays: ['FR', 'MO', 'TU', 'WE', 'TH'], weekStart });
      expect(describeRecurrence(rec, '2026-10-26')).toBe('Every weekday');
      expect(describeRecurrence({ ...rec, interval: 2 }, '2026-10-26')).toMatch(/^Every 2 weeks on /);
    }
  });
});

describe('weekStart: validation', () => {
  it('accepts every weekday code and a missing week start', () => {
    for (const weekStart of [...WEEKDAYS, undefined]) {
      expect(validateRecurrence(rule({ frequency: 'weekly', interval: 2, weekStart }), '2026-10-25')).toEqual([]);
    }
  });

  it('rejects an invalid week start code', () => {
    for (const weekStart of ['XX', 'su', '', 'Sunday']) {
      const rec = rule({ frequency: 'weekly', interval: 2, weekStart: weekStart as Weekday });
      expect(validateRecurrence(rec, '2026-10-25')).toEqual([
        'The first day of the week must be a day from Monday to Sunday.',
      ]);
    }
  });

  it('is passed through by validateScheduledMessage', () => {
    const msg = makeMessage({}, { frequency: 'weekly', weekStart: 'XX' as Weekday });
    expect(validateScheduledMessage(msg, NOW).errors.map((e) => e.field)).toEqual(['recurrence']);
  });
});

describe('weekStart: occurrences agree with ical.js expanding the emitted RRULE', () => {
  const PAIRS: Weekday[][] = [
    ['SU', 'TU'],
    ['SA', 'SU'],
    ['FR', 'SU'],
    ['MO', 'SU'],
    ['MO', 'TH'],
    ['SU'],
    [],
    ['TU', 'FR', 'SU'],
  ];
  // Mon 2026-10-26 .. Sun 2026-11-01: a start on every weekday.
  const STARTS = Array.from({ length: 7 }, (_, i) => addDays('2026-10-26', i));
  const cases: { name: string; rec: Recurrence; start: string; zone: string }[] = [];
  for (const weekStart of ['SU', 'MO', 'SA'] as Weekday[]) {
    for (const interval of [1, 2, 3]) {
      for (const weekdays of PAIRS) {
        for (const [i, start] of STARTS.entries()) {
          const zone = i % 2 === 0 ? 'Asia/Jerusalem' : 'America/New_York';
          const rec = rule({ frequency: 'weekly', interval, weekdays, weekStart });
          const name = `WKST ${weekStart} /${interval} [${weekdays.join(',')}] from ${start}`;
          cases.push({ name, rec, start, zone });
        }
      }
    }
  }

  it.each(cases)('$name', ({ rec, start, zone }) => {
    expect(weekdayOf(start)).toBe(WEEKDAYS[STARTS.indexOf(start)]);
    const ends: RecurrenceEnd[] = [
      { type: 'never' },
      { type: 'count', count: 5 },
      { type: 'until', date: addDays(start, 45) },
    ];
    for (const end of ends) {
      const withEnd = { ...rec, end };
      const first = at(alignStart(withEnd, start));
      const rrule = toRRule(withEnd, first, zone) as string;
      const ours = occurrences(withEnd, at(start), 20);
      expect(ours, rrule).toEqual(icalDates(rrule, first, zone, 20));
      expect(ours.length).toBeGreaterThan(0);
    }
  });
});

describe('start year and until-date bounds', () => {
  const errorsOf = (msg: ScheduledMessage) => validateScheduledMessage(msg, NOW).errors;

  it('rejects start years outside 2000..2199', () => {
    for (const date of ['1999-12-31', '0202-10-25', '2200-01-01', '9999-12-31']) {
      const errors = errorsOf(makeMessage({ start: at(date, '23:50') }));
      expect(errors).toEqual([{ field: 'date', message: 'Check the year.' }]);
    }
  });

  it('accepts the edges of the range, and the calendar outputs build without throwing', () => {
    expect(errorsOf(makeMessage({ start: at('2000-01-01') })).map((e) => e.message)).toEqual([
      'That time has already passed.',
    ]);
    const last = makeMessage({ start: at('2199-12-31', '23:50') });
    expect(errorsOf(last)).toEqual([]);
    expect(() => buildIcs(toCalendarEvent(last, NOW))).not.toThrow();
    expect(() => buildGoogleCalendarUrl(toCalendarEvent(last, NOW))).not.toThrow();
    // A weekly rule from the last allowed day moves into 2200; still fine.
    const weekly = makeMessage({ start: at('2199-12-31', '23:50') }, { frequency: 'weekly', weekdays: ['MO'] });
    expect(errorsOf(weekly)).toEqual([]);
    expect(toCalendarEvent(weekly, NOW).start.date).toBe('2200-01-06');
    expect(() => buildIcs(toCalendarEvent(weekly, NOW))).not.toThrow();
  });

  it('rejects an until-date after 2199-12-31', () => {
    for (const date of ['2200-01-01', '9999-12-31']) {
      const rec = rule({ frequency: 'daily', end: { type: 'until', date } });
      expect(validateRecurrence(rec, '2026-10-25')).toEqual(['Choose an end date before 2200.']);
    }
    const lastDay = rule({ frequency: 'daily', end: { type: 'until', date: '2199-12-31' } });
    expect(validateRecurrence(lastDay, '2026-10-25')).toEqual([]);
  });
});

describe('DST wall-time warnings', () => {
  const timeWarnings = (msg: ScheduledMessage) =>
    validateScheduledMessage(msg, NOW).warnings.filter((w) => w.field === 'time').map((w) => w.message);

  it('warns when the time is skipped because the clocks go forward', () => {
    const msg = makeMessage({ start: at('2027-03-26', '02:30') });
    expect(validateScheduledMessage(msg, NOW)).toEqual({
      errors: [],
      warnings: [
        {
          field: 'time',
          message: "02:30 doesn't exist on that day because the clocks go forward. The reminder will be at 03:30.",
        },
      ],
    });
    expect(timeWarnings(makeMessage({ start: at('2027-03-14', '02:05'), timeZone: 'America/New_York' }))).toEqual([
      "02:05 doesn't exist on that day because the clocks go forward. The reminder will be at 03:05.",
    ]);
  });

  it('warns when the time happens twice because the clocks go back', () => {
    const repeated = '01:30 happens twice on that day because the clocks go back. The first one (summer time) is used.';
    expect(timeWarnings(makeMessage({ start: at('2026-10-25', '01:30') }))).toEqual([repeated]);
    expect(timeWarnings(makeMessage({ start: at('2026-11-01', '01:30'), timeZone: 'America/New_York' }))).toEqual([
      repeated,
    ]);
  });

  it('checks the aligned first occurrence, not the raw start date', () => {
    // Wed 2027-03-24, weekly on Friday: the first reminder is on Friday 2027-03-26, Israel's spring-forward day.
    const msg = makeMessage({ start: at('2027-03-24', '02:15') }, { frequency: 'weekly', weekdays: ['FR'] });
    expect(timeWarnings(msg)).toEqual([
      "02:15 doesn't exist on that day because the clocks go forward. The reminder will be at 03:15.",
    ]);
    expect(timeWarnings(makeMessage({ start: at('2027-03-26', '02:15') }, { frequency: 'weekly', weekdays: ['SU'] })))
      .toEqual([]);
  });

  it('says nothing for ordinary times, the edges of the change, or UTC', () => {
    expect(timeWarnings(makeMessage({ start: at('2027-03-26', '01:59') }))).toEqual([]);
    expect(timeWarnings(makeMessage({ start: at('2027-03-26', '03:00') }))).toEqual([]);
    expect(timeWarnings(makeMessage({ start: at('2026-10-25', '02:00') }))).toEqual([]);
    expect(timeWarnings(makeMessage({ start: at('2027-03-26', '02:30'), timeZone: 'UTC' }))).toEqual([]);
  });
});

class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

describe('storage: weekStart, interval and count', () => {
  it('keeps a valid weekStart and drops an invalid one', () => {
    expect(sanitizeRecurrence({ frequency: 'weekly', weekStart: 'SU' }).weekStart).toBe('SU');
    for (const weekStart of ['XX', 'su', 6, null, '']) {
      const rec = sanitizeRecurrence({ frequency: 'weekly', weekStart });
      expect(rec).toEqual(rule({ frequency: 'weekly' }));
      expect('weekStart' in rec).toBe(false);
    }
  });

  it('round-trips weekStart through history and the draft', () => {
    const store = createStore(new MemoryStore());
    // Weekdays are stored Monday first whatever the week start.
    const msg = makeMessage({}, { frequency: 'weekly', interval: 2, weekdays: ['TU', 'SU'], weekStart: 'SU' });
    store.saveToHistory(msg);
    expect(store.listHistory()).toEqual([msg]);
    store.saveDraft({ recurrence: msg.recurrence });
    expect(store.loadDraft()?.recurrence?.weekStart).toBe('SU');
  });

  it("caps interval and count at the validator's limits", () => {
    expect(sanitizeRecurrence({ interval: 9e15 }).interval).toBe(999);
    expect(sanitizeRecurrence({ interval: 999 }).interval).toBe(999);
    expect(sanitizeRecurrence({ interval: 1e21 }).interval).toBe(999);
    expect(sanitizeRecurrence({ end: { type: 'count', count: 5000 } }).end).toEqual({ type: 'count', count: 1000 });
    expect(sanitizeRecurrence({ end: { type: 'count', count: 1000 } }).end).toEqual({ type: 'count', count: 1000 });
    const capped = sanitizeRecurrence({ frequency: 'daily', interval: 4000, end: { type: 'count', count: 2000 } });
    expect(validateRecurrence(capped, '2026-10-25')).toEqual([]);
  });
});
