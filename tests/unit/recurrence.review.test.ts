import ICAL from 'ical.js';
import { expect, it } from 'vitest';
import { addDays, diffDays } from '../../src/core/dates';
import { WEEKDAYS, alignStart, availableMonthlyModes, occurrences, toRRule } from '../../src/core/recurrence';
import type { Frequency, LocalDateTime, MonthlyMode, Recurrence, RecurrenceEnd, Weekday } from '../../src/core/types';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent brute-force oracle working on epoch-day numbers: walk day by day. */
function oracle(rec: Recurrence, startDate: string, limit: number, horizonDays: number): string[] {
  const DAY = 86_400_000;
  const toDay = (s: string) => Math.round(Date.parse(`${s}T00:00:00Z`) / DAY);
  const info = (n: number) => {
    const d = new Date(n * DAY);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const w = (d.getUTCDay() + 6) % 7;
    const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { year, month, day, w, dim, iso: d.toISOString().slice(0, 10) };
  };
  const s = info(toDay(startDate));
  const days = rec.weekdays.length ? WEEKDAYS.map((d, i) => (rec.weekdays.includes(d) ? i : -1)).filter((i) => i >= 0) : [s.w];
  const shape = (n: number): boolean => {
    const { month, day, w, dim } = info(n);
    switch (rec.frequency) {
      case 'daily': return true;
      case 'weekly': return days.includes(w);
      case 'monthly':
        switch (rec.monthlyMode) {
          case 'dayOfMonth': return day === s.day;
          case 'nthWeekday': return w === s.w && Math.ceil(day / 7) === Math.ceil(s.day / 7);
          case 'lastWeekday': return w === s.w && day + 7 > dim;
          case 'lastDay': return day === dim;
        }
        return false;
      case 'yearly': return month === s.month && day === s.day;
      default: return false;
    }
  };
  let first = toDay(startDate);
  for (let i = 0; i < 400 && !shape(first); i++) first++;
  const f = info(first);
  const monday = (n: number) => n - info(n).w;
  const N = rec.interval;
  const inPeriod = (n: number): boolean => {
    const p = info(n);
    switch (rec.frequency) {
      case 'daily': return (n - first) % N === 0;
      case 'weekly': return ((monday(n) - monday(first)) / 7) % N === 0;
      case 'monthly': return ((p.year - f.year) * 12 + (p.month - f.month)) % N === 0;
      case 'yearly': return (p.year - f.year) % N === 0;
      default: return false;
    }
  };
  const out: string[] = [];
  const max = rec.end.type === 'count' ? Math.min(limit, rec.end.count) : limit;
  const until = rec.end.type === 'until' ? toDay(rec.end.date) : Infinity;
  for (let n = first; n < first + horizonDays && out.length < max && n <= until; n++) {
    if (shape(n) && inPeriod(n)) out.push(info(n).iso);
  }
  return out;
}

const FREQS: Exclude<Frequency, 'none'>[] = ['daily', 'weekly', 'monthly', 'yearly'];

it.skip('fuzz vs oracle', () => {
  const r = rng(12345);
  let mismatches = 0;
  for (let n = 0; n < 4000; n++) {
    const start = addDays('2020-01-01', Math.floor(r() * 365 * 20));
    const freq = FREQS[Math.floor(r() * 4)]!;
    const interval = r() < 0.7 ? 1 + Math.floor(r() * 5) : 1 + Math.floor(r() * 999);
    const weekdays = WEEKDAYS.filter(() => r() < 0.3);
    const modes = availableMonthlyModes(start);
    const monthlyMode = modes[Math.floor(r() * modes.length)]!;
    const endKind = r();
    const end: RecurrenceEnd = endKind < 0.33 ? { type: 'never' } : endKind < 0.66 ? { type: 'count', count: 1 + Math.floor(r() * 20) } : { type: 'until', date: addDays(start, Math.floor(r() * 3000)) };
    const rec: Recurrence = { frequency: freq, interval, weekdays, monthlyMode, end };
    const horizon = 365 * 40;
    const ours = occurrences(rec, { date: start, time: '09:00' }, 15).filter((d) => diffDays(start, d) < horizon - 400);
    const theirs = oracle(rec, start, 15, horizon).filter((d) => diffDays(start, d) < horizon - 400);
    if (JSON.stringify(ours) !== JSON.stringify(theirs)) {
      if (mismatches++ < 10) console.log(JSON.stringify(rec), start, ours, theirs);
    }
  }
  console.log('oracle mismatches', mismatches);
  expect(mismatches).toBe(0);
});

