import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { daysInMonth, formatDate } from '../../src/core/dates';
import { offsetMinutesAt, utcToZoned, zonedTimeToUtc } from '../../src/core/timezone';
import type { LocalDateTime } from '../../src/core/types';
import { buildVTimezone, formatUtcOffset } from '../../src/core/vtimezone';

type IcalZone = InstanceType<typeof ICAL.Timezone>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const FROM = 2026;
const TO = 2036;

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

/** The UTC instant ical.js computes for a wall time in its parsed copy of our VTIMEZONE. */
function icalUtc(zone: IcalZone, local: LocalDateTime): number {
  const d = new Date(naiveMs(local));
  const data = {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: 0,
    isDate: false,
  };
  return ICAL.Time.fromData(data, zone).toUnixTime() * 1000;
}

/** Every instant whose wall time in `tzid` is `local`: one normally, none in a DST gap, two in an overlap. */
function instantsFor(local: LocalDateTime, tzid: string): number[] {
  const naive = naiveMs(local);
  const offsets = new Set([-36, 0, 36].map((h) => offsetMinutesAt(tzid, naive + h * HOUR)));
  return [...offsets]
    .map((offset) => naive - offset * MINUTE)
    .filter((utc) => {
      const wall = utcToZoned(new Date(utc), tzid);
      return wall.date === local.date && wall.time === local.time;
    })
    .sort((a, b) => a - b);
}

/**
 * Compares ical.js with Intl for each wall time and returns the disagreements as readable strings.
 * Unique wall times must match zonedTimeToUtc exactly. ical.js resolves the repeated hour of a fall-back to the
 * later instant (RFC 5545 says the earlier) and a non-existent wall time with the offset after the gap
 * (RFC 5545 says before): those are ical.js limitations, checked here to be one of the two candidates.
 */
function disagreements(zone: IcalZone, tzid: string, locals: readonly LocalDateTime[]): string[] {
  const problems: string[] = [];
  for (const local of locals) {
    const actual = icalUtc(zone, local);
    const instants = instantsFor(local, tzid);
    let ok: boolean;
    if (instants.length === 1) ok = actual === zonedTimeToUtc(local, tzid).getTime();
    else if (instants.length === 2) ok = actual === instants[1];
    else {
      const naive = naiveMs(local);
      const bordering = [-36, 36].map((h) => naive - offsetMinutesAt(tzid, naive + h * HOUR) * MINUTE);
      ok = bordering.includes(actual);
    }
    if (!ok) {
      const expected = zonedTimeToUtc(local, tzid).toISOString();
      problems.push(`${tzid} ${local.date} ${local.time}: ical.js ${new Date(actual).toISOString()}, Intl ${expected}`);
    }
  }
  return problems;
}

const SAMPLE_TIMES = ['00:00', '01:30', '02:30', '12:00', '23:59'];

/** Wall times on several days of every month of the given years. */
function sampleLocals(fromYear: number, toYear: number): LocalDateTime[] {
  const locals: LocalDateTime[] = [];
  for (let year = fromYear; year <= toYear; year++) {
    for (let month = 1; month <= 12; month++) {
      for (const day of [1, 15, daysInMonth(year, month)]) {
        for (const time of SAMPLE_TIMES) locals.push({ date: formatDate({ year, month, day }), time });
      }
    }
  }
  return locals;
}

/** Offset changes found independently of the implementation: daily probes, then bisection to the minute. */
function transitionInstants(tzid: string, fromYear: number, toYear: number): number[] {
  const DAY = 24 * HOUR;
  const found: number[] = [];
  const end = Date.UTC(toYear + 1, 0, 1);
  let previous = offsetMinutesAt(tzid, Date.UTC(fromYear, 0, 1));
  for (let t = Date.UTC(fromYear, 0, 1); t < end; t += DAY) {
    const next = offsetMinutesAt(tzid, t + DAY);
    if (next === previous) continue;
    let lo = t;
    let hi = t + DAY;
    while (hi - lo > MINUTE) {
      const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
      if (offsetMinutesAt(tzid, mid) === previous) lo = mid;
      else hi = mid;
    }
    found.push(hi);
    previous = next;
  }
  return found;
}

