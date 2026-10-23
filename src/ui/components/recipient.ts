/**
 * The "To" card: Contact Picker, typed number, .vcf import, recent contacts,
 * or "I'll choose the chat in WhatsApp".
 */

import { normalizePhone } from '../../core/phone';
import type { PhoneResult } from '../../core/phone';
import type { PendingRecipient, Recipient, SavedContact } from '../../core/types';
import { parseVCards } from '../../core/vcard';
import type { VCardContact } from '../../core/vcard';
import { isContactPickerSupported, pickContact } from '../contacts';
import { h, setChildren, uid } from '../dom';
import { countryInfo, recipientLabel } from '../format';
import { icon } from '../icons';
import { errorSlot, field } from './field';
import type { ErrorSlot } from './field';

const MAX_RECENTS = 6;
const MAX_LISTED_CONTACTS = 50;
const MAX_VCF_BYTES = 20 * 1024 * 1024;
/** What the store keeps of an unresolved recipient (longer values are not stored). */
const MAX_PENDING_PHONES = 20;
const MAX_PENDING_TEXT = 200;
/** vCard labels of mobile numbers (the Contact Picker gives none). */
const MOBILE_LABEL = /^(mobile|cell|cellular|iphone|mobil|handy)\b/i;
/** The core's remedy for a local number that only fits another country, which a picked contact can't follow. */
const ADD_ITS_COUNTRY_CODE = /\s*Add its country code \(start with \+\)\.$/;
const ADD_THE_COUNTRY_CODE = /^Add the country code \(start with \+\), or choose your country first\.$/;
/** Errors a different default country could fix. */
const COUNTRY_ERROR = /another country|country code/i;

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

/** What the draft keeps: a usable recipient (or "choose in WhatsApp"), else the input that is not resolved yet. */
export interface RecipientDraft {
  recipient?: Recipient;
  pending?: PendingRecipient;
}

export interface RecipientSection {
  readonly element: HTMLElement;
  /** Shows any problem inline; returns the recipient (with any doubt about its number), or the element to focus. */
  validate(): { recipient: Recipient; warning?: string } | { invalid: HTMLElement };
  /** Show an error from the core validator; returns the element to focus. */
  showError(message: string): HTMLElement;
  clearErrors(): void;
  draftValue(): RecipientDraft;
  /** Restore a recipient, or unresolved input (read again with the current default country). */
  set(recipient: Recipient | undefined, pending?: PendingRecipient): void;
}

export interface RecentContacts {
  list(): readonly SavedContact[];
  forget(contact: SavedContact): void;
}

export interface RecipientOptions {
  defaultCountry: string;
  /** Other countries a number without a country code may be meant for, offered as "Read as …" (see context.ts). */
  alternatives: readonly string[];
  /** Shown as chips, each with a remove button. */
  recents: RecentContacts;
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
    ? [`Numbers without a country code are read as +${info.callingCode} (${info.name}). `, settingsLink, '.']
    : ['Start with + and the country code, or set your country. ', settingsLink, '.'];
}

/** Written without a country code, so the default country decided how the number reads. */
const lacksCountryCode = (raw: string): boolean => !raw.includes('+');

/** Unusable, or usable with a warning. */
const isDoubtful = (choice: NumberChoice): boolean => !choice.result.ok || choice.result.warning !== undefined;

/** A doubtful number whose problem comes from the default country (not, say, a number that is too short). */
const isCountryDependent = (choice: NumberChoice): boolean =>
  lacksCountryCode(choice.raw) &&
  (choice.result.ok ? choice.result.warning !== undefined : COUNTRY_ERROR.test(choice.result.error));

/**
 * The core error, with a remedy a picked contact can follow (its number can't be edited here). `remedy` false keeps
 * only the reason, for places where the remedy is shown once below.
 */
function contactError(error: string, remedy: false | { readAs: boolean }): string {
  if (ADD_ITS_COUNTRY_CODE.test(error)) {
    if (!remedy) return error.replace(ADD_ITS_COUNTRY_CODE, '');
    const fix = remedy.readAs
      ? "Change the default country in Settings or use 'Read as …' below."
      : 'Change the default country in Settings.';
    return error.replace(ADD_ITS_COUNTRY_CODE, ` ${fix}`);
  }
  if (ADD_THE_COUNTRY_CODE.test(error)) {
    return remedy ? 'It has no country code. Choose your country in Settings.' : 'It has no country code.';
  }
  return error;
}

