/** Shared app state handed to every view. */

import { DEFAULT_DURATION_MINUTES } from '../core/event';
import { detectDefaultCountry } from '../core/phone';
import type { AppStore, KeyValueStore } from '../core/storage';
import { getDeviceTimeZone } from '../core/timezone';
import type { ScheduledMessage, Settings } from '../core/types';

export interface AppContext {
  readonly store: AppStore;
  settings: Settings;
  saveSettings(next: Settings): void;
  /** Values to open the compose form with instead of the saved draft (share target, Reuse, Edit a copy). */
  prefill: Partial<ScheduledMessage> | null;
  /** The message created in this session, so its result page works even when storage is unavailable. */
  lastCreated: ScheduledMessage | null;
  /** Warnings to show once on the result page right after creating message `id`; `phoneWarning` goes next to "To". */
  notice: { id: string; warnings: string[]; phoneWarning?: string | undefined } | null;
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

export function defaultSettings(): Settings {
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return {
    defaultCountry: detectDefaultCountry(languages, getDeviceTimeZone()),
    defaultReminderMinutesBefore: 0,
    defaultDurationMinutes: DEFAULT_DURATION_MINUTES,
  };
}
