import { describe, expect, it } from 'vitest';
import { buildGoogleCalendarUrl, isUtcZone } from '../../src/core/gcal';
import type { CalendarEvent } from '../../src/core/types';

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    uid: 'abc@whatstime',
    title: 'Call Mom',
    description: 'Tap the link',
    url: 'https://wa.me/972501234567?text=Hi',
    start: { date: '2026-10-25', time: '09:00' },
    timeZone: 'Asia/Jerusalem',
    durationMinutes: 15,
    reminderMinutesBefore: 10,
    rrule: null,
    dtstamp: new Date('2026-10-22T10:00:00Z'),
    ...overrides,
  };
}

function params(event: CalendarEvent): URLSearchParams {
  const url = new URL(buildGoogleCalendarUrl(event));
  expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
  expect(url.hash).toBe('');
  return url.searchParams;
}

function datesFor(date: string, time: string, timeZone: string, durationMinutes = 15): string | null {
  return params(makeEvent({ start: { date, time }, timeZone, durationMinutes })).get('dates');
}

describe('buildGoogleCalendarUrl: shape and encoding', () => {
  it('builds the exact URL for a simple one-off event', () => {
    expect(buildGoogleCalendarUrl(makeEvent({ title: 'Hi there', description: 'Line 1\nLine 2' }))).toBe(
      'https://calendar.google.com/calendar/render?action=TEMPLATE&text=Hi+there' +
        '&dates=20261025T090000%2F20261025T091500&ctz=Asia%2FJerusalem&crm=AVAILABLE&trp=false' +
        '&details=Line+1%0ALine+2',
    );
  });

  it('emits params in a fixed order and each exactly once', () => {
    const p = params(makeEvent({ rrule: 'FREQ=DAILY' }));
    expect([...p.keys()]).toEqual(['action', 'text', 'dates', 'ctz', 'crm', 'trp', 'details', 'recur']);
    expect(p.get('action')).toBe('TEMPLATE');
  });

  it('marks the event as free (available), like TRANSP:TRANSPARENT in the .ics', () => {
    for (const rrule of [null, 'FREQ=WEEKLY;BYDAY=SU,TU']) {
      const p = params(makeEvent({ rrule }));
      expect(p.getAll('crm')).toEqual(['AVAILABLE']);
      expect(p.getAll('trp')).toEqual(['false']);
    }
  });

  it('round-trips title and description with reserved characters, Hebrew, emoji and newlines', () => {
    const title = '💬 WhatsApp אמא: Tom & Jerry #1 + 50% off? "yes"';
    const description = [
      'Tap the link to open WhatsApp with your message ready to send:',
      'https://wa.me/972501234567?text=%D7%A9%D7%9C%D7%95%D7%9D%20%26%20hi',
      '',
      'Message:',
      'שלום 👨‍👩‍👧 🇮🇱\r\nline=2; a,b',
    ].join('\n');
    const p = params(makeEvent({ title, description }));
    expect(p.get('text')).toBe(title);
    expect(p.get('details')).toBe(description);
  });

  it('keeps the wa.me link in details intact (its own escapes survive one level of decoding)', () => {
    const link = 'https://wa.me/972501234567?text=Hello%20%26%20bye%0A%F0%9F%98%80';
    const p = params(makeEvent({ description: `Open:\n${link}` }));
    expect(p.get('details')).toBe(`Open:\n${link}`);
  });

  it('encodes with URLSearchParams rules: spaces as +, literal + as %2B', () => {
    const url = buildGoogleCalendarUrl(makeEvent({ title: 'a b+c', description: 'x' }));
    expect(url).toContain('&text=a+b%2Bc&');
    expect(url).toMatch(/^[\x21-\x7E]+$/);
  });

  it('passes the time zone through as ctz', () => {
    expect(params(makeEvent({ timeZone: 'America/New_York' })).get('ctz')).toBe('America/New_York');
    expect(params(makeEvent({ timeZone: 'Asia/Kolkata' })).get('ctz')).toBe('Asia/Kolkata');
    expect(params(makeEvent({ timeZone: 'UTC' })).get('ctz')).toBe('UTC');
  });

  it('handles an empty title and description', () => {
    const p = params(makeEvent({ title: '', description: '' }));
    expect(p.get('text')).toBe('');
    expect(p.get('details')).toBe('');
  });
});

