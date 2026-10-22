import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { daysInMonth, formatDate } from '../../src/core/dates';
import { toCalendarEvent } from '../../src/core/event';
import { buildIcs, foldLine } from '../../src/core/ics';
import { defaultRecurrence, occurrences } from '../../src/core/recurrence';
import { offsetMinutesAt, utcToZoned, zonedTimeToUtc } from '../../src/core/timezone';
import type { CalendarEvent, LocalDateTime, ScheduledMessage } from '../../src/core/types';
import { buildVTimezone } from '../../src/core/vtimezone';

type IcalZone = InstanceType<typeof ICAL.Timezone>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function icalZone(tzid: string, fromYear: number, toYear: number): IcalZone {
  const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...buildVTimezone(tzid, fromYear, toYear), 'END:VCALENDAR'];
  const vtimezone = new ICAL.Component(ICAL.parse(text.join('\r\n'))).getFirstSubcomponent('vtimezone');
  if (!vtimezone) throw new Error('no VTIMEZONE parsed');
  return new ICAL.Timezone(vtimezone);
}

function naiveMs(local: LocalDateTime): number {
  const [year, month, day] = local.date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = local.time.split(':').map(Number) as [number, number];
  return Date.UTC(year, month - 1, day, hour, minute);
}

/** Whether the wall time of `utc` also occurs at another instant (the repeated hour of a fall-back). */
function wallTimeRepeats(tzid: string, utc: number): boolean {
  const offset = offsetMinutesAt(tzid, utc);
  return [-36, 36]
    .map((h) => offsetMinutesAt(tzid, utc + h * HOUR))
    .some((other) => other !== offset && offsetMinutesAt(tzid, utc + (offset - other) * MINUTE) === other);
}

/**
 * Takes the wall time of each instant and checks that ical.js maps it back to that instant. Repeated wall times
 * are skipped: ical.js always resolves them to the later instant (see vtimezone.test.ts).
 */
function mismatches(zone: IcalZone, tzid: string, instants: readonly number[]): string[] {
  const problems: string[] = [];
  for (const utc of instants.filter((t) => !wallTimeRepeats(tzid, t))) {
    const d = new Date(utc + offsetMinutesAt(tzid, utc) * MINUTE);
    const data = {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: 0,
      isDate: false,
    };
    const actual = ICAL.Time.fromData(data, zone).toUnixTime() * 1000;
    if (actual !== utc) problems.push(`${tzid} ${new Date(utc).toISOString()}: ical.js ${new Date(actual).toISOString()}`);
  }
  return problems;
}

/** Noon UTC on the 1st and 15th of every month, plus 1 minute and 2 hours on both sides of every offset change. */
function probeInstants(tzid: string, fromYear: number, toYear: number): number[] {
  const instants: number[] = [];
  for (let year = fromYear; year <= toYear; year++) {
    for (let month = 0; month < 12; month++) instants.push(Date.UTC(year, month, 1, 12), Date.UTC(year, month, 15, 12));
  }
  const end = Date.UTC(toYear, 11, 31, 12);
  let previous = offsetMinutesAt(tzid, Date.UTC(fromYear, 0, 1));
  for (let t = Date.UTC(fromYear, 0, 1); t < end; t += 6 * HOUR) {
    const next = offsetMinutesAt(tzid, t + 6 * HOUR);
    if (next === previous) continue;
    let lo = t;
    let hi = t + 6 * HOUR;
    while (hi - lo > MINUTE) {
      const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
      if (offsetMinutesAt(tzid, mid) === previous) lo = mid;
      else hi = mid;
    }
    instants.push(hi - 2 * HOUR, hi - MINUTE, hi, hi + MINUTE, hi + 2 * HOUR);
    previous = next;
  }
  return instants;
}

