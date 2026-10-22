import { describe, expect, it } from 'vitest';
import { parseVCards } from '../../src/core/vcard';

const crlf = (...lines: string[]): string => lines.join('\r\n') + '\r\n';
const lf = (...lines: string[]): string => lines.join('\n') + '\n';

/** Android Contacts "Export to .vcf" (vCard 2.1): every byte of non-ASCII text is quoted-printable, soft-wrapped mid-character. */
const ANDROID_EXPORT = crlf(
  'BEGIN:VCARD',
  'VERSION:2.1',
  'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D7=9C=D7=95=D7=99;=D7=A8=D7=97=D7=9C;;;',
  'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D7=A8=D7=97=D7=9C=20=D7=9C=D7=',
  '=95=D7=99=20=D7=9E=D7=94=D7=A2=D7=91=D7=95=D7=93=D7=94=20=D7=94=D7=A7=D7=',
  '=95=D7=93=D7=9E=D7=AA',
  'TEL;CELL:050-123-4567',
  'TEL;HOME:+972 3-123-4567',
  'TEL;WORK;FAX:03-765-4321',
  'EMAIL;HOME:rachel@example.com',
  'X-ANDROID-CUSTOM;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:vnd.android.cursor.item/nickname;=D7=A8=D7=97=D7=9C=D7=99;1;;;;;;;;;;;;;',
  'PHOTO;ENCODING=BASE64;JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a',
  ' HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy',
  ' AhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMB',
  ' AAIRAxEAPwCdABmX/9k=',
  '',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:2.1',
  'N:Smith;John;;;',
  'FN:John Smith',
  'TEL;CELL;PREF:+1 212-555-0123',
  'TEL;X-Grandpa:+1 212-555-0199',
  'TEL;WORK;CELL:+1 646-555-0100',
  'TEL;VOICE:+1 718-555-0111',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:2.1',
  'N:;;;;',
  'EMAIL;HOME:nophone@example.com',
  'END:VCARD',
);

/** iPhone "Share contact" / iCloud export (vCard 3.0) with item groups and X-ABLabel. */
const IOS_EXPORT = crlf(
  'BEGIN:VCARD',
  'VERSION:3.0',
  'PRODID:-//Apple Inc.//iPhone OS 17.5.1//EN',
  'N:Cohen;Dana;;;',
  'FN:Dana Cohen',
  'ORG:Cohen & Sons;',
  'item1.TEL;type=pref:+972 50-123-4567',
  'item1.X-ABLabel:_$!<Mobile>!$_',
  'TEL;TYPE=CELL,VOICE,pref:+972 52-765-4321',
  'TEL;type=IPHONE;type=CELL;type=VOICE:+972 54-111-2222',
  'item2.TEL:+1 (212) 555-0123',
  'item2.X-ABLabel:Grandma\\, NY',
  'item3.X-ABLabel:_$!<HomeFAX>!$_',
  'item3.TEL:+972 3-555-0000',
  'TEL;type=WORK;type=VOICE:+972 3-123-4567',
  'item4.EMAIL;type=INTERNET:dana@example.com',
  'item4.X-ABLabel:_$!<Other>!$_',
  'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD/',
  ' 2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:3.0',
  'PRODID:-//Apple Inc.//iPhone OS 17.5.1//EN',
  'N:;;;;',
  'FN:',
  'ORG:Pizza Napoli;Delivery',
  'item1.TEL:+39 06 1234 5678',
  'item1.X-ABLabel:_$!<Main>!$_',
  'END:VCARD',
);

/** Google Contacts "Export > vCard (for iOS Contacts)" (vCard 3.0). */
const GOOGLE_EXPORT = crlf(
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Yossi Mizrahi',
  'N:Mizrahi;Yossi;;;',
  'EMAIL;TYPE=INTERNET;TYPE=HOME:yossi@example.com',
  'TEL;TYPE=CELL:054-987-6543',
  'TEL;TYPE=HOME:+972 2-123-4567',
  'TEL;TYPE=WORK:+972 3-765-4321',
  'TEL;TYPE=MAIN:+972 77-000-0000',
  'TEL:+972 8-999-9999',
  'item1.TEL:+972 52-000-1111',
  'item1.X-ABLabel:Kibbutz',
  'ADR;TYPE=HOME:;;Herzl 1;Tel Aviv;;6100000;Israel',
  'item2.URL:https\\://example.com',
  'item2.X-ABLabel:',
  'NOTE:Met at the conference\\, 2019\\nLikes coffee',
  'CATEGORIES:myContacts,starred',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Office\\, Main Branch',
  'N:;Office\\, Main Branch;;;',
  'TEL;TYPE=OTHER:+1-800-555-0199',
  'TEL;TYPE=PAGER:+1-800-555-0198',
  'END:VCARD',
);

