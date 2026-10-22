/**
 * Contact Picker API (Chrome on Android). TypeScript's DOM lib has no types
 * for it, so the minimal shapes are declared here.
 */

import type { VCardContact } from '../core/vcard';

type ContactProperty = 'address' | 'email' | 'icon' | 'name' | 'tel';

interface ContactInfo {
  name?: string[];
  tel?: string[];
}

interface ContactsManager {
  select(properties: ContactProperty[], options?: { multiple?: boolean }): Promise<ContactInfo[]>;
}

interface NavigatorWithContacts extends Navigator {
  contacts?: ContactsManager;
}

export type PickResult =
  | { kind: 'picked'; contact: VCardContact }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };

export function isContactPickerSupported(): boolean {
  return 'contacts' in navigator && 'ContactsManager' in window;
}

function errorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'InvalidStateError') return 'The contact picker is already open.';
  if (name === 'SecurityError' || name === 'NotAllowedError') {
    return "Your browser didn't allow the contact picker here. Enter the number instead.";
  }
  return "Couldn't open your contacts. Enter the number instead.";
}

/**
 * Opens the picker for one contact. Call it directly from a click handler: the API needs a user gesture,
 * so nothing may be awaited before `select`.
 */
export async function pickContact(): Promise<PickResult> {
  const manager = (navigator as NavigatorWithContacts).contacts;
  if (!manager) return { kind: 'error', message: errorMessage(null) };
  try {
    const [picked] = await manager.select(['name', 'tel'], { multiple: false });
    if (!picked) return { kind: 'cancelled' };
    const name = picked.name?.map((n) => n.trim()).find(Boolean) ?? '';
    const phones = (picked.tel ?? []).filter((tel) => tel.trim()).map((value) => ({ value, label: '' }));
    return { kind: 'picked', contact: { name, phones } };
  } catch (error) {
    return { kind: 'error', message: errorMessage(error) };
  }
}
