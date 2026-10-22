import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/core/dates';
import { buildIcs, escapeText, foldLine, icsFileName } from '../../src/core/ics';
import { zonedTimeToUtc } from '../../src/core/timezone';
import type { CalendarEvent, LocalDateTime } from '../../src/core/types';
import { buildVTimezone } from '../../src/core/vtimezone';

type IcalTime = InstanceType<typeof ICAL.Time>;

const LINK = 'https://wa.me/972501234567?text=Happy%20birthday!';

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    uid: 'abc-123@whatstime',
    title: '💬 WhatsApp Mom: Happy birthday!',
    description: `Tap the link:\n${LINK}`,
    url: LINK,
    start: { date: '2026-10-22', time: '09:00' },
    timeZone: 'Asia/Jerusalem',
    durationMinutes: 15,
    reminderMinutesBefore: 10,
    rrule: null,
    dtstamp: new Date('2026-10-20T08:30:15.250Z'),
    ...overrides,
  };
}

function parse(ics: string) {
  const calendar = new ICAL.Component(ICAL.parse(ics));
  const vevent = calendar.getFirstSubcomponent('vevent');
  if (!vevent) throw new Error('no VEVENT parsed');
  return { calendar, vevent, event: new ICAL.Event(vevent) };
}

const utcMs = (time: IcalTime): number => time.toUnixTime() * 1000;
const octets = (text: string): number => Buffer.byteLength(text, 'utf8');
const unfold = (text: string): string => text.replace(/\r\n /g, '');
/** Unfolded content lines (without the empty string after the final CRLF). */
const contentLines = (ics: string): string[] => unfold(ics).split('\r\n').slice(0, -1);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const HEBREW_EMOJI_TEXT =
  'שָׁלוֹם אמא! 🎂🎉 יום הולדת שמח, מאחלים לך הרבה בריאות; אושר ועושר 👨‍👩‍👧‍👦 🇮🇱 👍🏽\n' +
  'Line two: עברית mixed with English, emoji 😀😃😄😁 and CJK 你好世界 and العربية\\done';

/** Asserts the RFC 5545 physical-line rules on a whole .ics text. */
function expectWellFormed(ics: string): void {
  expect(ics.endsWith('\r\n')).toBe(true);
  expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  const physical = ics.split('\r\n').slice(0, -1);
  for (const line of physical) {
    expect(line.length).toBeGreaterThan(0);
    expect(octets(line)).toBeLessThanOrEqual(75);
    expect(line).not.toMatch(LONE_SURROGATE);
  }
}

describe('escapeText', () => {
  it('escapes backslash, semicolon and comma', () => {
    expect(escapeText('a\\b;c,d')).toBe('a\\\\b\\;c\\,d');
    expect(escapeText('C:\\new')).toBe('C:\\\\new');
    expect(escapeText('\\n')).toBe('\\\\n');
  });

  it('turns every newline style into \\n', () => {
    expect(escapeText('one\ntwo\r\nthree\rfour\n\n')).toBe('one\\ntwo\\nthree\\nfour\\n\\n');
  });

  it('keeps colons, quotes, tabs, Hebrew and emoji as they are', () => {
    expect(escapeText('שלום: "hi"\t😀 https://wa.me/1?text=a%2Cb')).toBe('שלום: "hi"\t😀 https://wa.me/1?text=a%2Cb');
    expect(escapeText('')).toBe('');
  });

  it('strips other control characters', () => {
    expect(escapeText('a\u0000b\u0007c\u001Bd\u007Fe\u000Bf\u000Cg\u0008h')).toBe('abcdefgh');
  });
});

