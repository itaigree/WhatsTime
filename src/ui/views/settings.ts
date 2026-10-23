/** '#/settings' — defaults, the scheduled list, how it works and privacy. */

import type { Settings } from '../../core/types';
import { confirmDialog } from '../components/confirm';
import { field, selectControl } from '../components/field';
import type { AppContext, View } from '../context';
import { h, uid } from '../dom';
import { DURATION_OPTIONS, REMINDER_OPTIONS, countryList } from '../format';
import { icon } from '../icons';

/** A titled card; the title can take focus (tabindex -1) for when the control that had it goes away. */
function card(title: string, ...children: (Node | null)[]): { element: HTMLElement; title: HTMLElement } {
  const titleEl = h('h2', { class: 'card-title', id: uid('settings'), tabindex: -1 }, title);
  return { element: h('section', { class: 'card', 'aria-labelledby': titleEl.id }, titleEl, ...children), title: titleEl };
}

export function settingsView(ctx: AppContext): View {
  const heading = h('h1', { tabindex: -1 }, 'Settings');

  const save = (patch: Partial<Settings>): void => {
    ctx.saveSettings({ ...ctx.settings, ...patch });
    ctx.announce('Saved');
  };

  const countrySelect = selectControl(
    countryList().map((c) => ({ value: c.code, label: `${c.name} (+${c.callingCode})` })),
    ctx.settings.defaultCountry,
    { onChange: () => save({ defaultCountry: countrySelect.value }) },
  );
  const reminderSelect = selectControl(
    REMINDER_OPTIONS.map((o) => ({ value: String(o.minutes), label: o.label })),
    String(ctx.settings.defaultReminderMinutesBefore),
    { onChange: () => save({ defaultReminderMinutesBefore: Number(reminderSelect.value) }) },
  );
  const durationSelect = selectControl(
    DURATION_OPTIONS.map((o) => ({ value: String(o.minutes), label: o.label })),
    String(ctx.settings.defaultDurationMinutes),
    { onChange: () => save({ defaultDurationMinutes: Number(durationSelect.value) }) },
  );

  const historyCount = h('p', { class: 'muted' });
  const clearButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-secondary btn-danger',
      onClick: async () => {
        const ok = await confirmDialog({
          title: 'Clear the scheduled list?',
          body: 'This removes every reminder saved on this device. Events you already added to your calendar stay there.',
          confirmLabel: 'Clear list',
          danger: true,
        });
        if (!ok) return;
        ctx.store.clearHistory();
        updateCounts();
        // The button is now disabled, which would drop focus to the page; keep it in this card instead.
        historyCard.title.focus();
        ctx.announce('Scheduled list cleared');
      },
    },
    icon('trash'),
    'Clear scheduled list',
  );

  const contactsCount = h('p', { class: 'muted' });
  const clearContactsButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-secondary btn-danger',
      onClick: async () => {
        const ok = await confirmDialog({
          title: 'Clear recent contacts?',
          body: "This removes the names and numbers shown under Recent. Your phone's contacts are not affected.",
          confirmLabel: 'Clear contacts',
          danger: true,
        });
        if (!ok) return;
        ctx.store.clearRecentContacts();
        updateCounts();
        contactsCard.title.focus();
        ctx.announce('Recent contacts cleared');
      },
    },
    icon('trash'),
    'Clear recent contacts',
  );

  function updateCounts(): void {
    const count = ctx.store.listHistory().length;
    historyCount.textContent =
      count === 0
        ? 'No reminders saved on this device.'
        : `${count} ${count === 1 ? 'reminder' : 'reminders'} saved on this device.`;
    clearButton.disabled = count === 0;
    const contacts = ctx.store.listRecentContacts().length;
    contactsCount.textContent =
      contacts === 0
        ? 'No recent contacts saved on this device.'
        : `${contacts} recent ${contacts === 1 ? 'contact' : 'contacts'} saved on this device.`;
    clearContactsButton.disabled = contacts === 0;
  }
  updateCounts();
  const historyCard = card('Scheduled list', historyCount, clearButton);
  const contactsCard = card('Recent contacts', contactsCount, clearContactsButton);

  const element = h(
    'div',
    { class: 'view' },
    heading,
    card(
      'Defaults',
      h(
        'div',
        { class: 'stack' },
        field({
          label: 'Default country',
          control: countrySelect,
          hint: 'For phone numbers without a country code.',
        }).element,
        field({ label: 'Default reminder', control: reminderSelect }).element,
        field({ label: 'Event length', control: durationSelect, hint: 'How long the calendar event lasts.' }).element,
      ),
    ).element,
    historyCard.element,
    contactsCard.element,
    card(
      'How it works',
      h(
        'ol',
        { class: 'steps' },
        h('li', null, 'Pick who to message, write the message and choose when.'),
        h('li', null, 'Add the event to your calendar: Google Calendar, or the .ics file for other calendar apps.'),
        h('li', null, 'When the reminder goes off, tap the WhatsApp link in the event.'),
        h('li', null, 'WhatsApp opens with your message ready. Press send.'),
      ),
      h(
        'p',
        { class: 'muted' },
        'The link is a standard WhatsApp click-to-chat (wa.me) link. A web app cannot send messages for you, so your calendar does the reminding.',
      ),
    ).element,
    card(
      'Privacy',
      h(
        'div',
        { class: 'with-icon' },
        icon('lock'),
        h(
          'div',
          { class: 'stack-tight' },
          h(
            'p',
            null,
            'WhatsTime has no server of its own. Your reminders, recent contacts and draft are stored only on this device.',
          ),
          h(
            'p',
            null,
            'When you tap Add to Google Calendar or open the WhatsApp link, the event details or the message are sent to Google or WhatsApp. The .ics file stays on your device until you import it into a calendar.',
          ),
        ),
      ),
    ).element,
  );

  return { title: 'Settings', element, heading };
}
