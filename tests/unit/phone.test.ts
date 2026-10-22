import { describe, expect, it } from 'vitest';
import { getCountries } from 'libphonenumber-js/min';
import { detectDefaultCountry, formatPhoneForDisplay, listCountries, normalizePhone } from '../../src/core/phone';

const ISRAELI_MOBILE = { ok: true, digits: '972501234567', international: '+972 50-123-4567' };

const ERR = {
  empty: 'Enter a phone number.',
  notANumber: "This doesn't look like a phone number.",
  letters: "Phone numbers can't contain letters.",
  extension: 'Remove the extension; WhatsApp needs the main number only.',
  serviceCode: "Numbers with * or # can't be used.",
  plusPosition: 'Put the + only at the start of the number.',
  needCountryCode: 'Add the country code (start with +), or choose your country first.',
  unknownCountryCode: 'Unknown country code. Check the digits after the +.',
  tooShort: 'This number is too short.',
  tooLong: 'This number is too long.',
};

const WARN_UNVERIFIED = "This number doesn't match the known numbering plan; double-check it.";
const WARN_INTERNATIONAL = 'Read as an international number; check the country code.';

describe('normalizePhone: accepted formats', () => {
  it.each([
    ['+972 50-123-4567', 'IL'],
    ['00972501234567', 'IL'],
    ['050-123-4567', 'IL'],
    ['0501234567', 'IL'],
    ['+972501234567', 'US'],
    ['tel:+972501234567', 'US'],
    ['TEL:+972-50-123-4567', 'US'],
    ['tel:050-123-4567', 'IL'],
    ['050.123.4567', 'IL'],
    ['050/123/4567', 'IL'],
    ['(050) 123 4567', 'IL'],
    ['(+972) 50 123 4567', 'US'],
    ['+972 (0)50-123-4567', 'IL'],
    ['972501234567', 'IL'],
    ['  050 123 4567  ', 'IL'],
  ])('%j with %s', (input, country) => {
    expect(normalizePhone(input, country)).toEqual(ISRAELI_MOBILE);
  });

  it('handles US national formatting', () => {
    expect(normalizePhone('(212) 555-0123', 'US')).toEqual({
      ok: true,
      digits: '12125550123',
      international: '+1 212 555-0123',
    });
  });

  it('treats the default country case-insensitively', () => {
    expect(normalizePhone('0501234567', 'il')).toEqual(ISRAELI_MOBILE);
    expect(normalizePhone('0501234567', ' IL ')).toEqual(ISRAELI_MOBILE);
  });

  it('ignores the default country when the number is international', () => {
    expect(normalizePhone('+44 7911 123456', 'IL')).toEqual({
      ok: true,
      digits: '447911123456',
      international: '+44 7911 123456',
    });
  });

  it('accepts the US international dialling prefix 011', () => {
    expect(normalizePhone('011 972 50 123 4567', 'US')).toEqual(ISRAELI_MOBILE);
  });

  it('accepts a 00 prefix even where the country dials out differently', () => {
    expect(normalizePhone('00972501234567', 'US')).toEqual(ISRAELI_MOBILE);
    expect(normalizePhone('00 44 7911 123456', 'RU')).toEqual({
      ok: true,
      digits: '447911123456',
      international: '+44 7911 123456',
    });
  });

  it('accepts a (0) trunk prefix written inside an international number', () => {
    expect(normalizePhone('+44 (0)20 7946 0958', 'US')).toEqual({
      ok: true,
      digits: '442079460958',
      international: '+44 20 7946 0958',
    });
  });

  it('accepts non-geographic numbers', () => {
    expect(normalizePhone('+800 1234 5678', 'IL')).toEqual({
      ok: true,
      digits: '80012345678',
      international: '+800 1234 5678',
    });
  });
});

