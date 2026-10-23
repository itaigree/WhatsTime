import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import {
  CHOOSE_IN_WHATSAPP,
  FUTURE_DATE,
  clearForm,
  createReminder,
  dateInput,
  fakeContactPicker,
  isAndroidProject,
  messageBox,
  projectTimeZone,
  setWhen,
  submitButton,
  timeInput,
} from './helpers';

// The app's user flows. Every test sets an explicit far-future date (or a long-past one), so nothing
// depends on today's date. The two projects differ in locale and time zone (he-IL / Asia/Jerusalem
// and en-US / America/New_York), which also changes the default country for phone numbers.

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
    // Default country United States: no US number starts with 0, so it can't be used, and the reason says why.
    await expect(numbers.getByRole('radio', { name: /050-123-4567.*another country/ })).toBeDisabled();
    await expect(page.getByText('Numbers without a country code are read as +1 (United States).')).toBeVisible();
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
  await expect(page.getByText(/before you tap Save, set the notification to '10 minutes before'/)).toBeVisible();
  await expect(page.getByText(/Google Calendar can't open these files/)).toBeVisible();

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
  await page.getByRole('group', { name: 'Recent' }).getByRole('button', { name: 'Noa', exact: true }).click();
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
  // The one mobile number is preselected (and focused, so it is heard and easy to change).
  await expect(numbers.getByRole('radio', { name: /\+972 54-111-2233.*Mobile/ })).toBeFocused();
  await expect(numbers.getByRole('radio', { name: /\+972 54-111-2233.*Mobile/ })).toBeChecked();
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
  const deleteButton = page
    .getByRole('listitem')
    .filter({ hasText: 'Water the plants' })
    .getByRole('button', { name: 'Delete' });
  await deleteButton.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('removed from this list only');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('listitem')).toHaveCount(1);
  await deleteButton.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
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
  await expect(page.getByText('Numbers without a country code are read as +1 (United States).')).toBeVisible();

  const phone = page.getByLabel('Phone number');
  await phone.fill('(212) 555-0123');
  await phone.blur();
  await expect(page.locator('.phone-preview')).toContainText('+1 212 555-0123');

  await page.reload();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Default country')).toHaveValue('US');
});

test('share target: shared text becomes the message and the query is removed', async ({ page }) => {
  await page.goto('./?text=Hello%20there');
  await expect(messageBox(page)).toHaveValue('Hello there');
  expect(new URL(page.url()).search).toBe('');

  // Android often repeats the URL inside the text; it is kept once.
  await clearForm(page);
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

  await clearForm(page);
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

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expectNoOverflow('settings');
});

