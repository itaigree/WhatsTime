/** '#/done/<id>' — add the saved message to a calendar. */

import { firstReminderAt, toCalendarEvent } from '../../core/event';
import { formatPhoneForDisplay } from '../../core/phone';
import { GOOGLE_CALENDAR_URL_MAX_LENGTH, buildGoogleCalendarUrl } from '../../core/gcal';
import { buildIcs, icsFileName } from '../../core/ics';
import { describeRecurrence } from '../../core/recurrence';
import { getDeviceTimeZone, utcToZoned, zonedTimeToUtc } from '../../core/timezone';
import type { CalendarEvent, ScheduledMessage } from '../../core/types';
import type { AppContext, View } from '../context';
import { h, uid } from '../dom';
import type { Child } from '../dom';
import { longDayTimeLabel, reminderLabel, timeLabel } from '../format';
import { icon } from '../icons';
import type { IconName } from '../icons';
import { nextReminder } from '../occurrence';
import { openInCompose } from './compose';

function notFoundView(): View {
  const heading = h('h1', { tabindex: -1 }, 'Reminder not found');
  const element = h(
    'div',
    { class: 'view' },
    heading,
    h(
      'section',
      { class: 'card empty' },
      h('p', null, "This reminder isn't on this device. It may have been deleted, or created in another browser."),
      h('a', { class: 'btn btn-primary', href: '#/' }, icon('add'), 'Schedule a message'),
    ),
  );
  return { title: 'Not found', element, heading };
}

function summaryRow(term: string, ...details: Child[]): HTMLElement[] {
  return [h('dt', null, term), h('dd', null, ...details)];
}

/** Google's template link can't carry the reminder, so say which notification to pick (in Google's words). */
function googleNote(msg: ScheduledMessage, chosenCalendar: boolean): string {
  const filled = msg.recurrence.frequency === 'none' ? 'the message and time' : 'the message, time and repeat';
  if (chosenCalendar) {
    return `Opens Google Calendar with ${filled} filled in, in your chosen calendar. Its default notification is used, so set that calendar's notifications to '${msg.reminderMinutesBefore === 0 ? 'At time of event' : reminderLabel(msg.reminderMinutesBefore)}' once in Google Calendar's settings.`;
  }
  const wanted = msg.reminderMinutesBefore === 0 ? 'At time of event' : reminderLabel(msg.reminderMinutesBefore);
  return `Opens Google Calendar with ${filled} filled in. Google can't take the reminder from a link: before you tap Save, set the notification to '${wanted}'.`;
}

const ICS_NOTE =
  'For Samsung Calendar, Outlook, Apple Calendar and others. Includes the reminder. Open the downloaded file from the ' +
  "notification or the Files app and choose your calendar app. Google Calendar can't open these files.";

function action(link: HTMLElement, note: string): HTMLElement {
  return h('div', { class: 'action' }, link, h('p', { class: 'action-note' }, note));
}

function actionLink(
  href: string,
  iconName: IconName,
  label: string,
  primary: boolean,
  extra: Record<string, string> = {},
): HTMLAnchorElement {
  return h(
    'a',
    {
      href,
      class: primary ? 'btn btn-primary btn-block btn-large' : 'btn btn-secondary btn-block btn-large',
      ...extra,
    },
    icon(iconName),
    label,
  );
}