/** RFC 6350 (vCard 4.0) with tel: URIs. */
const VCARD4 = crlf(
  'BEGIN:VCARD',
  'VERSION:4.0',
  'FN:Jane Doe',
  'N:Doe;Jane;;;',
  'TEL;VALUE=uri;PREF=1;TYPE="voice,cell":tel:+1-555-555-0100',
  'TEL;VALUE=uri;TYPE=work:tel:+44-20-7946-0958',
  'TEL;VALUE=uri;TYPE="voice,home":tel:+1-555-555-0101;ext=102',
  'TEL;TYPE=text:+1 555 555 0102',
  'END:VCARD',
);

describe('parseVCards: real-world exports', () => {
  it('parses an Android 2.1 export with quoted-printable Hebrew split over soft line breaks', () => {
    expect(parseVCards(ANDROID_EXPORT)).toEqual([
      {
        name: 'רחל לוי מהעבודה הקודמת',
        phones: [
          { value: '050-123-4567', label: 'Mobile' },
          { value: '+972 3-123-4567', label: 'Home' },
          { value: '03-765-4321', label: 'Work fax' },
        ],
      },
      {
        name: 'John Smith',
        phones: [
          { value: '+1 212-555-0123', label: 'Mobile' },
          { value: '+1 212-555-0199', label: 'Grandpa' },
          { value: '+1 646-555-0100', label: 'Work mobile' },
          { value: '+1 718-555-0111', label: '' },
        ],
      },
    ]);
  });

  it('builds the name from a quoted-printable N when FN is missing', () => {
    const text = ANDROID_EXPORT.replace(/FN;[\s\S]*?=95=D7=93=D7=9E=D7=AA\r\n/, '');
    expect(parseVCards(text)[0]?.name).toBe('רחל לוי');
  });

  it('parses an iOS 3.0 export with item groups, X-ABLabel and multi-valued TYPE', () => {
    expect(parseVCards(IOS_EXPORT)).toEqual([
      {
        name: 'Dana Cohen',
        phones: [
          { value: '+972 50-123-4567', label: 'Mobile' },
          { value: '+972 52-765-4321', label: 'Mobile' },
          { value: '+972 54-111-2222', label: 'iPhone' },
          { value: '+1 (212) 555-0123', label: 'Grandma, NY' },
          { value: '+972 3-555-0000', label: 'Home fax' },
          { value: '+972 3-123-4567', label: 'Work' },
        ],
      },
      { name: 'Pizza Napoli', phones: [{ value: '+39 06 1234 5678', label: 'Main' }] },
    ]);
  });

  it('parses a Google Contacts 3.0 export', () => {
    expect(parseVCards(GOOGLE_EXPORT)).toEqual([
      {
        name: 'Yossi Mizrahi',
        phones: [
          { value: '054-987-6543', label: 'Mobile' },
          { value: '+972 2-123-4567', label: 'Home' },
          { value: '+972 3-765-4321', label: 'Work' },
          { value: '+972 77-000-0000', label: 'Main' },
          { value: '+972 8-999-9999', label: '' },
          { value: '+972 52-000-1111', label: 'Kibbutz' },
        ],
      },
      {
        name: 'Office, Main Branch',
        phones: [
          { value: '+1-800-555-0199', label: 'Other' },
          { value: '+1-800-555-0198', label: 'Pager' },
        ],
      },
    ]);
  });

  it('parses vCard 4.0 tel: URIs and quoted TYPE lists', () => {
    expect(parseVCards(VCARD4)).toEqual([
      {
        name: 'Jane Doe',
        phones: [
          { value: '+1-555-555-0100', label: 'Mobile' },
          { value: '+44-20-7946-0958', label: 'Work' },
          { value: '+1-555-555-0101;ext=102', label: 'Home' },
          { value: '+1 555 555 0102', label: 'Text' },
        ],
      },
    ]);
  });

  it('parses all exports concatenated into one file', () => {
    const names = parseVCards(ANDROID_EXPORT + IOS_EXPORT + GOOGLE_EXPORT + VCARD4).map((c) => c.name);
    expect(names).toEqual([
      'רחל לוי מהעבודה הקודמת',
      'John Smith',
      'Dana Cohen',
      'Pizza Napoli',
      'Yossi Mizrahi',
      'Office, Main Branch',
      'Jane Doe',
    ]);
  });
});