test('a single number read with doubt shows the warning, and the result page repeats it next to "To"', async ({
  page,
}) => {
  await fakeContactPicker(page, [{ name: ['Maman'], tel: ['+44 501234567'] }]);
  await page.goto('./');
  await page.getByRole('button', { name: 'Choose from contacts' }).click();

  const change = page.getByRole('button', { name: 'Change recipient' });
  await expect(change).toBeFocused();
  await expect(page.locator('.contact-card')).toContainText('+44 501234567');
  await expect(change).toHaveAccessibleDescription(/\+44 501234567.*double-check it/);

  await messageBox(page).fill('Bonjour maman');
  await setWhen(page, FUTURE_DATE, '09:00');
  await submitButton(page).click();
  await expect(page).toHaveURL(/#\/done\//);
  const to = page.locator('.summary-list dd').first();
  await expect(to).toContainText('Maman');
  await expect(to).toContainText(/double-check it/);
});

test.describe('a phone in Israel with the default country set to the United States', () => {
  test.use({ timezoneId: 'Asia/Jerusalem' });

  test('a local contact number keeps its reason after submit, and reads as Israeli in one tap', async ({ page }) => {
    await fakeContactPicker(page, [{ name: ['Mom'], tel: ['050-1234567'] }]);
    await page.goto('./#/settings');
    await page.getByLabel('Default country').selectOption('US');
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await page.getByRole('button', { name: 'Choose from contacts' }).click();

    const reason = /This number can't be used: This looks like a number from another country/;
    await expect(page.getByText(reason)).toBeVisible();
    const fix = page.locator('.country-fix');
    await expect(fix).toContainText('Numbers without a country code are read as +1 (United States).');
    await expect(fix.getByRole('link', { name: 'Change in Settings' })).toHaveAttribute('href', '#/settings');

    await messageBox(page).fill('Hi Mom');
    await setWhen(page, FUTURE_DATE, '09:00');
    await submitButton(page).click();
    await expect(page.getByText(reason)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change recipient' })).toBeFocused();
    await expect(page).not.toHaveURL(/#\/done\//);

    await fix.getByRole('button', { name: 'Read as Israel (+972)' }).click();
    await expect(page.locator('.contact-card')).toContainText('+972 50-123-4567');
    await expect(page.getByText(reason)).toHaveCount(0);
    await submitButton(page).click();
    await expect(page.getByRole('link', { name: 'Try the WhatsApp link' })).toHaveAttribute(
      'href',
      'https://wa.me/972501234567?text=Hi%20Mom',
    );
  });
});

test('recent contacts can be removed one by one or all at once, and Settings clears the scheduled list', async ({
  page,
}) => {
  await page.goto('./');
  await page.evaluate(() => {
    const contact = (name: string, phone: string, day: number) => ({
      name,
      phone,
      lastUsed: new Date(Date.UTC(2026, 0, day)).toISOString(),
    });
    const contacts = [
      contact('Noa', '972501234567', 3),
      contact('Avi', '972527654321', 2),
      contact('Dana', '972541112233', 1),
    ];
    localStorage.setItem('whatstime:v1:contacts', JSON.stringify(contacts));
  });
  await createReminder(page, 'Call the bank');

  await page.getByRole('link', { name: 'New', exact: true }).click();
  const recent = page.getByRole('group', { name: 'Recent' });
  await expect(recent.getByRole('button', { name: 'Noa', exact: true })).toBeVisible();
  await recent.getByRole('button', { name: 'Remove Noa from recent contacts' }).click();
  await expect(recent.getByRole('button', { name: 'Noa', exact: true })).toHaveCount(0);
  // Focus stays in the list, on the next chip, so several can be removed in a row.
  await expect(recent.getByRole('button', { name: 'Remove Avi from recent contacts' })).toBeFocused();
  await expect(page.getByRole('status')).toHaveText('Removed Noa from recent contacts');
  expect(await page.evaluate(() => localStorage.getItem('whatstime:v1:contacts'))).not.toContain('972501234567');
  const removeTarget = await recent.getByRole('button', { name: 'Remove Avi from recent contacts' }).boundingBox();
  expect(removeTarget?.width).toBeGreaterThanOrEqual(44);
  expect(removeTarget?.height).toBeGreaterThanOrEqual(44);

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('2 recent contacts saved on this device.')).toBeVisible();
  await expect(page.getByText('1 reminder saved on this device.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear recent contacts' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Clear contacts' }).click();
  await expect(page.getByText('No recent contacts saved on this device.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear recent contacts' })).toBeDisabled();
  // The disabled button can't keep focus: it moves to the card's heading, not back to the top of the page.
  await expect(page.getByRole('heading', { level: 2, name: 'Recent contacts' })).toBeFocused();

  await page.getByRole('button', { name: 'Clear scheduled list' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Clear list' }).click();
  await expect(page.getByText('No reminders saved on this device.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Scheduled list' })).toBeFocused();
  const stored = await page.evaluate(() =>
    ['contacts', 'history'].map((key) => localStorage.getItem(`whatstime:v1:${key}`)),
  );
  expect(stored).toEqual([null, null]);

  await page.getByRole('link', { name: 'New', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Recent' })).toHaveCount(0);
});

test('share target: shared text is added below an unsent draft instead of replacing it', async ({ page }) => {
  await page.goto('./');
  await messageBox(page).fill('Happy birthday!');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('whatstime:v1:draft') ?? '')).toContain('birthday');

  await page.goto('./?text=See%20you%20at%208');
  await expect(messageBox(page)).toHaveValue('Happy birthday!\n\nSee you at 8');
  await expect(page.getByRole('status')).toHaveText('Shared text added below your draft');

  // Sharing the same text again changes nothing; neither does text identical to the draft.
  await page.goto('./?text=See%20you%20at%208');
  await expect(messageBox(page)).toHaveValue('Happy birthday!\n\nSee you at 8');
  await clearForm(page);
  await messageBox(page).fill('Same text');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('whatstime:v1:draft') ?? '')).toContain('Same text');
  await page.goto('./?text=Same%20text');
  await expect(messageBox(page)).toHaveValue('Same text');
});

test('a message too long for a Google Calendar link is flagged while typing, and offers the calendar file', async ({
  page,
}) => {
  const googleHint =
    'Too long for a Google Calendar link (you can still use the calendar file). Shorten it to use Google Calendar.';
  const generic = 'Very long messages may be cut off by some calendar apps.';
  await page.goto('./');
  await page.getByLabel(CHOOSE_IN_WHATSAPP).check();
  await setWhen(page, FUTURE_DATE, '09:30');

  // About 500 Hebrew characters: a long link, but Google still takes it.
  await messageBox(page).fill('שלום '.repeat(100));
  await expect(page.getByText(generic, { exact: false })).toBeVisible();
  await expect(page.getByText(googleHint)).toHaveCount(0);

  // About 1000: the wa.me link alone, encoded twice in `details`, is past Google's limit. Said under the message,
  // in place of the general hint.
  await messageBox(page).fill('שלום, מה שלומך היום? '.repeat(50));
  await expect(page.getByText(googleHint)).toBeVisible();
  await expect(messageBox(page)).toHaveAccessibleDescription(/Too long for a Google Calendar link/);
  await expect(page.getByText(generic, { exact: false })).toHaveCount(0);

  await submitButton(page).click();
  await expect(page).toHaveURL(/#\/done\//);
  await expect(page.getByRole('link', { name: 'Add to Google Calendar' })).toHaveCount(0);
  await expect(page.getByText('This message is too long for a Google Calendar link.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download calendar file (.ics)' })).toHaveClass(/btn-primary/);
  // One warning about the length, not two stacked ones.
  await expect(page.getByText(generic, { exact: false })).toHaveCount(0);
});

test('a time skipped or repeated by a clock change gets a note under it', async ({ page }) => {
  // Spring forward and fall back in the project's zone: Israel, or the United States.
  const [gap, repeated] = isAndroidProject() ? ['2027-03-26', '2026-10-25'] : ['2027-03-14', '2026-11-01'];
  await page.goto('./');
  await setWhen(page, gap, '02:30');
  await expect(timeInput(page)).toHaveAccessibleDescription(
    /^(02:30|2:30\sAM) doesn't exist on .+ \(clocks go forward\); (03:30|3:30\sAM) is used instead\.$/,
  );
  await setWhen(page, repeated, '01:30');
  await expect(timeInput(page)).toHaveAccessibleDescription(
    /^(01:30|1:30\sAM) happens twice on .+ \(clocks go back\); the first one is used\.$/,
  );
  await setWhen(page, FUTURE_DATE, '09:00');
  await expect(page.locator('.clock-note')).toBeEmpty();
});

test('a failed save on this device is reported', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
  });
  await page.goto('./');
  await messageBox(page).fill('Hello');
  await expect(page.getByRole('status')).toHaveText("Couldn't save on this device. Storage may be full or blocked.");
});

