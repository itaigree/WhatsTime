/** '#/' — the form that creates a scheduled message. */

import { addDays, isValidDate, isValidTime } from '../../core/dates';
import { LONG_LINK_THRESHOLD, validateScheduledMessage } from '../../core/event';
import type { MessageField, ValidationIssue } from '../../core/event';
import { defaultRecurrence } from '../../core/recurrence';
import { newId } from '../../core/storage';
import { getDeviceTimeZone, utcToZoned } from '../../core/timezone';
import type { LocalDateTime, ScheduledMessage } from '../../core/types';
import { buildWhatsAppLink } from '../../core/whatsapp';
import { createRecipientSection } from '../components/recipient';
import { createRepeatSection } from '../components/repeat';
import { defaultStart, createWhenSection, isFuture } from '../components/when';
import { errorSlot, field, selectControl, selectValue } from '../components/field';
import type { AppContext, View } from '../context';
import { debounce, h, inDocumentOrder } from '../dom';
import { REMINDER_OPTIONS, recipientLabel, reminderLabel } from '../format';
import { icon } from '../icons';
import { doneHref } from '../router';

const DRAFT_DELAY_MS = 300;

/** Open the form pre-filled from an existing message (it gets a new id when submitted). */
export function openInCompose(ctx: AppContext, msg: ScheduledMessage): void {
  ctx.prefill = {
    recipient: { ...msg.recipient },
    message: msg.message,
    start: { ...msg.start },
    recurrence: structuredClone(msg.recurrence),
    reminderMinutesBefore: msg.reminderMinutesBefore,
  };
  ctx.navigate('#/');
}

/** Keep a future start; otherwise the same time of day on the next day it is still ahead; else the default. */
function upcomingStart(start: LocalDateTime | undefined, now: Date, timeZone: string): LocalDateTime {
  if (start && isFuture(start, now, timeZone)) return start;
  if (start && isValidTime(start.time)) {
    const today = utcToZoned(now, timeZone).date;
    const sameTimeToday = { date: today, time: start.time };
    return isFuture(sameTimeToday, now, timeZone) ? sameTimeToday : { date: addDays(today, 1), time: start.time };
  }
  return defaultStart(now, timeZone);
}

