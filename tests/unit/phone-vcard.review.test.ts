/**
 * Adversarial review tests for src/core/phone.ts and src/core/vcard.ts: real contact strings, numbering-plan edge
 * cases, real exporter quirks and pathological inputs.
 */
import { describe, expect, it } from 'vitest';
import { formatPhoneForDisplay, normalizePhone } from '../../src/core/phone';
import { parseVCards } from '../../src/core/vcard';

const ISRAELI_MOBILE = { ok: true, digits: '972501234567', international: '+972 50-123-4567' };
const UK_MOBILE = { ok: true, digits: '447911123456', international: '+44 7911 123456' };
const US_NUMBER = { ok: true, digits: '12125550123', international: '+1 212 555-0123' };

const WARN_UNVERIFIED = "This number doesn't match the known numbering plan; double-check it.";
const WARN_INTERNATIONAL = 'Read as an international number; check the country code.';
const ERR_INVALID = 'This is not a valid phone number.';
const ERR_FOREIGN_LOCAL = 'This looks like a number from another country. Add its country code (start with +).';

describe('normalizePhone review: trunk zero and international prefixes in real contact strings', () => {
  it.each([
    ['+9720501234567', 'IL'],
    ['+9720501234567', 'US'],
    ['+972-050-1234567', 'US'],
    ['+972 (0) 50 123 4567', 'GB'],
    ['00972 0501234567', 'IL'],
    ['009720501234567', 'DE'],
    ['9720501234567', 'IL'],
    ['011 972 050 123 4567', 'US'],
    ['013-972-50-123-4567', 'IL'],
    ['‫+972-50-123-4567‬', 'US'],
    ['‏+972 50‑123‑4567', 'IL'],
    ['٠٠٩٧٢٥٠١٢٣٤٥٦٧', 'US'],
  ])('%j with %s', (input, country) => {
    expect(normalizePhone(input, country)).toEqual(ISRAELI_MOBILE);
  });

  it('reads "972 50..." without + as international when the default country is elsewhere, with a warning', () => {
    expect(normalizePhone('972 50 123 4567', 'US')).toEqual({ ...ISRAELI_MOBILE, warning: WARN_INTERNATIONAL });
  });

  it.each([
    ['00 972 50 123 4567', 'JP'],
    ['00 972 50 123 4567', 'KR'],
    ['00 972 50 123 4567', 'ID'],
    ['00972501234567', 'JP'],
  ])('a 00 prefix is an international prefix even where the national plan has 00 numbers (%j, %s)', (input, country) => {
    // JP/KR/ID metadata accepts some national numbers starting with 00, so the national reading looked "valid":
    // '+81 00972501234567' without any warning, i.e. a silently wrong wa.me link.
    expect(normalizePhone(input, country)).toEqual(ISRAELI_MOBILE);
  });

  it('a 00 prefix reaches UK and US numbers from JP/KR/ID too', () => {
    expect(normalizePhone('0044 7911 123456', 'JP')).toEqual(UK_MOBILE);
    expect(normalizePhone('0044 7911 123456', 'KR')).toEqual(UK_MOBILE);
    expect(normalizePhone('00 1 212 555 0123', 'ID')).toEqual(US_NUMBER);
    // The region's own IDD still works.
    expect(normalizePhone('010 44 7911 123456', 'JP')).toEqual(UK_MOBILE);
  });

  it('a 00 + own country code number in Colombia is not swallowed by the 005 carrier prefix', () => {
    // CO's IDD pattern includes the carrier prefix 005, so the national reading of '0057 321…' was the Russian
    // '+7 321 123-45-67', "valid" and without a warning.
    expect(normalizePhone('0057 321 1234567', 'CO')).toEqual({
      ok: true,
      digits: '573211234567',
      international: '+57 321 1234567',
    });
    expect(normalizePhone('0055 11 96123-4567', 'BR')).toMatchObject({ ok: true, digits: '5511961234567' });
  });
});

