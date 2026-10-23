/**
 * Adversarial review tests for src/core/recurrence.ts: RFC 5545 agreement with ical.js and with an independent
 * brute-force expansion, UNTIL inclusivity in zones whose clocks fall back at midnight, and pathological inputs.
 */
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
} from '../../src/core/recurrence';
import { utcToZoned, zonedTimeToUtc } from '../../src/core/timezone';
import type { Frequency, LocalDateTime, Recurrence, RecurrenceEnd } from '../../src/core/types';

type IcalZone = InstanceType<typeof ICAL.Timezone>;

const rule = (partial: Partial<Recurrence>): Recurrence => ({ ...defaultRecurrence(), ...partial });
const at = (date: string, time = '09:00'): LocalDateTime => ({ date, time });

/** Small deterministic PRNG (mulberry32) so the randomised tables are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hand-written VTIMEZONEs with current rules (kept independent of vtimezone.ts). */
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
  // Lebanon: clocks go 00:00 -> 01:00 on the last Sunday of March and 00:00 -> 23:00 (Saturday) on the last Sunday
  // of October, so the last hour of that Saturday, including 23:59:59, happens twice.
  'Asia/Beirut': [
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Beirut',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0300',
    'DTSTART:19930328T000000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0300',
    'TZOFFSETTO:+0200',
    'DTSTART:19991031T000000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ],
  'Australia/Sydney': [
    'BEGIN:VTIMEZONE',
    'TZID:Australia/Sydney',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+1100',
    'TZOFFSETTO:+1000',
    'DTSTART:20080406T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU',
    'END:STANDARD',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+1000',
    'TZOFFSETTO:+1100',
    'DTSTART:20081005T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU',
    'END:DAYLIGHT',
    'END:VTIMEZONE',
  ],
};

const zoneCache = new Map<string, IcalZone>();

