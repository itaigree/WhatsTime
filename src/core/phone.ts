/**
 * Phone number normalisation for wa.me links, built on libphonenumber-js
 * (min metadata). Pure: callers pass navigator.languages / time zone in.
 */

import {
  getCountries,
  getCountryCallingCode,
  isSupportedCountry,
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
} from 'libphonenumber-js/min';
import type { CountryCode, PhoneNumber } from 'libphonenumber-js/min';

export type PhoneResult =
  | { ok: true; digits: string; international: string; warning?: string }
  | { ok: false; error: string };

const ERRORS = {
  empty: 'Enter a phone number.',
  notANumber: "This doesn't look like a phone number.",
  letters: "Phone numbers can't contain letters.",
  extension: 'Remove the extension; WhatsApp needs the main number only.',
  serviceCode: "Numbers with * or # can't be used.",
  plusPosition: 'Put the + only at the start of the number.',
  needCountryCode: 'Add the country code (start with +), or choose your country first.',
  foreignLocal: 'This looks like a number from another country. Add its country code (start with +).',
  unknownCountryCode: 'Unknown country code. Check the digits after the +.',
  tooShort: 'This number is too short.',
  tooLong: 'This number is too long.',
  invalid: 'This is not a valid phone number.',
} as const;

const WARNINGS = {
  unverified: "This number doesn't match the known numbering plan; double-check it.",
  readAsInternational: 'Read as an international number; check the country code.',
} as const;

const fail = (error: string): PhoneResult => ({ ok: false, error });

/** Zero code points of non-ASCII decimal digit sets seen in contacts (Arabic-Indic, Extended Arabic-Indic, Devanagari). */
const DIGIT_ZEROS = [0x0660, 0x06f0, 0x0966];
const NON_ASCII_DIGIT = /[\u0660-\u0669\u06F0-\u06F9\u0966-\u096F]/g;
/** Bidi marks/embeddings/isolates, zero-width chars, BOM, soft hyphen, Arabic letter mark. */
const INVISIBLE = /\p{Cf}/gu;
/** Whitespace (incl. NBSP and thin spaces), dashes, dots, slashes and brackets. */
const SEPARATORS = /[\s.\-/\\()[\]~\u2010-\u2015\u2212\u30FC]/g;
/** `(?::\s*)?` rather than `:?\s*`: two adjacent `\s*` backtrack quadratically on long runs of spaces. */
const EXTENSION = /\d[^\d\p{L}]*(?:ext(?:ension|n)?\.?|x)\s*(?::\s*)?\d+\s*$/iu;

function toAsciiDigits(value: string): string {
  return value.replace(NON_ASCII_DIGIT, (ch) => {
    const cp = ch.charCodeAt(0);
    const zero = DIGIT_ZEROS.find((z) => cp >= z && cp <= z + 9);
    return zero === undefined ? ch : String(cp - zero);
  });
}

/** A number followed by 'ext 12' / 'x12' and no other letters. */
function isExtension(text: string): boolean {
  const match = EXTENSION.exec(text);
  return match !== null && !/\p{L}/u.test(text.slice(0, match.index));
}