describe('normalizePhone review: national formats', () => {
  it.each([
    ['02-123-4567', 'IL', '97221234567', '+972 2-123-4567'],
    ['04-812-3456', 'IL', '97248123456', '+972 4-812-3456'],
    ['072-212-3456', 'IL', '972722123456', '+972 72-212-3456'],
    ['052-765-4321', 'IL', '972527654321', '+972 52-765-4321'],
    ['054 1234567', 'IL', '972541234567', '+972 54-123-4567'],
    ['1-700-123-456', 'IL', '9721700123456', '+972 1-700-123-456'],
    ['07911 123456', 'GB', '447911123456', '+44 7911 123456'],
    ['+44 (0)7911 123456', 'IL', '447911123456', '+44 7911 123456'],
    ['0044 (0)20 7946 0958', 'IL', '442079460958', '+44 20 7946 0958'],
    ['98765 43210', 'IN', '919876543210', '+91 98765 43210'],
    ['09876543210', 'IN', '919876543210', '+91 98765 43210'],
    ['+91-98765-43210', 'IL', '919876543210', '+91 98765 43210'],
    ['0151 23456789', 'DE', '4915123456789', '+49 1512 3456789'],
    ['030/123456', 'DE', '4930123456', '+49 30 123456'],
    ['+49 (0)151 23456789', 'IL', '4915123456789', '+49 1512 3456789'],
    ['1 (212) 555-0123', 'US', '12125550123', '+1 212 555-0123'],
    ['212.555.0123', 'US', '12125550123', '+1 212 555-0123'],
    ['650 253 0000', 'CA', '16502530000', '+1 650 253-0000'],
    ['06 1234 5678', 'IT', '390612345678', '+39 06 1234 5678'],
  ])('%j with %s', (input, country, digits, international) => {
    expect(normalizePhone(input, country)).toEqual({ ok: true, digits, international });
  });

  it('accepts the legacy Mexican mobile "1" after +52 that old contacts still carry', () => {
    const mexicoCity = { ok: true, digits: '525512345678', international: '+52 55 1234 5678' };
    expect(normalizePhone('+52 1 55 1234 5678', 'US')).toEqual(mexicoCity);
    expect(normalizePhone('+5215512345678', 'MX')).toEqual(mexicoCity);
    expect(normalizePhone('55 1234 5678', 'MX')).toEqual(mexicoCity);
  });
});

describe('normalizePhone review: NANP numbers can never start with 0 or 1', () => {
  it.each(['050-123-4567', '0501234567', '052-765-4321', '0212345678', '1 050 123 4567'])(
    'rejects the foreign local number %j with a US default instead of producing +1 0…',
    (input) => {
      expect(normalizePhone(input, 'US')).toEqual({ ok: false, error: ERR_FOREIGN_LOCAL });
      expect(normalizePhone(input, 'CA')).toEqual({ ok: false, error: ERR_FOREIGN_LOCAL });
    },
  );

  it.each([
    ['+1 050 123 4567', 'IL'],
    ['+1 150 123 4567', 'IL'],
    ['150-123-4567', 'US'],
    ['1501234567', 'US'],
    ['+1 212 055 0123', 'IL'],
    ['(212) 155-0123', 'US'],
    ['001 050 123 4567', 'IL'],
  ])('rejects an impossible NANP area or exchange code: %j with %s', (input, country) => {
    expect(normalizePhone(input, country)).toEqual({ ok: false, error: ERR_INVALID });
  });

  it('still only warns for structurally fine NANP numbers that the metadata does not know (new area codes)', () => {
    expect(normalizePhone('+1 555 555 5555', 'US')).toEqual({
      ok: true,
      digits: '15555555555',
      international: '+1 555 555-5555',
      warning: WARN_UNVERIFIED,
    });
    expect(normalizePhone('(200) 555-0123', 'US')).toMatchObject({ ok: true, warning: WARN_UNVERIFIED });
  });
});

describe('normalizePhone review: foreign local formats in regions without a 0 trunk prefix', () => {
  it.each([
    ['0501234567', 'GR'],
    ['050123456', 'ES'],
    ['8 050 123 45 67', 'RU'],
    ['0501234567', 'RU'],
  ])('%j with %s', (input, country) => {
    expect(normalizePhone(input, country)).toEqual({ ok: false, error: ERR_FOREIGN_LOCAL });
  });

  it('stays metadata-tolerant: an explicit international number with a leading 0 only warns', () => {
    expect(normalizePhone('+30 0501234567', 'GR')).toMatchObject({ ok: true, digits: '300501234567', warning: WARN_UNVERIFIED });
  });

  it('does not touch numbers whose 0 is the trunk prefix or part of a valid number', () => {
    expect(normalizePhone('0501234567', 'IL')).toEqual(ISRAELI_MOBILE);
    expect(normalizePhone('0501234567', 'DE')).toMatchObject({ ok: true, digits: '49501234567' });
    expect(normalizePhone('0447911123456', 'IL')).toMatchObject({ ok: true, warning: WARN_UNVERIFIED });
  });
});