describe('parseVCards: line endings, BOM and folding', () => {
  const simple = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Avi Levi', 'TEL;TYPE=CELL:+972501234567', 'END:VCARD'];
  const expected = [{ name: 'Avi Levi', phones: [{ value: '+972501234567', label: 'Mobile' }] }];

  it('accepts LF-only files', () => {
    expect(parseVCards(lf(...simple))).toEqual(expected);
  });

  it('accepts CR-only files', () => {
    expect(parseVCards(simple.join('\r'))).toEqual(expected);
  });

  it('accepts a BOM-prefixed file', () => {
    expect(parseVCards('\uFEFF' + crlf(...simple))).toEqual(expected);
  });

  it('accepts BOMs at the start of concatenated files', () => {
    expect(parseVCards('\uFEFF' + lf(...simple) + '\uFEFF' + lf(...simple))).toEqual([...expected, ...expected]);
  });

  it('accepts a file without a trailing newline and with blank lines between cards', () => {
    expect(parseVCards(['', ...simple, '', '', ...simple].join('\r\n'))).toEqual([...expected, ...expected]);
  });

  it('unfolds lines continued with a space or a tab', () => {
    const text = crlf('BEGIN:VCARD', 'VERSION:3.0', 'FN:Avi Le', ' vi', 'TEL;TYPE=CE', '\tLL:+972501', ' 234567', 'END:VCARD');
    expect(parseVCards(text)).toEqual(expected);
  });

  it('does not let a dangling quoted-printable soft break swallow END:VCARD', () => {
    const text = crlf(
      'BEGIN:VCARD',
      'VERSION:2.1',
      'TEL;CELL:0501234567',
      'FN;ENCODING=QUOTED-PRINTABLE:Broken=',
      'END:VCARD',
      'BEGIN:VCARD',
      'FN:Next',
      'TEL:0521234567',
      'END:VCARD',
    );
    expect(parseVCards(text)).toEqual([
      { name: 'Broken', phones: [{ value: '0501234567', label: 'Mobile' }] },
      { name: 'Next', phones: [{ value: '0521234567', label: '' }] },
    ]);
  });
});

