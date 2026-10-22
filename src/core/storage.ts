/**
 * Persistence for settings, history, recent contacts and the unsent draft on
 * top of any localStorage-like backend. Every read survives a missing or
 * throwing backend, corrupted JSON and records of the wrong shape; every write
 * swallows errors (quota, private mode) and optionally reports them.
 */

import { isValidDate, isValidTime } from './dates';
import { MAX_REMINDER_MINUTES } from './event';
import { MAX_COUNT, MAX_INTERVAL, WEEKDAYS, defaultRecurrence } from './recurrence';
import { isValidTimeZone } from './timezone';
import type {
  Frequency,
  LocalDateTime,
  MonthlyMode,
  Recipient,
  Recurrence,
  RecurrenceEnd,
  SavedContact,
  ScheduledMessage,
  Settings,
  Weekday,
} from './types';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AppStore {
  loadSettings(defaults: Settings): Settings;
  saveSettings(settings: Settings): void;
  /** Newest createdAt first. */
  listHistory(): ScheduledMessage[];
  /** Upsert by id; keeps the newest HISTORY_CAP entries. */
  saveToHistory(message: ScheduledMessage): void;
  deleteFromHistory(id: string): void;
  /** Most recently used first. */
  listRecentContacts(): SavedContact[];
  /** Dedupes by phone digits ('' phone ignored); keeps CONTACTS_CAP entries. */
  rememberContact(contact: { name: string; phone: string }, now: Date): void;
  /** Removes one recent contact by phone digits. */
  forgetContact(phone: string): void;
  clearRecentContacts(): void;
  clearHistory(): void;
  loadDraft(): Partial<ScheduledMessage> | null;
  saveDraft(draft: Partial<ScheduledMessage>): void;
  clearDraft(): void;
}

export const KEY_PREFIX = 'whatstime:v1:';
export const HISTORY_CAP = 200;
export const CONTACTS_CAP = 20;
const MAX_DURATION_MINUTES = 24 * 60;

const KEYS = {
  settings: `${KEY_PREFIX}settings`,
  history: `${KEY_PREFIX}history`,
  contacts: `${KEY_PREFIX}contacts`,
  draft: `${KEY_PREFIX}draft`,
} as const;

const FREQUENCIES: readonly Frequency[] = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
const MONTHLY_MODES: readonly MonthlyMode[] = ['dayOfMonth', 'nthWeekday', 'lastWeekday', 'lastDay'];

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isNonEmptyString = (v: unknown): v is string => isString(v) && v.length > 0;
const isIntInRange = (v: unknown, min: number, max: number): v is number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
/** A whole number >= 1 capped at `max` (the validator's limit), or undefined. */
const cappedPositiveInt = (v: unknown, max: number): number | undefined =>
  Number.isInteger(v) && (v as number) >= 1 ? Math.min(v as number, max) : undefined;
