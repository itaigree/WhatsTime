/** '#/' — the form that creates a scheduled message. */

import { addDays, isValidDate, isValidTime } from '../../core/dates';
import { LONG_LINK_THRESHOLD, toCalendarEvent, validateScheduledMessage } from '../../core/event';
import type { MessageField, ValidationIssue } from '../../core/event';
import { GOOGLE_CALENDAR_URL_MAX_LENGTH, buildGoogleCalendarUrl } from '../../core/gcal';
import { LATEST_UNTIL_DATE, defaultRecurrence, validateRecurrence } from '../../core/recurrence';
import { newId } from '../../core/storage';
import { getDeviceTimeZone, utcToZoned } from '../../core/timezone';
import type { Draft, LocalDateTime, Recipient, ScheduledMessage } from '../../core/types';
import { buildWhatsAppLink } from '../../core/whatsapp';
import { confirmDialog } from '../components/confirm';
import { createRecipientSection } from '../components/recipient';
import { createRepeatSection } from '../components/repeat';
import { EARLIEST_START_DATE, defaultStart, createWhenSection, isFuture } from '../components/when';
import { errorSlot, field, selectControl, selectValue } from '../components/field';
import { alternativeCountries } from '../context';
import type { AppContext, View } from '../context';
import { addIdRef, debounce, h, inDocumentOrder, setChildren, uid } from '../dom';
import { REMINDER_OPTIONS, recipientLabel, reminderLabel } from '../format';
import { icon } from '../icons';
import { doneHref } from '../router';

const DRAFT_DELAY_MS = 300;
/** Building the Google link for a long message takes a moment; check it once typing pauses. */
const LINK_CHECK_DELAY_MS = 250;

const sameRecipient = (a: Recipient, b: Recipient): boolean => a.phone === b.phone && a.name.trim() === b.name.trim();

/** What opening `msg` in the form would throw away from the unsent draft, or null when nothing worth keeping. */
function unsentWork(draft: Draft | null, msg: ScheduledMessage): 'message' | 'recipient' | null {
  if (!draft) return null;
  const message = (draft.message ?? '').trim();
  if (message && message !== msg.message.trim()) return 'message';
  if (draft.pendingRecipient) return 'recipient';
  if (draft.recipient?.phone && !sameRecipient(draft.recipient, msg.recipient)) return 'recipient';
  return null;
}

/**
 * Open the form pre-filled from an existing message (it gets a new id when submitted). An unsent draft with its own
 * message or recipient is only replaced once the user agrees; on Cancel nothing changes.
 */