/** A usable number that is clearly a mobile one: labelled so, or an Israeli 05x number. */
function isMobile(choice: NumberChoice): boolean {
  if (!choice.result.ok || choice.result.warning) return false;
  return MOBILE_LABEL.test(choice.label.trim()) || choice.result.digits.startsWith('9725');
}

/** The number to preselect: the only usable one, else the only clearly mobile one; -1 to let the user choose. */
function preselect(choices: readonly NumberChoice[]): number {
  const usable = choices.flatMap((choice, index) => (choice.result.ok ? [index] : []));
  if (usable.length === 1) return usable[0] ?? -1;
  const mobiles = usable.filter((index) => {
    const choice = choices[index];
    return choice !== undefined && isMobile(choice);
  });
  return mobiles.length === 1 ? (mobiles[0] ?? -1) : -1;
}

/**
 * The choices with each doubtful number that has no country code read in `country` instead, where that gives a
 * clean reading of a different number; null when it improves none of them.
 */
function rereadChoices(choices: readonly NumberChoice[], country: string): NumberChoice[] | null {
  const seen = new Set(choices.flatMap((c) => (c.result.ok && !c.result.warning ? [c.result.digits] : [])));
  let improved = false;
  const next: NumberChoice[] = [];
  for (const choice of choices) {
    const result = isDoubtful(choice) && lacksCountryCode(choice.raw) ? normalizePhone(choice.raw, country) : null;
    const differs = result?.ok && !result.warning && (!choice.result.ok || choice.result.digits !== result.digits);
    if (!result?.ok || !differs) {
      next.push(choice);
    } else if (!seen.has(result.digits)) {
      // (A number already listed with its country code is dropped instead of shown twice.)
      seen.add(result.digits);
      improved = true;
      next.push({ ...choice, result });
    }
  }
  return improved ? next : null;
}

/** Why the selected contact cannot be used, or null when one of its numbers can. */
function selectionProblem(sel: Selection, readAs: boolean): string | null {
  if (sel.choices.some((choice) => choice.result.ok)) return null;
  const [only] = sel.choices;
  return sel.choices.length === 1 && only && !only.result.ok
    ? `This number can't be used: ${contactError(only.result.error, { readAs })}`
    : 'None of these numbers can be used. Choose another contact or enter the number.';
}