describe('buildVTimezone: more zones and rule changes agree with Intl (ical.js)', () => {
  const cases: [string, number, number][] = [
    ['Asia/Gaza', 2026, 2036], // Ramadan-dependent suspensions of DST
    ['Asia/Hebron', 2026, 2036],
    ['Asia/Tel_Aviv', 2026, 2036], // alias of Asia/Jerusalem still offered by some devices
    ['Asia/Beirut', 2026, 2036], // changes at midnight
    ['Africa/Cairo', 2021, 2030], // DST resumed in 2023 (last Friday of April)
    ['America/Havana', 2026, 2036], // changes at 00:00/01:00 local
    ['Pacific/Easter', 2026, 2036],
    ['Antarctica/Troll', 2026, 2036], // two-hour DST
    ['Europe/Chisinau', 2026, 2036],
    ['Europe/Dublin', 2026, 2036], // negative DST in tzdata source
    ['America/Asuncion', 2022, 2027], // permanent -03 from October 2024
    ['Asia/Tehran', 2019, 2025], // DST abolished in 2022
    ['America/Mexico_City', 2020, 2025], // DST abolished in 2022
    ['Asia/Amman', 2020, 2025], // permanent +03 from 2022
    ['Pacific/Apia', 2019, 2024], // DST abolished in 2021
  ];
  for (const [tzid, fromYear, toYear] of cases) {
    it(`${tzid} ${fromYear}-${toYear}`, () => {
      const zone = icalZone(tzid, fromYear, toYear);
      expect(mismatches(zone, tzid, probeInstants(tzid, fromYear, toYear))).toEqual([]);
    });
  }

  it('gives Israel the same open-ended rules for every one-year range from 2026 to 2045', () => {
    const expected = buildVTimezone('Asia/Jerusalem', 2026, 2036).filter((l) => l.startsWith('RRULE:'));
    for (let year = 2026; year <= 2045; year++) {
      expect(buildVTimezone('Asia/Jerusalem', year, year).filter((l) => l.startsWith('RRULE:'))).toEqual(expected);
    }
  });
});

describe('buildVTimezone: ranges that start before 1971', () => {
  it('starts the fixed observance no later than the year before fromYear', () => {
    expect(buildVTimezone('Asia/Kolkata', 1960, 1965)).toEqual([
      'BEGIN:VTIMEZONE',
      'TZID:Asia/Kolkata',
      'BEGIN:STANDARD',
      'DTSTART:19590101T000000',
      'TZOFFSETFROM:+0530',
      'TZOFFSETTO:+0530',
      'END:STANDARD',
      'END:VTIMEZONE',
    ]);
    // The common case keeps the conventional 1970 start.
    expect(buildVTimezone('Asia/Kolkata', 2026, 2036)).toContain('DTSTART:19700101T000000');
  });

  it.each([
    ['Asia/Kolkata', 1960, 1965],
    ['Asia/Kolkata', 1969, 1971],
    ['Asia/Jerusalem', 1960, 1965], // no DST in Israel from 1958 to 1973
    ['Asia/Tokyo', 1955, 1960],
  ])('%s %i-%i agrees with Intl before 1970', (tzid, fromYear, toYear) => {
    const zone = icalZone(tzid, fromYear, toYear);
    expect(mismatches(zone, tzid, probeInstants(tzid, fromYear, toYear))).toEqual([]);
  });
});

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    uid: 'review@whatstime',
    title: '💬 WhatsApp אמא: לילה טוב',
    description: 'Tap the link',
    url: 'https://wa.me/972501234567?text=x',
    start: { date: '2026-10-22', time: '09:00' },
    timeZone: 'Asia/Jerusalem',
    durationMinutes: 15,
    reminderMinutesBefore: 0,
    rrule: null,
    dtstamp: new Date('2026-10-20T08:30:00Z'),
    ...overrides,
  };
}

function parseEvent(ics: string) {
  const vevent = new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent('vevent');
  if (!vevent) throw new Error('no VEVENT parsed');
  return new ICAL.Event(vevent);
}

const contentLines = (ics: string): string[] => ics.replace(/\r\n /g, '').split('\r\n');
const timing = (ics: string): string[] => {
  const lines = contentLines(ics);
  return lines.slice(lines.indexOf('BEGIN:VEVENT')).filter((l) => /^DT(START|END)[;:]/.test(l));
};
const utcMs = (time: InstanceType<typeof ICAL.Time>): number => time.toUnixTime() * 1000;

