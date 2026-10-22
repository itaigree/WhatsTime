/**
 * The "To" card: Contact Picker, typed number, .vcf import, recent contacts,
 * or "I'll choose the chat in WhatsApp".
 */

import { formatPhoneForDisplay, normalizePhone } from '../../core/phone';
import type { PhoneResult } from '../../core/phone';
import type { Recipient, SavedContact } from '../../core/types';
import { parseVCards } from '../../core/vcard';
import type { VCardContact } from '../../core/vcard';
import { isContactPickerSupported, pickContact } from '../contacts';
import { h, setChildren, uid } from '../dom';
import { countryInfo } from '../format';
import { icon } from '../icons';
import { errorSlot, field } from './field';
import type { ErrorSlot } from './field';

const MAX_RECENTS = 6;
const MAX_LISTED_CONTACTS = 50;
const MAX_VCF_BYTES = 20 * 1024 * 1024;

interface NumberChoice {
  raw: string;
  label: string;
  result: PhoneResult;
}

/** A contact chosen from the picker, a .vcf, a recent chip or a restored draft. */
interface Selection {
  name: string;
  choices: NumberChoice[];
  /** Index into choices, or -1 while the user still has to pick one. */
  chosen: number;
}

export interface RecipientSection {
  readonly element: HTMLElement;
  /** Shows any problem inline; returns the recipient, or the element to focus. */
  validate(): { recipient: Recipient } | { invalid: HTMLElement };
  /** Show an error from the core validator; returns the element to focus. */
  showError(message: string): HTMLElement;
  clearErrors(): void;
  /** What the draft keeps: undefined until a usable recipient (or "choose in WhatsApp") is set. */
  draftValue(): Recipient | undefined;
  set(recipient: Recipient | undefined): void;
}

export interface RecipientOptions {
  defaultCountry: string;
  recentContacts: readonly SavedContact[];
  onChange: () => void;
}

/** Normalised numbers, deduplicated by their digits (contacts often list one number twice). */
function toChoices(phones: VCardContact['phones'], country: string): NumberChoice[] {
  const seen = new Set<string>();
  const choices: NumberChoice[] = [];
  for (const phone of phones) {
    const raw = phone.value.trim();
    if (!raw) continue;
    const result = normalizePhone(raw, country);
    const key = result.ok ? result.digits : raw;
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push({ raw, label: phone.label, result });
  }
  return choices;
}

function initial(name: string): string {
  return [...name.trim()][0]?.toLocaleUpperCase() ?? '';
}

function countryHint(country: string): (string | Node)[] {
  const info = countryInfo(country);
  const settingsLink = h('a', { href: '#/settings' }, 'Change in Settings');
  return info
    ? [`Numbers without a country code use +${info.callingCode} (${info.name}). `, settingsLink, '.']
    : ['Start with + and the country code, or set your country. ', settingsLink, '.'];
}