function icalZone(tzid: string): IcalZone {
  if (tzid === 'UTC') return ICAL.Timezone.utcTimezone;
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

/** What a calendar does with the generated event: DTSTART is the aligned start (as event.ts builds it). */
function crossCheck(rec: Recurrence, start: LocalDateTime, tzid: string, n = 25): { ours: string[]; theirs: string[] } {
  const first = { date: alignStart(rec, start.date), time: start.time };
  const rrule = toRRule(rec, first, tzid);
  if (rrule === null) throw new Error('expected a repeating rule');
  return { ours: occurrences(rec, start, n), theirs: icalDates(rrule, first, tzid, n) };
}

const DAY_MS = 86_400_000;

/**
 * Independent brute-force RFC 5545 expansion on epoch-day numbers (no shared helpers): DTSTART is the first day
 * >= start that has the rule's shape, then every later day of that shape whose period (day / Monday-based week /
 * month / year) is a multiple of INTERVAL away from DTSTART's period.
 */
function bruteForce(rec: Recurrence, startDate: string, limit: number, horizonDays: number): string[] {
  const info = (n: number) => {
    const d = new Date(n * DAY_MS);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    return {
      year,
      month,
      day: d.getUTCDate(),
      weekday: (d.getUTCDay() + 6) % 7,
      monthLength: new Date(Date.UTC(year, month, 0)).getUTCDate(),
      iso: d.toISOString().slice(0, 10),
    };
  };
  const toDay = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
  const s = info(toDay(startDate));
  const chosen = WEEKDAYS.flatMap((code, i) => (rec.weekdays.includes(code) ? [i] : []));
  const weekdays = chosen.length > 0 ? chosen : [s.weekday];
  const hasShape = (n: number): boolean => {
    const d = info(n);
    switch (rec.frequency) {
      case 'daily':
        return true;
      case 'weekly':
        return weekdays.includes(d.weekday);
      case 'monthly':
        if (rec.monthlyMode === 'nthWeekday') return d.weekday === s.weekday && Math.ceil(d.day / 7) === Math.ceil(s.day / 7);
        if (rec.monthlyMode === 'lastWeekday') return d.weekday === s.weekday && d.day + 7 > d.monthLength;
        if (rec.monthlyMode === 'lastDay') return d.day === d.monthLength;
        return d.day === s.day;
      case 'yearly':
        return d.month === s.month && d.day === s.day;
      default:
        return false;
    }
  };
  let first = toDay(startDate);
  while (!hasShape(first)) first++;
  const f = info(first);
  const monday = (n: number) => n - info(n).weekday;
  const inPeriod = (n: number): boolean => {
    const d = info(n);
    switch (rec.frequency) {
      case 'daily':
        return (n - first) % rec.interval === 0;
      case 'weekly':
        return ((monday(n) - monday(first)) / 7) % rec.interval === 0;
      case 'monthly':
        return ((d.year - f.year) * 12 + d.month - f.month) % rec.interval === 0;
      case 'yearly':
        return (d.year - f.year) % rec.interval === 0;
      default:
        return false;
    }
  };
  const max = rec.end.type === 'count' ? Math.min(limit, rec.end.count) : limit;
  const until = rec.end.type === 'until' ? toDay(rec.end.date) : Number.POSITIVE_INFINITY;
  const out: string[] = [];
  for (let n = first; n < first + horizonDays && n <= until && out.length < max; n++) {
    if (hasShape(n) && inPeriod(n)) out.push(info(n).iso);
  }
  return out;
}

const FREQUENCIES: Exclude<Frequency, 'none'>[] = ['daily', 'weekly', 'monthly', 'yearly'];

describe('weekly rules with an interval when the start weekday is not selected', () => {
  it.each<[string, Partial<Recurrence>, string, string[]]>([
    // Wednesday start, every 2 weeks on Monday: the first match is the next Monday and weeks count from there.
    ['every 2 weeks on Mon from a Wed', { interval: 2, weekdays: ['MO'] }, '2026-10-21', ['2026-10-26', '2026-11-09', '2026-11-23']],
    // A later selected day in the start week comes first; the earlier day of that week is not produced.
    ['every 2 weeks on Mon, Fri from a Wed', { interval: 2, weekdays: ['MO', 'FR'] }, '2026-10-21', ['2026-10-23', '2026-11-02', '2026-11-06']],
    // Sunday ends a Monday-based week (WKST=MO): from a Wednesday, Sunday of the same week is the first match.
    ['every 3 weeks on Sun from a Wed', { interval: 3, weekdays: ['SU'] }, '2026-10-21', ['2026-10-25', '2026-11-15', '2026-12-06']],
    // Weekend pairs stay together because Saturday and Sunday share a Monday-based week.
    ['every 2 weeks on Sat, Sun from a Wed', { interval: 2, weekdays: ['SA', 'SU'] }, '2026-10-21', ['2026-10-24', '2026-10-25', '2026-11-07', '2026-11-08']],
    ['every 2 weeks on Sat, Sun from a Sun', { interval: 2, weekdays: ['SA', 'SU'] }, '2026-10-25', ['2026-10-25', '2026-11-07', '2026-11-08', '2026-11-21']],
  ])('%s', (_name, partial, start, expected) => {
    const rec = rule({ frequency: 'weekly', ...partial });
    expect(occurrences(rec, at(start), expected.length)).toEqual(expected);
    expect(alignStart(rec, start)).toBe(expected[0]);
    for (const zone of ['Asia/Jerusalem', 'America/New_York', 'UTC']) {
      const { ours, theirs } = crossCheck(rec, at(start), zone, expected.length);
      expect(theirs).toEqual(ours);
    }
    // The UI expands from the raw start and the calendar from the aligned one; both must give the same dates.
    expect(occurrences(rec, at(alignStart(rec, start)), expected.length)).toEqual(expected);
  });
});

describe('UNTIL in zones whose clocks fall back at midnight', () => {
  // 23:59:59 on these Saturdays/Thursdays happens twice. UNTIL must be the later one, otherwise a client that reads
  // an ambiguous late-evening time as the second occurrence (ical.js does) drops the occurrence on the until-date.
  it.each<[string, string, string]>([
    ['Asia/Beirut', '2026-10-24', '20261024T215959Z'],
    ['America/Santiago', '2026-04-04', '20260405T035959Z'],
    ['Africa/Cairo', '2026-10-29', '20261029T215959Z'],
  ])('%s until %s is the last instant of that local day', (zone, until, expected) => {
    const rec = rule({ frequency: 'daily', end: { type: 'until', date: until } });
    expect(toRRule(rec, at('2026-01-01'), zone)).toBe(`FREQ=DAILY;UNTIL=${expected}`);
    const instant = new Date(expected.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
    expect(utcToZoned(instant, zone)).toEqual({ date: until, time: '23:59', second: 59 });
    expect(utcToZoned(new Date(instant.getTime() + 1000), zone).date).toBe(addDays(until, 1));
  });

  it.each<[string, string, string]>([
    ['Asia/Beirut', '2026-10-23', '20261023T205959Z'],
    ['Asia/Beirut', '2026-10-25', '20261025T215959Z'],
    ['Asia/Beirut', '2026-03-28', '20260328T215959Z'],
    ['America/Santiago', '2026-09-05', '20260906T035959Z'],
    ['America/New_York', '2026-10-31', '20261101T035959Z'],
    ['Australia/Sydney', '2026-04-04', '20260404T125959Z'],
    ['Australia/Sydney', '2026-04-05', '20260405T135959Z'],
  ])('%s until %s is unchanged on an ordinary day', (zone, until, expected) => {
    const rec = rule({ frequency: 'daily', end: { type: 'until', date: until } });
    expect(toRRule(rec, at('2026-01-01'), zone)).toBe(`FREQ=DAILY;UNTIL=${expected}`);
    expect(toRRule(rec, at('2026-01-01'), zone)).toBe(
      `FREQ=DAILY;UNTIL=${zonedTimeToUtc({ date: until, time: '23:59' }, zone, 59).toISOString().replace(/[-:]|\.\d{3}/g, '')}`,
    );
  });

  it.each(['23:00', '23:30', '23:59', '22:59', '00:00'])('ical.js keeps the occurrence at %s on the until-date', (time) => {
    const expected = ['2026-10-22', '2026-10-23', '2026-10-24'];
    const daily = rule({ frequency: 'daily', end: { type: 'until', date: '2026-10-24' } });
    const { ours, theirs } = crossCheck(daily, at('2026-10-22', time), 'Asia/Beirut');
    expect(ours).toEqual(expected);
    expect(theirs).toEqual(expected);
    const weekly = rule({ frequency: 'weekly', interval: 2, weekdays: ['SA'], end: { type: 'until', date: '2026-10-24' } });
    const w = crossCheck(weekly, at('2026-09-26', time), 'Asia/Beirut');
    expect(w.ours).toEqual(['2026-09-26', '2026-10-10', '2026-10-24']);
    expect(w.theirs).toEqual(w.ours);
  });

  it('still excludes the day after the until-date', () => {
    for (const time of ['00:00', '00:15', '09:00', '23:30']) {
      const rec = rule({ frequency: 'daily', end: { type: 'until', date: '2026-10-24' } });
      const { ours, theirs } = crossCheck(rec, at('2026-10-23', time), 'Asia/Beirut');
      expect(ours).toEqual(['2026-10-23', '2026-10-24']);
      expect(theirs).toEqual(ours);
    }
  });
});

describe('limits and pathological values', () => {
  it('never writes numbers in exponent notation into the RRULE', () => {
    const huge = rule({ frequency: 'daily', interval: 1e21, end: { type: 'count', count: 1e21 } });
    const rrule = toRRule(huge, at('2026-10-22'), 'UTC') as string;
    expect(rrule).toMatch(/^FREQ=DAILY;INTERVAL=\d+;COUNT=\d+$/);
    expect(describeRecurrence(huge, '2026-10-22')).not.toMatch(/e\+/);
    // Expansion and the rule still agree.
    const { ours, theirs } = crossCheck(huge, at('2026-10-22'), 'UTC', 3);
    expect(ours).toEqual(theirs);
  });

  it('keeps UNTIL a valid UTC date-time at the end of year 9999', () => {
    for (const zone of ['America/New_York', 'Pacific/Honolulu', 'UTC', 'Asia/Jerusalem']) {
      const rec = rule({ frequency: 'yearly', end: { type: 'until', date: '9999-12-31' } });
      const rrule = toRRule(rec, at('9990-06-01'), zone) as string;
      expect(rrule).toMatch(/^FREQ=YEARLY;UNTIL=\d{8}T\d{6}Z$/);
      expect(() => ICAL.Recur.fromString(rrule)).not.toThrow();
    }
  });

  it('returns at most floor(limit) dates', () => {
    expect(occurrences(rule({ frequency: 'daily' }), at('2026-10-22'), 2.5)).toEqual(['2026-10-22', '2026-10-23']);
    expect(occurrences(rule({ frequency: 'none' }), at('2026-10-22'), 1.9)).toEqual(['2026-10-22']);
  });

  it('agrees with ical.js for every allowed interval on sparse yearly and monthly rules (below year 10000)', () => {
    const below10000 = (dates: string[]) => dates.filter((date) => /^\d{4}-/.test(date));
    for (let interval = 1; interval <= 999; interval += interval < 60 ? 1 : 7) {
      const cases: [Recurrence, string][] = [
        [rule({ frequency: 'yearly', interval, end: { type: 'count', count: 4 } }), '2024-02-29'],
        [rule({ frequency: 'yearly', interval, end: { type: 'count', count: 4 } }), '2096-02-29'],
        [rule({ frequency: 'monthly', interval, end: { type: 'count', count: 4 } }), '2026-01-31'],
        [rule({ frequency: 'monthly', interval, end: { type: 'count', count: 4 } }), '2024-02-29'],
        [rule({ frequency: 'monthly', interval, monthlyMode: 'nthWeekday', end: { type: 'count', count: 4 } }), '2026-10-29'],
      ];
      for (const [rec, date] of cases) {
        const { ours, theirs } = crossCheck(rec, at(date), 'UTC', 4);
        expect(ours, `${toRRule(rec, at(date), 'UTC')} from ${date}`).toEqual(below10000(theirs));
      }
    }
  });
});

describe('randomised agreement', () => {
  function randomRule(r: () => number, start: string, maxInterval: number, untilSpan: Record<string, number>): Recurrence {
    const frequency = FREQUENCIES[Math.floor(r() * FREQUENCIES.length)] as Exclude<Frequency, 'none'>;
    const interval = r() < 0.75 ? 1 + Math.floor(r() * 4) : 1 + Math.floor(r() * maxInterval);
    const modes = availableMonthlyModes(start);
    const pick = r();
    const end: RecurrenceEnd =
      pick < 0.3
        ? { type: 'never' }
        : pick < 0.6
          ? { type: 'count', count: 1 + Math.floor(r() * 20) }
          : { type: 'until', date: addDays(start, Math.floor(r() * (untilSpan[frequency] ?? 100))) };
    return {
      frequency,
      interval,
      weekdays: WEEKDAYS.filter(() => r() < 0.3),
      monthlyMode: modes[Math.floor(r() * modes.length)] ?? 'dayOfMonth',
      end,
    };
  }

  it('matches an independent brute-force RFC 5545 expansion', () => {
    const r = rng(20261022);
    const span = { daily: 400, weekly: 1500, monthly: 6000, yearly: 30000 };
    for (let i = 0; i < 600; i++) {
      const start = addDays('2020-01-01', Math.floor(r() * 365 * 20));
      const rec = randomRule(r, start, 999, span);
      const horizon = { daily: 16, weekly: 120, monthly: 520, yearly: 6000 }[rec.frequency as Exclude<Frequency, 'none'>];
      const days = Math.min(horizon * rec.interval + 400, 365 * 30);
      const ours = occurrences(rec, at(start), 12).filter((date) => date < addDays(start, days - 400));
      const theirs = bruteForce(rec, start, 12, days).filter((date) => date < addDays(start, days - 400));
      expect(ours, `${JSON.stringify(rec)} from ${start}`).toEqual(theirs);
    }
  }, 60_000);

  it('matches ical.js across zones, DST-edge times and ends', () => {
    const r = rng(42);
    const zones = ['Asia/Jerusalem', 'America/New_York', 'Australia/Sydney', 'Asia/Beirut', 'UTC'];
    const times = ['00:00', '00:15', '01:30', '02:30', '09:00', '23:00', '23:30', '23:59'];
    const span = { daily: 40, weekly: 200, monthly: 900, yearly: 4000 };
    for (let i = 0; i < 1500; i++) {
      const start = at(addDays('2024-01-01', Math.floor(r() * 365 * 6)), times[Math.floor(r() * times.length)]);
      const zone = zones[Math.floor(r() * zones.length)] as string;
      const rec = randomRule(r, start.date, 30, span);
      const { ours, theirs } = crossCheck(rec, start, zone, 15);
      expect(ours, `${zone} ${start.date} ${start.time} ${toRRule(rec, start, zone)}`).toEqual(theirs);
    }
  }, 60_000);
});