describe('parseVCards: encodings and escapes', () => {
  const card = (...lines: string[]): string => crlf('BEGIN:VCARD', ...lines, 'TEL:+15555550100', 'END:VCARD');
  const nameOf = (...lines: string[]): string | undefined => parseVCards(card(...lines))[0]?.name;

  it('decodes quoted-printable with a bare 2.1 encoding param', () => {
    expect(nameOf('FN;CHARSET=UTF-8;QUOTED-PRINTABLE:=D7=93=D7=A0=D7=94=20=D7=9B=D7=94=D7=9F')).toBe('דנה כהן');
  });

  it('decodes quoted-printable in other charsets', () => {
    expect(nameOf('FN;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:Caf=E9 Ren=E9')).toBe('Café René');
  });

  it('falls back to UTF-8 for an unknown charset', () => {
    expect(nameOf('FN;CHARSET=X-BOGUS;ENCODING=QUOTED-PRINTABLE:Caf=C3=A9')).toBe('Café');
  });

  it('keeps raw text and stray = signs in quoted-printable values', () => {
    expect(nameOf('FN;ENCODING=QUOTED-PRINTABLE:A=3DB =ZZ')).toBe('A=B ZZ');
  });

  it('decodes legacy Hebrew code pages', () => {
    expect(nameOf('FN;CHARSET=windows-1255;ENCODING=QUOTED-PRINTABLE:=E3=F0=E4')).toBe('דנה');
  });

  it('decodes 4-byte UTF-8 sequences and keeps raw emoji inside quoted-printable', () => {
    expect(nameOf('FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Mom =F0=9F=98=80')).toBe('Mom 😀');
    expect(nameOf('FN;ENCODING=QUOTED-PRINTABLE:Mom 😀=21')).toBe('Mom 😀!');
  });

  it('decodes a quoted-printable TEL value', () => {
    const text = crlf('BEGIN:VCARD', 'TEL;CELL;ENCODING=QUOTED-PRINTABLE:=2B972=2050=2D123=2D4567', 'END:VCARD');
    expect(parseVCards(text)).toEqual([{ name: '', phones: [{ value: '+972 50-123-4567', label: 'Mobile' }] }]);
  });

  it('keeps raw UTF-8 text (no encoding)', () => {
    expect(nameOf('FN:שרה לוי')).toBe('שרה לוי');
  });

  it('unescapes text values', () => {
    expect(nameOf('FN:Smith\\, John \\; Jr\\\\Sr')).toBe('Smith, John ; Jr\\Sr');
    expect(nameOf('FN:Line\\nBreak')).toBe('Line Break');
  });

  it('builds the name from N (given + family) when FN is missing or empty', () => {
    expect(nameOf('N:Doe;Jane;Q.;Dr.;PhD')).toBe('Jane Doe');
    expect(nameOf('FN:  ', 'N:Doe;Jane;;;')).toBe('Jane Doe');
    expect(nameOf('N:Doe;Jane,Mary;;;')).toBe('Jane Mary Doe');
    expect(nameOf('N:O\\;Brien;Pat;;;')).toBe("Pat O;Brien");
    expect(nameOf('N:;Cher;;;')).toBe('Cher');
    expect(nameOf('N:Madonna')).toBe('Madonna');
  });

  it('falls back to ORG, then to an empty name', () => {
    expect(nameOf('N:;;;;', 'ORG:Acme\\, Inc.;Sales')).toBe('Acme, Inc.');
    expect(nameOf('ORG:;Support')).toBe('Support');
    expect(nameOf()).toBe('');
  });

  it('prefers the first non-empty FN', () => {
    expect(nameOf('FN:', 'FN:Second', 'FN:Third')).toBe('Second');
  });
});

describe('parseVCards: params, groups and labels', () => {
  const phonesOf = (...lines: string[]) =>
    parseVCards(crlf('BEGIN:VCARD', 'FN:X', ...lines, 'END:VCARD'))[0]?.phones ?? [];

  it('treats property names, params and groups case-insensitively', () => {
    const text = lf('begin:vcard', 'fn:lower', 'Item1.tel;Type=Cell:+1 555 555 0100', 'ITEM1.x-ablabel:Cabin', 'end:vcard');
    expect(parseVCards(text)).toEqual([{ name: 'lower', phones: [{ value: '+1 555 555 0100', label: 'Cabin' }] }]);
  });

  it.each([
    ['TEL;TYPE="cell":1', 'Mobile'],
    ['TEL;TYPE=cell,voice:1', 'Mobile'],
    ['TEL;TYPE=VOICE;TYPE=HOME:1', 'Home'],
    ['TEL;HOME;FAX:1', 'Home fax'],
    ['TEL;TYPE=fax:1', 'Fax'],
    ['TEL;WORK;PAGER:1', 'Work pager'],
    ['TEL;TYPE=car:1', 'Car'],
    ['TEL;TYPE=ISDN:1', 'ISDN'],
    ['TEL;TYPE=video:1', 'Video'],
    ['TEL;TYPE=X-ASSISTANT:1', 'Assistant'],
    ['TEL;X-Summer house:1', 'Summer house'],
    ['TEL;TYPE=pref:1', ''],
    ['TEL;PREF=1:1', ''],
    ['TEL:1', ''],
  ])('%s -> %j', (line, label) => {
    expect(phonesOf(line)).toEqual([{ value: '1', label }]);
  });

  it('prefers the X-ABLabel of the group over TYPE and falls back to TYPE when it is empty', () => {
    expect(phonesOf('item1.TEL;TYPE=CELL:1', 'item1.X-ABLabel:Grandma')).toEqual([{ value: '1', label: 'Grandma' }]);
    expect(phonesOf('item1.TEL;TYPE=CELL:1', 'item1.X-ABLabel:')).toEqual([{ value: '1', label: 'Mobile' }]);
  });

  it('maps Apple built-in labels', () => {
    expect(phonesOf('a.TEL:1', 'a.X-ABLabel:_$!<WorkFAX>!$_', 'b.TEL:2', 'b.X-ABLabel:_$!<Pager>!$_')).toEqual([
      { value: '1', label: 'Work fax' },
      { value: '2', label: 'Pager' },
    ]);
  });

  it('keeps unknown Apple built-in labels as their inner text', () => {
    expect(phonesOf('a.TEL:1', 'a.X-ABLabel:_$!<constructor>!$_', 'b.TEL:2', 'b.X-ABLabel:_$!<School>!$_')).toEqual([
      { value: '1', label: 'constructor' },
      { value: '2', label: 'School' },
    ]);
  });

  it('ignores an X-ABLabel without a group or from another group', () => {
    expect(phonesOf('X-ABLabel:Orphan', 'item1.TEL:1', 'item2.X-ABLabel:Other group')).toEqual([{ value: '1', label: '' }]);
  });

  it('strips tel: from values even without VALUE=uri', () => {
    expect(phonesOf('TEL;VALUE=uri:tel:+1-555-555-0100', 'TEL:TEL:+972501234567')).toEqual([
      { value: '+1-555-555-0100', label: '' },
      { value: '+972501234567', label: '' },
    ]);
  });

  it('handles quoted params containing ; and :', () => {
    expect(phonesOf('TEL;X-NOTE="a;b:c";TYPE=cell:+1 555')).toEqual([{ value: '+1 555', label: 'Mobile' }]);
  });

  it('drops empty TEL values and duplicate numbers', () => {
    expect(phonesOf('TEL;CELL:', 'TEL;CELL:   ', 'TEL;CELL:050-123-4567', 'TEL;HOME:0501234567', 'TEL:050 123 4567')).toEqual([
      { value: '050-123-4567', label: 'Mobile' },
    ]);
  });
});