test('every 2 weeks on Sun and Tue keeps each Sunday with the Tuesday after it (WKST)', async ({ page }) => {
  // Both projects use Sunday-first weeks (he-IL and en-US), so the days toggle in that order and the rule says so.
  const day = (weekday: string, date: number, month: string) =>
    `${weekday},? (${date} ${month}|${month} ${date})(,? \\d{4})?`;
  await page.goto('./');
  await page.getByLabel(CHOOSE_IN_WHATSAPP).check();
  await messageBox(page).fill('Gym');
  await setWhen(page, '2026-10-25', '07:00'); // a Sunday
  await page.getByLabel('Repeat', { exact: true }).selectOption('weekly');
  await page.getByLabel('Every', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Tuesday' }).click();
  await expect(page.getByText(/^Next reminders: /)).toHaveText(
    new RegExp(`^Next reminders: ${day('Sun', 25, 'Oct')} · ${day('Tue', 27, 'Oct')} · ${day('Sun', 8, 'Nov')} · `),
  );

  await submitButton(page).click();
  await expect(page).toHaveURL(/#\/done\//);
  const gcal = page.getByRole('link', { name: 'Add to Google Calendar' });
  const recur = new URL((await gcal.getAttribute('href')) ?? '').searchParams.get('recur') ?? '';
  expect(recur).toMatch(/^RRULE:FREQ=WEEKLY;/);
  expect(recur).toContain('INTERVAL=2');
  expect(recur).toContain('WKST=SU');
});
