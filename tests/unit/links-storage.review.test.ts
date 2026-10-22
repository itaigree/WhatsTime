/**
 * Adversarial review tests for whatsapp.ts, gcal.ts and storage.ts.
 */
import { describe, expect, it } from 'vitest';
import { GOOGLE_CALENDAR_URL_MAX_LENGTH, buildGoogleCalendarUrl } from '../../src/core/gcal';
import { defaultRecurrence } from '../../src/core/recurrence';
import { createStore, sanitizeMessage, type KeyValueStore } from '../../src/core/storage';
import type { CalendarEvent, ScheduledMessage } from '../../src/core/types';
import { buildWhatsAppLink } from '../../src/core/whatsapp';

const PHONE = '972501234567';
const HISTORY_KEY = 'whatstime:v1:history';
const CONTACTS_KEY = 'whatstime:v1:contacts';

/** The text WhatsApp receives from a link. */
const textOf = (link: string): string | null => new URL(link).searchParams.get('text');

/**
 * How Android's Linkify (Patterns.WEB_URL, used by calendar apps on the primary target platform) finds a URL in
 * plain text: the match must end on a word boundary, so trailing non-word characters are left out of the link.
 */
function androidLinkify(text: string): string | null {
  return /https:\/\/wa\.me\/\S*\b/.exec(text)?.[0] ?? null;
}