/** clipboard API, else select + execCommand on the visible link field. */
async function copyText(text: string, fallbackField: HTMLInputElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    fallbackField.focus();
    fallbackField.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

function eventFor(msg: ScheduledMessage): CalendarEvent {
  const created = new Date(msg.createdAt);
  return toCalendarEvent(msg, Number.isNaN(created.getTime()) ? new Date() : created);
}

export function resultView(ctx: AppContext, id: string): View {
  const msg =
    ctx.store.listHistory().find((m) => m.id === id) ?? (ctx.lastCreated?.id === id ? ctx.lastCreated : undefined);
  if (!msg) return notFoundView();
  const notice = ctx.notice?.id === id ? ctx.notice : null;
  ctx.notice = null;
  // Every reminder has gone off: adding it to a calendar now would never notify, so offer a fresh copy instead.
  const passed = nextReminder(msg, new Date()) === null;

  const event = eventFor(msg);
  const waLink = event.url;
  const icsUrl = URL.createObjectURL(new Blob([buildIcs(event)], { type: 'text/calendar;charset=utf-8' }));

  const heading = h('h1', { tabindex: -1 }, passed ? 'This reminder has already passed' : 'Add it to your calendar');

  // Summary. Times are the ones on the clock: a time skipped by a DST change is shown as the time actually used,
  // as the note in the form says ("02:30 doesn't exist …; 03:30 is used instead").
  const reminderAt = utcToZoned(firstReminderAt(msg), msg.timeZone);
  const messageAt = utcToZoned(zonedTimeToUtc(event.start, msg.timeZone), msg.timeZone);
  const otherZone = msg.timeZone !== getDeviceTimeZone() ? ` (${msg.timeZone})` : '';
  const reminderDetail =
    msg.reminderMinutesBefore === 0
      ? 'At the time of the message'
      : `${reminderLabel(msg.reminderMinutesBefore)} the message at ${timeLabel(messageAt.time)}`;
  const messageId = uid('message');
  const messageText = h('p', { class: 'message-text clamp', dir: 'auto', id: messageId }, msg.message);
  const showMore = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-text btn-small',
      'aria-expanded': false,
      'aria-controls': messageId,
      hidden: true,
      onClick: () => {
        const expanded = messageText.classList.toggle('clamp') === false;
        showMore.setAttribute('aria-expanded', String(expanded));
        showMore.textContent = expanded ? 'Show less' : 'Show more';
      },
    },
    'Show more',
  );
  const name = msg.recipient.name.trim();
  const to = msg.recipient.phone
    ? [
        name ? h('span', { class: 'strong block' }, h('span', { dir: 'auto' }, name)) : null,
        h(
          'span',
          { dir: 'ltr', class: name ? 'muted block phone' : 'strong block phone' },
          formatPhoneForDisplay(msg.recipient.phone),
        ),
        notice?.phoneWarning
          ? h('span', { class: 'inline-warning' }, icon('warning', 18), h('span', null, notice.phoneWarning))
          : null,
      ]
    : [h('span', { class: 'strong' }, 'Choose chat in WhatsApp')];
  const summary = h(
    'section',
    { class: 'card', 'aria-label': 'Details' },
    h(
      'dl',
      { class: 'summary-list' },
      summaryRow('To', ...to),
      summaryRow(
        'First reminder',
        h('span', { class: 'strong' }, longDayTimeLabel(reminderAt) + otherZone),
        h('span', { class: 'muted block' }, reminderDetail),
      ),
      summaryRow('Repeat', describeRecurrence(msg.recurrence, event.start.date)),
      // The box carries the padding, so the clamped text inside shows no sliver of a 7th line.
      summaryRow('Message', h('div', { class: 'message-box' }, messageText), showMore),
    ),
  );

  // Actions
  const linkField = h('input', {
    type: 'text',
    readonly: true,
    dir: 'ltr',
    class: 'link-field',
    spellcheck: 'false',
    value: waLink,
    onFocus: () => linkField.select(),
  });
  const copyButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-secondary',
      onClick: async () => {
        const ok = await copyText(waLink, linkField);
        ctx.announce(ok ? 'Copied' : 'Select the link and copy it.');
      },
    },
    icon('copy'),
    'Copy link',
  );
  const shareButton =
    typeof navigator.share === 'function'
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn-secondary',
            onClick: () => {
              navigator.share({ title: event.title, text: event.description }).catch(() => undefined);
            },
          },
          icon('share'),
          'Share',
        )
      : null;

  // Even with the description shortened, a long message can leave the link too long for Google to open.
  const googleUrl = buildGoogleCalendarUrl(event, ctx.settings.googleCalendarId);
  const googleFits = googleUrl.length <= GOOGLE_CALENDAR_URL_MAX_LENGTH;
  const actions = h(
    'section',
    { class: 'card actions', 'aria-label': 'Add to calendar' },
    googleFits
      ? action(
          actionLink(googleUrl, 'calendar', 'Add to Google Calendar', true, { target: '_blank', rel: 'noopener' }),
          googleNote(msg, Boolean(ctx.settings.googleCalendarId)),
        )
      : h(
          'p',
          { class: 'inline-warning' },
          icon('warning', 18),
          h(
            'span',
            null,
            'This message is too long for a Google Calendar link. Use the calendar file below, or edit a copy with a shorter message.',
          ),
        ),
    action(
      actionLink(icsUrl, 'download', 'Download calendar file (.ics)', !googleFits, { download: icsFileName(event) }),
      ICS_NOTE,
    ),
  );

  linkField.id = uid('link');
  const linkFieldLabel = h('label', { for: linkField.id, class: 'field-label' }, 'WhatsApp link');
  const linkCard = h(
    'section',
    { class: 'card actions' },
    action(
      actionLink(waLink, 'chat', 'Try the WhatsApp link', false, { target: '_blank', rel: 'noopener' }),
      "Opens WhatsApp with the message ready, so you can check it. Don't press send unless you mean it.",
    ),
    h('div', { class: 'field' }, linkFieldLabel, linkField),
    h('div', { class: 'button-row' }, copyButton, shareButton),
  );

  // The general "very long message" warning is already covered by the Google one above when the link doesn't fit.
  const shown = (notice?.warnings ?? []).filter((w) => googleFits || w.field !== 'message');
  const warnings =
    shown.length > 0
      ? h(
          'div',
          { class: 'notice', role: 'note' },
          icon('warning'),
          h(
            'div',
            null,
            shown.map((w) => h('p', null, w.message)),
          ),
        )
      : null;

  const editCopy = (primary: boolean): HTMLElement =>
    h(
      'button',
      {
        type: 'button',
        class: primary ? 'btn btn-primary btn-block btn-large' : 'btn btn-secondary',
        onClick: () => void openInCompose(ctx, msg),
      },
      icon('edit'),
      'Edit a copy',
    );

  const hero = passed
    ? h(
        'div',
        { class: 'hero' },
        h('span', { class: 'hero-icon is-muted' }, icon('clock', 30)),
        h('p', { class: 'eyebrow' }, 'Saved on this device'),
        heading,
        h(
          'p',
          { class: 'lead' },
          "Adding it to a calendar now wouldn't remind you. Edit a copy to schedule it again, or use the WhatsApp link below to send the message yourself.",
        ),
      )
    : h(
        'div',
        { class: 'hero' },
        h('span', { class: 'hero-icon' }, icon('checkCircle', 30)),
        h('p', { class: 'eyebrow' }, 'Saved on this device'),
        heading,
        h(
          'p',
          { class: 'lead' },
          'Your calendar does the reminding. When it goes off, tap the link in the event and press send in WhatsApp.',
        ),
      );

  const element = passed
    ? h(
        'div',
        { class: 'view' },
        hero,
        h('div', { class: 'passed-actions' }, editCopy(true)),
        summary,
        linkCard,
        h(
          'div',
          { class: 'button-row footer-actions' },
          h('a', { class: 'btn btn-secondary', href: '#/' }, icon('add'), 'Schedule another'),
        ),
      )
    : h(
        'div',
        { class: 'view' },
        hero,
        warnings,
        actions,
        summary,
        linkCard,
        h(
          'div',
          { class: 'button-row footer-actions' },
          h('a', { class: 'btn btn-secondary', href: '#/' }, icon('add'), 'Schedule another'),
          editCopy(false),
        ),
      );

  return {
    title: passed ? 'Reminder passed' : 'Add to calendar',
    element,
    heading,
    mounted() {
      // Only offer "Show more" when the clamp actually hides something.
      showMore.hidden = messageText.scrollHeight <= messageText.clientHeight + 1;
    },
    destroy() {
      URL.revokeObjectURL(icsUrl);
    },
  };
}