describe('normalizePhone review: a national reading that fits no number format', () => {
  it('prefers a well-formed international reading of "1 212 555 0123" over an unformattable Israeli one', () => {
    // Previously '+972 12125550123' with no warning at all: libphonenumber's min metadata only checks Israel's coarse
    // pattern, which any 11-digit number starting with 1 satisfies, although no Israeli number looks like that.
    expect(normalizePhone('1 212 555 0123', 'IL')).toEqual({ ...US_NUMBER, warning: WARN_INTERNATIONAL });
    expect(normalizePhone('1-800-555-0199', 'IL')).toEqual({
      ok: true,
      digits: '18005550199',
      international: '+1 800 555-0199',
      warning: WARN_INTERNATIONAL,
    });
  });

  it('keeps well-formed national readings', () => {
    expect(normalizePhone('1-700-123-456', 'IL')).toMatchObject({ ok: true, digits: '9721700123456' });
    expect(normalizePhone('1-800-555-0199', 'US')).toEqual({ ok: true, digits: '18005550199', international: '+1 800 555-0199' });
  });
});

describe('normalizePhone review: pathological input', () => {
  it('does not backtrack quadratically on whitespace after an "x"', () => {
    const started = performance.now();
    expect(normalizePhone(`1x${' '.repeat(50_000)}a`, 'US')).toEqual({ ok: false, error: "Phone numbers can't contain letters." });
    expect(normalizePhone(`1x${' '.repeat(25_000)}:${' '.repeat(25_000)}a`, 'US')).toMatchObject({ ok: false });
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('still recognises extensions written with a colon', () => {
    expect(normalizePhone('+1 212 555 0123 x: 5', 'US')).toEqual({
      ok: false,
      error: 'Remove the extension; WhatsApp needs the main number only.',
    });
    expect(normalizePhone('+1 212 555 0123 ext.: 5', 'US')).toMatchObject({ ok: false });
  });

  it('formatPhoneForDisplay never throws on junk', () => {
    expect(formatPhoneForDisplay('abc')).toBe('');
    expect(formatPhoneForDisplay('0'.repeat(500))).toBe(`+${'0'.repeat(500)}`);
  });
});

const crlf = (...lines: string[]): string => lines.join('\r\n') + '\r\n';

describe('parseVCards review: exporter quirks', () => {
  it('treats "=" followed by trailing whitespace as a quoted-printable soft line break (RFC 2045)', () => {
    const text = crlf(
      'BEGIN:VCARD',
      'VERSION:2.1',
      'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D7=A8=D7=97=D7=9C=20=D7=9C=D7= \t',
      '=95=D7=99',
      'TEL;CELL:0501234567',
      'END:VCARD',
    );
    expect(parseVCards(text)).toEqual([{ name: 'רחל לוי', phones: [{ value: '0501234567', label: 'Mobile' }] }]);
  });

  it('reads Samsung custom labels: TEL;X-CUSTOM(CHARSET=UTF-8,ENCODING=QUOTED-PRINTABLE,<label>)', () => {
    const text = crlf(
      'BEGIN:VCARD',
      'VERSION:2.1',
      'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D7=9C=D7=95=D7=99;=D7=A8=D7=97=D7=9C;;;',
      'TEL;X-CUSTOM(CHARSET=UTF-8,ENCODING=QUOTED-PRINTABLE,=D7=A1=D7=91=D7=AA=D7=90):050-123-4567',
      'TEL;X-CUSTOM(CHARSET=UTF-8,ENCODING=QUOTED-PRINTABLE,Beach house):050-765-4321',
      'TEL;X-CUSTOM(Grandma):+1 212-555-0123',
      'TEL;CELL:052-111-2222',
      'END:VCARD',
    );
    expect(parseVCards(text)).toEqual([
      {
        name: 'רחל לוי',
        phones: [
          { value: '050-123-4567', label: 'סבתא' },
          { value: '050-765-4321', label: 'Beach house' },
          { value: '+1 212-555-0123', label: 'Grandma' },
          { value: '052-111-2222', label: 'Mobile' },
        ],
      },
    ]);
  });

  it('does not lose a number when a parameter has an unbalanced double quote', () => {
    const text = crlf('BEGIN:VCARD', 'FN:X', 'TEL;X-CUSTOM(Mom "home):050-123-4567', 'TEL;X-NOTE="a;b:c";CELL:2', 'END:VCARD');
    expect(parseVCards(text)[0]?.phones).toEqual([
      { value: '050-123-4567', label: 'Mom "home' },
      { value: '2', label: 'Mobile' },
    ]);
  });

  it('an X-ABLabel still wins over a Samsung custom label, and an empty custom label falls back to TYPE', () => {
    const text = crlf(
      'BEGIN:VCARD',
      'FN:X',
      'item1.TEL;X-CUSTOM(Grandma):1',
      'item1.X-ABLabel:Nana',
      'TEL;CELL;X-CUSTOM():2',
      'END:VCARD',
    );
    expect(parseVCards(text)[0]?.phones).toEqual([
      { value: '1', label: 'Nana' },
      { value: '2', label: 'Mobile' },
    ]);
  });
});

describe('parseVCards review: size and pathological input', () => {
  /** Samsung Contacts 2.1 export: QP Hebrew split mid-character, X-ANDROID-CUSTOM, and a photo on every tenth card. */
  const samsungCard = (i: number): string =>
    crlf(
      'BEGIN:VCARD',
      'VERSION:2.1',
      'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D7=9C=D7=95=D7=99;=D7=A8=D7=97=D7=9C;;;',
      'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D7=A8=D7=97=D7=9C=20=D7=9C=D7=',
      '=95=D7=99=20=D7=9E=D7=94=D7=A2=D7=91=D7=95=D7=93=D7=94=20=D7=94=D7=A7=D7=',
      '=95=D7=93=D7=9E=D7=AA',
      `TEL;CELL:050-${String(i).padStart(7, '0')}`,
      `TEL;HOME:+972 3-${String(i).padStart(7, '0')}`,
      'EMAIL;HOME:rachel@example.com',
      'X-ANDROID-CUSTOM;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:vnd.android.cursor.item/nickname;=D7=A8=D7=97=D7=9C=D7=99;1;;;;;;;;;;;;;',
      ...(i % 10 === 0
        ? [
            'PHOTO;ENCODING=BASE64;JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a',
            ...Array.from({ length: 60 }, () => ' HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy'),
            '',
          ]
        : []),
      'END:VCARD',
    );

  it('parses a 10k-contact Samsung export (about 10 MB) well under a second', () => {
    const text = Array.from({ length: 10_000 }, (_, i) => samsungCard(i)).join('');
    parseVCards(text.slice(0, 200_000)); // warm up the JIT like a second import would
    // Best of three, so that other test files running in parallel do not make this flaky.
    let elapsed = Infinity;
    let contacts: ReturnType<typeof parseVCards> = [];
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      contacts = parseVCards(text);
      elapsed = Math.min(elapsed, performance.now() - started);
    }
    expect(contacts).toHaveLength(10_000);
    expect(contacts[9_999]).toEqual({
      name: 'רחל לוי מהעבודה הקודמת',
      phones: [
        { value: '050-0009999', label: 'Mobile' },
        { value: '+972 3-0009999', label: 'Home' },
      ],
    });
    expect(elapsed).toBeLessThan(800);
  });

  it('does not go quadratic on a line with a huge number of parameters', () => {
    const text = crlf('BEGIN:VCARD', 'FN:X', `TEL;${'CELL;'.repeat(50_000)}X:1`, 'END:VCARD');
    const started = performance.now();
    expect(parseVCards(text)).toEqual([{ name: 'X', phones: [{ value: '1', label: 'Mobile' }] }]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('handles a huge quoted-printable value and many soft line breaks quickly', () => {
    const hugeValue = crlf('BEGIN:VCARD', `FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${'=D7=90'.repeat(200_000)}`, 'TEL:1', 'END:VCARD');
    const softBreaks = crlf(
      'BEGIN:VCARD',
      'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D7=',
      ...Array.from({ length: 100_000 }, () => '=90=D7='),
      '=90',
      'TEL:1',
      'END:VCARD',
    );
    const started = performance.now();
    expect(parseVCards(hugeValue)[0]?.name).toBe('א'.repeat(200_000));
    expect(parseVCards(softBreaks)[0]?.name).toBe('א'.repeat(100_001));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('never throws on random binary-ish input', () => {
    let seed = 42;
    const random = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const alphabet = ['BEGIN:VCARD', 'END:VCARD', 'TEL', 'FN', ';', ':', '=', '"', '\r\n', '\n', ' ', 'item1.', 'X-CUSTOM(', ')', 'ENCODING=QUOTED-PRINTABLE', '=D7', '\uD800', '\u0000', 'a'];
    for (let n = 0; n < 200; n++) {
      const text = Array.from({ length: 200 }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
      expect(() => parseVCards(text)).not.toThrow();
    }
  });
});