describe('foldLine', () => {
  it('leaves lines of up to 75 octets alone', () => {
    expect(foldLine('')).toBe('');
    expect(foldLine('SUMMARY:Hi')).toBe('SUMMARY:Hi');
    expect(foldLine('X'.repeat(75))).toBe('X'.repeat(75));
    expect(foldLine('X'.repeat(71) + '😀')).toBe('X'.repeat(71) + '😀');
  });

  it('folds with CRLF and one space, counting the space towards the next 75 octets', () => {
    expect(foldLine('X'.repeat(76))).toBe(`${'X'.repeat(75)}\r\n X`);
    expect(foldLine('X'.repeat(200))).toBe(`${'X'.repeat(75)}\r\n ${'X'.repeat(74)}\r\n ${'X'.repeat(51)}`);
  });

  it('counts UTF-8 octets, not UTF-16 units', () => {
    // 'DESCRIPTION:' is 12 octets and each alef 2: 12 + 31 * 2 = 74, one more would make 76.
    expect(foldLine(`DESCRIPTION:${'א'.repeat(40)}`)).toBe(`DESCRIPTION:${'א'.repeat(31)}\r\n ${'א'.repeat(9)}`);
  });

  it('never splits a surrogate pair', () => {
    // 73 + 4 octets do not fit, so the whole emoji moves to the next line.
    expect(foldLine(`${'X'.repeat(73)}😀Y`)).toBe(`${'X'.repeat(73)}\r\n 😀Y`);
    expect(foldLine(`${'X'.repeat(74)}😀😀`)).toBe(`${'X'.repeat(74)}\r\n 😀😀`);
  });

  it('folds long Hebrew + emoji text into full, valid UTF-8 lines that unfold to the original', () => {
    const line = `DESCRIPTION:${escapeText(HEBREW_EMOJI_TEXT.repeat(6))}`;
    const folded = foldLine(line);
    const physical = folded.split('\r\n');
    expect(physical.length).toBeGreaterThan(10);
    physical.forEach((part, i) => {
      expect(octets(part)).toBeLessThanOrEqual(75);
      // A line is only broken when the next code point (at most 4 octets) does not fit.
      if (i < physical.length - 1) expect(octets(part)).toBeGreaterThanOrEqual(72);
      if (i > 0) expect(part).toMatch(/^ [^ ]|^ {2}/);
      expect(part).not.toMatch(LONE_SURROGATE);
      expect(Buffer.from(part, 'utf8').toString('utf8')).toBe(part);
    });
    expect(unfold(folded)).toBe(line);
  });

  it('round-trips folded text through ical.js', () => {
    const ics = buildIcs(makeEvent({ title: HEBREW_EMOJI_TEXT.split('\n')[0] ?? '', description: HEBREW_EMOJI_TEXT }));
    expectWellFormed(ics);
    const { vevent } = parse(ics);
    expect(vevent.getFirstPropertyValue('description')).toBe(HEBREW_EMOJI_TEXT);
    expect(vevent.getFirstPropertyValue('summary')).toBe(HEBREW_EMOJI_TEXT.split('\n')[0]);
  });
});

