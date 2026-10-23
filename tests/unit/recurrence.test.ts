import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/core/dates';
import {
  WEEKDAYS,
  alignStart,
  availableMonthlyModes,
  defaultRecurrence,
  describeRecurrence,
  occurrences,
  toRRule,
  validateRecurrence,
  weekdayOf,
} from '../../src/core/recurrence';
import { zonedTimeToUtc } from '../../src/core/timezone';
import type { Frequency, LocalDateTime, MonthlyMode, Recurrence, RecurrenceEnd, Weekday } from '../../src/core/types';

type IcalZone = InstanceType<typeof ICAL.Timezone>;

const rule = (partial: Partial<Recurrence>): Recurrence => ({ ...defaultRecurrence(), ...partial });
const at = (date: string, time = '09:00'): LocalDateTime => ({ date, time });

/** Hand-written VTIMEZONEs (current rules) so ical.js can expand rules in a real zone without other modules. */
const VTIMEZONES: Record<string, string[]> = {
  'Asia/Jerusalem': [
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Jerusalem',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0300',
    'DTSTART:20130329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=FR;BYMONTHDAY=23,24,25,26,27,28,29',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0300',
    'TZOFFSETTO:+0200',
    'DTSTART:20131027T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ],
  'America/New_York': [
    'BEGIN:VTIMEZONE',
    'TZID:America/New_York',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:-0500',
    'TZOFFSETTO:-0400',
    'DTSTART:20070311T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0400',
    'TZOFFSETTO:-0500',
    'DTSTART:20071104T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ],
};

const zoneCache = new Map<string, IcalZone>();

function icalZone(tzid: string): IcalZone {
  const cached = zoneCache.get(tzid);
  if (cached) return cached;
  const lines = VTIMEZONES[tzid];
  if (!lines) throw new Error(`No VTIMEZONE fixture for ${tzid}`);
  const calendar = new ICAL.Component(ICAL.parse(['BEGIN:VCALENDAR', ...lines, 'END:VCALENDAR'].join('\r\n')));
  const zone = new ICAL.Timezone(calendar.getFirstSubcomponent('vtimezone'));
  zoneCache.set(tzid, zone);
  return zone;
}

function icalTime(start: LocalDateTime, tzid: string) {
  const [year, month, day] = start.date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = start.time.split(':').map(Number) as [number, number];
  return ICAL.Time.fromData({ year, month, day, hour, minute, second: 0, isDate: false }, icalZone(tzid));
}

/** Local dates of the first `n` instances ical.js expands for `rrule` with DTSTART at `start` in `tzid`. */
function icalDates(rrule: string, start: LocalDateTime, tzid: string, n: number): string[] {
  const iterator = ICAL.Recur.fromString(rrule).iterator(icalTime(start, tzid));
  const dates: string[] = [];
  for (let i = 0; i < n; i++) {
    const next = iterator.next();
    if (!next) break;
    dates.push(next.toString().slice(0, 10));
  }
  return dates;
}

/** Expands with ical.js exactly the way a calendar would: DTSTART is the aligned start. */
function crossCheck(rec: Recurrence, start: LocalDateTime, tzid: string, n = 25): { ours: string[]; theirs: string[] } {
  const rrule = toRRule(rec, start, tzid);
  if (rrule === null) throw new Error('expected a repeating rule');
  const first = { date: alignStart(rec, start.date), time: start.time };
  return { ours: occurrences(rec, start, n), theirs: icalDates(rrule, first, tzid, n) };
}

describe('constants and helpers', () => {
  it('lists RFC 5545 weekday codes Monday first', () => {
    expect(WEEKDAYS).toEqual(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
  });

  it('builds a default non-repeating rule', () => {
    expect(defaultRecurrence()).toEqual({
      frequency: 'none',
      interval: 1,
      weekdays: [],
      monthlyMode: 'dayOfMonth',
      end: { type: 'never' },
    });
    expect(defaultRecurrence()).not.toBe(defaultRecurrence());
  });

  it('computes the weekday of a date', () => {
    expect(weekdayOf('2026-10-19')).toBe('MO');
    expect(weekdayOf('2026-10-22')).toBe('TH');
    expect(weekdayOf('2026-10-25')).toBe('SU');
    expect(weekdayOf('2024-02-29')).toBe('TH');
    expect(weekdayOf('2000-01-01')).toBe('SA');
    expect(() => weekdayOf('2026-02-30')).toThrow(RangeError);
  });
});

describe('availableMonthlyModes', () => {
  it.each<[string, MonthlyMode[]]>([
    ['2026-10-01', ['dayOfMonth', 'nthWeekday']],
    ['2026-10-22', ['dayOfMonth', 'nthWeekday']],
    ['2026-10-24', ['dayOfMonth', 'nthWeekday']],
    ['2026-10-25', ['dayOfMonth', 'nthWeekday', 'lastWeekday']],
    ['2026-10-28', ['dayOfMonth', 'nthWeekday', 'lastWeekday']],
    ['2026-10-29', ['dayOfMonth', 'lastWeekday']],
    ['2026-10-30', ['dayOfMonth', 'lastWeekday']],
    ['2026-10-31', ['dayOfMonth', 'lastWeekday', 'lastDay']],
    ['2026-11-23', ['dayOfMonth', 'nthWeekday']],
    ['2026-11-24', ['dayOfMonth', 'nthWeekday', 'lastWeekday']],
    ['2026-11-30', ['dayOfMonth', 'lastWeekday', 'lastDay']],
    ['2026-02-21', ['dayOfMonth', 'nthWeekday']],
    ['2026-02-22', ['dayOfMonth', 'nthWeekday', 'lastWeekday']],
    ['2026-02-28', ['dayOfMonth', 'nthWeekday', 'lastWeekday', 'lastDay']],
    ['2024-02-28', ['dayOfMonth', 'nthWeekday', 'lastWeekday']],
    ['2024-02-29', ['dayOfMonth', 'lastWeekday', 'lastDay']],
  ])('%s -> %j', (date, modes) => {
    expect(availableMonthlyModes(date)).toEqual(modes);
  });

  it('offers only dayOfMonth for an invalid date', () => {
    expect(availableMonthlyModes('')).toEqual(['dayOfMonth']);
    expect(availableMonthlyModes('2026-02-30')).toEqual(['dayOfMonth']);
  });
});

describe('alignStart', () => {
  it.each<[string, Partial<Recurrence>, string, string]>([
    ['none', { frequency: 'none' }, '2026-10-22', '2026-10-22'],
    ['daily', { frequency: 'daily', interval: 3 }, '2026-10-22', '2026-10-22'],
    ['weekly, no days selected', { frequency: 'weekly' }, '2026-10-22', '2026-10-22'],
    ['weekly, start weekday selected', { frequency: 'weekly', weekdays: ['MO', 'TH'] }, '2026-10-22', '2026-10-22'],
    ['weekly, next Monday', { frequency: 'weekly', weekdays: ['MO'] }, '2026-10-22', '2026-10-26'],
    ['weekly, nearest selected day', { frequency: 'weekly', weekdays: ['TU', 'SA'] }, '2026-10-22', '2026-10-24'],
    ['weekly, day before start', { frequency: 'weekly', weekdays: ['WE'] }, '2026-10-22', '2026-10-28'],
    ['weekly, across a year', { frequency: 'weekly', weekdays: ['SU'] }, '2026-12-28', '2027-01-03'],
    ['weekly, interval ignored', { frequency: 'weekly', interval: 3, weekdays: ['FR'] }, '2026-10-22', '2026-10-23'],
    ['monthly dayOfMonth', { frequency: 'monthly', monthlyMode: 'dayOfMonth' }, '2026-10-31', '2026-10-31'],
    ['monthly nthWeekday', { frequency: 'monthly', monthlyMode: 'nthWeekday' }, '2026-10-20', '2026-10-20'],
    ['monthly lastWeekday', { frequency: 'monthly', monthlyMode: 'lastWeekday' }, '2026-10-30', '2026-10-30'],
    ['monthly lastWeekday early', { frequency: 'monthly', monthlyMode: 'lastWeekday' }, '2026-10-01', '2026-10-29'],
    ['monthly lastDay', { frequency: 'monthly', monthlyMode: 'lastDay' }, '2026-10-31', '2026-10-31'],
    ['monthly lastDay mid-Feb', { frequency: 'monthly', monthlyMode: 'lastDay' }, '2026-02-10', '2026-02-28'],
    ['monthly lastDay mid-Feb leap', { frequency: 'monthly', monthlyMode: 'lastDay' }, '2024-02-10', '2024-02-29'],
    ['yearly', { frequency: 'yearly' }, '2026-10-22', '2026-10-22'],
    ['yearly Feb 29', { frequency: 'yearly', interval: 2 }, '2024-02-29', '2024-02-29'],
  ])('%s', (_name, partial, start, expected) => {
    expect(alignStart(rule(partial), start)).toBe(expected);
  });

  it('returns an invalid start date unchanged', () => {
    expect(alignStart(rule({ frequency: 'weekly', weekdays: ['MO'] }), '')).toBe('');
    expect(alignStart(rule({ frequency: 'daily' }), '2026-02-30')).toBe('2026-02-30');
  });
});

describe('toRRule', () => {
  const tz = 'Asia/Jerusalem';

  it('returns null for a one-off event', () => {
    expect(toRRule(rule({ frequency: 'none' }), at('2026-10-22'), tz)).toBeNull();
    expect(toRRule(rule({ frequency: 'none', end: { type: 'count', count: 5 } }), at('2026-10-22'), tz)).toBeNull();
  });

  it.each<[string, Partial<Recurrence>, string, string]>([
    ['daily', { frequency: 'daily' }, '2026-10-22', 'FREQ=DAILY'],
    ['daily interval', { frequency: 'daily', interval: 3 }, '2026-10-22', 'FREQ=DAILY;INTERVAL=3'],
    ['interval 1 omitted', { frequency: 'weekly', interval: 1 }, '2026-10-22', 'FREQ=WEEKLY;BYDAY=TH'],
    ['weekly start weekday', { frequency: 'weekly' }, '2026-10-25', 'FREQ=WEEKLY;BYDAY=SU'],
    [
      'weekly days sorted and deduplicated',
      { frequency: 'weekly', weekdays: ['FR', 'MO', 'WE', 'MO'] },
      '2026-10-23',
      'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    ],
    [
      'weekly interval and count',
      { frequency: 'weekly', interval: 2, weekdays: ['SU'], end: { type: 'count', count: 10 } },
      '2026-10-25',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU;COUNT=10',
    ],
    [
      'weekly all days',
      { frequency: 'weekly', weekdays: ['SU', 'SA', 'FR', 'TH', 'WE', 'TU', 'MO'] },
      '2026-10-22',
      'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU',
    ],
    ['monthly dayOfMonth', { frequency: 'monthly' }, '2026-10-22', 'FREQ=MONTHLY;BYMONTHDAY=22'],
    ['monthly day 31', { frequency: 'monthly', monthlyMode: 'dayOfMonth' }, '2026-01-31', 'FREQ=MONTHLY;BYMONTHDAY=31'],
    ['monthly 1st weekday', { frequency: 'monthly', monthlyMode: 'nthWeekday' }, '2026-10-01', 'FREQ=MONTHLY;BYDAY=1TH'],
    ['monthly 3rd Tuesday', { frequency: 'monthly', monthlyMode: 'nthWeekday' }, '2026-10-20', 'FREQ=MONTHLY;BYDAY=3TU'],
    ['monthly 4th weekday', { frequency: 'monthly', monthlyMode: 'nthWeekday' }, '2026-10-28', 'FREQ=MONTHLY;BYDAY=4WE'],
    ['monthly last Friday', { frequency: 'monthly', monthlyMode: 'lastWeekday' }, '2026-10-30', 'FREQ=MONTHLY;BYDAY=-1FR'],
    ['monthly last day', { frequency: 'monthly', monthlyMode: 'lastDay' }, '2026-10-31', 'FREQ=MONTHLY;BYMONTHDAY=-1'],
    [
      'monthly interval',
      { frequency: 'monthly', interval: 2, monthlyMode: 'lastWeekday', end: { type: 'count', count: 4 } },
      '2026-11-26',
      'FREQ=MONTHLY;INTERVAL=2;BYDAY=-1TH;COUNT=4',
    ],
    ['yearly', { frequency: 'yearly' }, '2026-10-22', 'FREQ=YEARLY'],
    ['yearly interval', { frequency: 'yearly', interval: 2 }, '2026-10-22', 'FREQ=YEARLY;INTERVAL=2'],
    ['yearly Feb 28', { frequency: 'yearly' }, '2024-02-28', 'FREQ=YEARLY'],
    ['yearly Feb 29', { frequency: 'yearly' }, '2024-02-29', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29'],
    [
      'yearly Feb 29 with interval and count',
      { frequency: 'yearly', interval: 4, end: { type: 'count', count: 3 } },
      '2024-02-29',
      'FREQ=YEARLY;INTERVAL=4;BYMONTH=2;BYMONTHDAY=29;COUNT=3',
    ],
    ['count 1', { frequency: 'daily', end: { type: 'count', count: 1 } }, '2026-10-22', 'FREQ=DAILY;COUNT=1'],
    ['invalid interval falls back to 1', { frequency: 'daily', interval: 0 }, '2026-10-22', 'FREQ=DAILY'],
  ])('%s', (_name, partial, date, expected) => {
    expect(toRRule(rule(partial), at(date), tz)).toBe(expected);
  });

  describe('UNTIL is 23:59:59 local on the until-date, in UTC', () => {
    it.each<[string, string, string]>([
      ['Asia/Jerusalem', '2026-12-31', '20261231T215959Z'],
      ['Asia/Jerusalem', '2026-07-15', '20260715T205959Z'],
      ['Asia/Jerusalem', '2026-10-25', '20261025T215959Z'],
      ['Asia/Jerusalem', '2026-03-27', '20260327T205959Z'],
      ['America/New_York', '2026-12-31', '20270101T045959Z'],
      ['America/New_York', '2026-07-04', '20260705T035959Z'],
      ['America/New_York', '2026-03-08', '20260309T035959Z'],
      ['America/New_York', '2026-11-01', '20261102T045959Z'],
      ['UTC', '2026-12-31', '20261231T235959Z'],
      ['Asia/Kolkata', '2026-12-31', '20261231T182959Z'],
    ])('%s until %s', (zone, until, expected) => {
      const rec = rule({ frequency: 'daily', end: { type: 'until', date: until } });
      expect(toRRule(rec, at('2026-01-01'), zone)).toBe(`FREQ=DAILY;UNTIL=${expected}`);
      const instant = zonedTimeToUtc({ date: until, time: '23:59' }, zone, 59);
      expect(instant.toISOString().replace(/[-:]|\.\d{3}/g, '')).toBe(expected);
    });

    it('puts UNTIL after the BY parts', () => {
      const rec = rule({ frequency: 'weekly', interval: 2, weekdays: ['TU', 'TH'], end: { type: 'until', date: '2027-01-31' } });
      expect(toRRule(rec, at('2026-10-22'), 'America/New_York')).toBe(
        'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20270201T045959Z',
      );
    });

    it('ignores an invalid until date rather than emitting a broken UNTIL', () => {
      const rec = rule({ frequency: 'daily', end: { type: 'until', date: '2026-02-30' } });
      expect(toRRule(rec, at('2026-01-01'), 'Asia/Jerusalem')).toBe('FREQ=DAILY');
    });
  });
});

describe('occurrences', () => {
  it('returns the start date for a one-off event', () => {
    expect(occurrences(rule({ frequency: 'none' }), at('2026-10-22'), 5)).toEqual(['2026-10-22']);
    expect(occurrences(rule({ frequency: 'none' }), at('2026-10-22'), 1)).toEqual(['2026-10-22']);
    expect(occurrences(rule({ frequency: 'none' }), at('2026-10-22'), 0)).toEqual([]);
  });

  it('expands daily rules with an interval across a year boundary', () => {
    expect(occurrences(rule({ frequency: 'daily' }), at('2026-12-30'), 4)).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
    expect(occurrences(rule({ frequency: 'daily', interval: 3 }), at('2026-12-28'), 4)).toEqual([
      '2026-12-28',
      '2026-12-31',
      '2027-01-03',
      '2027-01-06',
    ]);
  });

  it('expands weekly rules from the aligned start', () => {
    expect(occurrences(rule({ frequency: 'weekly' }), at('2026-10-22'), 3)).toEqual(['2026-10-22', '2026-10-29', '2026-11-05']);
    expect(occurrences(rule({ frequency: 'weekly', weekdays: ['MO', 'WE', 'FR'] }), at('2026-10-22'), 5)).toEqual([
      '2026-10-23',
      '2026-10-26',
      '2026-10-28',
      '2026-10-30',
      '2026-11-02',
    ]);
  });

  it('uses Monday-based weeks for weekly intervals', () => {
    expect(occurrences(rule({ frequency: 'weekly', interval: 2, weekdays: ['SU', 'MO'] }), at('2026-10-25'), 6)).toEqual([
      '2026-10-25',
      '2026-11-02',
      '2026-11-08',
      '2026-11-16',
      '2026-11-22',
      '2026-11-30',
    ]);
    expect(occurrences(rule({ frequency: 'weekly', interval: 3, weekdays: ['TU'] }), at('2026-10-22'), 3)).toEqual([
      '2026-10-27',
      '2026-11-17',
      '2026-12-08',
    ]);
  });

  it('skips months without the start day for dayOfMonth', () => {
    expect(occurrences(rule({ frequency: 'monthly' }), at('2026-01-31'), 7)).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
      '2026-07-31',
      '2026-08-31',
      '2026-10-31',
      '2026-12-31',
    ]);
    expect(occurrences(rule({ frequency: 'monthly' }), at('2026-01-30'), 3)).toEqual(['2026-01-30', '2026-03-30', '2026-04-30']);
    expect(occurrences(rule({ frequency: 'monthly' }), at('2027-01-29'), 3)).toEqual(['2027-01-29', '2027-03-29', '2027-04-29']);
    expect(occurrences(rule({ frequency: 'monthly' }), at('2028-01-29'), 3)).toEqual(['2028-01-29', '2028-02-29', '2028-03-29']);
    expect(occurrences(rule({ frequency: 'monthly', interval: 2 }), at('2026-01-31'), 6)).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
      '2026-07-31',
      '2027-01-31',
      '2027-03-31',
    ]);
  });

  it('expands nth weekday, last weekday and last day modes', () => {
    expect(occurrences(rule({ frequency: 'monthly', monthlyMode: 'nthWeekday' }), at('2026-10-20'), 4)).toEqual([
      '2026-10-20',
      '2026-11-17',
      '2026-12-15',
      '2027-01-19',
    ]);
    expect(occurrences(rule({ frequency: 'monthly', monthlyMode: 'lastWeekday' }), at('2026-10-30'), 5)).toEqual([
      '2026-10-30',
      '2026-11-27',
      '2026-12-25',
      '2027-01-29',
      '2027-02-26',
    ]);
    expect(occurrences(rule({ frequency: 'monthly', monthlyMode: 'lastDay' }), at('2026-01-31'), 4)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
    expect(occurrences(rule({ frequency: 'monthly', monthlyMode: 'lastDay', interval: 3 }), at('2023-11-30'), 3)).toEqual([
      '2023-11-30',
      '2024-02-29',
      '2024-05-31',
    ]);
  });

  it('skips months without a 5th weekday when nthWeekday is used on a late start', () => {
    expect(occurrences(rule({ frequency: 'monthly', monthlyMode: 'nthWeekday' }), at('2026-09-29'), 5)).toEqual([
      '2026-09-29',
      '2026-12-29',
      '2027-03-30',
      '2027-06-29',
      '2027-08-31',
    ]);
  });

  it('repeats Feb 29 only in leap years', () => {
    expect(occurrences(rule({ frequency: 'yearly' }), at('2024-02-29'), 4)).toEqual([
      '2024-02-29',
      '2028-02-29',
      '2032-02-29',
      '2036-02-29',
    ]);
    expect(occurrences(rule({ frequency: 'yearly', interval: 3 }), at('2024-02-29'), 3)).toEqual([
      '2024-02-29',
      '2036-02-29',
      '2048-02-29',
    ]);
    expect(occurrences(rule({ frequency: 'yearly' }), at('2096-02-29'), 2)).toEqual(['2096-02-29', '2104-02-29']);
    expect(occurrences(rule({ frequency: 'yearly', interval: 2 }), at('2026-10-22'), 3)).toEqual([
      '2026-10-22',
      '2028-10-22',
      '2030-10-22',
    ]);
  });

  it('honours COUNT, including the first occurrence', () => {
    const rec = rule({ frequency: 'daily', end: { type: 'count', count: 3 } });
    expect(occurrences(rec, at('2026-10-22'), 10)).toEqual(['2026-10-22', '2026-10-23', '2026-10-24']);
    expect(occurrences(rec, at('2026-10-22'), 2)).toEqual(['2026-10-22', '2026-10-23']);
    const once = rule({ frequency: 'weekly', weekdays: ['MO'], end: { type: 'count', count: 1 } });
    expect(occurrences(once, at('2026-10-22'), 5)).toEqual(['2026-10-26']);
  });

  it('includes an occurrence on the until-date', () => {
    const daily = rule({ frequency: 'daily', end: { type: 'until', date: '2026-12-31' } });
    expect(occurrences(daily, at('2026-12-29', '23:59'), 10)).toEqual(['2026-12-29', '2026-12-30', '2026-12-31']);
    const weekly = rule({ frequency: 'weekly', weekdays: ['MO'], end: { type: 'until', date: '2026-11-16' } });
    expect(occurrences(weekly, at('2026-10-22'), 10)).toEqual(['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']);
    const sameDay = rule({ frequency: 'monthly', end: { type: 'until', date: '2026-10-22' } });
    expect(occurrences(sameDay, at('2026-10-22'), 10)).toEqual(['2026-10-22']);
  });

  it('returns nothing when UNTIL is before the aligned start', () => {
    const rec = rule({ frequency: 'weekly', weekdays: ['MO'], end: { type: 'until', date: '2026-10-25' } });
    expect(occurrences(rec, at('2026-10-22'), 10)).toEqual([]);
  });

  it('terminates quickly for extreme or invalid input', () => {
    const started = performance.now();
    expect(occurrences(rule({ frequency: 'daily' }), at('2026-10-22'), Number.POSITIVE_INFINITY)).toHaveLength(5000);
    expect(occurrences(rule({ frequency: 'yearly' }), at('9996-02-29'), 10)).toEqual(['9996-02-29']);
    expect(occurrences(rule({ frequency: 'weekly', weekdays: ['MO', 'SU'] }), at('9999-12-20'), 10)).toEqual([
      '9999-12-20',
      '9999-12-26',
      '9999-12-27',
    ]);
    expect(occurrences(rule({ frequency: 'daily', interval: 999 }), at('9990-01-01'), 10)).toEqual([
      '9990-01-01',
      '9992-09-26',
      '9995-06-22',
      '9998-03-17',
    ]);
    const monthly = occurrences(rule({ frequency: 'monthly', interval: 999 }), at('9000-01-31'), 50);
    expect(monthly).toHaveLength(10);
    expect(monthly.slice(0, 3)).toEqual(['9000-01-31', '9166-07-31', '9249-10-31']);
    expect(monthly.at(-1)).toBe('9999-01-31');
    expect(occurrences(rule({ frequency: 'yearly', interval: 999 }), at('9000-10-22'), 50)).toEqual(['9000-10-22', '9999-10-22']);
    expect(occurrences(rule({ frequency: 'daily', interval: -5 }), at('2026-10-22'), 3)).toEqual([
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
    ]);
    expect(occurrences(rule({ frequency: 'daily', interval: Number.NaN }), at('2026-10-22'), 2)).toEqual([
      '2026-10-22',
      '2026-10-23',
    ]);
    expect(occurrences(rule({ frequency: 'daily' }), at('2026-02-30'), 5)).toEqual([]);
    expect(occurrences(rule({ frequency: 'daily' }), at(''), 5)).toEqual([]);
    expect(occurrences(rule({ frequency: 'daily' }), at('2026-10-22'), Number.NaN)).toEqual([]);
    expect(occurrences(rule({ frequency: 'daily' }), at('2026-10-22'), -1)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('ical.js test fixtures', () => {
  it.each<[string, string, string, string]>([
    ['Asia/Jerusalem', '2026-01-15', '09:00', '2026-01-15T07:00:00.000Z'],
    ['Asia/Jerusalem', '2026-03-26', '23:30', '2026-03-26T21:30:00.000Z'],
    ['Asia/Jerusalem', '2026-03-27', '09:00', '2026-03-27T06:00:00.000Z'],
    ['Asia/Jerusalem', '2026-10-24', '23:30', '2026-10-24T20:30:00.000Z'],
    ['Asia/Jerusalem', '2026-10-25', '09:00', '2026-10-25T07:00:00.000Z'],
    ['Asia/Jerusalem', '2028-03-24', '09:00', '2028-03-24T06:00:00.000Z'],
    ['America/New_York', '2026-03-07', '23:30', '2026-03-08T04:30:00.000Z'],
    ['America/New_York', '2026-03-08', '09:00', '2026-03-08T13:00:00.000Z'],
    ['America/New_York', '2026-11-01', '09:00', '2026-11-01T14:00:00.000Z'],
    ['America/New_York', '2026-12-31', '23:30', '2027-01-01T04:30:00.000Z'],
  ])('%s VTIMEZONE matches Intl at %s %s', (zone, date, time, iso) => {
    expect(zonedTimeToUtc({ date, time }, zone).toISOString()).toBe(iso);
    expect(icalTime({ date, time }, zone).toJSDate().toISOString()).toBe(iso);
  });
});

describe('occurrences agree with ical.js', () => {
  const STARTS = [
    '2026-10-22', // Thu
    '2026-10-25', // Sun, last week of the month
    '2026-01-31', // Sat, day 31
    '2026-03-30', // Mon, day 30
    '2025-12-29', // Mon, day 29 before a non-leap February
    '2024-01-29', // Mon, day 29 before a leap February
    '2024-02-29', // Thu, leap day
    '2028-02-29', // Tue, leap day
    '2027-08-31', // Tue, day 31
    '2026-11-30', // Mon, last day of a 30-day month
    '2026-02-28', // Sat, last day of a non-leap February
    '2023-05-01', // Mon, first of the month
    '2026-12-25', // Fri, last week of the year
    '2027-07-15', // Thu, mid-month
  ];
  const TIMES = ['09:00', '23:30', '00:15'];
  const ZONES = ['Asia/Jerusalem', 'America/New_York'];
  const MODES: MonthlyMode[] = ['dayOfMonth', 'nthWeekday', 'lastWeekday', 'lastDay'];
  const UNTIL_SPAN: Record<Exclude<Frequency, 'none'>, number> = { daily: 20, weekly: 60, monthly: 400, yearly: 3000 };

  const shift = (day: Weekday, by: number): Weekday => WEEKDAYS[(WEEKDAYS.indexOf(day) + by + 7) % 7] as Weekday;

  function weekdaySets(start: string): Weekday[][] {
    const own = weekdayOf(start);
    return [
      [],
      [own],
      ['MO', 'WE', 'FR'],
      ['SA', 'SU'],
      ['MO', 'TU', 'WE', 'TH', 'FR'],
      [...WEEKDAYS],
      [shift(own, 2), shift(own, 4)],
      [shift(own, -1)],
    ];
  }

  interface Case {
    name: string;
    rec: Recurrence;
    start: LocalDateTime;
    zone: string;
  }

  const cases: Case[] = [];
  STARTS.forEach((date, i) => {
    const start = at(date, TIMES[i % TIMES.length]);
    const zone = ZONES[i % ZONES.length] as string;
    const add = (label: string, partial: Partial<Recurrence>) =>
      cases.push({ name: `${date} ${start.time} ${zone} ${label}`, rec: rule(partial), start, zone });
    for (const interval of [1, 2, 3]) {
      add(`daily /${interval}`, { frequency: 'daily', interval });
      for (const weekdays of weekdaySets(date)) {
        add(`weekly /${interval} [${weekdays.join(',')}]`, { frequency: 'weekly', interval, weekdays });
      }
      for (const monthlyMode of MODES) {
        add(`monthly /${interval} ${monthlyMode}`, { frequency: 'monthly', interval, monthlyMode });
      }
      add(`yearly /${interval}`, { frequency: 'yearly', interval });
    }
  });

  function endsFor(rec: Recurrence, start: string): RecurrenceEnd[] {
    const span = UNTIL_SPAN[rec.frequency as Exclude<Frequency, 'none'>];
    return [
      { type: 'never' },
      { type: 'count', count: 1 },
      { type: 'count', count: 7 },
      { type: 'until', date: addDays(start, span) },
    ];
  }

  it('covers a broad table of rules', () => {
    expect(cases.length).toBe(STARTS.length * 3 * (1 + 8 + 4 + 1));
  });

  it.each(cases)('$name', ({ rec, start, zone }) => {
    for (const end of endsFor(rec, start.date)) {
      const withEnd = { ...rec, end };
      const { ours, theirs } = crossCheck(withEnd, start, zone);
      expect(ours, `${JSON.stringify(end)} ${toRRule(withEnd, start, zone)}`).toEqual(theirs);
      expect(ours.length).toBeGreaterThan(0);
    }
  });

  // ical.js skips a DTSTART that the rule does not produce, so its first instance from the raw start is the true first match.
  it.each(cases)('aligned start of $name is the first rule match', ({ rec, start, zone }) => {
    const rrule = toRRule({ ...rec, interval: 1 }, start, zone) as string;
    expect([alignStart(rec, start.date)]).toEqual(icalDates(rrule, start, zone, 1));
  });

  it('confirms ical.js skips a DTSTART that does not match the rule', () => {
    expect(icalDates('FREQ=WEEKLY;BYDAY=MO', at('2026-10-22'), 'Asia/Jerusalem', 2)).toEqual(['2026-10-26', '2026-11-02']);
    expect(icalDates('FREQ=MONTHLY;BYDAY=-1TH', at('2026-10-01'), 'Asia/Jerusalem', 1)).toEqual(['2026-10-29']);
  });

  it('starts yearly rules on the start date itself', () => {
    for (const date of STARTS) expect(alignStart(rule({ frequency: 'yearly', interval: 3 }), date)).toBe(date);
  });

  it.each<[string, string, string]>([
    ['Asia/Jerusalem', '23:30', '2026-12-31'],
    ['Asia/Jerusalem', '23:59', '2026-07-15'],
    ['America/New_York', '23:30', '2026-12-31'],
    ['America/New_York', '23:59', '2026-07-04'],
    ['America/New_York', '00:00', '2026-11-01'],
    ['Asia/Jerusalem', '00:00', '2026-03-27'],
  ])('%s: an occurrence at %s on the until-date %s is included by both', (zone, time, until) => {
    const rec = rule({ frequency: 'daily', end: { type: 'until', date: until } });
    const start = at(addDays(until, -2), time);
    const expected = [addDays(until, -2), addDays(until, -1), until];
    const { ours, theirs } = crossCheck(rec, start, zone);
    expect(ours).toEqual(expected);
    expect(theirs).toEqual(expected);
  });

  it('agrees that a weekly occurrence exactly on the until-date is the last one', () => {
    const rec = rule({ frequency: 'weekly', interval: 2, weekdays: ['TU', 'FR'], end: { type: 'until', date: '2026-11-20' } });
    const expected = ['2026-10-23', '2026-11-03', '2026-11-06', '2026-11-17', '2026-11-20'];
    for (const zone of ZONES) {
      const { ours, theirs } = crossCheck(rec, at('2026-10-22', '23:45'), zone);
      expect(ours).toEqual(expected);
      expect(theirs).toEqual(expected);
    }
  });

  it('agrees that nothing occurs when UNTIL is before the aligned start', () => {
    const rec = rule({ frequency: 'weekly', weekdays: ['MO'], end: { type: 'until', date: '2026-10-25' } });
    const { ours, theirs } = crossCheck(rec, at('2026-10-22'), 'America/New_York');
    expect(ours).toEqual([]);
    expect(theirs).toEqual([]);
  });
});

describe('describeRecurrence', () => {
  it.each<[Partial<Recurrence>, string, string]>([
    [{ frequency: 'none' }, '2026-10-22', 'Does not repeat'],
    [{ frequency: 'none', end: { type: 'count', count: 3 } }, '2026-10-22', 'Does not repeat'],
    [{ frequency: 'daily' }, '2026-10-22', 'Every day'],
    [{ frequency: 'daily', interval: 3 }, '2026-10-22', 'Every 3 days'],
    [{ frequency: 'weekly' }, '2026-10-22', 'Every week on Thu'],
    [{ frequency: 'weekly', weekdays: ['WE', 'MO'] }, '2026-10-22', 'Every week on Mon, Wed'],
    [{ frequency: 'weekly', weekdays: ['FR', 'TH', 'WE', 'TU', 'MO'] }, '2026-10-22', 'Every weekday'],
    [
      { frequency: 'weekly', interval: 2, weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'] },
      '2026-10-22',
      'Every 2 weeks on Mon, Tue, Wed, Thu, Fri',
    ],
    [
      { frequency: 'weekly', weekdays: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA'] },
      '2026-10-22',
      'Every week on Mon, Tue, Wed, Thu, Fri, Sat',
    ],
    [{ frequency: 'weekly', interval: 2 }, '2026-10-25', 'Every 2 weeks on Sun'],
    [{ frequency: 'monthly' }, '2026-10-22', 'Every month on day 22'],
    [{ frequency: 'monthly' }, '2026-10-28', 'Every month on day 28'],
    [{ frequency: 'monthly' }, '2026-10-29', 'Every month on day 29 (months without a 29th are skipped)'],
    [{ frequency: 'monthly' }, '2026-11-30', 'Every month on day 30 (months without a 30th are skipped)'],
    [{ frequency: 'monthly' }, '2026-10-31', 'Every month on day 31 (months without a 31st are skipped)'],
    [{ frequency: 'monthly', interval: 2 }, '2026-10-01', 'Every 2 months on day 1'],
    [{ frequency: 'monthly', monthlyMode: 'nthWeekday' }, '2026-10-01', 'Every month on the 1st Thursday'],
    [{ frequency: 'monthly', monthlyMode: 'nthWeekday' }, '2026-10-12', 'Every month on the 2nd Monday'],
    [{ frequency: 'monthly', monthlyMode: 'nthWeekday' }, '2026-10-20', 'Every month on the 3rd Tuesday'],
    [{ frequency: 'monthly', monthlyMode: 'nthWeekday', interval: 3 }, '2026-10-24', 'Every 3 months on the 4th Saturday'],
    [{ frequency: 'monthly', monthlyMode: 'lastWeekday' }, '2026-10-30', 'Every month on the last Friday'],
    [{ frequency: 'monthly', monthlyMode: 'lastWeekday' }, '2026-10-25', 'Every month on the last Sunday'],
    [{ frequency: 'monthly', monthlyMode: 'lastDay' }, '2026-10-31', 'Every month on the last day'],
    [{ frequency: 'yearly' }, '2026-10-22', 'Every year on Oct 22'],
    [{ frequency: 'yearly' }, '2027-01-01', 'Every year on Jan 1'],
    [{ frequency: 'yearly', interval: 2 }, '2026-12-25', 'Every 2 years on Dec 25'],
    [{ frequency: 'yearly' }, '2024-02-29', 'Every year on Feb 29 (leap years only)'],
    [{ frequency: 'yearly', interval: 4 }, '2024-02-29', 'Every 4 years on Feb 29 (leap years only)'],
    [{ frequency: 'daily', end: { type: 'count', count: 10 } }, '2026-10-22', 'Every day, 10 times'],
    [{ frequency: 'daily', end: { type: 'count', count: 1 } }, '2026-10-22', 'Every day, once'],
    [
      { frequency: 'weekly', weekdays: ['MO', 'WE'], end: { type: 'until', date: '2026-12-31' } },
      '2026-10-22',
      'Every week on Mon, Wed, until Dec 31, 2026',
    ],
    [
      { frequency: 'monthly', monthlyMode: 'lastDay', end: { type: 'count', count: 12 } },
      '2026-10-31',
      'Every month on the last day, 12 times',
    ],
    [
      { frequency: 'yearly', end: { type: 'until', date: '2030-03-05' } },
      '2026-10-22',
      'Every year on Oct 22, until Mar 5, 2030',
    ],
  ])('%j from %s -> %s', (partial, start, expected) => {
    expect(describeRecurrence(rule(partial), start)).toBe(expected);
  });

  it('falls back to a generic summary when the start date is invalid', () => {
    expect(describeRecurrence(rule({ frequency: 'weekly' }), '')).toBe('Every week');
    expect(describeRecurrence(rule({ frequency: 'weekly', weekdays: ['TU'] }), '')).toBe('Every week on Tue');
    expect(describeRecurrence(rule({ frequency: 'monthly', interval: 2 }), '2026-02-30')).toBe('Every 2 months');
    expect(describeRecurrence(rule({ frequency: 'yearly' }), '')).toBe('Every year');
  });
});

describe('validateRecurrence', () => {
  const INTERVAL = 'Repeat interval must be a whole number from 1 to 999.';
  const COUNT = 'Number of times must be a whole number from 1 to 1000.';
  const MONTHLY = 'This monthly option does not fit the start date. Choose another one.';

  it('accepts valid rules', () => {
    expect(validateRecurrence(defaultRecurrence(), '2026-10-22')).toEqual([]);
    expect(validateRecurrence(rule({ frequency: 'daily', interval: 999 }), '2026-10-22')).toEqual([]);
    expect(validateRecurrence(rule({ frequency: 'weekly', weekdays: ['MO', 'SU'] }), '2026-10-22')).toEqual([]);
    expect(validateRecurrence(rule({ frequency: 'monthly', monthlyMode: 'lastDay' }), '2026-10-31')).toEqual([]);
    expect(validateRecurrence(rule({ frequency: 'yearly', end: { type: 'count', count: 1000 } }), '2024-02-29')).toEqual([]);
    expect(validateRecurrence(rule({ frequency: 'daily', end: { type: 'count', count: 1 } }), '2026-10-22')).toEqual([]);
  });

  it('ignores repeat settings for a one-off event', () => {
    const ignored = rule({ frequency: 'none', interval: 0, end: { type: 'count', count: 0 } });
    expect(validateRecurrence(ignored, '2026-10-22')).toEqual([]);
  });

  it('rejects an unknown frequency', () => {
    expect(validateRecurrence(rule({ frequency: 'hourly' as Frequency }), '2026-10-22')).toEqual([
      'Choose how often the message repeats.',
    ]);
  });

  it.each([0, -1, 1000, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects interval %s', (interval) => {
    expect(validateRecurrence(rule({ frequency: 'daily', interval }), '2026-10-22')).toEqual([INTERVAL]);
  });

  it.each([0, -3, 1001, 2.5, Number.NaN])('rejects count %s', (count) => {
    expect(validateRecurrence(rule({ frequency: 'weekly', end: { type: 'count', count } }), '2026-10-22')).toEqual([COUNT]);
  });

  it('rejects an invalid until date', () => {
    for (const date of ['2026-02-30', '', '31/12/2026']) {
      expect(validateRecurrence(rule({ frequency: 'daily', end: { type: 'until', date } }), '2026-10-22')).toEqual([
        'End date is not a valid date.',
      ]);
    }
  });

  it('rejects an until date before the aligned first occurrence', () => {
    const weekly = (date: string) => rule({ frequency: 'weekly', weekdays: ['MO'], end: { type: 'until', date } });
    expect(validateRecurrence(weekly('2026-10-25'), '2026-10-22')).toEqual([
      'End date cannot be before the first occurrence (Oct 26, 2026).',
    ]);
    expect(validateRecurrence(weekly('2026-10-26'), '2026-10-22')).toEqual([]);
    expect(validateRecurrence(rule({ frequency: 'daily', end: { type: 'until', date: '2026-10-21' } }), '2026-10-22')).toEqual([
      'End date cannot be before the first occurrence (Oct 22, 2026).',
    ]);
    const sameDay = rule({ frequency: 'daily', end: { type: 'until', date: '2026-10-22' } });
    expect(validateRecurrence(sameDay, '2026-10-22')).toEqual([]);
  });

  it('rejects unknown weekday codes', () => {
    expect(validateRecurrence(rule({ frequency: 'weekly', weekdays: ['MO', 'XX' as Weekday] }), '2026-10-22')).toEqual([
      'Choose days of the week from Monday to Sunday.',
    ]);
  });

  it.each<[MonthlyMode, string]>([
    ['nthWeekday', '2026-10-29'],
    ['lastWeekday', '2026-10-01'],
    ['lastDay', '2026-10-30'],
    ['lastDay', '2024-02-28'],
    ['sometimes' as MonthlyMode, '2026-10-22'],
  ])('rejects monthly mode %s for a start on %s', (monthlyMode, start) => {
    expect(validateRecurrence(rule({ frequency: 'monthly', monthlyMode }), start)).toEqual([MONTHLY]);
  });

  it('only checks weekdays and monthly mode for their own frequency', () => {
    const daily = rule({ frequency: 'daily', weekdays: ['XX' as Weekday], monthlyMode: 'lastDay' });
    expect(validateRecurrence(daily, '2026-10-22')).toEqual([]);
  });

  it('reports every problem in a stable order', () => {
    const rec = rule({ frequency: 'monthly', interval: 0, monthlyMode: 'lastDay', end: { type: 'count', count: 0 } });
    expect(validateRecurrence(rec, '2026-10-22')).toEqual([INTERVAL, MONTHLY, COUNT]);
  });
});