export async function openInCompose(ctx: AppContext, msg: ScheduledMessage): Promise<void> {
  const lost = unsentWork(ctx.store.loadDraft(), msg);
  if (lost) {
    const ok = await confirmDialog({
      title: 'Replace your unsent draft?',
      body:
        lost === 'message'
          ? 'The message you were writing will be lost.'
          : 'The recipient you chose for your unsent draft will be lost.',
      confirmLabel: 'Replace draft',
      danger: true,
    });
    if (!ok) return;
  }
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

/** A date the core accepts as a start: a 'date' error on it can only mean the moment has passed. */
const isInRange = (date: string): boolean =>
  isValidDate(date) && date >= EARLIEST_START_DATE && date <= LATEST_UNTIL_DATE;

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
    alternatives: alternativeCountries(settings.defaultCountry),
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
    heading: true,
  });
  // Under the message: the one length limit that changes what the user can do next.
  const googleNote = h('p', { class: 'message-note inline-warning', id: uid('google'), 'aria-live': 'polite' });
  addIdRef(messageInput, 'aria-describedby', googleNote.id);
  messageField.element.append(googleNote);
  messageInput.addEventListener('input', () => {
    autoGrow();
    if (messageInput.value.trim()) messageField.error.clear();
  });

  const when = createWhenSection({ timeZone, onChange: changed, announce: ctx.announce });
  const repeat = createRepeatSection({ region: settings.defaultCountry, onChange: changed });

  const reminderSelect = selectControl(
    REMINDER_OPTIONS.map((o) => ({ value: String(o.minutes), label: o.label })),
    String(settings.defaultReminderMinutesBefore),
  );
  const reminderField = field({
    label: 'Reminder',
    control: reminderSelect,
    heading: true,
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
    // The h2 holds the field's label, so the card is in the heading outline. (No aria-labelledby on the section:
    // it would give the section the same accessible name as the textarea.)
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
      h(
        'button',
        { type: 'button', class: 'btn btn-text btn-small', 'aria-label': 'Clear form', onClick: () => void clearForm() },
        'Clear',
      ),
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
    checkLinks();
  }

  /** The form as a message the calendar links can be built from (invalid parts replaced by harmless defaults). */
  function currentMessage(now: Date): ScheduledMessage {
    const start = when.get();
    const validStart = isValidDate(start.date) && isValidTime(start.time);
    const recurrence = repeat.get();
    const validRepeat = validStart && validateRecurrence(recurrence, start.date).length === 0;
    return {
      id: 'draft',
      recipient: recipient.draftValue().recipient ?? { name: '', phone: '' },
      message: messageInput.value.trim(),
      start: validStart ? start : defaultStart(now, timeZone),
      timeZone,
      reminderMinutesBefore: reminderMinutes(),
      durationMinutes: settings.defaultDurationMinutes,
      recurrence: validRepeat ? recurrence : defaultRecurrence(),
      createdAt: now.toISOString(),
    };
  }

  function tooLongForGoogle(msg: ScheduledMessage, now: Date): boolean {
    try {
      return buildGoogleCalendarUrl(toCalendarEvent(msg, now), settings.googleCalendarId).length > GOOGLE_CALENDAR_URL_MAX_LENGTH;
    } catch {
      return false;
    }
  }

  /** Length hints: the specific Google one when the link can't be built, else the generic one for very long links. */
  const checkLinks = debounce(() => {
    const now = new Date();
    const msg = currentMessage(now);
    const google = msg.message !== '' && tooLongForGoogle(msg, now);
    const long = buildWhatsAppLink(msg.recipient.phone, msg.message).length > LONG_LINK_THRESHOLD;
    longWarning.textContent = long && !google ? ' · Very long messages may be cut off by some calendar apps.' : '';
    const note =
      'Too long for a Google Calendar link (you can still use the calendar file). Shorten it to use Google Calendar.';
    if (google && googleNote.textContent !== note) setChildren(googleNote, icon('warning', 18), h('span', null, note));
    else if (!google) googleNote.replaceChildren();
  }, LINK_CHECK_DELAY_MS);

  function draftValue(): Draft {
    const draft: Draft = {
      message: messageInput.value,
      start: when.get(),
      recurrence: repeat.get(),
      reminderMinutesBefore: reminderMinutes(),
    };
    const who = recipient.draftValue();
    if (who.recipient) draft.recipient = who.recipient;
    if (who.pending) draft.pendingRecipient = who.pending;
    return draft;
  }

  function apply(values: Draft): void {
    const now = new Date();
    const start = upcomingStart(values.start, now, timeZone);
    recipient.set(values.recipient, values.pendingRecipient);
    messageInput.value = values.message ?? '';
    when.set(start);
    const minutes = values.reminderMinutesBefore ?? settings.defaultReminderMinutesBefore;
    selectValue(reminderSelect, String(minutes), reminderLabel(minutes));
    repeat.set(values.recurrence ?? defaultRecurrence(), { start, timeZone, reminderMinutes: minutes });
    clearErrors();
    refresh();
    checkLinks.flush();
  }

  async function clearForm(): Promise<void> {
    if (messageInput.value.trim()) {
      const ok = await confirmDialog({
        title: 'Clear the form?',
        body: 'Your message, the recipient and the time you chose will be removed.',
        confirmLabel: 'Clear form',
        danger: true,
      });
      if (!ok) return;
    }
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
      // A 'date' error on a date the core accepts means the moment has passed: then the time is involved too. A date
      // out of range ("Check the year.") or missing concerns the date alone.
      const fields: ('date' | 'time')[] = [];
      if (byField.has('date')) fields.push('date');
      if (byField.has('time') || (byField.has('date') && isInRange(when.get().date))) fields.push('time');
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
    checkLinks.cancel();
    store.saveToHistory(msg);
    if (msg.recipient.phone) store.rememberContact({ name: msg.recipient.name, phone: msg.recipient.phone }, now);
    store.clearDraft();
    ctx.lastCreated = msg;
    const phoneWarning = 'recipient' in who ? who.warning : undefined;
    ctx.notice =
      warnings.length > 0 || phoneWarning
        ? { id: msg.id, warnings: warnings.map((w) => ({ field: w.field, message: w.message })), phoneWarning }
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
      checkLinks.cancel();
      window.removeEventListener('pagehide', flushDraft);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