/** At most `max` UTF-16 units, without splitting a character. */
function clip(text: string, max: number): string {
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/** How a number is kept while the contact is unresolved: a clean reading as is, a doubtful one as written. */
function pendingPhone(choice: NumberChoice): string {
  return choice.result.ok && !choice.result.warning ? `+${choice.result.digits}` : choice.raw;
}

interface Alternative {
  label: string;
  choices: NumberChoice[];
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

  const recentsTitleId = uid('recent');
  const recentChips = h('div', { class: 'chips', role: 'group', 'aria-labelledby': recentsTitleId });
  const recentsBlock = h(
    'div',
    { class: 'recents' },
    h('p', { class: 'subhead', id: recentsTitleId }, 'Recent'),
    recentChips,
  );

  /** (Re)builds the chips from storage; returns their remove buttons in order. */
  function renderRecents(): HTMLButtonElement[] {
    const recents = options.recents.list().slice(0, MAX_RECENTS);
    const removeButtons: HTMLButtonElement[] = [];
    recentsBlock.hidden = recents.length === 0;
    recentChips.replaceChildren(
      ...recents.map((contact, index) => {
        const label = recipientLabel(contact);
        const remove = h(
          'button',
          {
            type: 'button',
            class: 'chip-remove',
            'aria-label': `Remove ${label} from recent contacts`,
            onClick: () => forgetRecent(contact, index),
          },
          icon('close', 18),
        );
        removeButtons.push(remove);
        return h(
          'span',
          { class: 'recent-chip' },
          h(
            'button',
            {
              type: 'button',
              class: 'chip-select',
              onClick: () => selectContact({ name: contact.name, phones: [{ value: `+${contact.phone}`, label: '' }] }),
            },
            h('span', { dir: 'auto' }, label),
          ),
          remove,
        );
      }),
    );
    return removeButtons;
  }

  function forgetRecent(contact: SavedContact, index: number): void {
    options.recents.forget(contact);
    const removeButtons = renderRecents();
    // Stay in the list (next chip, else the previous one) so several can be removed in a row.
    (removeButtons[index] ?? removeButtons[index - 1] ?? pickButton ?? phoneInput).focus();
  }
  renderRecents();

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

  /** One-tap re-readings of the selection in the alternative countries that improve it. */
  function alternativesFor(sel: Selection): Alternative[] {
    return options.alternatives.flatMap((country) => {
      const info = countryInfo(country);
      const choices = info ? rereadChoices(sel.choices, country) : null;
      return info && choices ? [{ label: `Read as ${info.name} (+${info.callingCode})`, choices }] : [];
    });
  }

  function renderSelection(sel: Selection): HTMLElement {
    cardError = errorSlot();
    const alternatives = alternativesFor(sel);
    const only = sel.choices.length === 1 ? sel.choices[0] : undefined;
    const display = only?.result.ok ? only.result.international : only?.raw;
    const warning = only?.result.ok ? only.result.warning : undefined;
    const primary = sel.name || display || 'No name';
    const secondary = sel.name ? display : undefined;
    const card = h('div', { class: 'contact-card' });
    const textId = uid('contact');
    const warningId = uid('contact-warning');
    const change = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-text',
        'aria-label': 'Change recipient',
        'aria-describedby': warning ? `${textId} ${warningId}` : textId,
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
          // The ellipsis sits on the dir=auto element itself, so a Hebrew name is cut at its end (on the left).
          h('p', { class: 'contact-name' }, h('span', { class: 'truncate', dir: sel.name ? 'auto' : 'ltr' }, primary)),
          secondary ? h('p', { class: 'contact-number phone', dir: 'ltr' }, secondary) : null,
        ),
        change,
      ),
    );
    // A doubtful reading is used, so say so under the number.
    if (warning) {
      card.append(h('p', { class: 'inline-warning', id: warningId }, icon('warning', 18), h('span', null, warning)));
    }
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
            : [choice.label, contactError(choice.result.error, false)].filter(Boolean).join(' · ');
          return h(
            'label',
            { class: 'choice' },
            radio,
            h(
              'span',
              { class: 'choice-text' },
              h(
                'span',
                { class: 'choice-main phone', dir: 'ltr' },
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
      // Focus the preselected number (so it is heard, and easy to change), else the first one to choose from.
      const checked = radios[sel.chosen];
      if (checked && !checked.disabled) cardFocusTarget = checked;
      else if (firstEnabled) cardFocusTarget = firstEnabled;
      groupRef = { group, firstEnabled: firstEnabled ?? null };
    } else {
      card.append(cardError.element);
      groupRef = null;
      const problem = selectionProblem(sel, alternatives.length > 0);
      if (problem) cardError.show(problem, [change]);
    }
    const fix = countryFix(sel, alternatives);
    if (fix) card.append(fix);
    return card;
  }

  /**
   * Under numbers whose trouble comes from the default country, or that another likely country reads cleanly: which
   * country is used, a link to change it, and a one-tap re-read in each country that gives clean readings.
   */
  function countryFix(sel: Selection, alternatives: readonly Alternative[]): HTMLElement | null {
    if (alternatives.length === 0 && !sel.choices.some(isCountryDependent)) return null;
    return h(
      'div',
      { class: 'country-fix' },
      h('p', { class: 'hint' }, countryHint(defaultCountry)),
      alternatives.length > 0
        ? h(
            'div',
            { class: 'button-row' },
            alternatives.map((alt) =>
              h(
                'button',
                { type: 'button', class: 'btn btn-secondary btn-small', onClick: () => useChoices(sel, alt.choices) },
                alt.label,
              ),
            ),
          )
        : null,
    );
  }

  /** Swap in re-read numbers, keeping the chosen one when it is still there. */
  function useChoices(sel: Selection, choices: NumberChoice[]): void {
    const before = sel.choices[sel.chosen]?.result;
    const chosenDigits = before?.ok && !before.warning ? before.digits : undefined;
    const kept = choices.findIndex((choice) => choice.result.ok && choice.result.digits === chosenDigits);
    sel.choices = choices;
    sel.chosen = kept >= 0 ? kept : preselect(choices);
    clearErrors();
    render();
    onChange();
    cardFocusTarget?.focus();
  }

  function selectContact(contact: VCardContact, moveFocus = true): void {
    clearErrors();
    const choices = toChoices(contact.phones, defaultCountry);
    if (choices.length === 0) {
      chooserError.show('This contact has no phone number.', pickButton ? [pickButton] : []);
      return;
    }
    selection = { name: contact.name.trim(), choices, chosen: preselect(choices) };
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
              h('span', { class: 'contact-row-number phone', dir: 'ltr' }, contact.phones[0]?.value ?? ''),
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
    // While the list is open the submit bar stops being sticky (styles.css), and the page is the only scroller.
    search.focus({ preventScroll: true });
    vcfPicker.scrollIntoView({ block: 'start' });
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
      // "Choose a contact or enter a number." no longer applies.
      chooserError.clear();
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

  function validate(): { recipient: Recipient; warning?: string } | { invalid: HTMLElement } {
    clearErrors();
    if (chooseInApp.checked) return { recipient: { name: '', phone: '' } };

    if (selection) {
      const choice = selection.choices[selection.chosen];
      if (choice?.result.ok) {
        return { recipient: { name: selection.name, phone: choice.result.digits }, warning: choice.result.warning };
      }
      if (groupRef?.firstEnabled) {
        cardError?.show('Choose which number to use.', [groupRef.group]);
        return { invalid: groupRef.firstEnabled };
      }
      // Keep the specific reason (and the country hint below it) rather than a generic message.
      const target = cardFocusTarget ?? element;
      const readAs = alternativesFor(selection).length > 0;
      cardError?.show(selectionProblem(selection, readAs) ?? "This contact's number can't be used.", [target]);
      return { invalid: target };
    }

    if (phoneInput.value.trim()) {
      const result = checkPhone(true);
      if (result?.ok) {
        return { recipient: { name: nameInput.value.trim(), phone: result.digits }, warning: result.warning };
      }
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

  function draftValue(): RecipientDraft {
    if (chooseInApp.checked) return { recipient: { name: '', phone: '' } };
    if (selection) {
      const choice = selection.choices[selection.chosen];
      if (choice?.result.ok) return { recipient: { name: selection.name, phone: choice.result.digits } };
      // Not usable yet (no number chosen, or the default country reads it badly): keep it to resolve later.
      const phones = selection.choices.map(pendingPhone).filter((phone) => phone.length <= MAX_PENDING_TEXT);
      return phones.length > 0
        ? {
            pending: {
              name: clip(selection.name, MAX_PENDING_TEXT),
              phones: phones.slice(0, MAX_PENDING_PHONES),
              source: 'contact',
            },
          }
        : {};
    }
    const typed = phoneInput.value;
    if (!typed.trim()) return {};
    const result = normalizePhone(typed, defaultCountry);
    if (result.ok) return { recipient: { name: nameInput.value.trim(), phone: result.digits } };
    return typed.length <= MAX_PENDING_TEXT
      ? { pending: { name: clip(nameInput.value.trim(), MAX_PENDING_TEXT), phones: [typed], source: 'typed' } }
      : {};
  }

  function set(recipient: Recipient | undefined, pending?: PendingRecipient): void {
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
    } else if (!recipient && pending?.source === 'contact') {
      // Read again with the current default country: after a trip to Settings the contact may now be usable.
      selectContact({ name: pending.name, phones: pending.phones.map((value) => ({ value, label: '' })) }, false);
    } else if (!recipient && pending?.source === 'typed') {
      phoneInput.value = pending.phones[0] ?? '';
      nameInput.value = pending.name;
      if (manualDisclosure) manualDisclosure.open = true;
      checkPhone(true);
    }
    render();
  }

  render();
  return { element, validate, showError, clearErrors, draftValue, set };
}