export function createRecipientSection(options: RecipientOptions): RecipientSection {
  const { defaultCountry, onChange } = options;
  const supported = isContactPickerSupported();
  let selection: Selection | null = null;
  let picking = false;
  let cardError: ErrorSlot | null = null;
  let cardFocusTarget: HTMLElement | null = null;
  /** The number radio group of the selected contact, when it has several numbers. */
  let groupRef: { group: HTMLElement; firstEnabled: HTMLInputElement | null } | null = null;

  // Chooser: built once so typed values survive switching to a selected contact and back.
  const chooserError = errorSlot({ live: true });
  const pickButton = supported
    ? h(
        'button',
        { type: 'button', class: 'btn btn-primary btn-block', onClick: () => void onPick() },
        icon('contacts'),
        'Choose from contacts',
      )
    : null;

  const nameInput = h('input', { type: 'text', dir: 'auto', autocomplete: 'off', enterkeyhint: 'next' });
  const phoneInput = h('input', {
    type: 'tel',
    inputmode: 'tel',
    autocomplete: 'tel',
    dir: 'ltr',
    enterkeyhint: 'next',
    onBlur: () => checkPhone(true),
    onInput: () => checkPhone(false),
  });
  const nameField = field({ label: 'Name (optional)', control: nameInput });
  const phoneField = field({
    label: 'Phone number',
    control: phoneInput,
    hint: countryHint(defaultCountry),
    liveError: true,
  });
  const phonePreview = h('p', { class: 'phone-preview', 'aria-live': 'polite' });
  phoneInput.after(phonePreview);
  const manualFields = h('div', { class: 'stack' }, phoneField.element, nameField.element);
  const manualDisclosure = supported
    ? h(
        'details',
        { class: 'disclosure' },
        h('summary', null, 'Enter a number'),
        h('div', { class: 'disclosure-body' }, manualFields),
      )
    : null;

  const fileInput = h('input', {
    type: 'file',
    accept: '.vcf,text/vcard,text/x-vcard',
    class: 'file-input visually-hidden',
    onChange: () => void onFile(),
  });
  fileInput.id = uid('vcf');
  const fileButton = h(
    'label',
    { for: fileInput.id, class: 'btn btn-secondary btn-block' },
    icon('upload'),
    'Import contact card (.vcf)',
  );
  const vcfError = errorSlot({ live: true });
  const vcfPicker = h('div', { class: 'vcf-picker', hidden: true });

  const recents = options.recentContacts.slice(0, MAX_RECENTS);
  const recentsTitleId = uid('recent');
  const recentsBlock =
    recents.length > 0
      ? h(
          'div',
          { class: 'recents' },
          h('p', { class: 'subhead', id: recentsTitleId }, 'Recent'),
          h(
            'div',
            { class: 'chips', role: 'group', 'aria-labelledby': recentsTitleId },
            recents.map((contact) =>
              h(
                'button',
                {
                  type: 'button',
                  class: 'chip',
                  onClick: () =>
                    selectContact({ name: contact.name, phones: [{ value: `+${contact.phone}`, label: '' }] }),
                },
                h('span', { dir: 'auto' }, contact.name || formatPhoneForDisplay(contact.phone)),
              ),
            ),
          ),
        )
      : null;

  const chooser = h(
    'div',
    { class: 'stack' },
    pickButton,
    chooserError.element,
    manualDisclosure ?? manualFields,
    supported ? null : h('p', { class: 'hint' }, 'Contact picker works in Chrome on Android.'),
    h('div', { class: 'file-field' }, fileInput, fileButton),
    vcfError.element,
    vcfPicker,
    recentsBlock,
  );

  const body = h('div', { class: 'recipient-body' });
  const chooseInApp = h('input', {
    type: 'checkbox',
    onChange: () => {
      clearErrors();
      render();
      onChange();
    },
  });
  const chooseInAppNote = h('p', { class: 'hint' }, 'When you tap the link, WhatsApp asks which chat to open.');
  const titleId = uid('to');
  const element = h(
    'section',
    { class: 'card', 'aria-labelledby': titleId },
    h('h2', { class: 'card-title', id: titleId }, 'To'),
    body,
    h('label', { class: 'check' }, chooseInApp, h('span', null, "I'll choose the chat in WhatsApp (e.g. a group)")),
    chooseInAppNote,
  );

  function render(): void {
    body.hidden = chooseInApp.checked;
    chooseInAppNote.hidden = !chooseInApp.checked;
    body.replaceChildren(selection ? renderSelection(selection) : chooser);
  }

  function renderSelection(sel: Selection): HTMLElement {
    cardError = errorSlot();
    const only = sel.choices.length === 1 ? sel.choices[0] : undefined;
    const display = only?.result.ok ? only.result.international : only?.raw;
    const primary = sel.name || display || 'No name';
    const secondary = sel.name ? display : undefined;
    const card = h('div', { class: 'contact-card' });
    const textId = uid('contact');
    const change = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-text',
        'aria-label': 'Change recipient',
        'aria-describedby': textId,
        onClick: () => {
          selection = null;
          clearErrors();
          render();
          onChange();
          (pickButton ?? phoneInput).focus();
        },
      },
      'Change',
    );
    card.append(
      h(
        'div',
        { class: 'contact-head' },
        h('span', { class: 'avatar', 'aria-hidden': 'true' }, initial(sel.name) || icon('person', 22)),
        h(
          'div',
          { class: 'contact-text', id: textId },
          h('p', { class: 'contact-name' }, h('span', { dir: sel.name ? 'auto' : 'ltr' }, primary)),
          secondary ? h('p', { class: 'contact-number', dir: 'ltr' }, secondary) : null,
        ),
        change,
      ),
    );
    cardFocusTarget = change;

    if (sel.choices.length > 1) {
      const groupName = uid('number');
      const radios: HTMLInputElement[] = [];
      const group = h(
        'fieldset',
        { class: 'choices', role: 'radiogroup' },
        h('legend', null, 'Which number?'),
        sel.choices.map((choice, index) => {
          const radio = h('input', {
            type: 'radio',
            name: groupName,
            value: String(index),
            checked: sel.chosen === index,
            disabled: !choice.result.ok,
            onChange: () => {
              sel.chosen = index;
              cardError?.clear();
              onChange();
            },
          });
          radios.push(radio);
          const detail = choice.result.ok
            ? [choice.label, choice.result.warning].filter(Boolean).join(' · ')
            : [choice.label, choice.result.error].filter(Boolean).join(' · ');
          return h(
            'label',
            { class: 'choice' },
            radio,
            h(
              'span',
              { class: 'choice-text' },
              h(
                'span',
                { class: 'choice-main', dir: 'ltr' },
                choice.result.ok ? choice.result.international : choice.raw,
              ),
              detail
                ? h('span', { class: choice.result.ok ? 'choice-detail' : 'choice-detail is-error' }, detail)
                : null,
            ),
          );
        }),
        cardError.element,
      );
      card.append(group);
      const firstEnabled = radios.find((radio) => !radio.disabled);
      if (sel.chosen < 0 && firstEnabled) cardFocusTarget = firstEnabled;
      groupRef = { group, firstEnabled: firstEnabled ?? null };
    } else {
      card.append(cardError.element);
      groupRef = null;
      if (only && !only.result.ok) cardError.show(`This number can't be used: ${only.result.error}`, [change]);
    }
    return card;
  }

  function selectContact(contact: VCardContact, moveFocus = true): void {
    clearErrors();
    const choices = toChoices(contact.phones, defaultCountry);
    if (choices.length === 0) {
      chooserError.show('This contact has no phone number.', pickButton ? [pickButton] : []);
      return;
    }
    const valid = choices.flatMap((choice, index) => (choice.result.ok ? [index] : []));
    selection = { name: contact.name.trim(), choices, chosen: valid.length === 1 ? (valid[0] ?? -1) : -1 };
    vcfPicker.hidden = true;
    vcfPicker.replaceChildren();
    render();
    onChange();
    if (moveFocus) cardFocusTarget?.focus();
  }

  async function onPick(): Promise<void> {
    if (picking) return;
    picking = true;
    chooserError.clear();
    try {
      const result = await pickContact();
      if (result.kind === 'picked') selectContact(result.contact);
      else if (result.kind === 'error') chooserError.show(result.message, pickButton ? [pickButton] : []);
    } finally {
      picking = false;
    }
  }

  async function onFile(): Promise<void> {
    const file = fileInput.files?.[0];
    if (!file) return;
    vcfError.clear();
    let contacts: VCardContact[] = [];
    try {
      if (file.size > MAX_VCF_BYTES) throw new RangeError('too large');
      contacts = parseVCards(await file.text());
    } catch {
      vcfError.show("Couldn't read that file.", [fileInput]);
      return;
    } finally {
      fileInput.value = '';
    }
    const [first] = contacts;
    if (!first) vcfError.show('No contacts with a phone number in that file.', [fileInput]);
    else if (contacts.length === 1) selectContact(first);
    else showContactList(contacts);
  }

  function showContactList(contacts: VCardContact[]): void {
    const search = h('input', { type: 'search', dir: 'auto', autocomplete: 'off', enterkeyhint: 'search' });
    const searchField = field({ label: `Search ${contacts.length} contacts`, control: search });
    const status = h('p', { class: 'hint', 'aria-live': 'polite' });
    const list = h('ul', { class: 'contact-list' });

    const update = (): void => {
      const query = search.value.trim().toLocaleLowerCase();
      const digits = query.replace(/\D/g, '');
      const matches = query
        ? contacts.filter(
            (c) =>
              c.name.toLocaleLowerCase().includes(query) ||
              (digits.length > 0 && c.phones.some((p) => p.value.replace(/\D/g, '').includes(digits))),
          )
        : contacts;
      const shown = matches.slice(0, MAX_LISTED_CONTACTS);
      list.replaceChildren(
        ...shown.map((contact) =>
          h(
            'li',
            null,
            h(
              'button',
              { type: 'button', class: 'contact-row', onClick: () => selectContact(contact) },
              h('span', { class: 'contact-row-name', dir: 'auto' }, contact.name || 'No name'),
              h('span', { class: 'contact-row-number', dir: 'ltr' }, contact.phones[0]?.value ?? ''),
            ),
          ),
        ),
      );
      status.textContent =
        matches.length === 0
          ? 'No matches.'
          : matches.length > shown.length
            ? `Showing ${shown.length} of ${matches.length}. Type to narrow it down.`
            : `${matches.length} ${matches.length === 1 ? 'contact' : 'contacts'}`;
    };
    search.addEventListener('input', update);

    const close = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-text',
        onClick: () => {
          vcfPicker.hidden = true;
          vcfPicker.replaceChildren();
          fileButton.focus();
        },
      },
      'Cancel',
    );
    vcfPicker.replaceChildren(
      h('div', { class: 'vcf-head' }, h('p', { class: 'subhead' }, 'Choose a contact from the file'), close),
      searchField.element,
      status,
      list,
    );
    vcfPicker.hidden = false;
    update();
    search.focus();
  }

  /** Live check of the typed number: errors appear on blur and clear as soon as the number is fixed. */
  function checkPhone(onBlur: boolean): PhoneResult | null {
    const value = phoneInput.value;
    if (!value.trim()) {
      phonePreview.replaceChildren();
      phoneField.error.clear();
      return null;
    }
    const result = normalizePhone(value, defaultCountry);
    if (result.ok) {
      phoneField.error.clear();
      setChildren(
        phonePreview,
        icon('check', 18),
        h('span', { class: 'visually-hidden' }, 'Number: '),
        h('span', { dir: 'ltr' }, result.international),
        result.warning ? h('span', { class: 'phone-warning' }, result.warning) : null,
      );
    } else {
      phonePreview.replaceChildren();
      if (onBlur || phoneInput.getAttribute('aria-invalid') === 'true')
        phoneField.error.show(result.error, [phoneInput]);
    }
    return result;
  }

  function clearErrors(): void {
    chooserError.clear();
    phoneField.error.clear();
    vcfError.clear();
    cardError?.clear();
  }

  function validate(): { recipient: Recipient } | { invalid: HTMLElement } {
    clearErrors();
    if (chooseInApp.checked) return { recipient: { name: '', phone: '' } };

    if (selection) {
      const choice = selection.choices[selection.chosen];
      if (choice?.result.ok) return { recipient: { name: selection.name, phone: choice.result.digits } };
      const target = groupRef?.firstEnabled ?? cardFocusTarget ?? element;
      if (groupRef?.firstEnabled) cardError?.show('Choose which number to use.', [groupRef.group]);
      else
        cardError?.show("This contact's number can't be used. Choose another contact or enter the number.", [target]);
      return { invalid: target };
    }

    if (phoneInput.value.trim()) {
      const result = checkPhone(true);
      if (result?.ok) return { recipient: { name: nameInput.value.trim(), phone: result.digits } };
      if (manualDisclosure) manualDisclosure.open = true;
      return { invalid: phoneInput };
    }

    if (pickButton) {
      chooserError.show('Choose a contact or enter a number.', [pickButton]);
      return { invalid: pickButton };
    }
    phoneField.error.show('Enter a phone number, or choose the chat in WhatsApp below.', [phoneInput]);
    return { invalid: phoneInput };
  }

  function showError(message: string): HTMLElement {
    if (selection && cardError) {
      const target = cardFocusTarget ?? element;
      cardError.show(message, [target]);
      return target;
    }
    if (manualDisclosure) manualDisclosure.open = true;
    phoneField.error.show(message, [phoneInput]);
    return phoneInput;
  }

  function draftValue(): Recipient | undefined {
    if (chooseInApp.checked) return { name: '', phone: '' };
    if (selection) {
      const choice = selection.choices[selection.chosen];
      return choice?.result.ok ? { name: selection.name, phone: choice.result.digits } : undefined;
    }
    if (!phoneInput.value.trim()) return undefined;
    const result = normalizePhone(phoneInput.value, defaultCountry);
    return result.ok ? { name: nameInput.value.trim(), phone: result.digits } : undefined;
  }

  function set(recipient: Recipient | undefined): void {
    selection = null;
    chooseInApp.checked = false;
    nameInput.value = '';
    phoneInput.value = '';
    phonePreview.replaceChildren();
    vcfPicker.hidden = true;
    vcfPicker.replaceChildren();
    if (manualDisclosure) manualDisclosure.open = false;
    clearErrors();
    if (recipient && !recipient.phone) chooseInApp.checked = true;
    if (recipient?.phone) {
      const value = /^\d+$/.test(recipient.phone) ? `+${recipient.phone}` : recipient.phone;
      selectContact({ name: recipient.name, phones: [{ value, label: '' }] }, false);
    }
    render();
  }

  render();
  return { element, validate, showError, clearErrors, draftValue, set };
}
