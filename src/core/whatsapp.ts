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

/**
 * 'https://wa.me/972501234567?text=...' ; phone '' -> 'https://wa.me/?text=...' ; empty message -> no text param.
 * Encodes with encodeURIComponent (spaces %20, newlines %0A, emoji/Hebrew as UTF-8 percent-escapes).
 * Non-digit characters in `phoneDigits` are dropped so the path can never break the URL.
 */
export function buildWhatsAppLink(phoneDigits: string, message: string): string {
  const base = WA_ME + phoneDigits.replace(/\D/g, '');
  return message ? `${base}?text=${encodeURIComponent(toWellFormed(message))}` : base;
}