export function composeView(ctx: AppContext): View {
  const { settings, store } = ctx;
  const timeZone = getDeviceTimeZone();
  const prefill = ctx.prefill;
  ctx.prefill = null;
  let finished = false;

  const saveDraft = debounce(() => {
    if (!finished) store.saveDraft(draftValue());
  }, DRAFT_DELAY_MS);

  const recipient = createRecipientSection({
    defaultCountry: settings.defaultCountry,
    recents: {
      list: () => store.listRecentContacts(),
      forget(contact) {
        store.forgetContact(contact.phone);
        ctx.announce(`Removed ${recipientLabel(contact)} from recent contacts`);
      },
    },
    onChange: changed,
  });

  const messageInput = h('textarea', { rows: 4, dir: 'auto', autocapitalize: 'sentences', class: 'message-input' });
  const counter = h('span', null);
  const longWarning = h('span', { class: 'hint-warning' });
  const messageField = field({
    label: 'Message',
    control: messageInput,
    hint: [counter, longWarning],
    labelClass: 'card-title',
  });
  messageInput.addEventListener('input', () => {
    autoGrow();
    if (messageInput.value.trim()) messageField.error.clear();
  });

  const when = createWhenSection({ timeZone, onChange: changed });
  const repeat = createRepeatSection({ region: settings.defaultCountry, onChange: changed });

  const reminderSelect = selectControl(
    REMINDER_OPTIONS.map((o) => ({ value: String(o.minutes), label: o.label })),
    String(settings.defaultReminderMinutesBefore),
  );
  const reminderField = field({
    label: 'Reminder',
    control: reminderSelect,
    labelClass: 'card-title',
    hint: 'When your calendar should notify you.',
  });
  reminderSelect.addEventListener('change', () => reminderField.error.clear());

  const formError = errorSlot();
  const submitButton = h(
    'button',
    { type: 'submit', class: 'btn btn-primary btn-block btn-large' },
    icon('bell'),
    'Create reminder',
  );
  const heading = h('h1', { tabindex: -1 }, 'Schedule a WhatsApp message');
  const form = h(
    'form',
    { class: 'compose', novalidate: true, onSubmit: submit, onInput: changed, onChange: changed },
    recipient.element,
    h('section', { class: 'card' }, messageField.element),
    when.element,
    repeat.element,
    h('section', { class: 'card' }, reminderField.element),
    h('div', { class: 'submit-bar' }, formError.element, submitButton),
  );

  const element = h(
    'div',
    { class: 'view' },
    h(
      'div',
      { class: 'view-head' },
      heading,
      h('button', { type: 'button', class: 'btn btn-text btn-small', onClick: clearForm }, 'Clear'),
    ),
    form,
  );

  function autoGrow(): void {
    messageInput.style.height = 'auto';
    messageInput.style.height = `${messageInput.scrollHeight + 2}px`;
  }

  function reminderMinutes(): number {
    return Number(reminderSelect.value);
  }

  /** Refresh everything derived from the inputs and schedule a draft save. */
  function changed(): void {
    refresh();
    saveDraft();
  }

  function refresh(): void {
    repeat.update({ start: when.get(), timeZone, reminderMinutes: reminderMinutes() });
    const length = [...messageInput.value].length;
    counter.textContent = `${length} ${length === 1 ? 'character' : 'characters'}`;
    const link = buildWhatsAppLink(recipient.draftValue()?.phone ?? '', messageInput.value.trim());
    longWarning.textContent =
      link.length > LONG_LINK_THRESHOLD ? ' · Very long messages may be cut off by some calendar apps.' : '';
  }

  function draftValue(): Partial<ScheduledMessage> {
    const draft: Partial<ScheduledMessage> = {
      message: messageInput.value,
      start: when.get(),
      recurrence: repeat.get(),
      reminderMinutesBefore: reminderMinutes(),
    };
    const who = recipient.draftValue();
    if (who) draft.recipient = who;
    return draft;
  }

  function apply(values: Partial<ScheduledMessage>): void {
    const now = new Date();
    const start = upcomingStart(values.start, now, timeZone);
    recipient.set(values.recipient);
    messageInput.value = values.message ?? '';
    when.set(start);
    const minutes = values.reminderMinutesBefore ?? settings.defaultReminderMinutesBefore;
    selectValue(reminderSelect, String(minutes), reminderLabel(minutes));
    repeat.set(values.recurrence ?? defaultRecurrence(), { start, timeZone, reminderMinutes: minutes });
    clearErrors();
    refresh();
  }

  function clearForm(): void {
    saveDraft.cancel();
    store.clearDraft();
    apply({});
    autoGrow();
    ctx.announce('Form cleared');
  }

  function clearErrors(): void {
    recipient.clearErrors();
    messageField.error.clear();
    when.clearErrors();
    repeat.clearErrors();
    reminderField.error.clear();
    formError.clear();
  }

  /** Show core validation errors next to their fields; returns the elements to focus. */
  function showIssues(errors: readonly ValidationIssue[]): HTMLElement[] {
    const byField = new Map<MessageField, string[]>();
    for (const { field: name, message } of errors) byField.set(name, [...(byField.get(name) ?? []), message]);
    const text = (name: MessageField): string => (byField.get(name) ?? []).join(' ');
    const targets: HTMLElement[] = [];

    if (byField.has('recipient')) targets.push(recipient.showError(text('recipient')));
    if (byField.has('message')) {
      messageField.error.show(text('message'), [messageInput]);
      targets.push(messageInput);
    }
    if (byField.has('date') || byField.has('time') || byField.has('timeZone')) {
      // A 'date' error on a valid date means the moment has passed: both inputs are involved.
      const fields: ('date' | 'time')[] = [];
      if (byField.has('date')) fields.push('date');
      if (byField.has('time') || (byField.has('date') && isValidDate(when.get().date))) fields.push('time');
      targets.push(when.showError([text('date'), text('time'), text('timeZone')].filter(Boolean).join(' '), fields));
    }
    if (byField.has('recurrence')) targets.push(repeat.showErrors(byField.get('recurrence') ?? []));
    if (byField.has('reminder')) {
      reminderField.error.show(text('reminder'), [reminderSelect]);
      targets.push(reminderSelect);
    }
    if (byField.has('duration')) {
      formError.show(`${text('duration')} Change the event length in Settings.`, [submitButton]);
      targets.push(submitButton);
    }
    return targets;
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    clearErrors();
    const now = new Date();
    const who = recipient.validate();
    const msg: ScheduledMessage = {
      id: newId(),
      recipient: 'recipient' in who ? who.recipient : { name: '', phone: '' },
      message: messageInput.value.trim(),
      start: when.get(),
      timeZone,
      reminderMinutesBefore: reminderMinutes(),
      durationMinutes: settings.defaultDurationMinutes,
      recurrence: repeat.get(),
      createdAt: now.toISOString(),
    };
    const { errors, warnings } = validateScheduledMessage(msg, now);
    const targets = showIssues(errors);
    if ('invalid' in who) targets.push(who.invalid);
    const [first] = inDocumentOrder(targets);
    if (first) {
      first.focus();
      return;
    }

    finished = true;
    saveDraft.cancel();
    store.saveToHistory(msg);
    if (msg.recipient.phone) store.rememberContact({ name: msg.recipient.name, phone: msg.recipient.phone }, now);
    store.clearDraft();
    ctx.lastCreated = msg;
    const phoneWarning = 'recipient' in who ? who.warning : undefined;
    ctx.notice =
      warnings.length > 0 || phoneWarning
        ? { id: msg.id, warnings: warnings.map((w) => w.message), phoneWarning }
        : null;
    ctx.navigate(doneHref(msg.id));
  }

  const flushDraft = (): void => saveDraft.flush();
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') flushDraft();
  };

  apply(prefill ?? store.loadDraft() ?? {});
  if (prefill) store.saveDraft(draftValue());

  return {
    title: 'New reminder',
    element,
    heading,
    mounted() {
      autoGrow();
      window.addEventListener('pagehide', flushDraft);
      document.addEventListener('visibilitychange', onVisibility);
    },
    destroy() {
      flushDraft();
      window.removeEventListener('pagehide', flushDraft);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