/** Strip decoration and return '+digits' / 'digits', or an error for disallowed content. */
function compactInput(input: string): { ok: true; value: string } | { ok: false; error: string } {
  const text = toAsciiDigits(String(input ?? '').normalize('NFKC'))
    .replace(INVISIBLE, '')
    .trim()
    .replace(/^tel:(?:\/\/)?/i, '');
  if (!text.trim()) return { ok: false, error: ERRORS.empty };
  if (/[*#]/.test(text)) return { ok: false, error: ERRORS.serviceCode };
  if (/[,;]/.test(text) || isExtension(text)) return { ok: false, error: ERRORS.extension };
  if (/\p{L}/u.test(text)) return { ok: false, error: ERRORS.letters };
  const value = text.replace(SEPARATORS, '');
  if (/^\+?\d+$/.test(value)) return { ok: true, value };
  if (/^[+\d]+$/.test(value) && /\d/.test(value)) return { ok: false, error: ERRORS.plusPosition };
  return { ok: false, error: ERRORS.notANumber };
}

function toSupportedCountry(code: string): CountryCode | undefined {
  const upper = String(code ?? '').trim().toUpperCase();
  return isSupportedCountry(upper) ? upper : undefined;
}

function safeParse(text: string, country?: CountryCode): PhoneNumber | undefined {
  try {
    return parsePhoneNumberFromString(text, country);
  } catch {
    return undefined;
  }
}

function lengthError(text: string, country?: CountryCode): string {
  switch (validatePhoneNumberLength(text, country)) {
    case 'TOO_SHORT':
      return ERRORS.tooShort;
    case 'TOO_LONG':
      return ERRORS.tooLong;
    case 'INVALID_COUNTRY':
      return text.startsWith('+') ? ERRORS.unknownCountryCode : ERRORS.invalid;
    default:
      return ERRORS.invalid;
  }
}

/**
 * International format that keeps the national grouping punctuation, like Google's libphonenumber:
 * '+972 50-123-4567'. Falls back to libphonenumber-js's space-separated form when the national
 * format is not simply national prefix + national number (e.g. Argentina's mobile '15').
 */
function formatInternational(number: PhoneNumber): string {
  const national = number.formatNational();
  const nationalDigits = national.replace(/\D/g, '');
  if (!nationalDigits.endsWith(number.nationalNumber)) return number.formatInternational();
  let prefixDigits = nationalDigits.length - number.nationalNumber.length;
  let start = 0;
  while (prefixDigits > 0 && start < national.length) {
    if (/\d/.test(national.charAt(start))) prefixDigits--;
    start++;
  }
  const grouped = national
    .slice(start)
    .replace(/[()]/g, ' ')
    .replace(/^[\s\-./]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `+${number.countryCallingCode} ${grouped}`;
}

interface Reading {
  result: PhoneResult;
  valid: boolean;
  /** A national number format applied (min metadata only checks a coarse per-country pattern for validity). */
  formatted: boolean;
}

const failed = (error: string): Reading => ({ result: fail(error), valid: false, formatted: false });

/**
 * NANP numbers are NXX-NXX-XXXX: area and exchange codes never start with 0 or 1. This is the structure of the
 * numbering plan, not metadata that can go stale (new area codes still follow it), so it is safe to enforce.
 */
function isImpossibleNanp(number: PhoneNumber): boolean {
  return number.countryCallingCode === '1' && number.nationalNumber.length === 10 && !/^[2-9]\d\d[2-9]/.test(number.nationalNumber);
}

/** Mexico dropped the mobile '1' after +52 in 2019, but old contacts still store '+52 1 55 1234 5678'. */
function withoutLegacyMexicanMobileOne(number: PhoneNumber | undefined): PhoneNumber | undefined {
  if (number?.countryCallingCode !== '52' || number.isPossible() || !/^1\d{10}$/.test(number.nationalNumber)) return number;
  return safeParse(`+52${number.nationalNumber.slice(1)}`) ?? number;
}

function read(text: string, country?: CountryCode): Reading {
  const parsed = withoutLegacyMexicanMobileOne(safeParse(text, country));
  if (!parsed || !parsed.isPossible()) return failed(lengthError(text, country));
  const valid = parsed.isValid();
  // A leading 0 the default country did not strip as its trunk prefix (US, GR, ES, RU '8 0…', …) is another
  // country's local format, e.g. Israeli '050-123-4567' read with a US default. Valid numbers (Italy's '06…')
  // pass, and the user can still force an unknown number by writing it with '+'.
  const domestic = country !== undefined && parsed.countryCallingCode === getCountryCallingCode(country);
  if (domestic && !valid && parsed.nationalNumber.startsWith('0')) return failed(ERRORS.foreignLocal);
  if (isImpossibleNanp(parsed)) return failed(ERRORS.invalid);
  const formatted = /\D/.test(parsed.formatNational());
  const result = { ok: true as const, digits: parsed.number.slice(1), international: formatInternational(parsed) };
  if (valid) return { result, valid, formatted };
  return { result: { ...result, warning: WARNINGS.unverified }, valid, formatted };
}

/** Digits that fail for the default country may still be a complete international number (e.g. copied from wa.me). */
function readAsInternational(digits: string): Reading {
  const reading = digits.startsWith('0') ? undefined : read(`+${digits}`);
  if (!reading?.valid || !reading.result.ok) return failed(ERRORS.invalid);
  return { ...reading, result: { ...reading.result, warning: WARNINGS.readAsInternational } };
}

/**
 * Normalise any user/contact-supplied phone string to wa.me digits ('972501234567').
 * Without '+', the number is read in `defaultCountry`; a leading '00' or digits that only fit as an
 * international number are tried too, preferring a reading that is valid over one that is merely possible.
 */
export function normalizePhone(input: string, defaultCountry: string): PhoneResult {
  const compact = compactInput(input);
  if (!compact.ok) return compact;
  const { value } = compact;
  if (value.startsWith('+')) return read(value).result;

  const country = toSupportedCountry(defaultCountry);
  const idd = value.startsWith('00') ? `+${value.slice(2)}` : undefined;
  if (!country) return idd ? read(idd).result : fail(ERRORS.needCountryCode);

  const national = read(value, country);
  const international = idd ? read(idd) : readAsInternational(value);
  // A valid international reading wins over a valid national one when the input starts with '00' (JP, KR and ID
  // also have national service numbers starting 00, which WhatsApp cannot reach), or when the national reading fits
  // no national number format: min metadata validates most countries against one coarse pattern only, so Israel
  // "accepts" '1 212 555 0123' as '+972 12125550123' although no Israeli number looks like that.
  const internationalFirst = international.valid && (idd !== undefined || !national.formatted);
  const readings = internationalFirst ? [international, national] : [national, international];
  const best = readings.find((r) => r.valid) ?? readings.find((r) => r.result.ok) ?? national;
  return best.result;
}

const TIME_ZONE_REGIONS: Record<string, readonly string[]> = {
  IL: ['Asia/Jerusalem', 'Asia/Tel_Aviv', 'Israel'],
  GB: ['Europe/London', 'Europe/Belfast', 'GB'],
  US: [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix',
    'America/Anchorage', 'America/Detroit', 'America/Indiana/Indianapolis', 'America/Boise', 'Pacific/Honolulu',
    'US/Eastern', 'US/Central', 'US/Mountain', 'US/Pacific',
  ],
  CA: ['America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'America/Halifax', 'America/St_Johns'],
  DE: ['Europe/Berlin'],
  FR: ['Europe/Paris'],
  ES: ['Europe/Madrid', 'Atlantic/Canary'],
  IT: ['Europe/Rome'],
  NL: ['Europe/Amsterdam'],
  BE: ['Europe/Brussels'],
  CH: ['Europe/Zurich'],
  AT: ['Europe/Vienna'],
  PT: ['Europe/Lisbon'],
  IE: ['Europe/Dublin'],
  SE: ['Europe/Stockholm'],
  NO: ['Europe/Oslo'],
  DK: ['Europe/Copenhagen'],
  FI: ['Europe/Helsinki'],
  PL: ['Europe/Warsaw'],
  CZ: ['Europe/Prague'],
  HU: ['Europe/Budapest'],
  RO: ['Europe/Bucharest'],
  GR: ['Europe/Athens'],
  UA: ['Europe/Kyiv', 'Europe/Kiev'],
  RU: ['Europe/Moscow'],
  TR: ['Europe/Istanbul', 'Asia/Istanbul'],
  IN: ['Asia/Kolkata', 'Asia/Calcutta'],
  AE: ['Asia/Dubai'],
  SA: ['Asia/Riyadh'],
  JO: ['Asia/Amman'],
  LB: ['Asia/Beirut'],
  PS: ['Asia/Gaza', 'Asia/Hebron'],
  EG: ['Africa/Cairo'],
  ZA: ['Africa/Johannesburg'],
  NG: ['Africa/Lagos'],
  KE: ['Africa/Nairobi'],
  MA: ['Africa/Casablanca'],
  PK: ['Asia/Karachi'],
  BD: ['Asia/Dhaka'],
  CN: ['Asia/Shanghai'],
  HK: ['Asia/Hong_Kong'],
  TW: ['Asia/Taipei'],
  JP: ['Asia/Tokyo'],
  KR: ['Asia/Seoul'],
  SG: ['Asia/Singapore'],
  MY: ['Asia/Kuala_Lumpur'],
  TH: ['Asia/Bangkok'],
  VN: ['Asia/Ho_Chi_Minh', 'Asia/Saigon'],
  ID: ['Asia/Jakarta'],
  PH: ['Asia/Manila'],
  AU: ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Perth', 'Australia/Adelaide'],
  NZ: ['Pacific/Auckland'],
  BR: ['America/Sao_Paulo'],
  AR: ['America/Argentina/Buenos_Aires', 'America/Buenos_Aires'],
  MX: ['America/Mexico_City'],
  CO: ['America/Bogota'],
  PE: ['America/Lima'],
  CL: ['America/Santiago'],
};

const ZONE_TO_REGION = new Map(
  Object.entries(TIME_ZONE_REGIONS).flatMap(([region, zones]) => zones.map((zone) => [zone, region] as const)),
);

/** Region subtag of a language tag ('he-IL' -> 'IL'); with `likely`, also the inferred region ('he' -> 'IL'). */
function regionOf(tag: string, likely: boolean): CountryCode | undefined {
  try {
    const locale = new Intl.Locale(String(tag ?? '').trim().replace(/_/g, '-'));
    const region = (likely ? locale.maximize() : locale).region;
    return region ? toSupportedCountry(region) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-guess ISO region from navigator.languages (e.g. ['he-IL'] -> 'IL') and then the IANA time zone; fallback 'US'.
 * As a last resort before 'US', the likely region of a region-less language is used ('he' -> 'IL').
 */
export function detectDefaultCountry(languages: readonly string[], timeZone?: string): string {
  const tags = Array.isArray(languages) ? languages : [];
  const fromTags = (likely: boolean): CountryCode | undefined =>
    tags.map((tag) => regionOf(tag, likely)).find((region) => region !== undefined);
  const zoneRegion = timeZone ? ZONE_TO_REGION.get(timeZone) : undefined;
  const fromZone = zoneRegion && isSupportedCountry(zoneRegion) ? zoneRegion : undefined;
  return fromTags(false) ?? fromZone ?? fromTags(true) ?? 'US';
}

function regionNames(locale: string): Intl.DisplayNames {
  try {
    return new Intl.DisplayNames([locale], { type: 'region', fallback: 'code' });
  } catch {
    return new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' });
  }
}

function collatorFor(locale: string): Intl.Collator {
  try {
    return new Intl.Collator(locale);
  } catch {
    return new Intl.Collator('en');
  }
}

/**
 * All regions libphonenumber knows, with localized names (Intl.DisplayNames) and calling codes
 * (digits only, e.g. '972'), sorted by name in that locale.
 */
export function listCountries(locale: string): { code: string; name: string; callingCode: string }[] {
  const names = regionNames(locale);
  const collator = collatorFor(locale);
  return getCountries()
    .map((code) => ({ code, name: names.of(code) ?? code, callingCode: getCountryCallingCode(code) }))
    .sort((a, b) => collator.compare(a.name, b.name) || a.code.localeCompare(b.code));
}

/** '972501234567' -> '+972 50-123-4567' (falls back to '+' + digits when unparseable; '' stays ''). */
export function formatPhoneForDisplay(digits: string): string {
  const clean = String(digits ?? '').replace(/\D/g, '');
  if (!clean) return '';
  const parsed = safeParse(`+${clean}`);
  return parsed ? formatInternational(parsed) : `+${clean}`;
}
