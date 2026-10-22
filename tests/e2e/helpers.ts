import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Shared by the e2e specs (not a spec itself).

export const FUTURE_DATE = '2030-01-15'; // a Tuesday
export const CHOOSE_IN_WHATSAPP = "I'll choose the chat in WhatsApp (e.g. a group)";

export interface FakeContact {
  name: string[];
  tel: string[];
}

export function projectTimeZone(): string {
  return test.info().project.use.timezoneId ?? 'UTC';
}

export function isAndroidProject(): boolean {
  return test.info().project.name === 'android-chrome';
}

/** Chrome on Android's Contact Picker, faked before any page script runs. */
export async function fakeContactPicker(page: Page, contacts: FakeContact[]): Promise<void> {
  await page.addInitScript((picked: FakeContact[]) => {
    class ContactsManager {
      async select(): Promise<FakeContact[]> {
        return picked;
      }
      async getProperties(): Promise<string[]> {
        return ['name', 'tel'];
      }
    }
    Object.defineProperty(window, 'ContactsManager', { value: ContactsManager, configurable: true });
    Object.defineProperty(navigator, 'contacts', { value: new ContactsManager(), configurable: true });
  }, contacts);
}

export const messageBox = (page: Page) => page.getByLabel('Message', { exact: true });
export const dateInput = (page: Page) => page.getByLabel('Date', { exact: true });
export const timeInput = (page: Page) => page.getByLabel('Time', { exact: true });
export const submitButton = (page: Page) => page.getByRole('button', { name: 'Create reminder' });

export async function setWhen(page: Page, date: string, time: string): Promise<void> {
  await dateInput(page).fill(date);
  await timeInput(page).fill(time);
}

/** A one-off reminder without a fixed recipient; ends on the result page. */
export async function createReminder(page: Page, message: string, time = '09:30'): Promise<void> {
  await page.goto('./');
  await page.getByLabel(CHOOSE_IN_WHATSAPP).check();
  await messageBox(page).fill(message);
  await setWhen(page, FUTURE_DATE, time);
  await submitButton(page).click();
  await expect(page).toHaveURL(/#\/done\//);
}