describe('normalizePhone: invisible and exotic characters', () => {
  it.each([
    ['LRM/RLM', '\u200E050-123-4567\u200F'],
    ['LRE/PDF embedding', '\u202A+972 50-123-4567\u202C'],
    ['RLE embedding', '\u202B050-123-4567\u202C'],
    ['LRO/RLO overrides', '\u202D050\u202E-123-4567\u202C'],
    ['isolates', '\u2066+972 50 123 4567\u2069'],
    ['RLI/FSI isolates', '\u2067050\u2068 123 4567\u2069'],
    ['NBSP', '050\u00A0123\u00A04567'],
    ['figure space', '050\u2007123\u20074567'],
    ['thin space', '050\u2009123\u20094567'],
    ['narrow NBSP', '+972\u202F50\u202F123\u202F4567'],
    ['zero-width space and BOM', '\uFEFF050\u200B123\u200B4567'],
    ['non-breaking hyphens', '050\u2011123\u20114567'],
    ['en dash and minus sign', '050\u2013123\u22124567'],
    ['ideographic space', '050\u3000123\u30004567'],
  ])('%s', (_, input) => {
    expect(normalizePhone(input, 'IL')).toEqual(ISRAELI_MOBILE);
  });

  it('converts full-width digits and plus', () => {
    expect(normalizePhone('＋９７２ ５０ １２３ ４５６７', '')).toEqual(ISRAELI_MOBILE);
    expect(normalizePhone('（０５０）１２３\uFF0D４５６７', 'IL')).toEqual(ISRAELI_MOBILE);
  });

  it('converts Arabic-Indic digits', () => {
    expect(normalizePhone('٠٥٠١٢٣٤٥٦٧', 'IL')).toEqual(ISRAELI_MOBILE);
    expect(normalizePhone('+٩٧٢ ٥٠ ١٢٣ ٤٥٦٧', 'US')).toEqual(ISRAELI_MOBILE);
  });

  it('converts Extended Arabic-Indic (Persian) digits', () => {
    expect(normalizePhone('۰۵۰-۱۲۳-۴۵۶۷', 'IL')).toEqual(ISRAELI_MOBILE);
  });

  it('strips bidi marks before a tel: prefix', () => {
    expect(normalizePhone('\u200Etel:+972501234567\u200F', 'US')).toEqual(ISRAELI_MOBILE);
  });

  it('converts mixed digit scripts with bidi marks around them', () => {
    expect(normalizePhone('\u200F٠٥٠\u200F-123-۴۵۶۷', 'IL')).toEqual(ISRAELI_MOBILE);
  });
});

describe('normalizePhone: rejections', () => {
  it.each([
    ['', ERR.empty],
    ['   ', ERR.empty],
    ['\u200E\u200F\u202A', ERR.empty],
    ['tel:', ERR.empty],
    ['abc', ERR.letters],
    ['call 050-123-4567', ERR.letters],
    ['050-CALL-NOW', ERR.letters],
    ['wa.me/972501234567', ERR.letters],
    ['+1 212 555 0123 ext 5', ERR.extension],
    ['+1 212 555 0123 ext. 5', ERR.extension],
    ['+1 212 555 0123 extension 12', ERR.extension],
    ['+12125550123x5', ERR.extension],
    ['+1 212 555 0123 x 5', ERR.extension],
    ['050-123-4567,22', ERR.extension],
    ['050-123-4567;22', ERR.extension],
    ['tel:+1-212-555-0123;ext=5', ERR.extension],
    ['*31#050-123-4567', ERR.serviceCode],
    ['#31#', ERR.serviceCode],
    ['050-123-4567*', ERR.serviceCode],
    ['+', ERR.notANumber],
    ['()-', ERR.notANumber],
    ['050_123_4567', ERR.notANumber],
    ['+972+50-123-4567', ERR.plusPosition],
    ['050-123+4567', ERR.plusPosition],
    ['++972501234567', ERR.plusPosition],
    ['050-123', ERR.tooShort],
    ['+972 50 123', ERR.tooShort],
    ['5', ERR.tooShort],
    ['+97250123456789012', ERR.tooLong],
    ['+999 1234567', ERR.unknownCountryCode],
    ['+0501234567', ERR.unknownCountryCode],
  ])('%j', (input, error) => {
    expect(normalizePhone(input, 'IL')).toEqual({ ok: false, error });
  });

  it('rejects an absurdly long number without throwing', () => {
    expect(normalizePhone('1'.repeat(400), 'US')).toEqual({ ok: false, error: ERR.tooLong });
    expect(normalizePhone(`+${'1'.repeat(400)}`, 'US')).toEqual({ ok: false, error: ERR.tooLong });
  });

  it.each(['', 'ZZ', 'XX', 'Israel', '001', 'il-IL'])(
    'asks for the country code when the default country %j is unusable',
    (country) => {
      expect(normalizePhone('0501234567', country)).toEqual({ ok: false, error: ERR.needCountryCode });
      expect(normalizePhone('972501234567', country)).toEqual({ ok: false, error: ERR.needCountryCode });
    },
  );

  it('still accepts international numbers without a usable default country', () => {
    expect(normalizePhone('+972 50-123-4567', '')).toEqual(ISRAELI_MOBILE);
    expect(normalizePhone('00972501234567', 'ZZ')).toEqual(ISRAELI_MOBILE);
  });

  it('reports a short number after a 00 prefix as too short', () => {
    expect(normalizePhone('00972', '')).toEqual({ ok: false, error: ERR.tooShort });
  });
});