describe('buildIcs: one-off start in the repeated hour of a fall-back', () => {
  it.each([
    // [zone, date, time, expected DTSTART (first occurrence, RFC 5545), expected DTEND]
    ['Asia/Jerusalem', '2026-10-25', '01:30', '20261024T223000Z', '20261024T224500Z'],
    ['Asia/Jerusalem', '2026-10-25', '01:00', '20261024T220000Z', '20261024T221500Z'],
    ['America/New_York', '2026-11-01', '01:30', '20261101T053000Z', '20261101T054500Z'],
    ['Europe/London', '2026-10-25', '01:59', '20261025T005900Z', '20261025T011400Z'],
    ['Australia/Sydney', '2026-04-05', '02:15', '20260404T151500Z', '20260404T153000Z'],
    ['Australia/Lord_Howe', '2026-04-05', '01:45', '20260404T144500Z', '20260404T150000Z'],
  ])('%s %s %s is written in UTC so ical.js agrees with zonedTimeToUtc', (timeZone, date, time, dtstart, dtend) => {
    const ics = buildIcs(makeEvent({ timeZone, start: { date, time } }));
    expect(timing(ics)).toEqual([`DTSTART:${dtstart}`, `DTEND:${dtend}`]);
    const event = parseEvent(ics);
    const expected = zonedTimeToUtc({ date, time }, timeZone).getTime();
    expect(utcMs(event.startDate)).toBe(expected);
    expect(utcMs(event.endDate)).toBe(expected + 15 * MINUTE);
  });

  it('keeps TZID times right next to the repeated hour', () => {
    for (const time of ['00:59', '02:00']) {
      const ics = buildIcs(makeEvent({ start: { date: '2026-10-25', time } }));
      expect(timing(ics)[0]).toBe(`DTSTART;TZID=Asia/Jerusalem:20261025T${time.replace(':', '')}00`);
      expect(utcMs(parseEvent(ics).startDate)).toBe(zonedTimeToUtc({ date: '2026-10-25', time }, 'Asia/Jerusalem').getTime());
    }
  });

  it('keeps the TZID wall time for a recurring event (UTC would freeze the instant across DST)', () => {
    const ics = buildIcs(makeEvent({ start: { date: '2026-10-25', time: '01:30' }, rrule: 'FREQ=DAILY;COUNT=3' }));
    expect(timing(ics)[0]).toBe('DTSTART;TZID=Asia/Jerusalem:20261025T013000');
  });
});

describe('buildIcs: end in the first pass of the repeated hour', () => {
  it.each([
    ['Asia/Jerusalem', '2026-10-25', '00:30', 60, '20261024T223000Z'],
    ['America/New_York', '2026-11-01', '00:15', 90, '20261101T054500Z'],
    ['Europe/Berlin', '2026-10-25', '01:00', 90, '20261025T003000Z'],
  ])('%s %s %s + %i min ends at %s for every client', (timeZone, date, time, minutes, dtend) => {
    const ics = buildIcs(makeEvent({ timeZone, start: { date, time }, durationMinutes: minutes }));
    expect(timing(ics)[1]).toBe(`DTEND:${dtend}`);
    const event = parseEvent(ics);
    const start = zonedTimeToUtc({ date, time }, timeZone).getTime();
    expect(utcMs(event.startDate)).toBe(start);
    expect(utcMs(event.endDate)).toBe(start + minutes * MINUTE);
  });
});

