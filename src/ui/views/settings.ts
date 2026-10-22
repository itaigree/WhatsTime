/** '#/settings' — defaults, the scheduled list, how it works and privacy. */

import type { Settings } from '../../core/types';
import { confirmDialog } from '../components/confirm';
import { field, selectControl } from '../components/field';
import type { AppContext, View } from '../context';
import { h, uid } from '../dom';
import { DURATION_OPTIONS, REMINDER_OPTIONS, countryList } from '../format';
import { icon } from '../icons';

function card(title: string, ...children: (Node | null)[]): HTMLElement {
  const titleId = uid('settings');
  return h(
    'section',
    { class: 'card', 'aria-labelledby': titleId },
    h('h2', { class: 'card-title', id: titleId }, title),
    ...children,
  );
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
        for (const msg of ctx.store.listHistory()) ctx.store.deleteFromHistory(msg.id);
        updateCount();
        ctx.announce('Scheduled list cleared');
      },
    },
    icon('trash'),
    'Clear scheduled list',
  );

  function updateCount(): void {
    const count = ctx.store.listHistory().length;
    historyCount.textContent =
      count === 0
        ? 'No reminders saved on this device.'
        : `${count} ${count === 1 ? 'reminder' : 'reminders'} saved on this device.`;
    clearButton.disabled = count === 0;
  }
  updateCount();

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
    ),
    card('Scheduled list', historyCount, clearButton),
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
    ),
    card(
      'Privacy',
      h(
        'p',
        { class: 'with-icon' },
        icon('lock'),
        h(
          'span',
          null,
          'Everything stays on this device. WhatsTime has no server and never sends your contacts or messages anywhere.',
        ),
      ),
    ),
  );

  return { title: 'Settings', element, heading };
}