describe('normalizePhone: warnings', () => {
  it('accepts possible-but-invalid numbers with a warning', () => {
    expect(normalizePhone('+1 555 555 5555', 'US')).toEqual({
      ok: true,
      digits: '15555555555',
      international: '+1 555 555-5555',
      warning: WARN_UNVERIFIED,
    });
    expect(normalizePhone('(200) 555-0123', 'US')).toEqual({
      ok: true,
      digits: '12005550123',
      international: '+1 200 555-0123',
      warning: WARN_UNVERIFIED,
    });
  });

  it('reads digits that only make sense internationally (e.g. copied from wa.me) with a warning', () => {
    expect(normalizePhone('447911123456', 'US')).toEqual({
      ok: true,
      digits: '447911123456',
      international: '+44 7911 123456',
      warning: WARN_INTERNATIONAL,
    });
  });

  it('prefers a valid international reading over a merely possible national one', () => {
    expect(normalizePhone('447911123456', 'IL')).toEqual({
      ok: true,
      digits: '447911123456',
      international: '+44 7911 123456',
      warning: WARN_INTERNATIONAL,
    });
  });

  it('does not reinterpret numbers with a national trunk prefix', () => {
    expect(normalizePhone('0447911123456', 'US')).toEqual({ ok: false, error: ERR.tooLong });
    expect(normalizePhone('0447911123456', 'IL')).toEqual({
      ok: true,
      digits: '972447911123456',
      international: '+972 447911123456',
      warning: WARN_UNVERIFIED,
    });
  });

  it('valid numbers carry no warning key at all', () => {
    expect('warning' in normalizePhone('0501234567', 'IL')).toBe(false);
  });
});

describe('detectDefaultCountry', () => {
  it('uses the region of the first language tag that has one', () => {
    expect(detectDefaultCountry(['he-IL'])).toBe('IL');
    expect(detectDefaultCountry(['he', 'en-GB', 'en-US'])).toBe('GB');
    expect(detectDefaultCountry(['en-US', 'he-IL'], 'Asia/Jerusalem')).toBe('US');
    expect(detectDefaultCountry(['zh-Hant-TW'])).toBe('TW');
    expect(detectDefaultCountry(['pt-br'])).toBe('BR');
  });

  it('accepts underscore-separated tags and canonical aliases', () => {
    expect(detectDefaultCountry(['en_GB'])).toBe('GB');
    expect(detectDefaultCountry(['en-UK'])).toBe('GB');
  });

  it('skips regions libphonenumber does not support', () => {
    expect(detectDefaultCountry(['es-419'], 'America/Mexico_City')).toBe('MX');
    expect(detectDefaultCountry(['en-001', 'fr-FR'])).toBe('FR');
  });

  it('falls back to the time zone when languages carry no region', () => {
    expect(detectDefaultCountry(['en'], 'Asia/Jerusalem')).toBe('IL');
    expect(detectDefaultCountry(['he', 'en'], 'Asia/Tel_Aviv')).toBe('IL');
    expect(detectDefaultCountry([], 'Europe/London')).toBe('GB');
  });

  it.each([
    ['Asia/Jerusalem', 'IL'],
    ['Asia/Tel_Aviv', 'IL'],
    ['Europe/London', 'GB'],
    ['America/New_York', 'US'],
    ['America/Chicago', 'US'],
    ['America/Denver', 'US'],
    ['America/Los_Angeles', 'US'],
    ['Europe/Berlin', 'DE'],
    ['Europe/Paris', 'FR'],
    ['Asia/Kolkata', 'IN'],
    ['Asia/Calcutta', 'IN'],
    ['Asia/Dubai', 'AE'],
    ['America/Sao_Paulo', 'BR'],
    ['Europe/Moscow', 'RU'],
    ['Australia/Sydney', 'AU'],
    ['America/Toronto', 'CA'],
    ['Europe/Madrid', 'ES'],
    ['Europe/Rome', 'IT'],
    ['Africa/Johannesburg', 'ZA'],
    ['America/Mexico_City', 'MX'],
    ['Asia/Tokyo', 'JP'],
  ])('maps %s to %s', (zone, region) => {
    expect(detectDefaultCountry(['en'], zone)).toBe(region);
  });

  it('uses the likely region of a region-less language when the zone is unknown', () => {
    expect(detectDefaultCountry(['de'])).toBe('DE');
    expect(detectDefaultCountry(['he'], 'UTC')).toBe('IL');
  });

  it('falls back to US', () => {
    expect(detectDefaultCountry([])).toBe('US');
    expect(detectDefaultCountry([], 'UTC')).toBe('US');
    expect(detectDefaultCountry([], 'Mars/Olympus_Mons')).toBe('US');
    expect(detectDefaultCountry(['!!not a tag', ''], undefined)).toBe('US');
  });

  it('every mapped region is a libphonenumber region', () => {
    const zones = ['Asia/Jerusalem', 'Europe/Kyiv', 'Asia/Gaza', 'Pacific/Auckland', 'America/Argentina/Buenos_Aires'];
    for (const zone of zones) expect(getCountries()).toContain(detectDefaultCountry([], zone));
  });
});