/** Wall times of instants on both sides of each transition: 2 h, 61 min and 1 min before and after, and at it. */
function localsAroundTransitions(tzid: string, fromYear: number, toYear: number): LocalDateTime[] {
  const deltas = [-120, -61, -1, 0, 1, 61, 120].map((m) => m * MINUTE);
  return transitionInstants(tzid, fromYear, toYear).flatMap((t) =>
    deltas.map((delta) => {
      const { date, time } = utcToZoned(new Date(t + delta), tzid);
      return { date, time };
    }),
  );
}

function observances(lines: readonly string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:STANDARD' || line === 'BEGIN:DAYLIGHT') current = [line];
    else if (current) {
      current.push(line);
      if (line.startsWith('END:')) {
        blocks.push(current);
        current = null;
      }
    }
  }
  return blocks;
}

interface ZoneCase {
  tzid: string;
  /** Yearly rules continue past the range, so the VTIMEZONE must keep agreeing with Intl after toYear. */
  regular: boolean;
  /** Offset changes from 2026 through 2036. */
  changes: number;
}

const ZONES: ZoneCase[] = [
  { tzid: 'Asia/Jerusalem', regular: true, changes: 22 },
  { tzid: 'America/New_York', regular: true, changes: 22 },
  { tzid: 'Europe/London', regular: true, changes: 22 },
  { tzid: 'Europe/Berlin', regular: true, changes: 22 },
  { tzid: 'Australia/Sydney', regular: true, changes: 22 },
  { tzid: 'Australia/Lord_Howe', regular: true, changes: 22 },
  { tzid: 'America/St_Johns', regular: true, changes: 22 },
  { tzid: 'America/Santiago', regular: true, changes: 22 },
  { tzid: 'America/Nuuk', regular: true, changes: 22 },
  { tzid: 'Pacific/Chatham', regular: true, changes: 22 },
  { tzid: 'Asia/Kolkata', regular: true, changes: 0 },
  { tzid: 'Asia/Kathmandu', regular: true, changes: 0 },
  { tzid: 'America/Sao_Paulo', regular: true, changes: 0 },
  { tzid: 'UTC', regular: true, changes: 0 },
  { tzid: 'Etc/GMT-3', regular: true, changes: 0 },
  // Ramadan starts twice in 2029 and ends twice in 2033.
  { tzid: 'Africa/Casablanca', regular: false, changes: 24 },
];

describe('buildVTimezone agrees with Intl when parsed by ical.js', () => {
  for (const { tzid, regular, changes } of ZONES) {
    describe(tzid, () => {
      const zone = icalZone(tzid, FROM, TO);

      it(`matches on sampled wall times in every month of ${FROM}-${TO}`, () => {
        expect(disagreements(zone, tzid, sampleLocals(FROM, TO))).toEqual([]);
      });

      it('matches just before, at and after every transition', () => {
        const locals = localsAroundTransitions(tzid, FROM, TO);
        expect(locals.length).toBe(changes * 7);
        expect(disagreements(zone, tzid, locals)).toEqual([]);
      });

      if (regular) {
        it('keeps matching for years after toYear', () => {
          expect(disagreements(zone, tzid, sampleLocals(TO + 1, TO + 3))).toEqual([]);
          expect(disagreements(zone, tzid, localsAroundTransitions(tzid, TO + 1, TO + 3))).toEqual([]);
        });
      }
    });
  }
});

