import { expect, test } from '@playwright/test';
import { createReminder } from './helpers';

const ID = 'abc123@group.calendar.google.com';

test('a Google calendar chosen in Settings is preselected in the Google Calendar link', async ({ page }) => {
  await page.goto('./#/settings');
  const input = page.getByLabel('Google calendar');
  await input.fill('nonsense');
  await input.press('Tab');
  await expect(page.getByText('That does not look like a calendar ID.', { exact: false })).toBeVisible();

  await input.fill(` ${ID} `);
  await input.press('Tab');
  await expect(input).toHaveValue(ID);

  await createReminder(page, 'Calendar check');
  const href = await page.getByRole('link', { name: /Add to Google Calendar/ }).getAttribute('href');
  expect(new URL(href ?? '').searchParams.get('src')).toBe(ID);
  await expect(page.getByText('in your chosen calendar', { exact: false })).toBeVisible();

  await page.goto('./#/settings');
  await page.getByLabel('Google calendar').fill('');
  await page.getByLabel('Google calendar').press('Tab');
  await createReminder(page, 'Default calendar');
  const plain = await page.getByRole('link', { name: /Add to Google Calendar/ }).getAttribute('href');
  expect(new URL(plain ?? '').searchParams.has('src')).toBe(false);
});
