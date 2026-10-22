# WhatsTime

Schedule WhatsApp messages as calendar reminders.

Pick a contact, a date and time, optionally a repeat rule, and write the message. WhatsTime gives you a calendar event with a
reminder. The event contains a `https://wa.me/…` link with the phone number and the message embedded, so when the reminder
goes off you tap the link, WhatsApp opens with the chat and the text ready, and you press **Send**.

WhatsTime is a Progressive Web App (PWA): it runs in the browser, installs to your home screen, works offline, and has no
server. Your contacts and messages never leave your phone.

## How it works

1. **To** – tap **Choose from contacts** (Chrome on Android opens your phone's contact picker), type a number, import a
   contact card (`.vcf`), or reuse a recent contact. You can also leave the recipient open and pick the chat in WhatsApp
   when sending, which is the only way to reach a group.
2. **Message** – any text, including Hebrew and emoji.
3. **When** – date and time, in your phone's time zone.
4. **Repeat** (optional) – daily, weekly (on chosen days), monthly (on the same date, the *n*-th weekday, the last weekday or
   the last day), or yearly; every *n* days, weeks, months or years; ending never, on a date, or after a number of times.
   The form previews the next reminder dates.
5. **Reminder** – at the time of the message, or 5 minutes to 1 day before.

Then add it to your calendar:

| Option | Best for | Reminder |
| --- | --- | --- |
| **Add to Google Calendar** | Google Calendar (Android, web) | Google applies your default notification. Set it to *At time of event* in the editor before saving if needed. |
| **Download calendar file (.ics)** | Samsung Calendar, Outlook, Apple Calendar, most other apps | The exact reminder you chose is included. |

Both carry the repeat rule. The Google Calendar app on Android cannot import `.ics` files, which is why both options exist.

## Why a calendar reminder?

A web page can't send WhatsApp messages for you, and it can't reliably wake itself up later to notify you. Your calendar
can, on every phone, even when WhatsTime is closed. The calendar does the reminding, and the `wa.me` link does the rest.

## Using it on Android

1. Open the app's URL in **Chrome** (see deployment below).
2. Chrome menu → **Add to Home screen** / **Install app**.
3. The contact picker needs Chrome on Android and an HTTPS address (GitHub Pages is HTTPS). In other browsers, type the
   number or import a `.vcf` instead.

Installed on Android, WhatsTime also shows up in the **Share** sheet: share some text to it and that text becomes the
message.

## Development

Requires Node.js 20.19+.

```bash
npm install
npm run dev          # local dev server
npm test             # unit tests (vitest)
npm run typecheck
npm run build        # production build in dist/
npm run test:e2e     # end-to-end tests (Playwright; run `npx playwright install chromium` once)
```

Project layout:

- `src/core/` – pure, unit-tested logic: phone normalisation (libphonenumber-js), vCard parsing, repeat rules (RFC 5545
  RRULE), time zones, `.ics` generation (with VTIMEZONE and VALARM), Google Calendar links, `wa.me` links, storage.
- `src/ui/` – the vanilla TypeScript interface.
- `public/` – PWA manifest, service worker and icons.
- `tests/unit/`, `tests/e2e/` – vitest and Playwright suites.

## Deployment (GitHub Pages)

`.github/workflows/deploy.yml` builds the app and publishes it to GitHub Pages on every push to `main`.

One-time setup: in the repository on GitHub, go to **Settings → Pages → Build and deployment → Source** and choose
**GitHub Actions**. After the next push to `main`, the app is live at `https://<your-user>.github.io/<repo>/`.
