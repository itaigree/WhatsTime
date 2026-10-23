import { describe, expect, it } from 'vitest';
import { buildWhatsAppLink } from '../../src/core/whatsapp';

const PHONE = '972501234567';

/** Parses a wa.me link and returns the decoded text param (null when absent). */
function decodedText(link: string): string | null {
  return new URL(link).searchParams.get('text');
}

describe('buildWhatsAppLink: structure', () => {
  it('builds the canonical link', () => {
    expect(buildWhatsAppLink(PHONE, 'Hello')).toBe('https://wa.me/972501234567?text=Hello');
  });

  it('omits the phone for "choose a chat" links', () => {
    expect(buildWhatsAppLink('', 'Hi all')).toBe('https://wa.me/?text=Hi%20all');
    const url = new URL(buildWhatsAppLink('', 'Hi all'));
    expect(url.pathname).toBe('/');
    expect(url.searchParams.get('text')).toBe('Hi all');
  });

  it('omits the text param for an empty message', () => {
    expect(buildWhatsAppLink(PHONE, '')).toBe('https://wa.me/972501234567');
    expect(buildWhatsAppLink('', '')).toBe('https://wa.me/');
    expect(new URL(buildWhatsAppLink(PHONE, '')).searchParams.has('text')).toBe(false);
  });

  it('keeps whitespace-only and falsy-looking messages verbatim', () => {
    expect(buildWhatsAppLink(PHONE, ' ')).toBe('https://wa.me/972501234567?text=%20');
    expect(buildWhatsAppLink(PHONE, '0')).toBe('https://wa.me/972501234567?text=0');
  });

  it('drops any non-digit characters from the phone so the path cannot break the URL', () => {
    expect(buildWhatsAppLink('+972 50-123-4567', 'x')).toBe('https://wa.me/972501234567?text=x');
    expect(buildWhatsAppLink('97250?text=evil#frag/', 'x')).toBe('https://wa.me/97250?text=x');
  });

  it('produces exactly one query param and no fragment, host wa.me, https', () => {
    const url = new URL(buildWhatsAppLink(PHONE, 'a&b=c#d?e/f'));
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('wa.me');
    expect(url.pathname).toBe('/972501234567');
    expect(url.hash).toBe('');
    expect([...url.searchParams.keys()]).toEqual(['text']);
    expect(url.searchParams.get('text')).toBe('a&b=c#d?e/f');
  });
});

