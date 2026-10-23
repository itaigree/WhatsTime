/** Shared app state handed to every view. */

import { DEFAULT_DURATION_MINUTES } from '../core/event';
import { detectDefaultCountry } from '../core/phone';
import type { AppStore, KeyValueStore } from '../core/storage';
import { getDeviceTimeZone } from '../core/timezone';
import type { Draft, ScheduledMessage, Settings } from '../core/types';

export interface AppContext {
  readonly store: AppStore;
  settings: Settings;
  saveSettings(next: Settings): void;
  /** Values to open the compose form with instead of the saved draft (share target, Reuse, Edit a copy). */
  prefill: Draft | null;
  /** The message created in this session, so its result page works even when storage is unavailable. */
  lastCreated: ScheduledMessage | null;
  /**
   * Warnings to show once on the result page right after creating message `id` (`field` is the core's field name, so
   * the page can drop one it already explains); `phoneWarning` goes next to "To".
   */
  notice: { id: string; warnings: { field: string; message: string }[]; phoneWarning?: string | undefined } | null;
  /** Go to a hash route; re-renders even when it is the current one. */
  navigate(hash: string): void;
  /** Short status text for the polite live region (toast). */
  announce(message: string): void;
}

/** What each route renders. */
export interface View {
  /** Shown in the document title. */
  readonly title: string;
  readonly element: HTMLElement;
  /** Receives focus when the user navigates to this view (tabindex="-1"). */
  readonly heading: HTMLElement;
  /** Called once the element is in the document. */
  mounted?(): void;
  /** Called before the view is replaced. */
  destroy?(): void;
}

/** window.localStorage, or null where touching it throws (blocked storage, sandboxed frames). */
export function safeLocalStorage(): KeyValueStore | null {
  try {
    const storage = window.localStorage;
    storage.getItem('whatstime:v1:probe');
    return storage;
  } catch {
    return null;
  }
}

function deviceLanguages(): readonly string[] {
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

export function defaultSettings(): Settings {
  return {
    defaultCountry: detectDefaultCountry(deviceLanguages(), getDeviceTimeZone()),
    defaultReminderMinutesBefore: 0,
    defaultDurationMinutes: DEFAULT_DURATION_MINUTES,
  };
}

/**
 * The stored settings, completed with the detected defaults. On first launch (or when a stored value is missing or
 * invalid) the completed settings are saved straight away, so the default country is decided once, at home, and does
 * not follow the time zone around while travelling.
 */
export function initialSettings(store: AppStore): Settings {
  const unset: Settings = { defaultCountry: '', defaultReminderMinutesBefore: -1, defaultDurationMinutes: -1 };
  const stored = store.loadSettings(unset);
  const detected = defaultSettings();
  const settings: Settings = {
    defaultCountry: stored.defaultCountry || detected.defaultCountry,
    defaultReminderMinutesBefore:
      stored.defaultReminderMinutesBefore >= 0 ? stored.defaultReminderMinutesBefore : detected.defaultReminderMinutesBefore,
    defaultDurationMinutes:
      stored.defaultDurationMinutes >= 1 ? stored.defaultDurationMinutes : detected.defaultDurationMinutes,
  };
  const complete =
    stored.defaultCountry !== '' && stored.defaultReminderMinutesBefore >= 0 && stored.defaultDurationMinutes >= 1;
  if (!complete) store.saveSettings(settings);
  return settings;
}

/** A supported region from a language tag's explicit region subtag ('he-IL' -> 'IL'), else undefined. */
function explicitRegion(tag: string): string | undefined {
  try {
    const region = new Intl.Locale(String(tag).trim().replace(/_/g, '-')).region;
    // detectDefaultCountry with no time zone returns the tag's region when libphonenumber supports it.
    return region && detectDefaultCountry([`und-${region}`], '') === region ? region : undefined;
  } catch {
    return undefined;
  }
}

/** The region of the device's time zone when WhatsTime knows that zone, else undefined. */
function timeZoneRegion(timeZone: string): string | undefined {
  // An unknown zone falls through to the language tag, so two different tags give two answers; a known zone wins both.
  const a = detectDefaultCountry(['und-FJ'], timeZone);
  const b = detectDefaultCountry(['und-TO'], timeZone);
  return a === b ? a : undefined;
}

/**
 * Countries a number without a country code may have been written for, besides the default one: the region of the
 * first language with a region (who the user is) and of the time zone (where the phone is now). Offered as one-tap
 * "Read as …" alternatives for numbers the default country reads badly.
 */
export function alternativeCountries(defaultCountry: string): string[] {
  const language = deviceLanguages().map(explicitRegion).find((region) => region !== undefined);
  const zone = timeZoneRegion(getDeviceTimeZone());
  return [...new Set([language, zone])].filter(
    (region): region is string => region !== undefined && region !== defaultCountry,
  );
}
