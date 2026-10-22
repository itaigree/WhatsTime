/**
 * Lenient vCard 2.1 / 3.0 / 4.0 reader that extracts names and phone numbers
 * from .vcf exports (Android, Google Contacts, iOS). Never throws.
 */

export interface VCardContact {
  name: string;
  phones: { value: string; label: string }[];
}

interface ContentLine {
  group: string;
  name: string;
  params: Map<string, string[]>;
  value: string;
}

interface CardDraft {
  fn: string;
  n: string;
  org: string;
  tels: { group: string; value: string; types: string[] }[];
  groupLabels: Map<string, string>;
}

const CARD_BOUNDARY = /^\s*(?:BEGIN|END)\s*:\s*VCARD\s*$/i;
const QP_PARAM = /;\s*(?:ENCODING\s*=\s*)?"?QUOTED-PRINTABLE"?\s*(?=;|$)/i;
const BARE_ENCODINGS = new Set(['QUOTED-PRINTABLE', 'BASE64', 'B', '8BIT', '7BIT']);

/** Index of the first `char` that is not inside double quotes, or -1. */
function indexOfUnquoted(text: string, char: string): number {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (c === char && !quoted) return i;
  }
  return -1;
}

function splitUnquoted(text: string, char: string): string[] {
  const parts: string[] = [];
  let rest = text;
  for (let at = indexOfUnquoted(rest, char); at >= 0; at = indexOfUnquoted(rest, char)) {
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  parts.push(rest);
  return parts;
}

function isQuotedPrintableLine(line: string): boolean {
  const colon = line.indexOf(':');
  return colon > 0 && QP_PARAM.test(line.slice(0, colon));
}

/** Join folded lines (leading space/tab) and quoted-printable soft line breaks ('=' at end of line). */
function unfoldLines(text: string): string[] {
  const lines: string[] = [];
  let parts: string[] = [];
  let quotedPrintable = false;
  let softBreak = false;
  for (const physical of text.split(/\r\n|\r|\n/)) {
    let line = physical.charCodeAt(0) === 0xfeff ? physical.slice(1) : physical;
    const isSoftContinuation = softBreak && !CARD_BOUNDARY.test(line);
    const isFold = !softBreak && parts.length > 0 && /^[ \t]/.test(line);
    if (isFold) {
      line = line.slice(1);
    } else if (!isSoftContinuation) {
      if (parts.length > 0) lines.push(parts.join(''));
      parts = [];
      quotedPrintable = isQuotedPrintableLine(line);
    }
    softBreak = quotedPrintable && line.endsWith('=');
    parts.push(softBreak ? line.slice(0, -1) : line);
  }
  if (parts.length > 0) lines.push(parts.join(''));
  return lines;
}

function addParam(params: Map<string, string[]>, key: string, values: string[]): void {
  params.set(key, [...(params.get(key) ?? []), ...values.filter((v) => v !== '')]);
}

function parseParams(tokens: string[]): Map<string, string[]> {
  const params = new Map<string, string[]>();
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq < 0) {
      const bare = token.replace(/"/g, '').trim();
      addParam(params, BARE_ENCODINGS.has(bare.toUpperCase()) ? 'ENCODING' : 'TYPE', [bare]);
      continue;
    }
    const key = token.slice(0, eq).trim().toUpperCase();
    const values = token.slice(eq + 1).replace(/"/g, '').split(',').map((v) => v.trim());
    addParam(params, key, values);
  }
  return params;
}

function parseContentLine(line: string): ContentLine | null {
  const colon = indexOfUnquoted(line, ':');
  if (colon < 0) return null;
  const [head = '', ...paramTokens] = splitUnquoted(line.slice(0, colon), ';');
  const match = /^(?:(.+)\.)?([A-Za-z0-9_-]+)$/.exec(head.trim());
  if (!match) return null;
  return {
    group: (match[1] ?? '').toLowerCase(),
    name: (match[2] ?? '').toUpperCase(),
    params: parseParams(paramTokens),
    value: line.slice(colon + 1),
  };
}

function textDecoderFor(charset: string): TextDecoder {
  try {
    return new TextDecoder(charset || 'utf-8');
  } catch {
    return new TextDecoder('utf-8');
  }
}

/** Decode quoted-printable to bytes, then to text in `charset` (default UTF-8). */
function decodeQuotedPrintable(value: string, charset: string): string {
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (const [, hex, text] of value.matchAll(/=([0-9A-Fa-f]{2})|=|([^=]+)/g)) {
    if (hex) bytes.push(parseInt(hex, 16));
    else if (text) for (const byte of encoder.encode(text)) bytes.push(byte);
  }
  return textDecoderFor(charset).decode(Uint8Array.from(bytes));
}

function decodeValue(line: ContentLine): string {
  const encodings = (line.params.get('ENCODING') ?? []).map((e) => e.toUpperCase());
  if (!encodings.includes('QUOTED-PRINTABLE')) return line.value;
  return decodeQuotedPrintable(line.value, line.params.get('CHARSET')?.[0] ?? 'utf-8');
}

/** RFC 6350 TEXT unescaping of `\n` `\\` `\;` `\,` (plus the stray `\:` some exporters write). */
function unescapeText(value: string): string {
  return value.replace(/\\([\\,;:nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Split on unescaped `separator`, keeping escapes for the caller to resolve. */
function splitEscaped(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i);
    if (c === '\\' && i + 1 < value.length) {
      current += c + value.charAt(++i);
    } else if (c === separator) {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  parts.push(current);
  return parts;
}

function cleanText(value: string): string {
  return unescapeText(value).replace(/\s+/g, ' ').trim();
}

/** 'Cohen;Dana;;;' -> 'Dana Cohen'. Unescaped commas separate multiple values of one component. */
function nameFromN(value: string): string {
  const components = splitEscaped(value, ';').map((part) => splitEscaped(part, ',').map(cleanText).join(' ').trim());
  const [family = '', given = ''] = components;
  return [given, family].filter(Boolean).join(' ');
}

function nameFromOrg(value: string): string {
  return splitEscaped(value, ';').map(cleanText).find(Boolean) ?? '';
}

const TYPE_LABELS: readonly [readonly string[], string][] = [
  [['iphone'], 'iPhone'],
  [['cell', 'work'], 'Work mobile'],
  [['cell'], 'Mobile'],
  [['mobile'], 'Mobile'],
  [['fax', 'home'], 'Home fax'],
  [['fax', 'work'], 'Work fax'],
  [['fax'], 'Fax'],
  [['pager', 'work'], 'Work pager'],
  [['pager'], 'Pager'],
  [['main'], 'Main'],
  [['home'], 'Home'],
  [['work'], 'Work'],
  [['other'], 'Other'],
  [['car'], 'Car'],
  [['assistant'], 'Assistant'],
  [['callback'], 'Callback'],
  [['radio'], 'Radio'],
  [['isdn'], 'ISDN'],
  [['tty'], 'TTY'],
  [['textphone'], 'Textphone'],
  [['video'], 'Video'],
  [['mms'], 'MMS'],
  [['msg'], 'Message'],
  [['text'], 'Text'],
];

const APPLE_LABELS = new Map([
  ['HomeFAX', 'Home fax'],
  ['WorkFAX', 'Work fax'],
  ['OtherFAX', 'Other fax'],
]);

const RELEVANT_PROPERTIES = new Set(['FN', 'N', 'ORG', 'TEL', 'X-ABLABEL']);

function knownTypeLabel(types: readonly string[]): string {
  const lower = new Set(types.map((t) => t.toLowerCase()));
  return TYPE_LABELS.find(([required]) => required.every((t) => lower.has(t)))?.[1] ?? '';
}

/** 'Mobile', 'Home fax', ... from TYPE values; Android's custom 'X-Grandma' becomes 'Grandma'. */
function labelFromTypes(types: readonly string[]): string {
  const known = knownTypeLabel(types);
  if (known) return known;
  const custom = types.find((t) => /^x-./i.test(t))?.slice(2) ?? '';
  return knownTypeLabel([custom]) || custom;
}

/** Apple's built-in labels look like '_$!<Mobile>!$_'; custom ones are plain text. */
function labelFromAbLabel(value: string): string {
  const text = cleanText(value);
  const builtIn = /^_\$!<(.*)>!\$_$/.exec(text)?.[1];
  if (builtIn === undefined) return text;
  return APPLE_LABELS.get(builtIn) ?? builtIn;
}

function newDraft(): CardDraft {
  return { fn: '', n: '', org: '', tels: [], groupLabels: new Map() };
}

function telValue(raw: string): string {
  return cleanText(raw).replace(/^tel:(?:\/\/)?/i, '').trim();
}

function addProperty(draft: CardDraft, line: ContentLine): void {
  if (!RELEVANT_PROPERTIES.has(line.name)) return;
  const value = decodeValue(line);
  switch (line.name) {
    case 'FN':
      draft.fn ||= cleanText(value);
      break;
    case 'N':
      draft.n ||= nameFromN(value);
      break;
    case 'ORG':
      draft.org ||= nameFromOrg(value);
      break;
    case 'TEL': {
      const tel = telValue(value);
      if (tel) draft.tels.push({ group: line.group, value: tel, types: line.params.get('TYPE') ?? [] });
      break;
    }
    case 'X-ABLABEL':
      if (line.group) draft.groupLabels.set(line.group, labelFromAbLabel(value));
      break;
  }
}

function finishDraft(draft: CardDraft): VCardContact | null {
  const seen = new Set<string>();
  const phones: VCardContact['phones'] = [];
  for (const tel of draft.tels) {
    const key = tel.value.replace(/[^\d+]/g, '') || tel.value;
    if (seen.has(key)) continue;
    seen.add(key);
    const groupLabel = tel.group ? draft.groupLabels.get(tel.group) : undefined;
    phones.push({ value: tel.value, label: groupLabel || labelFromTypes(tel.types) });
  }
  if (phones.length === 0) return null;
  return { name: draft.fn || draft.n || draft.org, phones };
}

function isCardMarker(line: ContentLine, name: 'BEGIN' | 'END'): boolean {
  return line.name === name && line.value.trim().toUpperCase() === 'VCARD';
}

/** Parse every vCard in a .vcf file; cards without a TEL are skipped. Never throws. */
export function parseVCards(text: string): VCardContact[] {
  if (typeof text !== 'string') return [];
  const drafts: CardDraft[] = [];
  let current: CardDraft | undefined;
  for (const raw of unfoldLines(text)) {
    try {
      const line = parseContentLine(raw);
      if (!line) continue;
      if (isCardMarker(line, 'BEGIN')) drafts.push((current = newDraft()));
      else if (isCardMarker(line, 'END')) current = undefined;
      else if (current) addProperty(current, line);
    } catch {
      // A line we cannot decode is skipped; the rest of the card still counts.
    }
  }
  return drafts.map(finishDraft).filter((contact): contact is VCardContact => contact !== null);
}