describe('buildIcs: odd but valid inputs', () => {
  it('quotes a TZID parameter that needs quoting (offset time zones accepted by Intl)', () => {
    const ics = buildIcs(makeEvent({ timeZone: '+05:30' }));
    expect(timing(ics)).toEqual(['DTSTART;TZID="+05:30":20261022T090000', 'DTEND;TZID="+05:30":20261022T091500']);
    expect(contentLines(ics)).toContain('TZID:+05:30');
    expect(utcMs(parseEvent(ics).startDate)).toBe(Date.UTC(2026, 9, 22, 3, 30));
  });

  it.each([NaN, Infinity, -Infinity, -30])('writes a valid trigger for a nonsensical reminder offset (%s)', (minutes) => {
    expect(contentLines(buildIcs(makeEvent({ reminderMinutesBefore: minutes })))).toContain('TRIGGER:PT0S');
  });

  it('folds a line of exactly 75 octets ending in a multi-byte character only when it overflows', () => {
    expect(foldLine(`${'X'.repeat(73)}א`)).toBe(`${'X'.repeat(73)}א`);
    expect(foldLine(`${'X'.repeat(74)}א`)).toBe(`${'X'.repeat(74)}\r\n א`);
    expect(foldLine(`${'X'.repeat(72)}אב`)).toBe(`${'X'.repeat(72)}א\r\n ב`);
  });

  it('round-trips RTL marks, bidi isolates, ZWJ emoji and niqqud through ical.js', () => {
    const text = '‏אמא‎ (+972 50‑123‑4567)⁦שָׁלוֹם⁩ 👩🏽‍❤️‍👨🏻  end';
    const ics = buildIcs(makeEvent({ title: text, description: `${text}\n${text}` }));
    const event = parseEvent(ics);
    expect(event.summary).toBe(text);
    expect(event.description).toBe(`${text}\n${text}`);
  });
});

describe('buildIcs from toCalendarEvent: a weekly Israeli reminder across both DST changes', () => {
  it('expands in ical.js to the same dates and instants as occurrences()', () => {
    const msg: ScheduledMessage = {
      id: 'weekly',
      recipient: { name: 'סבתא', phone: '972501234567' },
      message: 'שבת שלום ❤️',
      start: { date: '2026-03-20', time: '14:00' },
      timeZone: 'Asia/Jerusalem',
      reminderMinutesBefore: 30,
      durationMinutes: 15,
      recurrence: { ...defaultRecurrence(), frequency: 'weekly', weekdays: ['FR'], end: { type: 'until', date: '2027-04-02' } },
      createdAt: '2026-03-01T00:00:00Z',
    };
    const event = toCalendarEvent(msg, new Date('2026-03-01T00:00:00Z'));
    const iterator = parseEvent(buildIcs(event)).iterator();
    const instants: number[] = [];
    for (let next = iterator.next(); next; next = iterator.next()) instants.push(utcMs(next));
    const dates = occurrences(msg.recurrence, event.start, 1000);
    expect(dates[0]).toBe('2026-03-20');
    expect(dates[dates.length - 1]).toBe('2027-04-02');
    expect(instants).toEqual(dates.map((date) => zonedTimeToUtc({ date, time: '14:00' }, 'Asia/Jerusalem').getTime()));
    expect(new Set(instants.map((utc) => utcToZoned(new Date(utc), 'Asia/Jerusalem').time))).toEqual(new Set(['14:00']));
    expect(new Set(dates.map((date, i) => naiveMs({ date, time: '14:00' }) - (instants[i] ?? 0)))).toEqual(
      new Set([2 * HOUR, 3 * HOUR]),
    );
  });
});

describe('sampled wall times in Israel for 30 years', () => {
  it('match zonedTimeToUtc in ical.js for every day of March and October 2026-2055 at 09:00', () => {
    const ics = buildIcs(makeEvent({ start: { date: '2026-01-01', time: '09:00' }, rrule: 'FREQ=DAILY' }));
    const zone = new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent('vtimezone');
    if (!zone) throw new Error('no VTIMEZONE');
    const tz = new ICAL.Timezone(zone);
    const problems: string[] = [];
    for (let year = 2026; year <= 2055; year++) {
      for (const month of [3, 10]) {
        for (let day = 1; day <= daysInMonth(year, month); day++) {
          const date = formatDate({ year, month, day });
          const time = ICAL.Time.fromData({ year, month, day, hour: 9, minute: 0, second: 0, isDate: false }, tz);
          const expected = zonedTimeToUtc({ date, time: '09:00' }, 'Asia/Jerusalem').getTime();
          if (utcMs(time) !== expected) problems.push(date);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