describe('listCountries', () => {
  const english = listCountries('en');

  it('lists every libphonenumber region exactly once', () => {
    expect(english).toHaveLength(getCountries().length);
    expect(new Set(english.map((c) => c.code)).size).toBe(english.length);
  });

  it('includes localized names and calling codes', () => {
    expect(english).toContainEqual({ code: 'IL', name: 'Israel', callingCode: '972' });
    expect(english).toContainEqual({ code: 'US', name: 'United States', callingCode: '1' });
    expect(english).toContainEqual({ code: 'GB', name: 'United Kingdom', callingCode: '44' });
    expect(english).toContainEqual({ code: 'IN', name: 'India', callingCode: '91' });
  });

  it('sorts by name with locale-aware collation', () => {
    expect(english.slice(0, 3).map((c) => c.name)).toEqual(['Afghanistan', 'Åland Islands', 'Albania']);
    const collator = new Intl.Collator('en');
    for (let i = 1; i < english.length; i++) {
      expect(collator.compare(english[i - 1]!.name, english[i]!.name)).toBeLessThanOrEqual(0);
    }
  });

  it('localizes names', () => {
    expect(listCountries('he').find((c) => c.code === 'IL')?.name).toBe('ישראל');
    expect(listCountries('de').find((c) => c.code === 'DE')?.name).toBe('Deutschland');
  });

  it('falls back to English for an invalid locale', () => {
    expect(listCountries('not a locale!!').find((c) => c.code === 'IL')?.name).toBe('Israel');
  });
});

describe('formatPhoneForDisplay', () => {
  it.each([
    ['972501234567', '+972 50-123-4567'],
    ['97231234567', '+972 3-123-4567'],
    ['12125550123', '+1 212 555-0123'],
    ['447911123456', '+44 7911 123456'],
    ['442079460958', '+44 20 7946 0958'],
    ['4930123456', '+49 30 123456'],
    ['79123456789', '+7 912 345-67-89'],
    ['819012345678', '+81 90-1234-5678'],
    ['5511961234567', '+55 11 96123-4567'],
    ['33612345678', '+33 6 12 34 56 78'],
    ['5491123456789', '+54 9 11 2345 6789'],
    ['80012345678', '+800 1234 5678'],
  ])('%s -> %s', (digits, expected) => {
    expect(formatPhoneForDisplay(digits)).toBe(expected);
  });

  it('agrees with normalizePhone().international', () => {
    const result = normalizePhone('050-123-4567', 'IL');
    expect(result.ok && formatPhoneForDisplay(result.digits)).toBe(result.ok && result.international);
  });

  it('falls back to + digits when unparseable', () => {
    expect(formatPhoneForDisplay('9991234567')).toBe('+9991234567');
    expect(formatPhoneForDisplay('1'.repeat(30))).toBe(`+${'1'.repeat(30)}`);
  });

  it('tolerates stray formatting and empty input', () => {
    expect(formatPhoneForDisplay('+972 50 123 4567')).toBe('+972 50-123-4567');
    expect(formatPhoneForDisplay('')).toBe('');
  });
});
