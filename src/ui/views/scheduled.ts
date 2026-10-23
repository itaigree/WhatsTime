/** '#/scheduled' — everything created on this device, upcoming first. */

import { messageSnippet } from '../../core/event';
import { describeRecurrence } from '../../core/recurrence';
import type { ScheduledMessage } from '../../core/types';
import { confirmDialog } from '../components/confirm';
import type { AppContext, View } from '../context';
import { h, uid } from '../dom';
import { dayTimeLabel, recipientLabel } from '../format';
import { icon } from '../icons';
import { nextReminder } from '../occurrence';
import type { NextReminder } from '../occurrence';
import { doneHref } from '../router';
import { openInCompose } from './compose';

const SNIPPET_LENGTH = 90;

interface Entry {
  msg: ScheduledMessage;
  /** The next reminder still ahead of now, or null when all have gone off. */
  next: NextReminder | null;
}

/** When the calendar next notifies: "Reminder: …" when that is before the message's time, else "Next: …". */
function nextLabel(msg: ScheduledMessage, next: NextReminder): string {
  return msg.reminderMinutesBefore > 0
    ? `Reminder: ${dayTimeLabel(next.reminder)}`
    : `Next: ${dayTimeLabel(next.event)}`;
}

/** Upcoming by next reminder, then done ones newest first. */
function sortEntries(entries: Entry[]): Entry[] {
  const upcoming = entries.filter((e) => e.next).sort((a, b) => (a.next?.at ?? 0) - (b.next?.at ?? 0));
  const done = entries.filter((e) => !e.next);
  return [...upcoming, ...done];
}

export function scheduledView(ctx: AppContext): View {
  const heading = h('h1', { tabindex: -1 }, 'Scheduled');
  const content = h('div', null);
  const element = h('div', { class: 'view' }, heading, content);

  async function deleteItem(msg: ScheduledMessage): Promise<void> {
    const ok = await confirmDialog({
      title: `Delete the reminder for ${recipientLabel(msg.recipient)}?`,
      body: 'It is removed from this list only. If you added it to your calendar, delete it there too.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    ctx.store.deleteFromHistory(msg.id);
    render();
    ctx.announce('Deleted from the list');
    heading.focus();
  }

  function renderItem({ msg, next }: Entry): HTMLElement {
    const titleId = uid('item');
    const repeating = msg.recurrence.frequency !== 'none';
    return h(
      'li',
      { class: next ? 'card item' : 'card item is-done' },
      h(
        'div',
        { class: 'item-head' },
        // The ellipsis sits on the dir=auto element itself, so a Hebrew title is cut at its end (on the left).
        h(
          'h2',
          { class: 'item-title', id: titleId },
          h('span', { class: 'truncate', dir: 'auto' }, recipientLabel(msg.recipient)),
        ),
        next
          ? h('span', { class: 'pill' }, nextLabel(msg, next))
          : h('span', { class: 'pill pill-done' }, 'Done'),
      ),
      h('p', { class: 'item-message', dir: 'auto' }, messageSnippet(msg.message, SNIPPET_LENGTH)),
      h(
        'p',
        { class: 'item-meta' },
        icon(repeating ? 'repeat' : 'clock', 16),
        h('span', null, describeRecurrence(msg.recurrence, msg.start.date)),
      ),
      h(
        'div',
        { class: 'item-actions' },
        h(
          'a',
          { class: 'btn btn-secondary btn-small', href: doneHref(msg.id), 'aria-describedby': titleId },
          icon('info', 18),
          'Details',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-secondary btn-small',
            'aria-describedby': titleId,
            onClick: () => void openInCompose(ctx, msg),
          },
          icon('edit', 18),
          'Reuse',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-text btn-small btn-danger',
            'aria-describedby': titleId,
            onClick: () => void deleteItem(msg),
          },
          icon('trash', 18),
          'Delete',
        ),
      ),
    );
  }

  function render(): void {
    const now = new Date();
    const entries = sortEntries(ctx.store.listHistory().map((msg) => ({ msg, next: nextReminder(msg, now) })));
    if (entries.length === 0) {
      content.replaceChildren(
        h(
          'section',
          { class: 'card empty' },
          h('span', { class: 'empty-icon' }, icon('bell', 28)),
          h('p', { class: 'strong' }, 'Nothing scheduled yet'),
          h('p', { class: 'muted' }, 'Reminders you create on this device show up here.'),
          h('a', { class: 'btn btn-primary', href: '#/' }, icon('add'), 'Schedule a message'),
        ),
      );
      return;
    }
    const upcoming = entries.filter((e) => e.next).length;
    const done = entries.length - upcoming;
    const counts = [upcoming > 0 && `${upcoming} upcoming`, done > 0 && `${done} done`].filter(Boolean).join(' · ');
    content.replaceChildren(
      h('p', { class: 'lead' }, `${counts}. Deleting one here doesn't remove it from your calendar.`),
      h('ul', { class: 'item-list' }, entries.map(renderItem)),
    );
  }

  render();
  return { title: 'Scheduled', element, heading };
}