/** Linkifiers in the style of Closure / linkify-it (web calendars) strip trailing sentence punctuation. */
function punctuationStrippingLinkify(text: string): string | null {
  const match = /https:\/\/wa\.me\/\S*/.exec(text)?.[0];
  return match ? match.replace(/[.,;:!?'"*~)\]}-]+$/, '') : null;
}

describe('wa.me link survives calendar linkifiers', () => {
  const messages = [
    'Happy birthday!',
    'See you tomorrow.',
    'Thanks...',
    'Are we still on for (dinner)',
    "Don't forget the cake'",
    '*Happy birthday*',
    '_see you soon_',
    '~cancelled~',
    'Call me back -',
    'מזל טוב!',
    'שבת שלום :)',
  ];

  it.each(messages)('%j keeps its last character when tapped from a calendar description', (message) => {
    const link = buildWhatsAppLink(PHONE, message);
    expect(textOf(link)).toBe(message);
    const description = `Tap the link to open WhatsApp:\n${link}\n\nTo: Mom`;
    for (const linkify of [androidLinkify, punctuationStrippingLinkify]) {
      const tapped = linkify(description);
      expect(tapped).not.toBeNull();
      expect(textOf(tapped ?? '')).toBe(message);
    }
  });

  it('ends every link with a letter or digit', () => {
    for (const message of messages) expect(buildWhatsAppLink(PHONE, message)).toMatch(/[A-Za-z0-9]$/);
    expect(buildWhatsAppLink('', 'Hi all!')).toMatch(/[A-Za-z0-9]$/);
  });

  it('still leaves punctuation inside the message as encodeURIComponent writes it', () => {
    expect(buildWhatsAppLink(PHONE, "Hi! It's 5 o'clock (ok).")).toBe(
      "https://wa.me/972501234567?text=Hi!%20It's%205%20o'clock%20(ok%29%2E",
    );
  });
});

describe('wa.me phone path', () => {
  it('never starts the number with zeros (international prefix 00 / +00)', () => {
    expect(buildWhatsAppLink('00972501234567', 'x')).toBe('https://wa.me/972501234567?text=x');
    expect(buildWhatsAppLink('+001 (212) 555-0123', 'x')).toBe('https://wa.me/12125550123?text=x');
    expect(buildWhatsAppLink('0', 'x')).toBe('https://wa.me/?text=x');
  });
});

describe('Google Calendar link length', () => {
  const HEBREW_WISHES = 'מזל טוב ליום הולדת! 🎂🎉 '.repeat(30).trim();

  function eventFor(message: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    const url = buildWhatsAppLink(PHONE, message);
    return {
      uid: 'abc@whatstime',
      title: '💬 WhatsApp Mom: long one',
      description: [
        'Tap the link to open WhatsApp with your message ready to send:',
        url,
        '',
        'To: Mom (+972 50-123-4567)',
        '',
        'Message:',
        message,
        '',
        'Scheduled with WhatsTime',
      ].join('\n'),
      url,
      start: { date: '2026-10-25', time: '09:00' },
      timeZone: 'Asia/Jerusalem',
      durationMinutes: 15,
      reminderMinutesBefore: 10,
      rrule: 'FREQ=WEEKLY;BYDAY=SU',
      dtstamp: new Date('2026-10-22T10:00:00Z'),
      ...overrides,
    };
  }

  /** The URL as it would be without any shortening. */
  function untrimmedLength(event: CalendarEvent): number {
    const params = new URLSearchParams({ action: 'TEMPLATE', text: event.title, dates: 'x'.repeat(31) });
    params.set('ctz', event.timeZone);
    params.set('details', event.description);
    if (event.rrule) params.set('recur', `RRULE:${event.rrule}`);
    return 'https://calendar.google.com/calendar/render?'.length + params.toString().length;
  }

  it('is a sensible limit', () => {
    expect(GOOGLE_CALENDAR_URL_MAX_LENGTH).toBeGreaterThanOrEqual(2000);
    expect(GOOGLE_CALENDAR_URL_MAX_LENGTH).toBeLessThanOrEqual(8192);
  });

  it('a few hundred Hebrew characters and emoji already exceed it untrimmed', () => {
    const message = HEBREW_WISHES; // ~700 characters
    expect(untrimmedLength(eventFor(message))).toBeGreaterThan(GOOGLE_CALENDAR_URL_MAX_LENGTH);
  });

  it.each([
    ['Hebrew + emoji', HEBREW_WISHES],
    ['long English', `${'Please remember to bring the documents for the meeting. '.repeat(70)}Thanks!`],
    ['emoji only', '👨‍👩‍👧‍👦🇮🇱'.repeat(40)],
  ])('shortens details to fit while keeping the full wa.me link (%s)', (_label, message) => {
    const event = eventFor(message);
    const url = buildGoogleCalendarUrl(event);
    expect(url.length).toBeLessThanOrEqual(GOOGLE_CALENDAR_URL_MAX_LENGTH);
    const params = new URL(url).searchParams;
    const details = params.get('details') ?? '';
    expect(details).toContain(event.url);
    expect(event.description.startsWith(details.slice(0, -1))).toBe(true);
    expect(details.endsWith('…')).toBe(true);
    expect(details).not.toContain('�');
    expect(textOf(androidLinkify(details) ?? '')).toBe(message);
    expect(params.get('text')).toBe(event.title);
    expect(params.get('dates')).toBe('20261025T090000/20261025T091500');
    expect(params.get('ctz')).toBe('Asia/Jerusalem');
    expect(params.get('recur')).toBe('RRULE:FREQ=WEEKLY;BYDAY=SU');
  });

  it('uses as much of the description as fits', () => {
    const event = eventFor(HEBREW_WISHES);
    const url = buildGoogleCalendarUrl(event);
    const details = new URL(url).searchParams.get('details') ?? '';
    // One more code point would not fit (each costs at most 12 URL characters).
    expect(url.length).toBeGreaterThan(GOOGLE_CALENDAR_URL_MAX_LENGTH - 12 - 9);
    expect(details.length).toBeGreaterThan(event.url.length);
  });

  it('keeps the link alone when even link + context cannot fit', () => {
    const message = 'שלום '.repeat(800);
    const event = eventFor(message);
    const url = buildGoogleCalendarUrl(event);
    const details = new URL(url).searchParams.get('details');
    expect(details).toBe(event.url);
    expect(url.length).toBeLessThan(untrimmedLength(event));
  });

  it('does not touch details that fit', () => {
    const event = eventFor('Short and sweet!');
    expect(new URL(buildGoogleCalendarUrl(event)).searchParams.get('details')).toBe(event.description);
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

function makeMessage(overrides: Partial<ScheduledMessage> = {}): ScheduledMessage {
  return {
    id: 'msg-1',
    recipient: { name: 'Mom', phone: '972501234567' },
    message: 'Happy birthday!',
    start: { date: '2026-10-25', time: '09:00' },
    timeZone: 'Asia/Jerusalem',
    reminderMinutesBefore: 10,
    durationMinutes: 15,
    recurrence: defaultRecurrence(),
    createdAt: '2026-10-22T10:00:00.000Z',
    ...overrides,
  };
}

describe('storage: records that would crash the calendar views are dropped', () => {
  it.each(['Mars/Olympus', 'Asia/Jerusalam', '+05:30', 'not a zone'])('drops time zone %j', (timeZone) => {
    expect(sanitizeMessage(makeMessage({ timeZone }))).toBeNull();
    const backend = new MemoryStore();
    backend.setItem(HISTORY_KEY, JSON.stringify([makeMessage({ timeZone }), makeMessage({ id: 'ok' })]));
    expect(createStore(backend).listHistory().map((m) => m.id)).toEqual(['ok']);
  });

  it.each(['UTC', 'Etc/GMT-14', 'America/Argentina/Buenos_Aires', 'Asia/Calcutta', 'Australia/Lord_Howe'])(
    'keeps time zone %j',
    (timeZone) => {
      expect(sanitizeMessage(makeMessage({ timeZone }))?.timeZone).toBe(timeZone);
    },
  );

  it('rejects phone numbers with leading zeros (Recipient.phone contract)', () => {
    expect(sanitizeMessage(makeMessage({ recipient: { name: 'x', phone: '0501234567' } }))).toBeNull();
    expect(sanitizeMessage(makeMessage({ recipient: { name: 'x', phone: '00972501234567' } }))).toBeNull();
    const backend = new MemoryStore();
    backend.setItem(
      CONTACTS_KEY,
      JSON.stringify([{ name: 'Zero', phone: '0501234567', lastUsed: '2026-10-01T00:00:00.000Z' }]),
    );
    expect(createStore(backend).listRecentContacts()).toEqual([]);
  });

  it('does not remember a contact whose number has leading zeros', () => {
    const backend = new MemoryStore();
    const store = createStore(backend);
    store.rememberContact({ name: 'Local', phone: '050-123-4567' }, new Date('2026-10-22T10:00:00Z'));
    expect(backend.data.has(CONTACTS_KEY)).toBe(false);
  });
});

describe('storage: rewriting history keeps what a newer app version wrote', () => {
  // A PWA can run an older cached build next to data written by a newer one (stale tab, pending service worker).
  const fromNewerVersion = {
    ...makeMessage({ id: 'newer', createdAt: '2026-10-20T10:00:00.000Z' }),
    note: 'added in v1.1',
    recipient: { name: 'Dad', phone: '972509999999', label: 'Mobile' },
    recurrence: { ...defaultRecurrence(), frequency: 'hourly' },
  };

  it('saveToHistory leaves other records untouched', () => {
    const backend = new MemoryStore();
    backend.setItem(HISTORY_KEY, JSON.stringify([fromNewerVersion]));
    createStore(backend).saveToHistory(makeMessage());
    const stored = JSON.parse(backend.getItem(HISTORY_KEY) ?? '[]') as unknown[];
    expect(stored).toHaveLength(2);
    expect(stored[1]).toEqual(fromNewerVersion);
    expect(stored[0]).toEqual(makeMessage());
  });

  it('deleteFromHistory leaves other records untouched', () => {
    const backend = new MemoryStore();
    backend.setItem(HISTORY_KEY, JSON.stringify([makeMessage(), fromNewerVersion]));
    createStore(backend).deleteFromHistory('msg-1');
    expect(JSON.parse(backend.getItem(HISTORY_KEY) ?? '[]')).toEqual([fromNewerVersion]);
  });

  it('still lists the sanitized form', () => {
    const backend = new MemoryStore();
    backend.setItem(HISTORY_KEY, JSON.stringify([fromNewerVersion]));
    const [listed] = createStore(backend).listHistory();
    expect(listed).toEqual({
      ...makeMessage({ id: 'newer', createdAt: '2026-10-20T10:00:00.000Z' }),
      recipient: { name: 'Dad', phone: '972509999999' },
    });
  });

  it('still drops invalid records, duplicates and the overflow when rewriting', () => {
    const backend = new MemoryStore();
    const older = { ...makeMessage({ id: 'dup', createdAt: '2026-01-01T00:00:00.000Z' }), message: 'old' };
    const newer = { ...makeMessage({ id: 'dup', createdAt: '2026-02-01T00:00:00.000Z' }), message: 'new' };
    backend.setItem(HISTORY_KEY, JSON.stringify([{ junk: true }, older, newer, 42]));
    createStore(backend).saveToHistory(makeMessage());
    expect(JSON.parse(backend.getItem(HISTORY_KEY) ?? '[]')).toEqual([makeMessage(), newer]);
  });
});
