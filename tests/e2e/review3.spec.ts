import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  CHOOSE_IN_WHATSAPP,
  FUTURE_DATE,
  createReminder,
  dateInput,
  fakeContactPicker,
  messageBox,
  setWhen,
  submitButton,
  timeInput,
} from './helpers';

// Drafts, recipients across trips to Settings, travellers' default country, and what the result and Scheduled pages
// say about reminder times. Every test sets explicit dates (far future, or long past) so none depends on today.

const storedDraft = (page: Page) => page.evaluate(() => localStorage.getItem('whatstime:v1:draft') ?? '');
const storedCountry = (page: Page) =>
  page.evaluate(() => (JSON.parse(localStorage.getItem('whatstime:v1:settings') ?? '{}') as { defaultCountry?: string }).defaultCountry);

async function setDefaultCountry(page: Page, code: string): Promise<void> {
  await page.goto('./#/settings');
  await page.getByLabel('Default country').selectOption(code);
  await page.getByRole('link', { name: 'New', exact: true }).click();
}

test.describe('travellers', () => {
  test('the detected default country is saved on first launch and stays put abroad', async ({ browser }) => {
    const baseURL = test.info().project.use.baseURL;
    const home = await browser.newContext({ baseURL, locale: 'he-IL', timezoneId: 'Asia/Jerusalem' });
    const homePage = await home.newPage();
    await homePage.goto('./');
    await expect(homePage.getByRole('heading', { level: 1 })).toHaveText('Schedule a WhatsApp message');
    expect(await storedCountry(homePage)).toBe('IL');
    const storageState = await home.storageState();
    await home.close();

    // Later, in Berlin: the time zone alone would say Germany, but the saved default stays Israel.
    const abroad = await browser.newContext({ baseURL, locale: 'he-IL', timezoneId: 'Europe/Berlin', storageState });
    const page = await abroad.newPage();
    await fakeContactPicker(page, [{ name: ['Mom'], tel: ['050-1234567'] }]);
    await page.goto('./');
    await page.getByRole('button', { name: 'Choose from contacts' }).click();
    await expect(page.locator('.contact-card')).toContainText('+972 50-123-4567');
    await expect(page.getByRole('button', { name: /^Read as / })).toHaveCount(0);
    expect(await storedCountry(page)).toBe('IL');
    await abroad.close();
  });

  test.describe('a Hebrew phone first opened in New York', () => {
    test.use({ locale: 'he-IL', timezoneId: 'America/New_York' });

    test('offers the language’s country for a local contact number', async ({ page }) => {
      await fakeContactPicker(page, [{ name: ['Mom'], tel: ['050-1234567'] }]);
      await page.goto('./');
      expect(await storedCountry(page)).toBe('US');
      await page.getByRole('button', { name: 'Choose from contacts' }).click();
      await expect(page.getByText(/This number can't be used: This looks like a number from another country/)).toBeVisible();

      await page.getByRole('button', { name: 'Read as Israel (+972)' }).click();
      await expect(page.locator('.contact-card')).toContainText('+972 50-123-4567');
      await messageBox(page).fill('Hi Mom');
      await setWhen(page, FUTURE_DATE, '09:00');
      await submitButton(page).click();
      await expect(page.getByRole('link', { name: 'Try the WhatsApp link' })).toHaveAttribute(
        'href',
        'https://wa.me/972501234567?text=Hi%20Mom',
      );
    });
  });

  test.describe('an en-GB phone in Israel with the default country set to the United States', () => {
    test.use({ locale: 'en-GB', timezoneId: 'Asia/Jerusalem' });

    test('offers each country that reads the numbers cleanly', async ({ page }) => {
      await fakeContactPicker(page, [{ name: ['Sam'], tel: ['07911 123456', '050-1234567'] }]);
      await setDefaultCountry(page, 'US');
      await page.getByRole('button', { name: 'Choose from contacts' }).click();
      const fix = page.locator('.country-fix');
      await expect(fix).toContainText('Numbers without a country code are read as +1 (United States).');
      await expect(fix.getByRole('button', { name: 'Read as United Kingdom (+44)' })).toBeVisible();
      await fix.getByRole('button', { name: 'Read as Israel (+972)' }).click();
      const numbers = page.getByRole('radiogroup', { name: 'Which number?' });
      await expect(numbers.getByRole('radio', { name: '+972 50-123-4567' })).toBeEnabled();
    });
  });
});

test.describe('in Israel', () => {
  test.use({ timezoneId: 'Asia/Jerusalem' });

  test('a time skipped by the clocks shows the time actually used on the result and Scheduled pages', async ({
    page,
  }) => {
    await page.goto('./');
    await page.getByLabel(CHOOSE_IN_WHATSAPP).check();
    await messageBox(page).fill('Spring forward');
    await setWhen(page, '2027-03-26', '02:30');
    await expect(timeInput(page)).toHaveAccessibleDescription(/(03:30|3:30\sAM) is used instead/);
    await page.getByLabel('Reminder', { exact: true }).selectOption({ label: '10 minutes before' });
    await submitButton(page).click();
    await expect(page).toHaveURL(/#\/done\//);

    const firstReminder = page.locator('.summary-list dd').nth(1);
    await expect(firstReminder).toContainText(/(03:20|3:20\sAM)/);
    await expect(firstReminder).toContainText(/10 minutes before the message at (03:30|3:30\sAM)$/);
    await expect(page.getByRole('note')).toContainText(
      "02:30 doesn't exist on that day because the clocks go forward; 03:30 is used instead.",
    );

    await page.getByRole('link', { name: 'Scheduled' }).click();
    await expect(page.getByRole('listitem').first()).toContainText(/Reminder: Fri,? (26 Mar|Mar 26),? 2027,? (03:20|3:20\sAM)/);
  });
});

test('a year out of range marks only the date, and the date inputs say which years they take', async ({ page }) => {
  await page.goto('./');
  await expect(dateInput(page)).toHaveAttribute('max', '2199-12-31');
  await page.getByLabel(CHOOSE_IN_WHATSAPP).check();
  await messageBox(page).fill('Far away');
  await setWhen(page, '2200-01-01', '09:00');
  await submitButton(page).click();
  await expect(dateInput(page)).toBeFocused();
  await expect(dateInput(page)).toHaveAccessibleDescription(/Check the year/);
  await expect(timeInput(page)).not.toHaveAttribute('aria-invalid', 'true');

  await setWhen(page, FUTURE_DATE, '09:00');
  await page.getByLabel('Repeat', { exact: true }).selectOption('daily');
  await page.getByRole('radio', { name: 'On', exact: true }).check();
  await expect(page.getByLabel('End date')).toHaveAttribute('max', '2199-12-31');
  await expect(page.getByLabel('End date')).toHaveAttribute('min', FUTURE_DATE);
});

test('Reuse and Edit a copy ask before replacing an unsent draft', async ({ page }) => {
  await createReminder(page, 'Old saved message', '08:00');
  await page.getByRole('link', { name: 'New', exact: true }).click();
  await messageBox(page).fill('A long draft I was carefully writing');
  await expect.poll(() => storedDraft(page)).toContain('carefully');

  await page.getByRole('link', { name: 'Scheduled' }).click();
  const item = page.getByRole('listitem').filter({ hasText: 'Old saved message' });
  const reuse = item.getByRole('button', { name: 'Reuse' });
  await reuse.click();
  const dialog = page.getByRole('dialog', { name: 'Replace your unsent draft?' });
  await expect(dialog).toContainText('The message you were writing will be lost.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/#\/scheduled$/);
  await expect(reuse).toBeFocused();
  expect(await storedDraft(page)).toContain('carefully');

  // Edit a copy (via Details) asks the same; agreeing replaces the draft.
  await item.getByRole('link', { name: 'Details' }).click();
  await expect(page).toHaveURL(/#\/done\//);
  await page.getByRole('button', { name: 'Edit a copy' }).click();
  await page.getByRole('dialog', { name: 'Replace your unsent draft?' }).getByRole('button', { name: 'Replace draft' }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(messageBox(page)).toHaveValue('Old saved message');

  // That draft is the saved message itself, so reusing it again has nothing to lose: no question.
  await page.getByRole('link', { name: 'Scheduled' }).click();
  await item.getByRole('button', { name: 'Reuse' }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test.describe('a phone in Israel with the default country set to the United States', () => {
  test.use({ timezoneId: 'Asia/Jerusalem' });

  test('a picked contact survives a trip to Settings and becomes usable there', async ({ page }) => {
    await fakeContactPicker(page, [{ name: ['Mom'], tel: ['050-1234567'] }]);
    await setDefaultCountry(page, 'US');
    await page.getByRole('button', { name: 'Choose from contacts' }).click();
    // A picked contact's number can't be edited here, so the remedy is the country, not "add its country code".
    await expect(
      page.getByText(
        "This number can't be used: This looks like a number from another country. Change the default country in Settings or use 'Read as …' below.",
      ),
    ).toBeVisible();
    await messageBox(page).fill('Hi Mom');

    await page.locator('.country-fix').getByRole('link', { name: 'Change in Settings' }).click();
    await page.getByLabel('Default country').selectOption('IL');
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await expect(page.locator('.contact-card')).toContainText('Mom');
    await expect(page.locator('.contact-card')).toContainText('+972 50-123-4567');
    await expect(page.locator('.country-fix')).toHaveCount(0);
    await expect(messageBox(page)).toHaveValue('Hi Mom');
  });

  test('a typed number survives a trip to Settings, with its section still open', async ({ page }) => {
    await fakeContactPicker(page, []);
    await setDefaultCountry(page, 'US');
    await page.getByText('Enter a number', { exact: true }).click();
    const phone = page.getByLabel('Phone number');
    await phone.fill('050-1234567');
    await phone.blur();
    await expect(phone).toHaveAttribute('aria-invalid', 'true');
    await expect.poll(() => storedDraft(page)).toContain('pendingRecipient');

    await page.getByRole('link', { name: 'Change in Settings' }).click();
    await page.getByLabel('Default country').selectOption('IL');
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await expect(page.getByLabel('Phone number')).toBeVisible();
    await expect(page.getByLabel('Phone number')).toHaveValue('050-1234567');
    await expect(page.getByLabel('Phone number')).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('.phone-preview')).toContainText('+972 50-123-4567');
  });
});

test('a contact whose number is not chosen yet survives a reload', async ({ page }) => {
  await fakeContactPicker(page, [{ name: ['Twins'], tel: ['+972 50-123-4567', '+972 52-765-4321'] }]);
  await page.goto('./');
  await page.getByRole('button', { name: 'Choose from contacts' }).click();
  const numbers = page.getByRole('radiogroup', { name: 'Which number?' });
  // Two mobile numbers: nothing to go by, so nothing is preselected.
  await expect(numbers.getByRole('radio', { checked: true })).toHaveCount(0);
  await expect.poll(() => storedDraft(page)).toContain('Twins');

  await page.reload();
  await expect(page.locator('.contact-card')).toContainText('Twins');
  await expect(numbers.getByRole('radio')).toHaveCount(2);
  await numbers.getByRole('radio', { name: '+972 52-765-4321' }).check();
});

test('the one mobile number among landlines is preselected, and can still be changed', async ({ page }) => {
  await fakeContactPicker(page, [{ name: ['אמא'], tel: ['+972 3-555-1234', '+972 50-123-4567', '+972 4-822-3333'] }]);
  await page.goto('./');
  await page.getByRole('button', { name: 'Choose from contacts' }).click();
  const numbers = page.getByRole('radiogroup', { name: 'Which number?' });
  const mobile = numbers.getByRole('radio', { name: '+972 50-123-4567' });
  await expect(mobile).toBeChecked();
  await expect(mobile).toBeFocused();
  await numbers.getByRole('radio', { name: '+972 3-555-1234' }).check();
  await expect(mobile).not.toBeChecked();
});

test('"Clear" asks first when a message is written; Cancel keeps everything', async ({ page }) => {
  await page.goto('./');
  const clear = page.getByRole('button', { name: 'Clear form' });
  await messageBox(page).fill('Keep me');
  await clear.click();
  const dialog = page.getByRole('dialog', { name: 'Clear the form?' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(messageBox(page)).toHaveValue('Keep me');
  await expect(clear).toBeFocused();

  await clear.click();
  await dialog.getByRole('button', { name: 'Clear form' }).click();
  await expect(messageBox(page)).toHaveValue('');
  await expect(page.getByRole('status')).toHaveText('Form cleared');

  // Nothing written: nothing to lose, so no question.
  await clear.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a monthly reminder started on the last day of a month repeats on the last day', async ({ page }) => {
  await page.goto('./');
  await setWhen(page, '2030-01-31', '09:00');
  await page.getByLabel('Repeat', { exact: true }).selectOption('monthly');
  await expect(page.getByRole('radio', { name: 'On the last day', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'On day 31', exact: true })).not.toBeChecked();
  await expect(page.getByText('Every month on the last day', { exact: false })).toBeVisible();

  // Not the end of the month: the day itself.
  await dateInput(page).fill('2030-01-30');
  await expect(page.getByRole('radio', { name: 'On day 30', exact: true })).toBeChecked();
  // 30 April is the end of its month again; a choice the user makes is kept.
  await dateInput(page).fill('2030-04-30');
  await expect(page.getByRole('radio', { name: 'On the last day', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: 'On day 30', exact: true }).check();
  await dateInput(page).fill('2030-06-30');
  await expect(page.getByRole('radio', { name: 'On day 30', exact: true })).toBeChecked();
});

test('Scheduled shows when the reminder goes off, and "Details" opens the item', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel(CHOOSE_IN_WHATSAPP).check();
  await messageBox(page).fill('Birthday tomorrow');
  await setWhen(page, FUTURE_DATE, '09:30');
  await page.getByLabel('Reminder', { exact: true }).selectOption({ label: '1 day before' });
  await submitButton(page).click();
  await expect(page).toHaveURL(/#\/done\//);

  await page.getByRole('link', { name: 'Scheduled' }).click();
  const item = page.getByRole('listitem').filter({ hasText: 'Birthday tomorrow' });
  await expect(item).toContainText(/Reminder: Mon,? (14 Jan|Jan 14),? 2030,? (09:30|9:30\sAM)/);
  await item.getByRole('link', { name: 'Details' }).click();
  await expect(page).toHaveURL(/#\/done\//);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Add it to your calendar');
});

test('a reminder that has already passed offers a fresh copy instead of the calendar', async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => {
    const past = {
      id: 'past1',
      recipient: { name: 'Dana', phone: '972501234567' },
      message: 'Happy new year',
      start: { date: '2026-01-05', time: '09:00' },
      timeZone: 'Asia/Jerusalem',
      reminderMinutesBefore: 0,
      durationMinutes: 15,
      recurrence: { frequency: 'none', interval: 1, weekdays: [], monthlyMode: 'dayOfMonth', end: { type: 'never' } },
      createdAt: '2026-01-01T10:00:00.000Z',
    };
    localStorage.setItem('whatstime:v1:history', JSON.stringify([past]));
  });
  await page.goto('./#/done/past1');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('This reminder has already passed');
  await expect(page.getByRole('button', { name: 'Edit a copy' })).toHaveClass(/btn-primary/);
  await expect(page.getByRole('link', { name: 'Add to Google Calendar' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Download calendar file (.ics)' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Try the WhatsApp link' })).toBeVisible();

  await page.getByRole('button', { name: 'Edit a copy' }).click();
  await expect(messageBox(page)).toHaveValue('Happy new year');
  await expect(page.locator('.contact-card')).toContainText('Dana');
});

test('"Choose a contact or enter a number." goes away once a valid number is typed', async ({ page }) => {
  await fakeContactPicker(page, []);
  await page.goto('./');
  await messageBox(page).fill('Hello');
  await setWhen(page, FUTURE_DATE, '09:00');
  await submitButton(page).click();
  const pick = page.getByRole('button', { name: 'Choose from contacts' });
  await expect(pick).toHaveAccessibleDescription('Choose a contact or enter a number.');

  await page.getByText('Enter a number', { exact: true }).click();
  await page.getByLabel('Phone number').fill('+972 50-123-4567');
  await expect(page.getByText('Choose a contact or enter a number.')).toHaveCount(0);
  await expect(pick).toHaveAccessibleDescription('');
});

test('a repeat interval error shows under "Every", not under the end options', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel(CHOOSE_IN_WHATSAPP).check();
  await messageBox(page).fill('Water the plants');
  await setWhen(page, FUTURE_DATE, '09:00');
  await page.getByLabel('Repeat', { exact: true }).selectOption('weekly');
  const every = page.getByLabel('Every', { exact: true });
  await every.fill('');
  await submitButton(page).click();
  await expect(every).toBeFocused();
  await expect(every).toHaveAccessibleDescription(/Repeat interval must be a whole number/);
  const error = page.getByText(/^Repeat interval must be a whole number/);
  const ends = page.getByRole('group', { name: 'Ends' });
  const [errorBox, endsBox] = [await error.boundingBox(), await ends.boundingBox()];
  expect(errorBox?.y ?? Infinity).toBeLessThan(endsBox?.y ?? 0);
});

test('a long Hebrew name is cut at its end, on the left', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const name = 'סבתא רחל כהן-לוי מירושלים העתיקה';
  await fakeContactPicker(page, [{ name: [name], tel: ['+972 50-123-4567'] }]);
  await page.goto('./');
  await page.getByRole('button', { name: 'Choose from contacts' }).click();
  const shown = page.locator('.contact-name .truncate');
  await expect(shown).toHaveText(name);
  const style = await shown.evaluate((el) => {
    const css = getComputedStyle(el);
    return { direction: css.direction, overflow: css.textOverflow, clipped: el.scrollWidth > el.clientWidth };
  });
  expect(style).toEqual({ direction: 'rtl', overflow: 'ellipsis', clipped: true });
  // The number stays on one line.
  const number = await page.locator('.contact-number').boundingBox();
  expect(number?.height ?? 0).toBeLessThan(30);
});

test('quick picks say what they set', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: /^Tomorrow / }).click();
  await expect(page.getByRole('status')).toHaveText(/^Set to \w{3},? /);
});