describe('buildVTimezone across historical rule changes', () => {
  const cases: [string, number, number][] = [
    ['America/Sao_Paulo', 2016, 2021], // DST abolished in 2019
    ['America/New_York', 2004, 2009], // US rules changed in 2007
    ['Asia/Jerusalem', 2009, 2015], // irregular dates until the 2013 rule
    ['Europe/Moscow', 2009, 2016], // permanent +04 from 2011, back to +03 in 2014
    ['Europe/Istanbul', 2014, 2018], // stayed on +03 from 2016
    ['Africa/Casablanca', 2010, 2020], // Ramadan suspensions, then permanent +01 with Ramadan +00
  ];
  for (const [tzid, fromYear, toYear] of cases) {
    it(`${tzid} ${fromYear}-${toYear}`, () => {
      const zone = icalZone(tzid, fromYear, toYear);
      expect(disagreements(zone, tzid, sampleLocals(fromYear, toYear))).toEqual([]);
      expect(disagreements(zone, tzid, localsAroundTransitions(tzid, fromYear, toYear))).toEqual([]);
    });
  }
});

describe('buildVTimezone output', () => {
  it('describes Israel with open-ended yearly rules (Friday before the last Sunday of March)', () => {
    expect(buildVTimezone('Asia/Jerusalem', 2026, 2036)).toEqual([
      'BEGIN:VTIMEZONE',
      'TZID:Asia/Jerusalem',
      'BEGIN:DAYLIGHT',
      'DTSTART:20250328T020000',
      'TZOFFSETFROM:+0200',
      'TZOFFSETTO:+0300',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=FR;BYMONTHDAY=23,24,25,26,27,28,29',
      'END:DAYLIGHT',
      'BEGIN:STANDARD',
      'DTSTART:20251026T020000',
      'TZOFFSETFROM:+0300',
      'TZOFFSETTO:+0200',
      'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
      'END:STANDARD',
      'END:VTIMEZONE',
    ]);
  });

  it('describes New York with 2nd-Sunday-of-March and 1st-Sunday-of-November rules', () => {
    expect(buildVTimezone('America/New_York', 2026, 2036)).toEqual([
      'BEGIN:VTIMEZONE',
      'TZID:America/New_York',
      'BEGIN:DAYLIGHT',
      'DTSTART:20250309T020000',
      'TZOFFSETFROM:-0500',
      'TZOFFSETTO:-0400',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
      'END:DAYLIGHT',
      'BEGIN:STANDARD',
      'DTSTART:20251102T020000',
      'TZOFFSETFROM:-0400',
      'TZOFFSETTO:-0500',
      'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
      'END:STANDARD',
      'END:VTIMEZONE',
    ]);
  });

  it('expresses DTSTART in the offset before the change (London switches at 01:00 GMT and 02:00 BST)', () => {
    const blocks = observances(buildVTimezone('Europe/London', 2026, 2036));
    expect(blocks.map((b) => b.slice(0, 4))).toEqual([
      ['BEGIN:DAYLIGHT', 'DTSTART:20250330T010000', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0100'],
      ['BEGIN:STANDARD', 'DTSTART:20251026T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0000'],
    ]);
  });

  it('handles the southern hemisphere and a 30-minute DST shift (Lord Howe)', () => {
    expect(observances(buildVTimezone('Australia/Lord_Howe', 2026, 2036))).toEqual([
      [
        'BEGIN:STANDARD',
        'DTSTART:20250406T020000',
        'TZOFFSETFROM:+1100',
        'TZOFFSETTO:+1030',
        'RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU',
        'END:STANDARD',
      ],
      [
        'BEGIN:DAYLIGHT',
        'DTSTART:20251005T020000',
        'TZOFFSETFROM:+1030',
        'TZOFFSETTO:+1100',
        'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU',
        'END:DAYLIGHT',
      ],
    ]);
  });

  it('formats half-hour and 45-minute offsets and transitions at odd local times (Chatham, St Johns)', () => {
    const chatham = buildVTimezone('Pacific/Chatham', 2026, 2036);
    expect(chatham).toContain('TZOFFSETFROM:+1345');
    expect(chatham).toContain('TZOFFSETTO:+1245');
    expect(chatham).toContain('DTSTART:20250406T034500');
    const stJohns = buildVTimezone('America/St_Johns', 2026, 2036);
    expect(stJohns).toContain('TZOFFSETFROM:-0330');
    expect(stJohns).toContain('TZOFFSETTO:-0230');
  });

  it('finds non-standard 7-day windows (Chile: first Sunday on or after the 2nd; Greenland: Saturday)', () => {
    const santiago = buildVTimezone('America/Santiago', 2026, 2036);
    expect(santiago).toContain('RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=SU;BYMONTHDAY=2,3,4,5,6,7,8');
    expect(santiago).toContain('RRULE:FREQ=YEARLY;BYMONTH=9;BYDAY=SU;BYMONTHDAY=2,3,4,5,6,7,8');
    const nuuk = buildVTimezone('America/Nuuk', 2026, 2036);
    expect(nuuk).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=SA;BYMONTHDAY=24,25,26,27,28,29,30');
  });

  it('pins the window from later years when the range is too short to show it', () => {
    for (const year of [2026, 2027, 2028, 2029, 2030, 2031, 2032]) {
      const lines = buildVTimezone('Asia/Jerusalem', year, year);
      expect(lines).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=FR;BYMONTHDAY=23,24,25,26,27,28,29');
      expect(lines).toContain('RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU');
    }
  });

  it('emits a single fixed STANDARD observance for zones without changes', () => {
    const fixed = (offset: string) => [
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      `TZOFFSETFROM:${offset}`,
      `TZOFFSETTO:${offset}`,
      'END:STANDARD',
    ];
    expect(buildVTimezone('UTC', 2026, 2036)).toEqual(['BEGIN:VTIMEZONE', 'TZID:UTC', ...fixed('+0000'), 'END:VTIMEZONE']);
    expect(buildVTimezone('Etc/GMT-3', 2026, 2036)).toEqual([
      'BEGIN:VTIMEZONE',
      'TZID:Etc/GMT-3',
      ...fixed('+0300'),
      'END:VTIMEZONE',
    ]);
    expect(observances(buildVTimezone('Asia/Kolkata', 2026, 2036))).toEqual([fixed('+0530')]);
    expect(observances(buildVTimezone('Asia/Kathmandu', 2026, 2036))).toEqual([fixed('+0545')]);
    expect(observances(buildVTimezone('America/Sao_Paulo', 2026, 2036))).toEqual([fixed('-0300')]);
  });

  it('ends a rule with UNTIL (UTC) when the zone drops DST mid-range', () => {
    expect(buildVTimezone('America/Sao_Paulo', 2018, 2020)).toEqual([
      'BEGIN:VTIMEZONE',
      'TZID:America/Sao_Paulo',
      'BEGIN:STANDARD',
      'DTSTART:20170219T000000',
      'TZOFFSETFROM:-0200',
      'TZOFFSETTO:-0300',
      'RRULE:FREQ=YEARLY;BYMONTH=2;BYDAY=3SU;UNTIL=20190217T020000Z',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:20171015T000000',
      'TZOFFSETFROM:-0300',
      'TZOFFSETTO:-0200',
      'RDATE:20171015T000000',
      'RDATE:20181104T000000',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
    ]);
  });

  it('falls back to explicit RDATEs for irregular (Ramadan-dependent) Casablanca', () => {
    const lines = buildVTimezone('Africa/Casablanca', 2026, 2036);
    expect(lines.some((l) => l.startsWith('RRULE:'))).toBe(false);
    const blocks = observances(lines);
    expect(blocks.map((b) => b.slice(0, 4))).toEqual([
      ['BEGIN:STANDARD', 'DTSTART:20250223T030000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0000'],
      ['BEGIN:DAYLIGHT', 'DTSTART:20250406T020000', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0100'],
    ]);
    const rdates = lines.filter((l) => l.startsWith('RDATE:'));
    // Every change from 2025 through 2036 (two in 2029 and 2033, when Ramadan starts twice in one year).
    expect(rdates).toHaveLength(transitionInstants('Africa/Casablanca', 2025, 2036).length);
    expect(rdates).toContain('RDATE:20250223T030000');
    expect(rdates).toContain('RDATE:20260215T030000');
    expect(rdates).toContain('RDATE:20260322T020000');
    expect(rdates).toContain('RDATE:20361123T020000');
    expect(rdates.every((l) => /^RDATE:\d{8}T\d{6}$/.test(l))).toBe(true);
  });

  it('covers Jan 1 of fromYear with a fixed observance when the zone first changes later that year', () => {
    // North Korea: +09 until 2015-08-15, +0830 until 2018-05-05, then +09 again; no change in 2014.
    expect(buildVTimezone('Asia/Pyongyang', 2015, 2020)).toEqual([
      'BEGIN:VTIMEZONE',
      'TZID:Asia/Pyongyang',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0900',
      'TZOFFSETTO:+0900',
      'END:STANDARD',
      'BEGIN:STANDARD',
      'DTSTART:20150815T000000',
      'TZOFFSETFROM:+0900',
      'TZOFFSETTO:+0830',
      'RDATE:20150815T000000',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:20180504T233000',
      'TZOFFSETFROM:+0830',
      'TZOFFSETTO:+0900',
      'RDATE:20180504T233000',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
    ]);
    const zone = icalZone('Asia/Pyongyang', 2015, 2020);
    expect(disagreements(zone, 'Asia/Pyongyang', sampleLocals(2015, 2020))).toEqual([]);
    expect(disagreements(zone, 'Asia/Pyongyang', localsAroundTransitions('Asia/Pyongyang', 2015, 2020))).toEqual([]);
  });

  it('treats toYear < fromYear as a single year and returns a fresh array each call', () => {
    expect(buildVTimezone('Asia/Jerusalem', 2026, 2020)).toEqual(buildVTimezone('Asia/Jerusalem', 2026, 2026));
    const first = buildVTimezone('Europe/Berlin', 2026, 2036);
    first.push('MUTATED');
    expect(buildVTimezone('Europe/Berlin', 2026, 2036)).not.toContain('MUTATED');
  });

  it('only emits valid RFC 5545 observance lines', () => {
    for (const { tzid } of ZONES) {
      const lines = buildVTimezone(tzid, FROM, TO);
      expect(lines[0]).toBe('BEGIN:VTIMEZONE');
      expect(lines[1]).toBe(`TZID:${tzid}`);
      expect(lines[lines.length - 1]).toBe('END:VTIMEZONE');
      for (const line of lines.slice(2, -1)) {
        expect(line).toMatch(
          /^(BEGIN|END):(STANDARD|DAYLIGHT)$|^(DTSTART|RDATE):\d{8}T\d{6}$|^TZOFFSET(FROM|TO):[+-]\d{4}$|^RRULE:FREQ=YEARLY;BYMONTH=\d{1,2};BYDAY=(-1|[1-4])?(MO|TU|WE|TH|FR|SA|SU)(;BYMONTHDAY=(\d{1,2},){6}\d{1,2})?(;UNTIL=\d{8}T\d{6}Z)?$/,
        );
      }
    }
  });

  it('rejects unknown zones', () => {
    expect(() => buildVTimezone('Not/AZone', 2026, 2036)).toThrow(RangeError);
  });
});

describe('formatUtcOffset', () => {
  it('formats RFC 5545 UTC offsets', () => {
    expect(formatUtcOffset(0)).toBe('+0000');
    expect(formatUtcOffset(-0)).toBe('+0000');
    expect(formatUtcOffset(120)).toBe('+0200');
    expect(formatUtcOffset(330)).toBe('+0530');
    expect(formatUtcOffset(345)).toBe('+0545');
    expect(formatUtcOffset(765)).toBe('+1245');
    expect(formatUtcOffset(840)).toBe('+1400');
    expect(formatUtcOffset(-210)).toBe('-0330');
    expect(formatUtcOffset(-600)).toBe('-1000');
  });
});
