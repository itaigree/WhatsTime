import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultRecurrence } from '../../src/core/recurrence';
import {
  CONTACTS_CAP,
  HISTORY_CAP,
  KEY_PREFIX,
  createStore,
  isGoogleCalendarId,
  newId,
  sanitizeMessage,
  sanitizeRecurrence,
  type KeyValueStore,
} from '../../src/core/storage';
import type { ScheduledMessage, Settings } from '../../src/core/types';

const KEYS = {
  settings: 'whatstime:v1:settings',
  history: 'whatstime:v1:history',
  contacts: 'whatstime:v1:contacts',
  draft: 'whatstime:v1:draft',
};

const DEFAULTS: Settings = { defaultCountry: 'IL', defaultReminderMinutesBefore: 0, defaultDurationMinutes: 15 };
const NOW = new Date('2026-10-22T10:00:00.000Z');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  writes = 0;

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.data.set(key, value);
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes++;
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.writes++;
    this.data.delete(key);
  }

  json(key: string): unknown {
    const raw = this.data.get(key);
    return raw === undefined ? undefined : JSON.parse(raw);
  }
}

/** Reads work, every write fails like a full localStorage. */
class QuotaStore extends MemoryStore {
  override setItem(): void {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  }

  override removeItem(): void {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  }
}

/** Every access throws, like Safari private mode or blocked site data. */
const throwingStore: KeyValueStore = {
  getItem() {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem() {
    throw new DOMException('denied', 'SecurityError');
  },
  removeItem() {
    throw new DOMException('denied', 'SecurityError');
  },
};

function makeMessage(overrides: Partial<ScheduledMessage> = {}): ScheduledMessage {
  return {
    id: 'msg-1',
    recipient: { name: 'Mom', phone: '972501234567' },
    message: 'Happy birthday! 🎂\nLove you',
    start: { date: '2026-10-25', time: '09:00' },
    timeZone: 'Asia/Jerusalem',
    reminderMinutesBefore: 10,
    durationMinutes: 15,
    recurrence: defaultRecurrence(),
    createdAt: '2026-10-22T10:00:00.000Z',
    ...overrides,
  };
}

/** Message n created n minutes after a fixed base time. */
function nthMessage(n: number): ScheduledMessage {
  const createdAt = new Date(Date.parse('2026-01-01T00:00:00Z') + n * 60_000).toISOString();
  return makeMessage({ id: `m${n}`, createdAt });
}

function storeWith(initial: Record<string, unknown>): MemoryStore {
  return new MemoryStore(
    Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])),
  );
}

describe('keys', () => {
  it('prefixes every key with whatstime:v1:', () => {
    expect(KEY_PREFIX).toBe('whatstime:v1:');
    const backend = new MemoryStore();
    const store = createStore(backend);
    store.saveSettings(DEFAULTS);
    store.saveToHistory(makeMessage());
    store.rememberContact({ name: 'Mom', phone: '972501234567' }, NOW);
    store.saveDraft({ message: 'hi' });
    expect([...backend.data.keys()].sort()).toEqual([KEYS.contacts, KEYS.draft, KEYS.history, KEYS.settings]);
  });
});

