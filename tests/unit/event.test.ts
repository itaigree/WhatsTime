import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { buildIcs } from '../../src/core/ics';
import {
  eventDescription,
  eventTitle,
  firstReminderAt,
  messageSnippet,
  toCalendarEvent,
  validateScheduledMessage,
} from '../../src/core/event';
import { buildGoogleCalendarUrl } from '../../src/core/gcal';
import { defaultRecurrence } from '../../src/core/recurrence';
import type { Recurrence, ScheduledMessage } from '../../src/core/types';

const NOW = new Date('2026-10-22T10:00:00Z');

function makeMessage(overrides: Partial<ScheduledMessage> = {}, recurrence: Partial<Recurrence> = {}): ScheduledMessage {
  return {
    id: 'abc-123',
    recipient: { name: 'Mom', phone: '972501234567' },
    message: 'Happy birthday! 🎂\nLove you',
    start: { date: '2026-10-25', time: '09:00' },
    timeZone: 'Asia/Jerusalem',
    reminderMinutesBefore: 0,
    durationMinutes: 15,
    recurrence: { ...defaultRecurrence(), ...recurrence },
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

describe('messageSnippet', () => {
  it('keeps short first lines and truncates long ones without splitting emoji', () => {
    expect(messageSnippet('  Hi there\nsecond line')).toBe('Hi there');
    expect(messageSnippet('')).toBe('');
    const long = '👍'.repeat(50);
    const snippet = messageSnippet(long);
    expect([...snippet]).toHaveLength(40);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('eventTitle / eventDescription', () => {
  it('names the recipient and previews the message', () => {
    expect(eventTitle(makeMessage())).toBe('💬 WhatsApp Mom: Happy birthday! 🎂');
  });

  it('falls back to the formatted number, then to a generic title', () => {
    expect(eventTitle(makeMessage({ recipient: { name: ' ', phone: '972501234567' } }))).toBe(
      '💬 WhatsApp +972 50-123-4567: Happy birthday! 🎂',
    );
    expect(eventTitle(makeMessage({ recipient: { name: '', phone: '' }, message: '' }))).toBe('💬 WhatsApp');
  });

  it('puts the link first and includes recipient and message', () => {
    const text = eventDescription(makeMessage(), 'https://wa.me/972501234567?text=x');
    const lines = text.split('\n');
    expect(lines[1]).toBe('https://wa.me/972501234567?text=x');
    expect(text).toContain('To: Mom (+972 50-123-4567)');
    expect(text).toContain('Happy birthday! 🎂\nLove you');
    expect(eventDescription(makeMessage({ recipient: { name: '', phone: '' } }), 'L')).toContain(
      'To: choose the chat in WhatsApp',
    );
  });
});

describe('toCalendarEvent', () => {
  it('builds a one-off event with the wa.me link', () => {
    const event = toCalendarEvent(makeMessage(), NOW);
    expect(event.uid).toBe('abc-123@whatstime');
    expect(event.url).toBe(
      'https://wa.me/972501234567?text=Happy%20birthday!%20%F0%9F%8E%82%0ALove%20you',
    );
    expect(event.rrule).toBeNull();
    expect(event.start).toEqual({ date: '2026-10-25', time: '09:00' });
    expect(event.dtstamp).toBe(NOW);
  });

  it('aligns a weekly start to the first selected weekday', () => {
    // 2026-10-25 is a Sunday; repeat on Tue/Thu.
    const event = toCalendarEvent(
      makeMessage({}, { frequency: 'weekly', weekdays: ['TU', 'TH'] }),
      NOW,
    );
    expect(event.start.date).toBe('2026-10-27');
    expect(event.rrule).toBe('FREQ=WEEKLY;BYDAY=TU,TH');
  });

  it('produces an ICS that ical.js reads back with the right instant and alarm', () => {
    const event = toCalendarEvent(
      makeMessage({ reminderMinutesBefore: 10 }, { frequency: 'monthly', end: { type: 'count', count: 3 } }),
      NOW,
    );
    const vevent = new ICAL.Component(ICAL.parse(buildIcs(event))).getFirstSubcomponent('vevent')!;
    const icalEvent = new ICAL.Event(vevent);
    expect(icalEvent.startDate.toJSDate().toISOString()).toBe('2026-10-25T07:00:00.000Z');
    expect(icalEvent.summary).toBe(event.title);
    expect(icalEvent.description).toBe(event.description);
    expect(vevent.getFirstPropertyValue('url')).toBe(event.url);
    const alarm = vevent.getFirstSubcomponent('valarm')!;
    expect(String(alarm.getFirstPropertyValue('trigger'))).toBe('-PT10M');
    const it = icalEvent.iterator();
    const dates: string[] = [];
    for (let next = it.next(); next; next = it.next()) dates.push(next.toString());
    expect(dates).toEqual(['2026-10-25T09:00:00', '2026-11-25T09:00:00', '2026-12-25T09:00:00']);
  });

  it('produces a Google Calendar link with the same rule', () => {
    const event = toCalendarEvent(makeMessage({}, { frequency: 'daily', interval: 2 }), NOW);
    const url = new URL(buildGoogleCalendarUrl(event));
    expect(url.searchParams.get('recur')).toBe('RRULE:FREQ=DAILY;INTERVAL=2');
    expect(url.searchParams.get('dates')).toBe('20261025T090000/20261025T091500');
    expect(url.searchParams.get('ctz')).toBe('Asia/Jerusalem');
    expect(url.searchParams.get('details')).toContain(event.url);
  });
});

describe('firstReminderAt', () => {
  it('subtracts the reminder offset from the aligned start', () => {
    expect(firstReminderAt(makeMessage({ reminderMinutesBefore: 60 })).toISOString()).toBe('2026-10-25T06:00:00.000Z');
  });
});

describe('validateScheduledMessage', () => {
  it('accepts a good message', () => {
    expect(validateScheduledMessage(makeMessage(), NOW)).toEqual({ errors: [], warnings: [] });
  });

  it('allows an empty phone (choose chat in WhatsApp) but not a malformed one', () => {
    expect(validateScheduledMessage(makeMessage({ recipient: { name: '', phone: '' } }), NOW).errors).toEqual([]);
    expect(
      validateScheduledMessage(makeMessage({ recipient: { name: '', phone: '0501234567' } }), NOW).errors.map((e) => e.field),
    ).toEqual(['recipient']);
  });

  it('reports missing message, bad date/time, zone, reminder and duration', () => {
    const result = validateScheduledMessage(
      makeMessage({
        message: '   ',
        start: { date: '2026-02-30', time: '25:00' },
        timeZone: 'Mars/Olympus',
        reminderMinutesBefore: -5,
        durationMinutes: 0,
      }),
      NOW,
    );
    expect(result.errors.map((e) => e.field)).toEqual(['message', 'date', 'time', 'timeZone', 'reminder', 'duration']);
  });

  it('rejects a one-off reminder in the past but only warns for repeating ones', () => {
    const past = { start: { date: '2026-10-22', time: '12:00' } }; // 09:00Z < NOW? 12:00 IDT = 09:00Z < 10:00Z
    expect(validateScheduledMessage(makeMessage(past), NOW).errors.map((e) => e.message)).toEqual([
      'That time has already passed.',
    ]);
    const repeating = validateScheduledMessage(makeMessage(past, { frequency: 'daily' }), NOW);
    expect(repeating.errors).toEqual([]);
    expect(repeating.warnings.map((w) => w.field)).toEqual(['date']);
  });

  it('counts the reminder offset when checking the past', () => {
    const msg = makeMessage({ start: { date: '2026-10-22', time: '13:30' }, reminderMinutesBefore: 60 });
    expect(validateScheduledMessage(msg, NOW).errors.map((e) => e.field)).toEqual(['date']);
  });

  it('passes recurrence problems through', () => {
    const result = validateScheduledMessage(makeMessage({}, { frequency: 'daily', interval: 0 }), NOW);
    expect(result.errors.map((e) => e.field)).toEqual(['recurrence']);
  });

  it('warns about very long messages', () => {
    const result = validateScheduledMessage(makeMessage({ message: 'שלום '.repeat(200) }), NOW);
    expect(result.warnings.map((w) => w.field)).toEqual(['message']);
  });
});