describe('buildIcs', () => {
  it('produces the exact calendar for a one-off event', () => {
    expect(buildIcs(makeEvent())).toBe(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//WhatsTime//Scheduled WhatsApp Reminder//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        ...buildVTimezone('Asia/Jerusalem', 2026, 2036),
        'BEGIN:VEVENT',
        'UID:abc-123@whatstime',
        'DTSTAMP:20261020T083015Z',
        'DTSTART;TZID=Asia/Jerusalem:20261022T090000',
        'DTEND;TZID=Asia/Jerusalem:20261022T091500',
        'SUMMARY:💬 WhatsApp Mom: Happy birthday!',
        'DESCRIPTION:Tap the link:\\nhttps://wa.me/972501234567?text=Happy%20birthday',
        ' !',
        'URL:https://wa.me/972501234567?text=Happy%20birthday!',
        'TRANSP:TRANSPARENT',
        'STATUS:CONFIRMED',
        'CLASS:PRIVATE',
        'SEQUENCE:0',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'DESCRIPTION:💬 WhatsApp Mom: Happy birthday!',
        'TRIGGER:-PT10M',
        'END:VALARM',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
    );
  });

  it('uses CRLF everywhere, folds every line and ends with CRLF', () => {
    const events = [
      makeEvent({ description: HEBREW_EMOJI_TEXT.repeat(4), title: HEBREW_EMOJI_TEXT.slice(0, 60) }),
      makeEvent({ rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20301231T215959Z', timeZone: 'Africa/Casablanca' }),
      makeEvent({ timeZone: 'UTC', description: 'a\r\nb\rc\nd' }),
    ];
    for (const event of events) expectWellFormed(buildIcs(event));
  });

  it('writes VEVENT properties in the documented order and parses them back with ical.js', () => {
    const event = makeEvent({
      title: 'Mom; Dad, & co\\',
      description: 'Line 1\nLine 2, with; specials\\',
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TH;COUNT=10',
    });
    const ics = buildIcs(event);
    const lines = contentLines(ics);
    const vevent = lines.slice(lines.indexOf('BEGIN:VEVENT'), lines.indexOf('END:VEVENT') + 1);
    expect(vevent.map((l) => l.split(/[:;]/, 1)[0])).toEqual([
      'BEGIN',
      'UID',
      'DTSTAMP',
      'DTSTART',
      'DTEND',
      'RRULE',
      'SUMMARY',
      'DESCRIPTION',
      'URL',
      'TRANSP',
      'STATUS',
      'CLASS',
      'SEQUENCE',
      'BEGIN',
      'ACTION',
      'DESCRIPTION',
      'TRIGGER',
      'END',
      'END',
    ]);
    expect(vevent).toContain('SUMMARY:Mom\\; Dad\\, & co\\\\');
    expect(vevent).toContain('DESCRIPTION:Line 1\\nLine 2\\, with\\; specials\\\\');
    expect(vevent).toContain('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH;COUNT=10');

    const parsed = parse(ics);
    expect(parsed.event.uid).toBe('abc-123@whatstime');
    expect(parsed.event.summary).toBe(event.title);
    expect(parsed.event.description).toBe(event.description);
    expect(parsed.vevent.getFirstPropertyValue('url')).toBe(LINK);
    expect(parsed.vevent.getFirstPropertyValue('transp')).toBe('TRANSPARENT');
    expect(parsed.vevent.getFirstPropertyValue('status')).toBe('CONFIRMED');
    expect(parsed.vevent.getFirstPropertyValue('class')).toBe('PRIVATE');
    expect(parsed.vevent.getFirstPropertyValue('sequence')).toBe(0);
    expect(utcMs(parsed.vevent.getFirstPropertyValue('dtstamp') as IcalTime)).toBe(Date.UTC(2026, 9, 20, 8, 30, 15));
    expect(parsed.calendar.getFirstPropertyValue('prodid')).toBe('-//WhatsTime//Scheduled WhatsApp Reminder//EN');
    expect(parsed.calendar.getFirstPropertyValue('method')).toBe('PUBLISH');
    const alarm = parsed.vevent.getFirstSubcomponent('valarm');
    expect(alarm?.getFirstPropertyValue('action')).toBe('DISPLAY');
    expect(alarm?.getFirstPropertyValue('description')).toBe(event.title);
  });

  it('does not text-escape the URL', () => {
    const url = 'https://wa.me/972501234567?text=a%2Cb%3Bc%5C';
    expect(contentLines(buildIcs(makeEvent({ url })))).toContain(`URL:${url}`);
  });

  it.each([
    [0, 'PT0S'],
    [5, '-PT5M'],
    [10, '-PT10M'],
    [60, '-PT1H'],
    [90, '-PT1H30M'],
    [1440, '-P1D'],
    [1500, '-P1DT1H'],
    [2885, '-P2DT5M'],
    [10080, '-P7D'],
    [40320, '-P28D'],
  ])('writes a VALARM trigger %i minutes before as %s', (minutes, trigger) => {
    const ics = buildIcs(makeEvent({ reminderMinutesBefore: minutes }));
    expect(contentLines(ics)).toContain(`TRIGGER:${trigger}`);
    const alarm = parse(ics).vevent.getFirstSubcomponent('valarm');
    const value = alarm?.getFirstPropertyValue('trigger') as InstanceType<typeof ICAL.Duration>;
    expect(value.toSeconds()).toBe(minutes === 0 ? 0 : -minutes * 60);
  });

  it('sizes the VTIMEZONE from the start year to 10 years later or the UNTIL year', () => {
    const vtimezone = (event: CalendarEvent): string[] => {
      const lines = contentLines(buildIcs(event));
      return lines.slice(lines.indexOf('BEGIN:VTIMEZONE'), lines.indexOf('END:VTIMEZONE') + 1);
    };
    const casablanca = makeEvent({ timeZone: 'Africa/Casablanca', start: { date: '2027-01-10', time: '09:00' } });
    expect(vtimezone(casablanca)).toEqual(buildVTimezone('Africa/Casablanca', 2027, 2037));
    const until2045 = { ...casablanca, rrule: 'FREQ=YEARLY;UNTIL=20450110T085959Z' };
    expect(vtimezone(until2045)).toEqual(buildVTimezone('Africa/Casablanca', 2027, 2045));
    const rdateYears = (lines: string[]) => lines.filter((l) => l.startsWith('RDATE:')).map((l) => Number(l.slice(6, 10)));
    expect(Math.max(...rdateYears(vtimezone(until2045)))).toBe(2045);
    // A far-away UNTIL is capped at 50 years after the start (Casablanca has listed changes until 2087).
    const until2199 = { ...casablanca, rrule: 'FREQ=YEARLY;UNTIL=21991231T225959Z' };
    expect(Math.max(...rdateYears(vtimezone(until2199)))).toBe(2077);
  });

  it('omits the VTIMEZONE and writes UTC times for UTC and its aliases', () => {
    for (const timeZone of ['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT', 'Etc/GMT+0', 'Zulu']) {
      const ics = buildIcs(makeEvent({ timeZone, rrule: 'FREQ=DAILY;COUNT=3' }));
      const lines = contentLines(ics);
      expect(lines.some((l) => l.includes('VTIMEZONE'))).toBe(false);
      expect(lines.some((l) => l.includes('TZID'))).toBe(false);
      expect(lines).toContain('DTSTART:20261022T090000Z');
      expect(lines).toContain('DTEND:20261022T091500Z');
      const { event } = parse(ics);
      expect(utcMs(event.startDate)).toBe(Date.UTC(2026, 9, 22, 9, 0));
      expect(utcMs(event.endDate)).toBe(Date.UTC(2026, 9, 22, 9, 15));
    }
  });

  it('keeps a VTIMEZONE for fixed non-UTC zones', () => {
    for (const [timeZone, offset] of [
      ['Etc/GMT-3', '+0300'],
      ['Africa/Abidjan', '+0000'],
      ['Asia/Kathmandu', '+0545'],
    ] as const) {
      const lines = contentLines(buildIcs(makeEvent({ timeZone })));
      expect(lines).toContain(`TZID:${timeZone}`);
      expect(lines).toContain(`TZOFFSETTO:${offset}`);
      expect(lines).toContain(`DTSTART;TZID=${timeZone}:20261022T090000`);
    }
  });
});

const ZONES = [
  'Asia/Jerusalem',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Australia/Sydney',
  'Australia/Lord_Howe',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'America/St_Johns',
  'America/Sao_Paulo',
  'Africa/Casablanca',
  'UTC',
  'Etc/GMT-3',
];

describe('ical.js computes the same instants as zonedTimeToUtc', () => {
  const starts: LocalDateTime[] = [
    { date: '2026-01-15', time: '09:00' },
    { date: '2026-03-01', time: '00:00' },
    { date: '2026-07-04', time: '18:30' },
    { date: '2026-10-22', time: '23:59' },
    { date: '2027-12-31', time: '23:45' },
    { date: '2034-06-30', time: '07:05' },
  ];

  for (const timeZone of ZONES) {
    it(`one-off events in ${timeZone}: start and end`, () => {
      for (const start of starts) {
        const { event } = parse(buildIcs(makeEvent({ timeZone, start, durationMinutes: 45 })));
        const expected = zonedTimeToUtc(start, timeZone).getTime();
        expect(utcMs(event.startDate)).toBe(expected);
        expect(utcMs(event.endDate)).toBe(expected + 45 * 60_000);
      }
    });

    it(`a weekly event in ${timeZone} keeps its wall time across DST changes for two years`, () => {
      const start = { date: '2026-01-05', time: '09:00' };
      const ics = buildIcs(makeEvent({ timeZone, start, rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=105' }));
      const iterator = parse(ics).event.iterator();
      const offsets = new Set<number>();
      let count = 0;
      for (let next = iterator.next(); next; next = iterator.next()) {
        const date = addDays(start.date, 7 * count);
        expect(next.toString().replace(/Z$/, '')).toBe(`${date}T09:00:00`);
        const expected = zonedTimeToUtc({ date, time: '09:00' }, timeZone).getTime();
        expect(utcMs(next)).toBe(expected);
        offsets.add(Date.parse(`${date}T09:00:00Z`) - expected);
        count++;
      }
      expect(count).toBe(105);
      const hasDst = !['Asia/Kolkata', 'Asia/Kathmandu', 'America/Sao_Paulo', 'UTC', 'Etc/GMT-3'].includes(timeZone);
      expect(offsets.size).toBe(hasDst ? 2 : 1);
    });
  }

  it('expands a daily event with UNTIL in UTC up to the last local day', () => {
    const rrule = 'FREQ=DAILY;UNTIL=20261102T055959Z'; // 23:59:59 on Nov 1 in New York (EST)
    const ics = buildIcs(makeEvent({ timeZone: 'America/New_York', start: { date: '2026-10-25', time: '08:00' }, rrule }));
    const iterator = parse(ics).event.iterator();
    const instants: string[] = [];
    for (let next = iterator.next(); next; next = iterator.next()) instants.push(new Date(utcMs(next)).toISOString());
    expect(instants).toEqual([
      '2026-10-25T12:00:00.000Z',
      '2026-10-26T12:00:00.000Z',
      '2026-10-27T12:00:00.000Z',
      '2026-10-28T12:00:00.000Z',
      '2026-10-29T12:00:00.000Z',
      '2026-10-30T12:00:00.000Z',
      '2026-10-31T12:00:00.000Z',
      '2026-11-01T13:00:00.000Z',
    ]);
  });
});

describe('DTEND across DST changes', () => {
  it.each([
    // [zone, start date, start time, minutes, expected DTEND wall time]
    ['America/New_York', '2026-03-08', '01:30', 60, '20260308T033000'],
    ['America/New_York', '2026-11-01', '00:30', 180, '20261101T023000'],
    ['Asia/Jerusalem', '2026-03-27', '01:45', 30, '20260327T031500'],
    ['Asia/Jerusalem', '2026-10-25', '00:30', 150, '20261025T020000'],
    ['Australia/Sydney', '2026-04-05', '01:00', 240, '20260405T040000'],
    ['Australia/Lord_Howe', '2026-10-04', '01:50', 20, '20261004T024000'],
    ['Europe/Berlin', '2026-03-29', '01:30', 1440, '20260330T023000'],
  ])('%s %s %s + %i min ends at %s', (timeZone, date, time, minutes, end) => {
    const ics = buildIcs(makeEvent({ timeZone, start: { date, time }, durationMinutes: minutes }));
    expect(contentLines(ics)).toContain(`DTEND;TZID=${timeZone}:${end}`);
    const { event } = parse(ics);
    const startUtc = zonedTimeToUtc({ date, time }, timeZone).getTime();
    expect(utcMs(event.startDate)).toBe(startUtc);
    expect(utcMs(event.endDate)).toBe(startUtc + minutes * 60_000);
  });

  it('writes the end in UTC when it falls in the repeated hour, where a local DTEND would read as the earlier instant', () => {
    // London 2026-10-25: 00:30 BST + 2 h = 01:30 GMT, but 01:30 also existed an hour earlier as BST.
    const ics = buildIcs(makeEvent({ timeZone: 'Europe/London', start: { date: '2026-10-25', time: '00:30' }, durationMinutes: 120 }));
    const lines = contentLines(ics);
    expect(lines).toContain('DTSTART;TZID=Europe/London:20261025T003000');
    expect(lines).toContain('DTEND:20261025T013000Z');
    const { event } = parse(ics);
    expect(utcMs(event.startDate)).toBe(Date.UTC(2026, 9, 24, 23, 30));
    expect(utcMs(event.endDate)).toBe(Date.UTC(2026, 9, 25, 1, 30));
  });

  it('writes a one-off start inside a DST gap as the wall time it resolves to', () => {
    const ics = buildIcs(makeEvent({ timeZone: 'America/New_York', start: { date: '2026-03-08', time: '02:30' } }));
    const lines = contentLines(ics);
    expect(lines).toContain('DTSTART;TZID=America/New_York:20260308T033000');
    expect(lines).toContain('DTEND;TZID=America/New_York:20260308T034500');
    const { event } = parse(ics);
    expect(utcMs(event.startDate)).toBe(zonedTimeToUtc({ date: '2026-03-08', time: '02:30' }, 'America/New_York').getTime());
  });

  it('keeps the chosen wall time of a recurring event even when its first instance is in a gap', () => {
    const ics = buildIcs(
      makeEvent({ timeZone: 'America/New_York', start: { date: '2026-03-08', time: '02:30' }, rrule: 'FREQ=DAILY;COUNT=3' }),
    );
    expect(contentLines(ics)).toContain('DTSTART;TZID=America/New_York:20260308T023000');
    expect(contentLines(ics)).toContain('DTEND;TZID=America/New_York:20260308T034500');
  });
});

describe('icsFileName', () => {
  const nameFor = (title: string, date = '2026-10-22'): string => icsFileName(makeEvent({ title, start: { date, time: '09:00' } }));

  it('builds a safe ASCII name from the recipient part of the title and the date', () => {
    expect(nameFor('💬 WhatsApp Mom: Happy birthday!')).toBe('whatsapp-mom-2026-10-22.ics');
    expect(nameFor('💬 WhatsApp Mom')).toBe('whatsapp-mom-2026-10-22.ics');
    expect(nameFor('💬 WhatsApp José Ñúñez: hola', '2027-01-05')).toBe('whatsapp-jose-nunez-2027-01-05.ics');
    expect(nameFor('💬 WhatsApp +972 50-123-4567: hi')).toBe('whatsapp-972-50-123-4567-2026-10-22.ics');
    expect(nameFor('💬 WhatsApp אמא: מזל טוב')).toBe('whatsapp-2026-10-22.ics');
  });

  it('falls back to a generic name and neutralises path tricks', () => {
    expect(nameFor('')).toBe('whatsapp-reminder-2026-10-22.ics');
    expect(nameFor('אמא')).toBe('whatsapp-reminder-2026-10-22.ics');
    expect(nameFor('../../etc/passwd')).toBe('etc-passwd-2026-10-22.ics');
    expect(nameFor('CON\\..\\"quoted"*?<>|')).toBe('con-quoted-2026-10-22.ics');
  });

  it('caps the length without leaving a trailing dash', () => {
    const name = nameFor(`💬 WhatsApp ${'Bartholomew '.repeat(8)}: hi`);
    expect(name).toBe('whatsapp-bartholomew-bartholomew-barthol-2026-10-22.ics');
    expect(nameFor(`💬 WhatsApp ${'abc '.repeat(20)}`)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*-2026-10-22\.ics$/);
  });
});
