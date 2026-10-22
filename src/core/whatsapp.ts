/**
 * wa.me "click to chat" links that open WhatsApp with a chat and a
 * pre-filled message.
 */

const WA_ME = 'https://wa.me/';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Replace unpaired UTF-16 surrogates (which encodeURIComponent rejects) with U+FFFD. */
function toWellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, '�');
}

/** A trailing run of the punctuation encodeURIComponent leaves unescaped: - _ . ! ~ * ' ( ) */
const TRAILING_UNESCAPED = /[^A-Za-z0-9%]+$/;

/**
 * encodeURIComponent, plus percent-escapes for any punctuation it leaves at the very end. The link is tapped from
 * a calendar description, and linkifiers (Android Linkify, Google Calendar) leave trailing punctuation out of
 * the link, so a message ending in '.', '!', ')' or WhatsApp's *bold* / ~strike~ markers would lose it.
 */
function encodeText(message: string): string {
  return encodeURIComponent(toWellFormed(message)).replace(TRAILING_UNESCAPED, (tail) =>
    [...tail].map((c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`).join(''),
  );
}

/**
 * 'https://wa.me/972501234567?text=...' ; phone '' -> 'https://wa.me/?text=...' ; empty message -> no text param.
 * Encodes with encodeURIComponent (spaces %20, newlines %0A, emoji/Hebrew as UTF-8 percent-escapes), and also
 * escapes trailing punctuation so the link always ends in a letter or digit.
 * Non-digit characters and leading zeros (an international '00' / '+00' prefix) are dropped from `phoneDigits`,
 * as wa.me requires, so the path can never break the URL.
 */
export function buildWhatsAppLink(phoneDigits: string, message: string): string {
  const base = WA_ME + phoneDigits.replace(/\D/g, '').replace(/^0+/, '');
  return message ? `${base}?text=${encodeText(message)}` : base;
}
