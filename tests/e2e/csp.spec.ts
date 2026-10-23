import { expect, test } from '@playwright/test';
import { FUTURE_DATE, fakeContactPicker, messageBox, setWhen, submitButton } from './helpers';

// The production build carries a strict Content-Security-Policy (vite.config.ts). These tests run against
// that build (vite preview) and walk every view and the main flow, failing on any violation.

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

test('the built app runs under its Content-Security-Policy without a single violation', async ({ page }) => {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      const where = `${event.sourceFile}:${event.lineNumber}`;
      window.__cspViolations?.push(`${event.effectiveDirective} ${event.blockedURI} ${where}`);
    });
  });
  const consoleReports: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) consoleReports.push(message.text());
  });
  await fakeContactPicker(page, [{ name: ['Dana Cohen'], tel: ['+972 50-123-4567', '+1 212 555 0123'] }]);

  await page.goto('./');
  // The policy is the first thing after <meta charset>, so it covers everything the page loads.
  const head = await page.evaluate(() =>
    [...document.head.children].slice(0, 2).map((el) => el.getAttribute('charset') ?? el.getAttribute('http-equiv')),
  );
  expect(head).toEqual(['utf-8', 'Content-Security-Policy']);
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("script-src 'self'");
  expect(policy).toContain("style-src 'self'");
  // The app registers its service worker on load.
  await page.waitForFunction(() => navigator.serviceWorker.getRegistration().then((r) => r !== undefined));

  // Compose: picker, a number, message, quick pick, weekly repeat, a .vcf list.
  await page.getByRole('button', { name: 'Choose from contacts' }).click();
  await page.getByRole('radio', { name: '+972 50-123-4567' }).check();
  await messageBox(page).fill('Hello Dana! 👋 '.repeat(40));
  await page.getByRole('button', { name: /^Tomorrow/ }).click();
  await setWhen(page, FUTURE_DATE, '09:30');
  await page.getByLabel('Repeat', { exact: true }).selectOption('weekly');
  await page.getByRole('radio', { name: 'On', exact: true }).check();
  await page.getByRole('button', { name: 'Change recipient' }).click();
  await page.getByLabel('Import contact card (.vcf)').setInputFiles({
    name: 'contacts.vcf',
    mimeType: 'text/vcard',
    buffer: Buffer.from(
      ['Avi Levi', 'Maya Ben-David']
        .map((name, i) => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${name}\r\nTEL:+972 52-765-432${i}\r\nEND:VCARD\r\n`)
        .join(''),
    ),
  });
  await page.getByRole('button', { name: /Avi Levi/ }).click();
  await submitButton(page).click();

  // Result: show more, the .ics download, copy.
  await expect(page).toHaveURL(/#\/done\//);
  await page.getByRole('button', { name: 'Show more' }).click();
  await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download calendar file (.ics)' }).click(),
  ]);
  await page.getByRole('button', { name: 'Copy link' }).click();

  // Scheduled: the list and the delete dialog.
  await page.getByRole('link', { name: 'Scheduled' }).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  // Settings: a change, and the clear dialog.
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Default reminder').selectOption({ label: '10 minutes before' });
  await page.getByRole('button', { name: 'Clear scheduled list' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  // Back to a fresh form, and an unknown reminder.
  await page.getByRole('link', { name: 'New', exact: true }).click();
  await page.goto('./#/done/unknown-id');
  await expect(page.getByRole('heading', { name: 'Reminder not found' })).toBeVisible();

  expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
  expect(consoleReports).toEqual([]);
});