const FIXTURES: Record<string, string[]> = {
  'Asia/Jerusalem': [
    'BEGIN:VTIMEZONE', 'TZID:Asia/Jerusalem',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0300', 'DTSTART:20130329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=FR;BYMONTHDAY=23,24,25,26,27,28,29', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0300', 'TZOFFSETTO:+0200', 'DTSTART:20131027T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE',
  ],
  'America/New_York': [
    'BEGIN:VTIMEZONE', 'TZID:America/New_York',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'DTSTART:20070311T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'DTSTART:20071104T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
    'END:VTIMEZONE',
  ],
  'Asia/Beirut': [
    'BEGIN:VTIMEZONE', 'TZID:Asia/Beirut',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0300', 'DTSTART:19930328T000000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0300', 'TZOFFSETTO:+0200', 'DTSTART:19991031T000000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE',
  ],
  'Australia/Sydney': [
    'BEGIN:VTIMEZONE', 'TZID:Australia/Sydney',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+1100', 'TZOFFSETTO:+1000', 'DTSTART:20080406T030000', 'RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU', 'END:STANDARD',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+1000', 'TZOFFSETTO:+1100', 'DTSTART:20081005T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU', 'END:DAYLIGHT',
    'END:VTIMEZONE',
  ],
};
const zones = new Map<string, InstanceType<typeof ICAL.Timezone>>();
function zoneOf(tzid: string) {
  if (tzid === 'UTC') return ICAL.Timezone.utcTimezone;
  let z = zones.get(tzid);
  if (!z) {
    const cal = new ICAL.Component(ICAL.parse(['BEGIN:VCALENDAR', ...FIXTURES[tzid]!, 'END:VCALENDAR'].join('\r\n')));
    z = new ICAL.Timezone(cal.getFirstSubcomponent('vtimezone'));
    zones.set(tzid, z);
  }
  return z;
}
function icalDates(rrule: string, start: LocalDateTime, tzid: string, n: number): string[] {
  const [year, month, day] = start.date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = start.time.split(':').map(Number) as [number, number];
  const dt = ICAL.Time.fromData({ year, month, day, hour, minute, second: 0, isDate: false }, zoneOf(tzid));
  const iter = ICAL.Recur.fromString(rrule).iterator(dt);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const next = iter.next();
    if (!next) break;
    out.push(next.toString().slice(0, 10));
  }
  return out;
}

it.skip('fuzz vs ical.js', () => {
  const r = rng(777);
  const zoneIds = ['Asia/Jerusalem', 'America/New_York', 'Australia/Sydney', 'UTC', 'Asia/Beirut'];
  const TIMES = ['00:00', '00:15', '00:30', '01:30', '02:30', '09:00', '23:00', '23:30', '23:59'];
  let mismatches = 0;
  for (let n = 0; n < 6000; n++) {
    const start = addDays('2024-01-01', Math.floor(r() * 365 * 6));
    const zone = zoneIds[Math.floor(r() * zoneIds.length)]!;
    const time = TIMES[Math.floor(r() * TIMES.length)]!;
    const freq = FREQS[Math.floor(r() * 4)]!;
    const interval = r() < 0.8 ? 1 + Math.floor(r() * 4) : 1 + Math.floor(r() * 30);
    const weekdays = WEEKDAYS.filter(() => r() < 0.3);
    const modes = availableMonthlyModes(start);
    const monthlyMode = modes[Math.floor(r() * modes.length)]!;
    const endKind = r();
    const span = { daily: 40, weekly: 200, monthly: 900, yearly: 4000 }[freq];
    const end: RecurrenceEnd = endKind < 0.2 ? { type: 'never' } : endKind < 0.5 ? { type: 'count', count: 1 + Math.floor(r() * 20) } : { type: 'until', date: addDays(start, Math.floor(r() * span)) };
    const rec: Recurrence = { frequency: freq, interval, weekdays, monthlyMode, end };
    const s = { date: start, time };
    const first = { date: alignStart(rec, start), time };
    const rrule = toRRule(rec, first, zone)!;
    const ours = occurrences(rec, s, 20);
    const theirs = icalDates(rrule, first, zone, 20);
    if (JSON.stringify(ours) !== JSON.stringify(theirs)) {
      if (mismatches++ < 15) console.log(zone, start, time, rrule, '\n ours  ', ours.join(' '), '\n theirs', theirs.join(' '));
    }
  }
  console.log('ical mismatches', mismatches);
  expect(mismatches).toBe(0);
}, 120_000);

it('probe large intervals vs ical.js', () => {
  const bad: string[] = [];
  const cases: [Partial<Recurrence>, string][] = [];
  for (let interval = 1; interval <= 999; interval++) {
    for (const d of ['2024-02-29', '2000-02-29', '2096-02-29']) cases.push([{ frequency: 'yearly', interval }, d]);
    for (const d of ['2024-02-29', '2026-01-31', '2026-10-29', '2026-03-30']) cases.push([{ frequency: 'monthly', interval, monthlyMode: 'dayOfMonth' }, d]);
    for (const d of ['2026-10-29', '2026-01-31']) cases.push([{ frequency: 'monthly', interval, monthlyMode: 'nthWeekday' }, d]);
  }
  for (const [partial, date] of cases) {
    const rec: Recurrence = { frequency: 'none', interval: 1, weekdays: [], monthlyMode: 'dayOfMonth', end: { type: 'count', count: 4 }, ...partial };
    const s = { date, time: '09:00' };
    const ours = occurrences(rec, s, 4);
    const theirs = icalDates(toRRule(rec, s, 'UTC')!, s, 'UTC', 4).filter((x) => /^\d{4}-/.test(x));
    if (JSON.stringify(ours) !== JSON.stringify(theirs)) bad.push(`${toRRule(rec, s, 'UTC')} ${date} ours=${ours} theirs=${theirs}`);
  }
  console.log(bad.length, bad.slice(0, 20).join('\n'));
  const huge: Recurrence = { frequency: 'daily', interval: 1e21, weekdays: [], monthlyMode: 'dayOfMonth', end: { type: 'count', count: 1e21 } };
  console.log(toRRule(huge, { date: '2026-10-22', time: '09:00' }, 'UTC'), occurrences(huge, { date: '2026-10-22', time: '09:00' }, 3));
  console.log(occurrences({ ...huge, interval: 1, end: { type: 'never' } }, { date: '2026-10-22', time: '09:00' }, 2.5));
  console.log(toRRule({ ...huge, interval: 1, end: { type: 'until', date: '9999-12-31' } }, { date: '2026-10-22', time: '09:00' }, 'America/New_York'));
}, 120_000);