describe('buildGoogleCalendarUrl: recur', () => {
  it('is absent for one-off events (null or empty rrule)', () => {
    expect(params(makeEvent({ rrule: null })).has('recur')).toBe(false);
    expect(params(makeEvent({ rrule: '' })).has('recur')).toBe(false);
  });

  it('is the RRULE prefixed with "RRULE:"', () => {
    expect(params(makeEvent({ rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=10' })).get('recur')).toBe(
      'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=10',
    );
    expect(params(makeEvent({ rrule: 'FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20261231T215959Z' })).get('recur')).toBe(
      'RRULE:FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20261231T215959Z',
    );
  });

  it('escapes the rule in the raw URL', () => {
    expect(buildGoogleCalendarUrl(makeEvent({ rrule: 'FREQ=DAILY;INTERVAL=2' }))).toMatch(
      /&recur=RRULE%3AFREQ%3DDAILY%3BINTERVAL%3D2$/,
    );
  });
});

describe('buildGoogleCalendarUrl: dates', () => {
  it('uses local wall times in the event zone', () => {
    expect(datesFor('2026-10-25', '09:00', 'Asia/Jerusalem')).toBe('20261025T090000/20261025T091500');
    expect(datesFor('2026-07-04', '18:30', 'America/New_York', 90)).toBe('20260704T183000/20260704T200000');
    expect(datesFor('2026-10-22', '09:00', 'Asia/Kolkata', 1)).toBe('20261022T090000/20261022T090100');
  });

  it('rolls the end past midnight, month end and year end', () => {
    expect(datesFor('2026-10-22', '23:50', 'Asia/Jerusalem')).toBe('20261022T235000/20261023T000500');
    expect(datesFor('2026-02-28', '23:30', 'Europe/London', 60)).toBe('20260228T233000/20260301T003000');
    expect(datesFor('2026-12-31', '23:50', 'Asia/Kolkata')).toBe('20261231T235000/20270101T000500');
    expect(datesFor('2028-02-28', '23:45', 'Asia/Tokyo', 30)).toBe('20280228T234500/20280229T001500');
  });

  it('handles a 24 hour event', () => {
    expect(datesFor('2026-10-22', '09:00', 'Asia/Jerusalem', 1440)).toBe('20261022T090000/20261023T090000');
  });

  describe('end crossing a spring-forward transition (computed via UTC)', () => {
    it('America/New_York (02:00 -> 03:00 on 2026-03-08)', () => {
      expect(datesFor('2026-03-08', '01:50', 'America/New_York')).toBe('20260308T015000/20260308T030500');
      expect(datesFor('2026-03-07', '12:00', 'America/New_York', 1440)).toBe('20260307T120000/20260308T130000');
    });

    it('Asia/Jerusalem (02:00 -> 03:00 on Friday 2026-03-27)', () => {
      expect(datesFor('2026-03-27', '01:30', 'Asia/Jerusalem', 60)).toBe('20260327T013000/20260327T033000');
    });

    it('Europe/London (01:00 -> 02:00 on 2026-03-29)', () => {
      expect(datesFor('2026-03-29', '00:45', 'Europe/London', 30)).toBe('20260329T004500/20260329T021500');
    });

    it('Australia/Lord_Howe 30-minute DST (02:00 -> 02:30 on 2026-10-04)', () => {
      expect(datesFor('2026-10-04', '01:50', 'Australia/Lord_Howe')).toBe('20261004T015000/20261004T023500');
    });

    it('writes a one-off start inside the gap as the wall time it resolves to (RFC 5545: 02:30 -> 03:30 EDT)', () => {
      expect(datesFor('2026-03-08', '02:30', 'America/New_York')).toBe('20260308T033000/20260308T034500');
      expect(datesFor('2026-03-27', '02:15', 'Asia/Jerusalem', 30)).toBe('20260327T031500/20260327T034500');
    });

    it('keeps a recurring start inside the gap as typed so later repeats keep that wall time', () => {
      const start = { date: '2026-03-08', time: '02:30' };
      const p = params(makeEvent({ start, timeZone: 'America/New_York', rrule: 'FREQ=DAILY' }));
      expect(p.get('dates')).toBe('20260308T023000/20260308T034500');
    });
  });

  describe('end crossing a fall-back transition', () => {
    it('uses wall times when the end is after the repeated hour', () => {
      // 23:30 EDT + 4h = 02:30 EST (the clock showed 01:xx twice).
      expect(datesFor('2026-10-31', '23:30', 'America/New_York', 240)).toBe('20261031T233000/20261101T023000');
      // Europe/London 2026-10-25: 02:00 BST -> 01:00 GMT. 00:30 BST + 3h = 02:30 GMT.
      expect(datesFor('2026-10-25', '00:30', 'Europe/London', 180)).toBe('20261025T003000/20261025T023000');
    });

    it('uses wall times when the end is in the first pass of the repeated hour', () => {
      expect(datesFor('2026-11-01', '01:00', 'America/New_York', 30)).toBe('20261101T010000/20261101T013000');
      // Lord Howe 2026-04-05: 02:00 -> 01:30. 01:20 + 15 = 01:35 (first pass).
      expect(datesFor('2026-04-05', '01:20', 'Australia/Lord_Howe')).toBe('20260405T012000/20260405T013500');
    });

    it('falls back to UTC instants when the end lands in the second pass of the repeated hour', () => {
      // 01:50 EDT (05:50Z) + 15 min = 01:05 EST: earlier on the wall clock than the start.
      expect(datesFor('2026-11-01', '01:50', 'America/New_York')).toBe('20261101T055000Z/20261101T060500Z');
      // 01:30 EDT + 60 min = 01:30 EST: same wall time as the start.
      expect(datesFor('2026-11-01', '01:30', 'America/New_York', 60)).toBe('20261101T053000Z/20261101T063000Z');
      // 00:30 EDT + 2h = 01:30 EST, which would read back as 01:30 EDT (a 1 hour event).
      expect(datesFor('2026-11-01', '00:30', 'America/New_York', 120)).toBe('20261101T043000Z/20261101T063000Z');
      // Asia/Jerusalem 2026-10-25: 02:00 IDT -> 01:00 IST. 01:30 IDT + 45 min = 01:15 IST.
      expect(datesFor('2026-10-25', '01:30', 'Asia/Jerusalem', 45)).toBe('20261024T223000Z/20261024T231500Z');
    });
  });

  describe('UTC zones use the Z form', () => {
    it.each(['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT', 'Etc/Universal', 'Etc/Zulu'])('%s', (timeZone) => {
      expect(datesFor('2026-10-22', '09:00', timeZone)).toBe('20261022T090000Z/20261022T091500Z');
      expect(datesFor('2026-12-31', '23:50', timeZone)).toBe('20261231T235000Z/20270101T000500Z');
    });

    it('keeps the recurrence and ctz alongside the Z form', () => {
      const p = params(makeEvent({ timeZone: 'UTC', rrule: 'FREQ=YEARLY' }));
      expect(p.get('dates')).toBe('20261025T090000Z/20261025T091500Z');
      expect(p.get('ctz')).toBe('UTC');
      expect(p.get('recur')).toBe('RRULE:FREQ=YEARLY');
    });

    it('does not treat Europe/London (GMT in winter) as UTC', () => {
      expect(datesFor('2026-01-15', '09:00', 'Europe/London')).toBe('20260115T090000/20260115T091500');
      expect(datesFor('2026-07-15', '09:00', 'Europe/London')).toBe('20260715T090000/20260715T091500');
    });
  });

  it('throws RangeError for an invalid start', () => {
    expect(() => buildGoogleCalendarUrl(makeEvent({ start: { date: '2026-02-30', time: '09:00' } }))).toThrow(
      RangeError,
    );
    expect(() => buildGoogleCalendarUrl(makeEvent({ start: { date: '2026-02-01', time: '24:00' } }))).toThrow(
      RangeError,
    );
  });
});

describe('isUtcZone', () => {
  const utcAliases = ['UTC', 'utc', 'Etc/UTC', 'Etc/UCT', 'UCT', 'Universal', 'Etc/Universal', 'Zulu', 'Etc/Zulu'];
  const gmtAliases = ['GMT', 'Etc/GMT', 'GMT0', 'Etc/GMT0', 'Etc/GMT+0', 'Etc/GMT-0', 'Greenwich', 'Etc/Greenwich'];

  it.each([...utcAliases, ...gmtAliases])('%s is UTC', (zone) => {
    expect(isUtcZone(zone)).toBe(true);
  });

  it.each(['Europe/London', 'Africa/Abidjan', 'Etc/GMT+1', 'Etc/GMT-10', 'Asia/Jerusalem', '', 'UTC+1', 'America/UTC'])(
    '%s is not UTC',
    (zone) => {
      expect(isUtcZone(zone)).toBe(false);
    },
  );
});

describe('chosen calendar', () => {
  const ID = 'd160f7f34387f5fe047406dbe1d1d421c5589e3e9dee333d7626d08d68b0008e@group.calendar.google.com';

  it('adds src only when a calendar is chosen, before details', () => {
    expect(new URL(buildGoogleCalendarUrl(makeEvent())).searchParams.has('src')).toBe(false);
    const url = new URL(buildGoogleCalendarUrl(makeEvent({ rrule: 'FREQ=DAILY' }), ID));
    expect(url.searchParams.get('src')).toBe(ID);
    expect([...url.searchParams.keys()]).toEqual(['action', 'text', 'dates', 'ctz', 'crm', 'trp', 'src', 'details', 'recur']);
  });
});
