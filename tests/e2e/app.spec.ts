import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// The app's user flows. Every test sets an explicit far-future date (or a long-past one), so nothing
// depends on today's date. The two projects differ in locale and time zone (he-IL / Asia/Jerusalem
// and en-US / America/New_York), which also changes the default country for phone numbers.

const FUTURE_DATE = '2030-01-15'; // a Tuesday
const CHOOSE_IN_WHATSAPP = "I'll choose the chat in WhatsApp (e.g. a group)";

interface FakeContact {
  name: string[];
  tel: string[];
}

function projectTimeZone(): string {
  return test.info().project.use.timezoneId ?? 'UTC';
}

function isAndroidProject(): boolean {
  return test.info().project.name === 'android-chrome';
}

/** Chrome on Android's Contact Picker, faked before any page script runs. */
async function fakeContactPicker(page: Page, contacts: FakeContact[]): Promise<void> {
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

const messageBox = (page: Page) => page.getByLabel('Message', { exact: true });
const dateInput = (page: Page) => page.getByLabel('Date', { exact: true });
const timeInput = (page: Page) => page.getByLabel('Time', { exact: true });
const submitButton = (page: Page) => page.getByRole('button', { name: 'Create reminder' });

async function setWhen(page: Page, date: string, time: string): Promise<void> {
  await dateInput(page).fill(date);
  await timeInput(page).fill(time);
}

/** A one-off reminder without a fixed recipient; ends on the result page. */
async function createReminder(page: Page, message: string, time = '09:30'): Promise<void> {
  await page.goto('./');
  await page.getByLabel(CHOOSE_IN_WHATSAPP).check();
  await messageBox(page).fill(message);
  await setWhen(page, FUTURE_DATE, time);
  await submitButton(page).click();
  await expect(page).toHaveURL(/#\/done\//);
}

/** iCalendar content lines with folding undone (RFC 5545 section 3.1). */
function unfold(ics: string): string {
  return ics.replace(/\r\n[ \t]/g, '');
}

test('contact picker: choose a number, repeat weekly, and get Google Calendar, .ics and wa.me links', async ({
  page,
}) => {
  await fakeContactPicker(page, [{ name: ['Dana Cohen'], tel: ['050-123-4567', '+1 (212) 555-0123'] }]);
  await page.goto('./');

  await page.getByRole('button', { name: 'Choose from contacts' }).click();
  await expect(page.getByText('Dana Cohen')).toBeVisible();
  const numbers = page.getByRole('radiogroup', { name: 'Which number?' });
  await expect(numbers.getByRole('radio')).toHaveCount(2);
  if (isAndroidProject()) {
    // Default country Israel: the local number is understood.
    await expect(numbers.getByRole('radio', { name: '+972 50-123-4567' })).toBeEnabled();
  } else {
    // Default country United States: '050…' only has the length of a US number; it is offered with a warning.
    await expect(numbers.getByRole('radio', { name: /0501234567.*double-check/ })).toBeEnabled();
  }
  await numbers.getByRole('radio', { name: '+1 212 555-0123' }).check();

  const message = 'שלום Dana! 👋\nנתראה מחר ב-10 🙂';
  await messageBox(page).fill(message);
  await setWhen(page, FUTURE_DATE, '09:30');

  await page.getByLabel('Repeat', { exact: true }).selectOption('weekly');
  await expect(page.getByRole('button', { name: 'Tuesday' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Thursday' }).click();
  await expect(page.getByRole('button', { name: 'Thursday' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('radio', { name: 'After', exact: true }).check();
  await page.getByLabel('Number of times').fill('6');
  await expect(page.getByText('Every week on Tue, Thu, 6 times')).toBeVisible();
  // Five upcoming dates, formatted per locale ('Tue 15 Jan 2030' or 'Tue, Jan 15, 2030').
  const preview = page.getByText(/^Next reminders: /);
  await expect(preview).toHaveText(/^Next reminders: ([^·]+ · ){4}[^·]+$/);
  await expect(preview).toContainText(/Tue,? (15 Jan|Jan 15)/);
  await expect(preview).toContainText(/Thu,? (17 Jan|Jan 17)/);

  await page.getByLabel('Reminder', { exact: true }).selectOption({ label: '10 minutes before' });
  await submitButton(page).click();

  await expect(page).toHaveURL(/#\/done\/[\w-]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Add it to your calendar');
  await expect(page.getByText('Every week on Tue, Thu, 6 times')).toBeVisible();

  const waHref = `https://wa.me/12125550123?text=${encodeURIComponent(message)}`;
  const waLink = page.getByRole('link', { name: 'Try the WhatsApp link' });
  await expect(waLink).toHaveAttribute('href', waHref);
  await expect(waLink).toHaveAttribute('target', '_blank');
  await expect(page.getByLabel('WhatsApp link')).toHaveValue(waHref);

  const tz = projectTimeZone();
  const gcal = page.getByRole('link', { name: 'Add to Google Calendar' });
  await expect(gcal).toHaveAttribute('rel', /noopener/);
  const gcalUrl = new URL((await gcal.getAttribute('href')) ?? '');
  expect(gcalUrl.origin + gcalUrl.pathname).toBe('https://calendar.google.com/calendar/render');
  expect(gcalUrl.searchParams.get('action')).toBe('TEMPLATE');
  expect(gcalUrl.searchParams.get('dates')).toBe('20300115T093000/20300115T094500');
  expect(gcalUrl.searchParams.get('ctz')).toBe(tz);
  expect(gcalUrl.searchParams.get('recur')).toBe('RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=6');
  expect(gcalUrl.searchParams.get('details')).toContain(waHref);
  await expect(page.getByText(/set it to '10 minutes before'/)).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download calendar file (.ics)' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^[\w.-]+\.ics$/);
  const ics = unfold(await readFile(await download.path(), 'utf8'));
  expect(ics).toContain(`DTSTART;TZID=${tz}:20300115T093000`);
  expect(ics).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=6');
  expect(ics).toContain('TRIGGER:-PT10M');
  expect(ics).toContain(`URL:${waHref}`);
});

test('manual number: an invalid number is reported and focused, then corrected', async ({ page }) => {
  await page.goto('./');
  // No Contact Picker in this browser: the number field is shown directly.
  await expect(page.getByRole('button', { name: 'Choose from contacts' })).toHaveCount(0);
  await expect(page.getByText('Contact picker works in Chrome on Android.')).toBeVisible();

  const phone = page.getByLabel('Phone number');
  await phone.fill('+972 50-12');
  await phone.blur();
  await expect(phone).toHaveAttribute('aria-invalid', 'true');
  await expect(phone).toHaveAccessibleDescription(/too short/i);

  await messageBox(page).fill('Hi Noa');
  await setWhen(page, FUTURE_DATE, '10:00');
  await submitButton(page).click();
  await expect(phone).toBeFocused();
  await expect(page).not.toHaveURL(/#\/done\//);

  await phone.fill('+972 50-123-4567');
  await expect(phone).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.phone-preview')).toContainText('+972 50-123-4567');
  await page.getByLabel('Name (optional)').fill('Noa');
  await submitButton(page).click();

  await expect(page).toHaveURL(/#\/done\//);
  await expect(page.getByRole('link', { name: 'Try the WhatsApp link' })).toHaveAttribute(
    'href',
    'https://wa.me/972501234567?text=Hi%20Noa',
  );

  // The contact is remembered: a "Recent" chip selects it again.
  await page.getByRole('link', { name: 'New', exact: true }).click();
  await page.getByRole('group', { name: 'Recent' }).getByRole('button', { name: 'Noa' }).click();
  await expect(page.getByRole('button', { name: 'Change recipient' })).toBeFocused();
  await expect(page.getByText('+972 50-123-4567')).toBeVisible();
});

test('contact card import: pick one of several contacts from a .vcf file', async ({ page }) => {
  const vcf = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Avi Levi',
    'TEL;TYPE=CELL:+972 52-765-4321',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Maya Ben-David',
    'TEL;TYPE=CELL:+972 54-111-2233',
    'TEL;TYPE=HOME:+972 3-555-1234',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:2.1',
    'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D7=9B=D7=94=D7=9F;=D7=93=D7=A0=D7=94;;;',
    'TEL;CELL:+972501234567',
    'END:VCARD',
    '',
  ].join('\r\n');
  await page.goto('./');
  await page.getByLabel('Import contact card (.vcf)').setInputFiles({
    name: 'contacts.vcf',
    mimeType: 'text/vcard',
    buffer: Buffer.from(vcf, 'utf8'),
  });

  const search = page.getByLabel('Search 3 contacts');
  await expect(search).toBeFocused();
  await expect(page.getByRole('button', { name: /דנה כהן/ })).toBeVisible();
  await search.fill('maya');
  await expect(page.locator('.contact-list').getByRole('button')).toHaveCount(1);
  await page.getByRole('button', { name: /Maya Ben-David/ }).click();

  const numbers = page.getByRole('radiogroup', { name: 'Which number?' });
  await expect(numbers.getByRole('radio', { name: /\+972 54-111-2233.*Mobile/ })).toBeFocused();
  await numbers.getByRole('radio', { name: /Home/ }).check();
  await messageBox(page).fill('Shabbat shalom');
  await setWhen(page, FUTURE_DATE, '16:00');
  await submitButton(page).click();
  await expect(page.getByRole('link', { name: 'Try the WhatsApp link' })).toHaveAttribute(
    'href',
    'https://wa.me/97235551234?text=Shabbat%20shalom',
  );
});

test('"Choose chat in WhatsApp" makes a wa.me link without a number', async ({ page }) => {
  const message = 'Who is in for pizza tonight? 🍕';
  await createReminder(page, message);
  await expect(page.getByRole('link', { name: 'Try the WhatsApp link' })).toHaveAttribute(
    'href',
    `https://wa.me/?text=${encodeURIComponent(message)}`,
  );
  await expect(page.getByText('Choose chat in WhatsApp')).toBeVisible();
});

test('still works when the browser blocks storage', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('Storage is disabled', 'SecurityError');
      },
    });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await createReminder(page, 'No storage, no problem');
  await expect(page.getByRole('link', { name: 'Try the WhatsApp link' })).toHaveAttribute(
    'href',
    'https://wa.me/?text=No%20storage%2C%20no%20problem',
  );
  expect(errors).toEqual([]);
});

test('validation: an empty message and a past time for a one-off are refused', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel(CHOOSE_IN_WHATSAPP).check();
  await setWhen(page, FUTURE_DATE, '09:00');
  await submitButton(page).click();

  const message = messageBox(page);
  await expect(message).toBeFocused();
  await expect(message).toHaveAttribute('aria-invalid', 'true');
  await expect(message).toHaveAccessibleDescription(/Write the message you want to send/);

  await message.fill('Too late');
  await expect(message).not.toHaveAttribute('aria-invalid', 'true');
  await setWhen(page, '2020-01-01', '09:00');
  await submitButton(page).click();

  await expect(dateInput(page)).toBeFocused();
  await expect(dateInput(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(dateInput(page)).toHaveAccessibleDescription(/already passed/);
  await expect(page).not.toHaveURL(/#\/done\//);

  // A repeating reminder that started in the past is allowed, with a warning on the next page.
  await page.getByLabel('Repeat', { exact: true }).selectOption('yearly');
  await submitButton(page).click();
  await expect(page).toHaveURL(/#\/done\//);
  await expect(page.getByRole('note')).toContainText('later repeats will still remind you');
});

test('scheduled list: shows the item, Reuse pre-fills the form, Delete removes it', async ({ page }) => {
  await createReminder(page, 'Water the plants 🌱', '18:45');

  await page.getByRole('link', { name: 'Scheduled' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Scheduled' })).toBeFocused();
  const item = page.getByRole('listitem').filter({ hasText: 'Water the plants' });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('Next:');
  await expect(item).toContainText('2030');
  await expect(item).toContainText('Does not repeat');

  await item.getByRole('button', { name: 'Reuse' }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(messageBox(page)).toHaveValue('Water the plants 🌱');
  await expect(page.getByLabel(CHOOSE_IN_WHATSAPP)).toBeChecked();
  await expect(dateInput(page)).toHaveValue(FUTURE_DATE);
  await expect(timeInput(page)).toHaveValue('18:45');

  await page.getByRole('link', { name: 'Scheduled' }).click();
  page.once('dialog', (dialog) => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('does not delete the event from your calendar');
    void dialog.accept();
  });
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Water the plants' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(page.getByRole('listitem')).toHaveCount(0);
  await expect(page.getByText('Nothing scheduled yet')).toBeVisible();
});

test('settings: the default country changes how local numbers are read', async ({ page }) => {
  await page.goto('./#/settings');
  const country = page.getByLabel('Default country');
  await country.selectOption('US');
  await expect(page.getByRole('status')).toHaveText('Saved');

  await page.getByRole('link', { name: 'New', exact: true }).click();
  await expect(page.getByRole('link', { name: 'New', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await expect(page.getByText('Numbers without a country code use +1 (United States).')).toBeVisible();

  const phone = page.getByLabel('Phone number');
  await phone.fill('(212) 555-0123');
  await phone.blur();
  await expect(page.locator('.phone-preview')).toContainText('+1 212 555-0123');

  await page.reload();
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByLabel('Default country')).toHaveValue('US');
});

test('share target: shared text becomes the message and the query is removed', async ({ page }) => {
  await page.goto('./?text=Hello%20there');
  await expect(messageBox(page)).toHaveValue('Hello there');
  expect(new URL(page.url()).search).toBe('');

  // Android often repeats the URL inside the text; it is kept once.
  await page.goto('./?title=Look&text=Check%20this%20out%20https%3A%2F%2Fexample.com&url=https%3A%2F%2Fexample.com');
  await expect(messageBox(page)).toHaveValue('Look\nCheck this out https://example.com');
  expect(new URL(page.url()).search).toBe('');
});

test('the draft survives a reload', async ({ page }) => {
  await page.goto('./');
  await page.getByLabel(CHOOSE_IN_WHATSAPP).check();
  await messageBox(page).fill('Draft that survives ✨');
  await setWhen(page, FUTURE_DATE, '07:15');
  await page.getByLabel('Repeat', { exact: true }).selectOption('daily');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('whatstime:v1:draft') ?? '')).toContain('"daily"');

  await page.reload();
  await expect(messageBox(page)).toHaveValue('Draft that survives ✨');
  await expect(dateInput(page)).toHaveValue(FUTURE_DATE);
  await expect(timeInput(page)).toHaveValue('07:15');
  await expect(page.getByLabel('Repeat', { exact: true })).toHaveValue('daily');
  await expect(page.getByLabel(CHOOSE_IN_WHATSAPP)).toBeChecked();

  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(messageBox(page)).toHaveValue('');
  await page.reload();
  await expect(messageBox(page)).toHaveValue('');
});

test('no horizontal scrolling at 320px on any view', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await fakeContactPicker(page, [
    { name: ['Bartholomew Montgomery-Featherstonehaugh the Third'], tel: ['+972 50-123-4567', '+1 212 555 0123'] },
  ]);
  const expectNoOverflow = async (view: string) => {
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth, view).toBeLessThanOrEqual(clientWidth);
  };

  await page.goto('./');
  await page.getByRole('button', { name: 'Choose from contacts' }).click();
  await page.getByRole('radio', { name: '+972 50-123-4567' }).check();
  await messageBox(page).fill('A long message without spaces: ' + 'x'.repeat(200));
  await setWhen(page, FUTURE_DATE, '09:30');
  await page.getByLabel('Repeat', { exact: true }).selectOption('weekly');
  await page.getByRole('radio', { name: 'On', exact: true }).check();
  await expectNoOverflow('compose');
  await submitButton(page).click();
  await expect(page).toHaveURL(/#\/done\//);
  await expectNoOverflow('result');

  await page.getByRole('link', { name: 'Scheduled' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(1);
  await expectNoOverflow('scheduled');

  await page.getByRole('link', { name: 'Settings' }).click();
  await expectNoOverflow('settings');
});
