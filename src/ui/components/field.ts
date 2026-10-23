/** Labelled form fields with hint and error wiring (aria-describedby + aria-invalid). */

import { addIdRef, h, removeIdRef, uid } from '../dom';
import type { Child, Props } from '../dom';
import { icon } from '../icons';

export type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export interface ErrorSlot {
  readonly element: HTMLElement;
  /** Show `message`, link it to `targets` via aria-describedby and mark form controls aria-invalid. */
  show(message: string, targets: readonly HTMLElement[]): void;
  clear(): void;
}

/** Controls that may carry aria-invalid; buttons only get the description. */
const canBeInvalid = (el: HTMLElement): boolean =>
  el instanceof HTMLInputElement ||
  el instanceof HTMLSelectElement ||
  el instanceof HTMLTextAreaElement ||
  el.getAttribute('role') === 'radiogroup';

/** An inline error message. `live` announces it as it appears (for errors shown without moving focus). */
export function errorSlot(options: { live?: boolean } = {}): ErrorSlot {
  const id = uid('error');
  const element = h('p', { id, class: 'field-error', 'aria-live': options.live ? 'polite' : null });
  let linked: readonly HTMLElement[] = [];

  const clear = (): void => {
    for (const target of linked) {
      target.removeAttribute('aria-invalid');
      removeIdRef(target, 'aria-describedby', id);
    }
    linked = [];
    element.replaceChildren();
  };

  return {
    element,
    clear,
    show(message, targets) {
      clear();
      element.append(icon('error', 18), h('span', null, message));
      for (const target of targets) {
        if (canBeInvalid(target)) target.setAttribute('aria-invalid', 'true');
        addIdRef(target, 'aria-describedby', id);
      }
      linked = targets;
    },
  };
}

export interface Field {
  readonly element: HTMLElement;
  readonly label: HTMLLabelElement;
  readonly error: ErrorSlot;
  /** The h2 around the label when `heading` is set (for the card's aria-labelledby), else null. */
  readonly heading: HTMLHeadingElement | null;
}

export interface FieldOptions {
  label: Child | readonly Child[];
  control: Control;
  hint?: Child | readonly Child[];
  /** Extra class on the label. */
  labelClass?: string;
  /** The label doubles as the card's title: it is wrapped in an h2 so the card shows up in the heading outline. */
  heading?: boolean;
  liveError?: boolean;
}

/** label (in an h2 when `heading`), control, error, hint, in that order. */
export function field({ label, control, hint, labelClass, heading, liveError }: FieldOptions): Field {
  control.id ||= uid('field');
  const labelEl = h(
    'label',
    { for: control.id, class: labelClass ? `field-label ${labelClass}` : 'field-label' },
    label,
  );
  const headingEl = heading ? h('h2', { class: 'card-title field-heading', id: uid('heading') }, labelEl) : null;
  const error = errorSlot({ live: liveError ?? false });
  let hintEl: HTMLElement | null = null;
  if (hint) {
    hintEl = h('p', { id: uid('hint'), class: 'hint' }, hint);
    addIdRef(control, 'aria-describedby', hintEl.id);
  }
  return {
    element: h('div', { class: 'field' }, headingEl ?? labelEl, control, error.element, hintEl),
    label: labelEl,
    error,
    heading: headingEl,
  };
}

/** A <select> with the given options; `value` is selected, added as an extra option if unknown. */
export function selectControl(
  options: readonly { value: string; label: string }[],
  value: string,
  props: Props = {},
): HTMLSelectElement {
  const all = options.some((o) => o.value === value) ? options : [...options, { value, label: value }];
  return h('select', { ...props, value }, ...all.map((o) => h('option', { value: o.value }, o.label)));
}

/** Select `value`, adding an option with `label` first if the select does not offer it. */
export function selectValue(select: HTMLSelectElement, value: string, label: string): void {
  if (![...select.options].some((o) => o.value === value)) select.append(h('option', { value }, label));
  select.value = value;
}