const isReminder = (v: unknown): v is number => isIntInRange(v, 0, MAX_REMINDER_MINUTES);
const isDuration = (v: unknown): v is number => isIntInRange(v, 1, MAX_DURATION_MINUTES);
const isCountry = (v: unknown): v is string => isString(v) && /^[A-Z]{2}$/.test(v);
const isTimestamp = (v: unknown): v is string => isString(v) && Number.isFinite(Date.parse(v));
/** Recipient.phone: '' or international digits without '+' or leading zeros. */
const isPhoneDigits = (v: unknown): v is string => isString(v) && /^(?:[1-9]\d{0,14})?$/.test(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => list.includes(v as T);

/** Field validators for persisted records; strict (history) or lenient for work-in-progress text (draft). */
interface FieldRules {
  phone: (v: unknown) => v is string;
  date: (v: unknown) => v is string;
  time: (v: unknown) => v is string;
  timeZone: (v: unknown) => v is string;
  createdAt: (v: unknown) => v is string;
}

const STRICT: FieldRules = {
  phone: isPhoneDigits,
  date: (v): v is string => isString(v) && isValidDate(v),
  time: (v): v is string => isString(v) && isValidTime(v),
  // An unknown zone would make every calendar conversion of the record throw.
  timeZone: (v): v is string => isString(v) && isValidTimeZone(v),
  createdAt: isTimestamp,
};

const LENIENT: FieldRules = {
  phone: isString,
  date: isString,
  time: isString,
  timeZone: isString,
  createdAt: isString,
};

function sanitizeRecipient(v: unknown, rules: FieldRules): Recipient | undefined {
  if (!isRecord(v) || !isString(v.name) || !rules.phone(v.phone)) return undefined;
  return { name: v.name, phone: v.phone };
}

function sanitizeStart(v: unknown, rules: FieldRules): LocalDateTime | undefined {
  if (!isRecord(v) || !rules.date(v.date) || !rules.time(v.time)) return undefined;
  return { date: v.date, time: v.time };
}

function sanitizeEnd(v: unknown): RecurrenceEnd {
  if (isRecord(v)) {
    const count = cappedPositiveInt(v.count, MAX_COUNT);
    if (v.type === 'count' && count !== undefined) return { type: 'count', count };
    if (v.type === 'until' && isString(v.date) && isValidDate(v.date)) return { type: 'until', date: v.date };
  }
  return { type: 'never' };
}

function sanitizeWeekdays(v: unknown): Weekday[] {
  if (!Array.isArray(v)) return [];
  return WEEKDAYS.filter((day) => v.includes(day));
}

/**
 * Any value -> a complete Recurrence; missing or invalid fields fall back to defaultRecurrence(). An interval or
 * count above the validator's limit is capped there, and an invalid weekStart is left out (Monday-start weeks).
 */
export function sanitizeRecurrence(v: unknown): Recurrence {
  const defaults = defaultRecurrence();
  if (!isRecord(v)) return defaults;
  return {
    frequency: oneOf(FREQUENCIES, v.frequency) ? v.frequency : defaults.frequency,
    interval: cappedPositiveInt(v.interval, MAX_INTERVAL) ?? defaults.interval,
    weekdays: sanitizeWeekdays(v.weekdays),
    monthlyMode: oneOf(MONTHLY_MODES, v.monthlyMode) ? v.monthlyMode : defaults.monthlyMode,
    ...(oneOf(WEEKDAYS, v.weekStart) ? { weekStart: v.weekStart } : {}),
    end: sanitizeEnd(v.end),
  };
}

/** The valid fields of a stored message; recurrence is always completed from defaults when present. */
function sanitizeFields(v: Rec, rules: FieldRules): Partial<ScheduledMessage> {
  const out: Partial<ScheduledMessage> = {};
  if (isNonEmptyString(v.id)) out.id = v.id;
  const recipient = sanitizeRecipient(v.recipient, rules);
  if (recipient) out.recipient = recipient;
  if (isString(v.message)) out.message = v.message;
  const start = sanitizeStart(v.start, rules);
  if (start) out.start = start;
  if (rules.timeZone(v.timeZone)) out.timeZone = v.timeZone;
  if (isReminder(v.reminderMinutesBefore)) out.reminderMinutesBefore = v.reminderMinutesBefore;
  if (isDuration(v.durationMinutes)) out.durationMinutes = v.durationMinutes;
  if (v.recurrence !== undefined) out.recurrence = sanitizeRecurrence(v.recurrence);
  if (rules.createdAt(v.createdAt)) out.createdAt = v.createdAt;
  return out;
}

/** A clean copy of a stored history record, or null when any required field is missing or invalid. */
export function sanitizeMessage(v: unknown): ScheduledMessage | null {
  if (!isRecord(v)) return null;
  const f = sanitizeFields(v, STRICT);
  if (
    f.id === undefined ||
    f.recipient === undefined ||
    f.message === undefined ||
    f.start === undefined ||
    f.timeZone === undefined ||
    f.reminderMinutesBefore === undefined ||
    f.durationMinutes === undefined ||
    f.createdAt === undefined
  ) {
    return null;
  }
  return {
    id: f.id,
    recipient: f.recipient,
    message: f.message,
    start: f.start,
    timeZone: f.timeZone,
    reminderMinutesBefore: f.reminderMinutesBefore,
    durationMinutes: f.durationMinutes,
    recurrence: f.recurrence ?? defaultRecurrence(),
    createdAt: f.createdAt,
  };
}

function sanitizeDraft(v: unknown): Partial<ScheduledMessage> | null {
  if (!isRecord(v)) return null;
  const draft = sanitizeFields(v, LENIENT);
  return Object.keys(draft).length > 0 ? draft : null;
}

function sanitizeContact(v: unknown): SavedContact | null {
  if (!isRecord(v) || !isString(v.name) || !isPhoneDigits(v.phone) || !v.phone) return null;
  if (!isTimestamp(v.lastUsed)) return null;
  return { name: v.name, phone: v.phone, lastUsed: v.lastUsed };
}

function sanitizeList<T>(v: unknown, sanitize: (item: unknown) => T | null): T[] {
  if (!Array.isArray(v)) return [];
  return v.map(sanitize).filter((item): item is T => item !== null);
}

/** Stable sort, newest timestamp first. */
function newestFirst<T>(items: T[], timestamp: (item: T) => string): T[] {
  return [...items].sort((a, b) => Date.parse(timestamp(b)) - Date.parse(timestamp(a)));
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A valid history record: its clean form, plus the form it is stored in (which may hold newer fields). */
interface HistoryEntry {
  message: ScheduledMessage;
  stored: unknown;
}

function orderHistory(entries: HistoryEntry[]): HistoryEntry[] {
  return uniqueBy(newestFirst(entries, (e) => e.message.createdAt), (e) => e.message.id).slice(0, HISTORY_CAP);
}

function orderContacts(items: SavedContact[]): SavedContact[] {
  return uniqueBy(newestFirst(items, (c) => c.lastUsed), (c) => c.phone).slice(0, CONTACTS_CAP);
}

function sanitizeSettings(v: unknown, defaults: Settings): Settings {
  const s = isRecord(v) ? v : {};
  return {
    defaultCountry: isCountry(s.defaultCountry) ? s.defaultCountry : defaults.defaultCountry,
    defaultReminderMinutesBefore: isReminder(s.defaultReminderMinutesBefore)
      ? s.defaultReminderMinutesBefore
      : defaults.defaultReminderMinutesBefore,
    defaultDurationMinutes: isDuration(s.defaultDurationMinutes)
      ? s.defaultDurationMinutes
      : defaults.defaultDurationMinutes,
  };
}

/**
 * An AppStore over `backend` (pass `globalThis.localStorage`, or null when it is unavailable).
 * `onWriteError` receives errors thrown while writing (e.g. QuotaExceededError); they are never rethrown.
 */
export function createStore(backend: KeyValueStore | null, onWriteError?: (error: unknown) => void): AppStore {
  const read = (key: string): unknown => {
    try {
      const raw = backend?.getItem(key);
      return isString(raw) ? (JSON.parse(raw) as unknown) : undefined;
    } catch {
      return undefined;
    }
  };

  const attempt = (operation: (store: KeyValueStore) => void): void => {
    if (!backend) return;
    try {
      operation(backend);
    } catch (error) {
      onWriteError?.(error);
    }
  };

  const write = (key: string, value: unknown): void => attempt((store) => store.setItem(key, JSON.stringify(value)));
  const remove = (key: string): void => attempt((store) => store.removeItem(key));

  const readHistory = (): HistoryEntry[] =>
    orderHistory(
      sanitizeList(read(KEYS.history), (stored) => {
        const message = sanitizeMessage(stored);
        return message ? { message, stored } : null;
      }),
    );
  // Rewrites keep other records as stored, so fields written by a newer version (a stale tab or service worker can
  // run older code on the same data) are not stripped or downgraded.
  const writeHistory = (entries: HistoryEntry[]): void => write(KEYS.history, entries.map((e) => e.stored));
  const listHistory = (): ScheduledMessage[] => readHistory().map((e) => e.message);
  const listRecentContacts = (): SavedContact[] => orderContacts(sanitizeList(read(KEYS.contacts), sanitizeContact));

  return {
    loadSettings: (defaults) => sanitizeSettings(read(KEYS.settings), defaults),
    saveSettings: ({ defaultCountry, defaultReminderMinutesBefore, defaultDurationMinutes }) =>
      write(KEYS.settings, { defaultCountry, defaultReminderMinutesBefore, defaultDurationMinutes }),
    listHistory,
    saveToHistory(message) {
      const clean = sanitizeMessage(message);
      if (!clean) return;
      const others = readHistory().filter((e) => e.message.id !== clean.id);
      writeHistory(orderHistory([{ message: clean, stored: clean }, ...others]));
    },
    deleteFromHistory(id) {
      const history = readHistory();
      const remaining = history.filter((e) => e.message.id !== id);
      if (remaining.length !== history.length) writeHistory(remaining);
    },
    listRecentContacts,
    rememberContact(contact, now) {
      const phone = contact.phone.replace(/\D/g, '');
      if (!phone || !isPhoneDigits(phone)) return;
      const contacts = listRecentContacts();
      const previous = contacts.find((c) => c.phone === phone);
      const name = contact.name.trim() || previous?.name || '';
      const updated = { name, phone, lastUsed: now.toISOString() };
      write(KEYS.contacts, orderContacts([updated, ...contacts.filter((c) => c.phone !== phone)]));
    },
    forgetContact(phone) {
      const digits = phone.replace(/\D/g, '');
      const contacts = listRecentContacts();
      const remaining = contacts.filter((c) => c.phone !== digits);
      if (remaining.length !== contacts.length) write(KEYS.contacts, remaining);
    },
    clearRecentContacts: () => remove(KEYS.contacts),
    clearHistory: () => remove(KEYS.history),
    loadDraft: () => sanitizeDraft(read(KEYS.draft)),
    saveDraft(draft) {
      const clean = sanitizeDraft(draft);
      if (clean) write(KEYS.draft, clean);
      else remove(KEYS.draft);
    },
    clearDraft: () => remove(KEYS.draft),
  };
}

function randomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoApi?.getRandomValues === 'function') return cryptoApi.getRandomValues(bytes);
  for (let i = 0; i < count; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

/** RFC 4122 version 4 UUID built from random bytes. */
function fallbackUuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A random UUID: crypto.randomUUID when available (secure contexts), else a getRandomValues/Math.random fallback. */
export function newId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return fallbackUuid();
}