describe('buildWhatsAppLink: encoding', () => {
  it('encodes spaces as %20 (not +) and newlines as %0A', () => {
    expect(buildWhatsAppLink(PHONE, 'Hi there\nsee you')).toBe(
      'https://wa.me/972501234567?text=Hi%20there%0Asee%20you',
    );
  });

  it('keeps CRLF and tabs as escapes', () => {
    expect(buildWhatsAppLink(PHONE, 'a\r\nb\tc')).toBe('https://wa.me/972501234567?text=a%0D%0Ab%09c');
  });

  it.each([
    ['&', '%26'],
    ['#', '%23'],
    ['+', '%2B'],
    ['%', '%25'],
    ['?', '%3F'],
    ['=', '%3D'],
    ['/', '%2F'],
    [':', '%3A'],
    ['"', '%22'],
    ['<>', '%3C%3E'],
    ['\\', '%5C'],
    // Inside the message, encodeURIComponent leaves these as they are...
    ["a'b", "a'b"],
    ['a!b', 'a!b'],
    ['a*()~-_.b', 'a*()~-_.b'],
    // ...but at the very end they are escaped, because calendar linkifiers leave trailing punctuation out of the link.
    ["'", '%27'],
    ['!', '%21'],
    ['*()~-_.', '%2A%28%29%7E%2D%5F%2E'],
    ['Hi.', 'Hi%2E'],
  ])('encodes %j as %s', (input, encoded) => {
    expect(buildWhatsAppLink(PHONE, input)).toBe(`https://wa.me/972501234567?text=${encoded}`);
  });

  it('encodes a literal "%20" so it is not decoded as a space', () => {
    expect(buildWhatsAppLink(PHONE, '100%20off')).toBe('https://wa.me/972501234567?text=100%2520off');
    expect(decodedText(buildWhatsAppLink(PHONE, '100%20off'))).toBe('100%20off');
  });

  it('encodes Hebrew as UTF-8 percent-escapes', () => {
    expect(buildWhatsAppLink(PHONE, 'שלום')).toBe('https://wa.me/972501234567?text=%D7%A9%D7%9C%D7%95%D7%9D');
  });

  it('encodes emoji, including ZWJ sequences, flags, skin tones and variation selectors', () => {
    expect(buildWhatsAppLink(PHONE, '😀')).toBe('https://wa.me/972501234567?text=%F0%9F%98%80');
    expect(buildWhatsAppLink(PHONE, '👨‍👩‍👧')).toBe(
      'https://wa.me/972501234567?text=%F0%9F%91%A8%E2%80%8D%F0%9F%91%A9%E2%80%8D%F0%9F%91%A7',
    );
    expect(buildWhatsAppLink(PHONE, '🇮🇱')).toBe('https://wa.me/972501234567?text=%F0%9F%87%AE%F0%9F%87%B1');
    expect(buildWhatsAppLink(PHONE, '👍🏽')).toBe('https://wa.me/972501234567?text=%F0%9F%91%8D%F0%9F%8F%BD');
    expect(buildWhatsAppLink(PHONE, '❤️')).toBe('https://wa.me/972501234567?text=%E2%9D%A4%EF%B8%8F');
  });

  it('preserves invisible bidi marks', () => {
    expect(buildWhatsAppLink(PHONE, '‏א')).toBe('https://wa.me/972501234567?text=%E2%80%8F%D7%90');
  });

  it('replaces unpaired surrogates with U+FFFD instead of throwing', () => {
    expect(buildWhatsAppLink(PHONE, 'a\uD83D')).toBe('https://wa.me/972501234567?text=a%EF%BF%BD');
    expect(buildWhatsAppLink(PHONE, '\uDE00b')).toBe('https://wa.me/972501234567?text=%EF%BF%BDb');
    expect(decodedText(buildWhatsAppLink(PHONE, 'x😀\uD83Dy'))).toBe('x😀�y');
  });

  it('only ever emits printable ASCII', () => {
    const link = buildWhatsAppLink(PHONE, 'מה נשמע? 👋🏼\n"quoted" & <tags> 🏳️‍🌈 🇺🇸 100% #1 +more');
    expect(link).toMatch(/^[\x21-\x7E]+$/);
  });
});

describe('buildWhatsAppLink: round trip through URL / URLSearchParams', () => {
  const samples: [string, string][] = [
    ['plain', 'Hello world'],
    ['hebrew with punctuation', 'מזל טוב! 🎉 נתראה ב-20:00, בסדר?'],
    ['mixed RTL/LTR', 'Meeting עם דני at 10am (חדר 3)'],
    ['zwj family + rainbow flag', '👨‍👩‍👧‍👦 and 🏳️‍🌈 and 👩🏽‍💻'],
    ['regional flags', '🇮🇱🇺🇸🇬🇧🇯🇵'],
    ['newlines', 'line 1\nline 2\r\nline 3\n\n'],
    ['reserved chars', 'a&b=c?d#e+f%g/h:i;j,k@l$m'],
    ['quotes', `"double" 'single' \`back\` „low“ «guillemets»`],
    ['plus vs space', '1 + 1 = 2'],
    ['percent sequences', '%41 %%25 %zz %'],
    ['leading/trailing whitespace', '  padded \t'],
    ['bidi controls', '‫text‬ ⁦iso⁩ ‎'],
    ['NUL and controls', 'a\u0000b\u0007c'],
    ['astral CJK', '𠀀𠀁 漢字 かな'],
    ['combining marks', 'é שָׁלוֹם'],
  ];

  it.each(samples)('%s', (_label, message) => {
    const link = buildWhatsAppLink(PHONE, message);
    expect(decodedText(link)).toBe(message);
    expect(new URLSearchParams(link.slice(link.indexOf('?'))).get('text')).toBe(message);
    expect(decodeURIComponent(link.slice(link.indexOf('=') + 1))).toBe(message);
  });

  it('handles very long text', () => {
    const message = `${'שלום עולם 🌍 & more\n'.repeat(500)}end`;
    const link = buildWhatsAppLink(PHONE, message);
    expect(link.length).toBeGreaterThan(20_000);
    expect(decodedText(link)).toBe(message);
  });

  it('round-trips when there is no phone', () => {
    const message = 'Group: הכנה לחג 🕎 #2 & co.';
    expect(decodedText(buildWhatsAppLink('', message))).toBe(message);
  });
});