describe('parseVCards: malformed input', () => {
  it('skips cards without a TEL', () => {
    expect(parseVCards(crlf('BEGIN:VCARD', 'VERSION:3.0', 'FN:No Phone', 'EMAIL:a@b.c', 'END:VCARD'))).toEqual([]);
  });

  it.each([
    ['empty string', ''],
    ['plain text', 'hello world\nthis is not a vcard'],
    ['binary noise', '\u0000\u0001\u00FF\uFFFD\uD800'],
    ['only END', 'END:VCARD\r\n'],
    ['TEL outside a card', 'TEL:+972501234567\r\nFN:Nobody\r\n'],
    ['JSON', '{"name":"x","tel":"1"}'],
    ['lines without colons', 'BEGIN:VCARD\nFN Nobody\nTEL 123\nEND:VCARD'],
  ])('returns [] for %s', (_, text) => {
    expect(parseVCards(text)).toEqual([]);
  });

  it('returns [] for non-string input', () => {
    expect(parseVCards(null as unknown as string)).toEqual([]);
    expect(parseVCards(42 as unknown as string)).toEqual([]);
  });

  it('keeps a final card that is missing END:VCARD', () => {
    expect(parseVCards('BEGIN:VCARD\nFN:Unfinished\nTEL:123')).toEqual([
      { name: 'Unfinished', phones: [{ value: '123', label: '' }] },
    ]);
  });

  it('starts a new card when BEGIN:VCARD repeats without END', () => {
    expect(parseVCards(lf('BEGIN:VCARD', 'FN:A', 'TEL:1', 'BEGIN:VCARD', 'FN:B', 'TEL:2', 'END:VCARD'))).toEqual([
      { name: 'A', phones: [{ value: '1', label: '' }] },
      { name: 'B', phones: [{ value: '2', label: '' }] },
    ]);
  });

  it('skips garbage lines inside a card but keeps the rest', () => {
    const text = lf('BEGIN:VCARD', ':::', '.TEL:9', 'garbage', ';;;=', 'FN:Kept', 'TEL;;;:5', 'END:VCARD');
    expect(parseVCards(text)).toEqual([{ name: 'Kept', phones: [{ value: '5', label: '' }] }]);
  });

  it('handles a large export quickly', () => {
    const one = crlf('BEGIN:VCARD', 'VERSION:3.0', 'FN:Bulk', 'TEL;TYPE=CELL:+15555550100', 'END:VCARD');
    const started = performance.now();
    expect(parseVCards(one.repeat(5000))).toHaveLength(5000);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