describe('null backend', () => {
  const store = createStore(null);

  it('reads defaults and empty lists', () => {
    expect(store.loadSettings(DEFAULTS)).toEqual(DEFAULTS);
    expect(store.listHistory()).toEqual([]);
    expect(store.listRecentContacts()).toEqual([]);
    expect(store.loadDraft()).toBeNull();
  });

  it('ignores writes without throwing', () => {
    const onError = vi.fn();
    const quiet = createStore(null, onError);
    expect(quiet.saveSettings(DEFAULTS)).toBeUndefined();
    expect(quiet.saveToHistory(makeMessage())).toBeUndefined();
    expect(quiet.deleteFromHistory('msg-1')).toBeUndefined();
    expect(quiet.rememberContact({ name: 'A', phone: '1234567' }, NOW)).toBeUndefined();
    expect(quiet.saveDraft({ message: 'x' })).toBeUndefined();
    expect(quiet.clearDraft()).toBeUndefined();
    expect(quiet.listHistory()).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('throwing backend', () => {
  it('reads defaults and empty lists', () => {
    const store = createStore(throwingStore);
    expect(store.loadSettings(DEFAULTS)).toEqual(DEFAULTS);
    expect(store.listHistory()).toEqual([]);
    expect(store.listRecentContacts()).toEqual([]);
    expect(store.loadDraft()).toBeNull();
  });

  it('swallows write errors and reports each one to the callback', () => {
    const onError = vi.fn();
    const store = createStore(throwingStore, onError);
    expect(() => {
      store.saveSettings(DEFAULTS);
      store.saveToHistory(makeMessage());
      store.rememberContact({ name: 'A', phone: '1234567' }, NOW);
      store.saveDraft({ message: 'x' });
      store.clearDraft();
    }).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(5);
    const error = onError.mock.calls[0]?.[0] as DOMException;
    expect(error.name).toBe('SecurityError');
  });

  it('does not throw without a callback', () => {
    const store = createStore(throwingStore);
    expect(() => store.saveToHistory(makeMessage())).not.toThrow();
    expect(() => store.clearDraft()).not.toThrow();
  });

  it('treats a non-string from getItem as missing', () => {
    const odd = { getItem: () => undefined as unknown as string | null, setItem() {}, removeItem() {} };
    expect(createStore(odd).listHistory()).toEqual([]);
    expect(createStore(odd).loadSettings(DEFAULTS)).toEqual(DEFAULTS);
  });
});

describe('quota errors', () => {
  it('leaves existing data intact and reports QuotaExceededError', () => {
    const backend = new QuotaStore({ [KEYS.history]: JSON.stringify([makeMessage()]) });
    const onError = vi.fn();
    const store = createStore(backend, onError);
    store.saveToHistory(makeMessage({ id: 'msg-2' }));
    store.clearDraft();
    expect(store.listHistory().map((m) => m.id)).toEqual(['msg-1']);
    expect(onError).toHaveBeenCalledTimes(2);
    expect((onError.mock.calls[0]?.[0] as DOMException).name).toBe('QuotaExceededError');
  });
});

describe('corrupted JSON', () => {
  it.each(['{not json', '', 'undefined', 'NaN', '[1,2', '\u0000', '{"a":1}}'])('survives %j in every key', (raw) => {
    const store = createStore(
      new MemoryStore({ [KEYS.settings]: raw, [KEYS.history]: raw, [KEYS.contacts]: raw, [KEYS.draft]: raw }),
    );
    expect(store.loadSettings(DEFAULTS)).toEqual(DEFAULTS);
    expect(store.listHistory()).toEqual([]);
    expect(store.listRecentContacts()).toEqual([]);
    expect(store.loadDraft()).toBeNull();
  });

  it.each([null, 42, 'text', true, [], {}])('survives valid JSON of the wrong type: %j', (value) => {
    const json = JSON.stringify(value);
    const store = createStore(
      new MemoryStore({ [KEYS.settings]: json, [KEYS.history]: json, [KEYS.contacts]: json, [KEYS.draft]: json }),
    );
    expect(store.loadSettings(DEFAULTS)).toEqual(DEFAULTS);
    expect(store.listHistory()).toEqual([]);
    expect(store.listRecentContacts()).toEqual([]);
    expect(store.loadDraft()).toBeNull();
  });

  it('overwrites a corrupted history with valid data on the next save', () => {
    const backend = new MemoryStore({ [KEYS.history]: '{oops' });
    createStore(backend).saveToHistory(makeMessage());
    expect(backend.json(KEYS.history)).toEqual([makeMessage()]);
  });
});

describe('settings', () => {
  it('returns a copy of the defaults when nothing is stored', () => {
    const loaded = createStore(new MemoryStore()).loadSettings(DEFAULTS);
    expect(loaded).toEqual(DEFAULTS);
    expect(loaded).not.toBe(DEFAULTS);
  });

  it('round-trips', () => {
    const store = createStore(new MemoryStore());
    const settings: Settings = { defaultCountry: 'US', defaultReminderMinutesBefore: 60, defaultDurationMinutes: 30 };
    store.saveSettings(settings);
    expect(store.loadSettings(DEFAULTS)).toEqual(settings);
  });

  it('merges a partial record with the defaults', () => {
    const store = createStore(storeWith({ [KEYS.settings]: { defaultCountry: 'GB' } }));
    expect(store.loadSettings(DEFAULTS)).toEqual({ ...DEFAULTS, defaultCountry: 'GB' });
  });

  it.each([
    ['lowercase country', { defaultCountry: 'il' }],
    ['3-letter country', { defaultCountry: 'ISR' }],
    ['empty country', { defaultCountry: '' }],
    ['numeric country', { defaultCountry: 972 }],
    ['negative reminder', { defaultReminderMinutesBefore: -5 }],
    ['fractional reminder', { defaultReminderMinutesBefore: 1.5 }],
    ['string reminder', { defaultReminderMinutesBefore: '10' }],
    ['null reminder (NaN serialised)', { defaultReminderMinutesBefore: null }],
    ['reminder above 4 weeks', { defaultReminderMinutesBefore: 40_321 }],
    ['zero duration', { defaultDurationMinutes: 0 }],
    ['duration above 24h', { defaultDurationMinutes: 1441 }],
    ['boolean duration', { defaultDurationMinutes: true }],
  ])('rejects %s', (_label, stored) => {
    const store = createStore(storeWith({ [KEYS.settings]: stored }));
    expect(store.loadSettings(DEFAULTS)).toEqual(DEFAULTS);
  });

  it('accepts the boundary values', () => {
    const stored = { defaultCountry: 'AU', defaultReminderMinutesBefore: 40_320, defaultDurationMinutes: 1440 };
    expect(createStore(storeWith({ [KEYS.settings]: stored })).loadSettings(DEFAULTS)).toEqual(stored);
    const zero = { defaultCountry: 'AU', defaultReminderMinutesBefore: 0, defaultDurationMinutes: 1 };
    expect(createStore(storeWith({ [KEYS.settings]: zero })).loadSettings(DEFAULTS)).toEqual(zero);
  });

  it('keeps valid fields while rejecting invalid ones in the same record', () => {
    const stored = { defaultCountry: 'FR', defaultReminderMinutesBefore: 'soon', defaultDurationMinutes: 45 };
    expect(createStore(storeWith({ [KEYS.settings]: stored })).loadSettings(DEFAULTS)).toEqual({
      defaultCountry: 'FR',
      defaultReminderMinutesBefore: 0,
      defaultDurationMinutes: 45,
    });
  });

  it('stores only the known fields and drops unknown ones on load', () => {
    const backend = new MemoryStore();
    const store = createStore(backend);
    store.saveSettings({ ...DEFAULTS, extra: 'nope' } as Settings);
    expect(backend.json(KEYS.settings)).toEqual(DEFAULTS);
    const polluted = createStore(storeWith({ [KEYS.settings]: { ...DEFAULTS, defaultCountry: 'DE', junk: 1 } }));
    expect(polluted.loadSettings(DEFAULTS)).toEqual({ ...DEFAULTS, defaultCountry: 'DE' });
  });
});

describe('history', () => {
  it('round-trips a message exactly', () => {
    const store = createStore(new MemoryStore());
    const msg = makeMessage({
      recurrence: {
        frequency: 'weekly',
        interval: 2,
        weekdays: ['MO', 'TH'],
        monthlyMode: 'dayOfMonth',
        end: { type: 'count', count: 5 },
      },
    });
    store.saveToHistory(msg);
    expect(store.listHistory()).toEqual([msg]);
  });

  it('lists newest createdAt first regardless of stored order or timestamp format', () => {
    const stored = [
      makeMessage({ id: 'a', createdAt: '2026-10-22T10:00:00Z' }),
      makeMessage({ id: 'b', createdAt: '2026-10-22T12:30:00+02:00' }), // 10:30Z
      makeMessage({ id: 'c', createdAt: '2026-10-22T10:15:00.000Z' }),
      makeMessage({ id: 'd', createdAt: '2025-12-31T23:59:59.999Z' }),
    ];
    const store = createStore(storeWith({ [KEYS.history]: stored }));
    expect(store.listHistory().map((m) => m.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('upserts by id, keeping createdAt order', () => {
    const store = createStore(new MemoryStore());
    store.saveToHistory(nthMessage(1));
    store.saveToHistory(nthMessage(2));
    store.saveToHistory(nthMessage(3));
    expect(store.listHistory().map((m) => m.id)).toEqual(['m3', 'm2', 'm1']);

    store.saveToHistory({ ...nthMessage(2), message: 'edited' });
    const afterEdit = store.listHistory();
    expect(afterEdit.map((m) => m.id)).toEqual(['m3', 'm2', 'm1']);
    expect(afterEdit[1]?.message).toBe('edited');

    store.saveToHistory({ ...nthMessage(1), createdAt: '2027-01-01T00:00:00.000Z' });
    expect(store.listHistory().map((m) => m.id)).toEqual(['m1', 'm3', 'm2']);
  });

  it('puts the most recently saved first among equal createdAt values', () => {
    const store = createStore(new MemoryStore());
    store.saveToHistory(makeMessage({ id: 'x' }));
    store.saveToHistory(makeMessage({ id: 'y' }));
    expect(store.listHistory().map((m) => m.id)).toEqual(['y', 'x']);
  });

  it(`caps at ${HISTORY_CAP}, dropping the oldest`, () => {
    expect(HISTORY_CAP).toBe(200);
    const backend = new MemoryStore();
    const store = createStore(backend);
    for (let n = 0; n < 205; n++) store.saveToHistory(nthMessage(n));
    const ids = store.listHistory().map((m) => m.id);
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe('m204');
    expect(ids[199]).toBe('m5');
    expect(ids).not.toContain('m4');
    expect(backend.json(KEYS.history)).toHaveLength(200);

    store.saveToHistory(nthMessage(-1));
    expect(store.listHistory().map((m) => m.id)).not.toContain('m-1');
    expect(store.listHistory()).toHaveLength(200);
  });

  it('caps an oversized stored list on read', () => {
    const stored = Array.from({ length: 250 }, (_, n) => nthMessage(n));
    const list = createStore(storeWith({ [KEYS.history]: stored })).listHistory();
    expect(list).toHaveLength(200);
    expect(list[0]?.id).toBe('m249');
    expect(list[199]?.id).toBe('m50');
  });

  it('dedupes stored duplicates by id, keeping the newest', () => {
    const stored = [
      makeMessage({ id: 'dup', message: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
      makeMessage({ id: 'dup', message: 'new', createdAt: '2026-02-01T00:00:00.000Z' }),
    ];
    const list = createStore(storeWith({ [KEYS.history]: stored })).listHistory();
    expect(list).toHaveLength(1);
    expect(list[0]?.message).toBe('new');
  });

  it('deletes by id and does not write when the id is unknown', () => {
    const backend = new MemoryStore();
    const store = createStore(backend);
    store.saveToHistory(nthMessage(1));
    store.saveToHistory(nthMessage(2));
    const writes = backend.writes;
    store.deleteFromHistory('nope');
    expect(backend.writes).toBe(writes);
    store.deleteFromHistory('m1');
    expect(store.listHistory().map((m) => m.id)).toEqual(['m2']);
    store.deleteFromHistory('m2');
    expect(store.listHistory()).toEqual([]);
    expect(backend.json(KEYS.history)).toEqual([]);
  });

  it('ignores an invalid message instead of storing it', () => {
    const backend = new MemoryStore();
    const store = createStore(backend);
    store.saveToHistory(makeMessage({ start: { date: '2026-02-30', time: '09:00' } }));
    expect(backend.data.has(KEYS.history)).toBe(false);
    expect(store.listHistory()).toEqual([]);
  });

  it('drops invalid records field by field and keeps the valid ones', () => {
    const valid = makeMessage({ id: 'ok' });
    const stored: unknown[] = [
      1,
      'msg-1',
      null,
      true,
      [],
      {},
      { id: 'partial', message: 'hi' },
      valid,
      { ...valid, id: '' },
      { ...valid, id: 7 },
      { ...valid, recipient: null },
      { ...valid, recipient: { name: 'x' } },
      { ...valid, recipient: { name: 5, phone: '972501234567' } },
      { ...valid, recipient: { name: 'x', phone: '+972501234567' } },
      { ...valid, recipient: { name: 'x', phone: '1234567890123456' } },
      { ...valid, message: 42 },
      { ...valid, start: { date: '2026-02-30', time: '09:00' } },
      { ...valid, start: { date: '2026-10-25', time: '9:00' } },
      { ...valid, start: '2026-10-25T09:00' },
      { ...valid, timeZone: '' },
      { ...valid, timeZone: null },
      { ...valid, reminderMinutesBefore: -1 },
      { ...valid, reminderMinutesBefore: '10' },
      { ...valid, durationMinutes: 0 },
      { ...valid, durationMinutes: 2.5 },
      { ...valid, createdAt: 'yesterday' },
      { ...valid, createdAt: 1_700_000_000_000 },
    ];
    const list = createStore(storeWith({ [KEYS.history]: stored })).listHistory();
    expect(list).toEqual([valid]);
  });

  it('accepts an empty recipient (choose the chat in WhatsApp)', () => {
    const msg = makeMessage({ recipient: { name: '', phone: '' } });
    expect(createStore(storeWith({ [KEYS.history]: [msg] })).listHistory()).toEqual([msg]);
  });

  it('strips unknown properties from stored records', () => {
    const stored = { ...makeMessage(), extra: 'x', recipient: { name: 'Mom', phone: '972501234567', avatar: 'y' } };
    const [loaded] = createStore(storeWith({ [KEYS.history]: [stored] })).listHistory();
    expect(loaded).toEqual(makeMessage());
    expect(Object.keys(loaded ?? {})).not.toContain('extra');
    expect(Object.keys(loaded?.recipient ?? {})).toEqual(['name', 'phone']);
  });

  it('fills a missing or partial recurrence from defaults', () => {
    const { recurrence: _omit, ...withoutRecurrence } = makeMessage({ id: 'none' });
    const partial = { ...makeMessage({ id: 'partial' }), recurrence: { frequency: 'weekly', weekdays: ['FR'] } };
    const list = createStore(storeWith({ [KEYS.history]: [withoutRecurrence, partial] })).listHistory();
    const byId = new Map(list.map((m) => [m.id, m]));
    expect(byId.get('none')?.recurrence).toEqual(defaultRecurrence());
    expect(byId.get('partial')?.recurrence).toEqual({ ...defaultRecurrence(), frequency: 'weekly', weekdays: ['FR'] });
  });
});

describe('sanitizeRecurrence', () => {
  it('returns defaults for non-objects', () => {
    for (const value of [undefined, null, 'weekly', 3, [], true]) {
      expect(sanitizeRecurrence(value)).toEqual(defaultRecurrence());
    }
  });

  it('keeps every valid field', () => {
    const rec = {
      frequency: 'monthly',
      interval: 3,
      weekdays: ['TU'],
      monthlyMode: 'lastWeekday',
      end: { type: 'until', date: '2027-03-31' },
    };
    expect(sanitizeRecurrence(rec)).toEqual(rec);
  });

  it('replaces each invalid field with its default', () => {
    expect(
      sanitizeRecurrence({
        frequency: 'hourly',
        interval: 0,
        weekdays: 'MO',
        monthlyMode: 'firstMonday',
        end: { type: 'count', count: 0 },
      }),
    ).toEqual(defaultRecurrence());
    expect(sanitizeRecurrence({ interval: 2.5 }).interval).toBe(1);
    expect(sanitizeRecurrence({ interval: '2' }).interval).toBe(1);
    expect(sanitizeRecurrence({ interval: -1 }).interval).toBe(1);
  });

  it('filters, dedupes and orders weekdays Monday first', () => {
    const weekdays = ['SU', 'XX', 'MO', 'MO', 3, null, 'fr', 'WE'];
    expect(sanitizeRecurrence({ weekdays }).weekdays).toEqual(['MO', 'WE', 'SU']);
  });

  it('validates the end rule', () => {
    expect(sanitizeRecurrence({ end: { type: 'count', count: 10 } }).end).toEqual({ type: 'count', count: 10 });
    expect(sanitizeRecurrence({ end: { type: 'count', count: 1.5 } }).end).toEqual({ type: 'never' });
    expect(sanitizeRecurrence({ end: { type: 'count' } }).end).toEqual({ type: 'never' });
    const until = { type: 'until', date: '2026-12-31' };
    expect(sanitizeRecurrence({ end: until }).end).toEqual(until);
    expect(sanitizeRecurrence({ end: { type: 'until', date: '2026-02-29' } }).end).toEqual({ type: 'never' });
    expect(sanitizeRecurrence({ end: { type: 'until', date: 20261231 } }).end).toEqual({ type: 'never' });
    expect(sanitizeRecurrence({ end: { type: 'forever' } }).end).toEqual({ type: 'never' });
    expect(sanitizeRecurrence({ end: 'never' }).end).toEqual({ type: 'never' });
  });

  it('drops extra properties on the end rule', () => {
    const end = { type: 'count', count: 3, date: '2026-01-01' };
    expect(sanitizeRecurrence({ end }).end).toEqual({ type: 'count', count: 3 });
  });
});

describe('sanitizeMessage', () => {
  it('returns a clean copy or null', () => {
    const msg = makeMessage();
    const copy = sanitizeMessage(msg);
    expect(copy).toEqual(msg);
    expect(copy).not.toBe(msg);
    expect(copy?.recurrence).not.toBe(msg.recurrence);
    expect(sanitizeMessage({ ...msg, id: undefined })).toBeNull();
    expect(sanitizeMessage('x')).toBeNull();
  });
});

describe('recent contacts', () => {
  it('lists the most recently used first', () => {
    const store = createStore(new MemoryStore());
    store.rememberContact({ name: 'A', phone: '972500000001' }, new Date('2026-10-01T00:00:00Z'));
    store.rememberContact({ name: 'B', phone: '972500000002' }, new Date('2026-10-02T00:00:00Z'));
    store.rememberContact({ name: 'C', phone: '972500000003' }, new Date('2026-10-03T00:00:00Z'));
    expect(store.listRecentContacts()).toEqual([
      { name: 'C', phone: '972500000003', lastUsed: '2026-10-03T00:00:00.000Z' },
      { name: 'B', phone: '972500000002', lastUsed: '2026-10-02T00:00:00.000Z' },
      { name: 'A', phone: '972500000001', lastUsed: '2026-10-01T00:00:00.000Z' },
    ]);
  });

  it('dedupes by phone digits and moves the contact to the top', () => {
    const store = createStore(new MemoryStore());
    store.rememberContact({ name: 'Mom', phone: '972501234567' }, new Date('2026-10-01T00:00:00Z'));
    store.rememberContact({ name: 'Dad', phone: '972509999999' }, new Date('2026-10-02T00:00:00Z'));
    store.rememberContact({ name: 'Mother', phone: '+972 50-123-4567' }, new Date('2026-10-03T00:00:00Z'));
    expect(store.listRecentContacts()).toEqual([
      { name: 'Mother', phone: '972501234567', lastUsed: '2026-10-03T00:00:00.000Z' },
      { name: 'Dad', phone: '972509999999', lastUsed: '2026-10-02T00:00:00.000Z' },
    ]);
  });

  it('keeps the previous name when the new one is blank, and trims names', () => {
    const store = createStore(new MemoryStore());
    store.rememberContact({ name: '  Mom  ', phone: '972501234567' }, new Date('2026-10-01T00:00:00Z'));
    store.rememberContact({ name: '   ', phone: '972501234567' }, NOW);
    expect(store.listRecentContacts()).toEqual([{ name: 'Mom', phone: '972501234567', lastUsed: NOW.toISOString() }]);
    store.rememberContact({ name: '', phone: '15551234567' }, NOW);
    expect(store.listRecentContacts()[0]).toEqual({ name: '', phone: '15551234567', lastUsed: NOW.toISOString() });
  });

  it("ignores contacts without phone digits ('' phone) and does not write", () => {
    const backend = new MemoryStore();
    const store = createStore(backend);
    store.rememberContact({ name: 'Group', phone: '' }, NOW);
    store.rememberContact({ name: 'Junk', phone: '+ -()' }, NOW);
    expect(backend.writes).toBe(0);
    expect(store.listRecentContacts()).toEqual([]);
  });

  it(`caps at ${CONTACTS_CAP}, dropping the least recently used`, () => {
    expect(CONTACTS_CAP).toBe(20);
    const store = createStore(new MemoryStore());
    for (let n = 0; n < 25; n++) {
      const phone = `97250000${String(n).padStart(4, '0')}`;
      store.rememberContact({ name: `C${n}`, phone }, new Date(Date.UTC(2026, 0, 1, 0, n)));
    }
    const names = store.listRecentContacts().map((c) => c.name);
    expect(names).toHaveLength(20);
    expect(names[0]).toBe('C24');
    expect(names[19]).toBe('C5');
  });

  it('validates, sorts and dedupes stored contacts', () => {
    const stored: unknown[] = [
      { name: 'Old', phone: '972501111111', lastUsed: '2026-01-01T00:00:00.000Z' },
      { name: 'New', phone: '972502222222', lastUsed: '2026-06-01T00:00:00.000Z' },
      { name: 'Dup older', phone: '972502222222', lastUsed: '2026-02-01T00:00:00.000Z' },
      { name: 'No phone', phone: '', lastUsed: '2026-03-01T00:00:00.000Z' },
      { name: 'Plus', phone: '+972503333333', lastUsed: '2026-03-01T00:00:00.000Z' },
      { name: 'Bad time', phone: '972504444444', lastUsed: 'later' },
      { name: 5, phone: '972505555555', lastUsed: '2026-03-01T00:00:00.000Z' },
      { phone: '972506666666', lastUsed: '2026-03-01T00:00:00.000Z' },
      'Mom',
      42,
      null,
    ];
    expect(createStore(storeWith({ [KEYS.contacts]: stored })).listRecentContacts()).toEqual([
      { name: 'New', phone: '972502222222', lastUsed: '2026-06-01T00:00:00.000Z' },
      { name: 'Old', phone: '972501111111', lastUsed: '2026-01-01T00:00:00.000Z' },
    ]);
  });
});

describe('draft', () => {
  it('round-trips a partial draft, including work-in-progress text', () => {
    const store = createStore(new MemoryStore());
    const draft: Partial<ScheduledMessage> = {
      recipient: { name: 'דני', phone: '050-123' },
      message: 'שלום 👋\nsee you',
      start: { date: '', time: '09:00' },
      timeZone: 'Asia/Jerusalem',
      reminderMinutesBefore: 15,
    };
    store.saveDraft(draft);
    expect(store.loadDraft()).toEqual(draft);
  });

  it('round-trips a full message', () => {
    const store = createStore(new MemoryStore());
    store.saveDraft(makeMessage());
    expect(store.loadDraft()).toEqual(makeMessage());
  });

  it('completes a partial recurrence from defaults', () => {
    const store = createStore(storeWith({ [KEYS.draft]: { recurrence: { frequency: 'daily', interval: 2 } } }));
    expect(store.loadDraft()).toEqual({ recurrence: { ...defaultRecurrence(), frequency: 'daily', interval: 2 } });
  });

  it('drops fields of the wrong type', () => {
    const stored = {
      id: 3,
      message: 5,
      recipient: 'Mom',
      start: { date: '2026-10-25' },
      timeZone: 7,
      reminderMinutesBefore: '10',
      durationMinutes: 30,
      createdAt: false,
      junk: 'x',
    };
    expect(createStore(storeWith({ [KEYS.draft]: stored })).loadDraft()).toEqual({ durationMinutes: 30 });
  });

  it('returns null when nothing valid remains', () => {
    expect(createStore(storeWith({ [KEYS.draft]: { message: 1, junk: true } })).loadDraft()).toBeNull();
    expect(createStore(storeWith({ [KEYS.draft]: [{ message: 'hi' }] })).loadDraft()).toBeNull();
  });

  it('clears the draft', () => {
    const backend = new MemoryStore();
    const store = createStore(backend);
    store.saveDraft({ message: 'hi' });
    expect(store.loadDraft()).toEqual({ message: 'hi' });
    store.clearDraft();
    expect(backend.data.has(KEYS.draft)).toBe(false);
    expect(store.loadDraft()).toBeNull();
  });

  it('removes the stored draft when saving an empty one', () => {
    const backend = new MemoryStore();
    const store = createStore(backend);
    store.saveDraft({ message: 'hi' });
    store.saveDraft({});
    expect(backend.data.has(KEYS.draft)).toBe(false);
    expect(store.loadDraft()).toBeNull();
  });
});

describe('newId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses crypto.randomUUID when available', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(UUID_V4);
    vi.stubGlobal('crypto', { randomUUID: () => 'from-random-uuid' });
    expect(newId()).toBe('from-random-uuid');
  });

  it('falls back to getRandomValues when randomUUID is missing (insecure context)', () => {
    const getRandomValues = vi.fn(<T extends ArrayBufferView>(array: T): T => {
      new Uint8Array(array.buffer).fill(0xff);
      return array;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    expect(newId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it('falls back to Math.random without crypto', () => {
    vi.stubGlobal('crypto', undefined);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(newId()).toBe('00000000-0000-4000-8000-000000000000');
    vi.restoreAllMocks();
    const ids = new Set(Array.from({ length: 200 }, () => newId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });
});

describe('clearing data', () => {
  function memory(): KeyValueStore & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    };
  }

  it('forgets one recent contact and clears all of them', () => {
    const backend = memory();
    const store = createStore(backend);
    store.rememberContact({ name: 'Mom', phone: '972501234567' }, new Date('2026-10-22T10:00:00Z'));
    store.rememberContact({ name: 'Dad', phone: '972521234567' }, new Date('2026-10-22T11:00:00Z'));
    store.forgetContact('+972 50-123-4567');
    expect(store.listRecentContacts().map((c) => c.name)).toEqual(['Dad']);
    store.forgetContact('999');
    expect(store.listRecentContacts()).toHaveLength(1);
    store.clearRecentContacts();
    expect(store.listRecentContacts()).toEqual([]);
    expect([...backend.data.keys()].some((k) => k.endsWith('contacts'))).toBe(false);
  });

  it('clears history', () => {
    const backend = memory();
    const store = createStore(backend);
    backend.setItem('whatstime:v1:history', '[]');
    store.clearHistory();
    expect(backend.data.has('whatstime:v1:history')).toBe(false);
    expect(store.listHistory()).toEqual([]);
  });

  it('never throws when the backend is missing or broken', () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    for (const store of [createStore(null), createStore(broken)]) {
      expect(() => {
        store.forgetContact('1');
        store.clearRecentContacts();
        store.clearHistory();
      }).not.toThrow();
    }
  });
});

describe('draft pending recipient', () => {
  function memory(): KeyValueStore {
    const data = new Map<string, string>();
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  }

  it('round-trips an unresolved contact with the rest of the draft', () => {
    const store = createStore(memory());
    store.saveDraft({ message: 'Hi', pendingRecipient: { name: 'Mom', phones: ['050-1234567', '03-5551234'], source: 'contact' } });
    expect(store.loadDraft()).toEqual({
      message: 'Hi',
      pendingRecipient: { name: 'Mom', phones: ['050-1234567', '03-5551234'], source: 'contact' },
    });
  });

  it('keeps a draft that only has a pending recipient', () => {
    const store = createStore(memory());
    store.saveDraft({ pendingRecipient: { name: '', phones: ['0501234567'], source: 'typed' } });
    expect(store.loadDraft()).toEqual({ pendingRecipient: { name: '', phones: ['0501234567'], source: 'typed' } });
  });

  it('drops malformed pending recipients', () => {
    const backend = memory();
    const store = createStore(backend);
    const bad = [
      { name: 'x', phones: [], source: 'contact' },
      { name: 'x', phones: ['1'], source: 'other' },
      { name: 3, phones: ['1'], source: 'typed' },
      { name: 'x', phones: 'abc', source: 'typed' },
      { name: 'x', phones: Array.from({ length: 21 }, () => '1'), source: 'typed' },
      null,
    ];
    for (const pendingRecipient of bad) {
      backend.setItem('whatstime:v1:draft', JSON.stringify({ message: 'm', pendingRecipient }));
      expect(store.loadDraft()).toEqual({ message: 'm' });
    }
    backend.setItem('whatstime:v1:draft', JSON.stringify({ message: 'm', pendingRecipient: { name: 'x', phones: ['1', 2, '3'], source: 'typed' } }));
    expect(store.loadDraft()?.pendingRecipient?.phones).toEqual(['1', '3']);
  });
});

describe('google calendar setting', () => {
  const defaults = { defaultCountry: 'IL', defaultReminderMinutesBefore: 0, defaultDurationMinutes: 15 };
  function memory(): KeyValueStore {
    const data = new Map<string, string>();
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  }

  it('round-trips a calendar ID and drops malformed ones', () => {
    const store = createStore(memory());
    const id = 'abc123@group.calendar.google.com';
    store.saveSettings({ ...defaults, googleCalendarId: id });
    expect(store.loadSettings(defaults)).toEqual({ ...defaults, googleCalendarId: id });
    for (const bad of ['', 'not an id', 'a@b', 'x@y.com&src=evil', 'https://calendar.google.com']) {
      store.saveSettings({ ...defaults, googleCalendarId: bad });
      expect(store.loadSettings(defaults)).toEqual(defaults);
    }
    expect(isGoogleCalendarId('me@gmail.com')).toBe(true);
  });
});
