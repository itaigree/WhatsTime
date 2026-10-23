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
  tels: { group: string; value: string; types: string[]; customLabel: string }[];
  groupLabels: Map<string, string>;
}

const CARD_BOUNDARY = /^\s*(?:BEGIN|END)\s*:\s*VCARD\s*$/i;
const QP_PARAM = /;\s*(?:ENCODING\s*=\s*)?"?QUOTED-PRINTABLE"?\s*(?=;|$)/i;
/** RFC 2045: a soft line break is '=' at the end of a line, possibly followed by transport-added whitespace. */
const QP_SOFT_BREAK = /=[ \t]*$/;
const BARE_ENCODINGS = new Set(['QUOTED-PRINTABLE', 'BASE64', 'B', '8BIT', '7BIT']);
/** Samsung Contacts: TEL;X-CUSTOM(CHARSET=UTF-8,ENCODING=QUOTED-PRINTABLE,<label>) or TEL;X-CUSTOM(<label>). */
const SAMSUNG_CUSTOM = /^X-CUSTOM\((.*)\)$/is;
const SAMSUNG_CUSTOM_OPTION = /^\s*(CHARSET|ENCODING)\s*=\s*([^,]*),/i;
const NAME_TOKEN = /^(?:(.+)\.)?([A-Za-z0-9_-]+)$/;

/** Index of the first `char` that is not inside double quotes, or -1. */
function indexOfUnquoted(text: string, char: string): number {
  const target = char.charCodeAt(0);
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22) quoted = !quoted;
    else if (c === target && !quoted) return i;
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

/** Index of the '=' that starts a quoted-printable soft line break at the end of `line`, or -1. */
function softBreakIndex(line: string): number {
  const last = line.charCodeAt(line.length - 1);
  if (last === 0x3d) return line.length - 1;
  if (last !== 0x20 && last !== 0x09) return -1;
  return QP_SOFT_BREAK.exec(line)?.index ?? -1;
}

/** Join folded lines (leading space/tab) and quoted-printable soft line breaks ('=' at end of line). */
function unfoldLines(text: string): string[] {
  const lines: string[] = [];
  const parts: string[] = [];
  const flush = (): void => {
    if (parts.length > 0) lines.push(parts.length === 1 ? (parts[0] ?? '') : parts.join(''));
    parts.length = 0;
  };
  let quotedPrintable = false;
  let softBreak = false;
  for (const physical of text.split(/\r\n|\r|\n/)) {
    let line = physical.charCodeAt(0) === 0xfeff ? physical.slice(1) : physical;
    const isSoftContinuation = softBreak && !CARD_BOUNDARY.test(line);
    const first = line.charCodeAt(0);
    const isFold = !softBreak && parts.length > 0 && (first === 0x20 || first === 0x09);
    if (isFold) {
      line = line.slice(1);
    } else if (!isSoftContinuation) {
      flush();
      quotedPrintable = isQuotedPrintableLine(line);
    }
    const softBreakAt = quotedPrintable ? softBreakIndex(line) : -1;
    softBreak = softBreakAt >= 0;
    parts.push(softBreak ? line.slice(0, softBreakAt) : line);
  }
  flush();
  return lines;
}

/** Appends in place: copying the list on every parameter made a line with many parameters quadratic. */
function addParam(params: Map<string, string[]>, key: string, values: readonly string[]): void {
  let list = params.get(key);
  if (!list) params.set(key, (list = []));
  for (const value of values) if (value !== '') list.push(value);
}

/** The label inside Samsung's X-CUSTOM(...) parameter, decoded when it is quoted-printable. */
function samsungCustomLabel(inner: string): string {
  let rest = inner;
  let charset = 'utf-8';
  let quotedPrintable = false;
  for (let option = SAMSUNG_CUSTOM_OPTION.exec(rest); option; option = SAMSUNG_CUSTOM_OPTION.exec(rest)) {
    const value = (option[2] ?? '').trim();
    if ((option[1] ?? '').toUpperCase() === 'CHARSET') charset = value;
    else quotedPrintable = value.toUpperCase() === 'QUOTED-PRINTABLE';
    rest = rest.slice(option[0].length);
  }
  return cleanText(quotedPrintable ? decodeQuotedPrintable(rest, charset) : rest);
}

function parseParams(tokens: readonly string[]): Map<string, string[]> {
  const params = new Map<string, string[]>();
  for (const token of tokens) {
    const custom = SAMSUNG_CUSTOM.exec(token.trim());
    if (custom) {
      addParam(params, 'X-CUSTOM', [samsungCustomLabel(custom[1] ?? '')]);
      continue;
    }
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
  // An unbalanced quote in the parameters must not hide the value: fall back to the first colon.
  let colon = indexOfUnquoted(line, ':');
  if (colon < 0) colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const semicolon = indexOfUnquoted(head, ';');
  const match = NAME_TOKEN.exec((semicolon < 0 ? head : head.slice(0, semicolon)).trim());
  if (!match) return null;
  const name = (match[2] ?? '').toUpperCase();
  // Parameters of properties we ignore (PHOTO, EMAIL, ADR, ...) are never looked at; skip parsing them.
  const wanted = semicolon >= 0 && RELEVANT_PROPERTIES.has(name);
  return {
    group: (match[1] ?? '').toLowerCase(),
    name,
    params: wanted ? parseParams(splitUnquoted(head.slice(semicolon + 1), ';')) : new Map(),
    value: line.slice(colon + 1),
  };
}

const UTF8_ENCODER = new TextEncoder();
const DECODERS = new Map<string, TextDecoder>();

function textDecoderFor(charset: string): TextDecoder {
  const key = charset.trim().toLowerCase() || 'utf-8';
  let decoder = DECODERS.get(key);
  if (!decoder) {
    try {
      decoder = new TextDecoder(key);
    } catch {
      decoder = new TextDecoder('utf-8');
    }
    if (DECODERS.size < 32) DECODERS.set(key, decoder);
  }
  return decoder;
}

function hexDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  const lower = code | 0x20;
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : -1;
}

/** Reused between calls for ordinary values (decoding is synchronous), so a big export does not churn the GC. */
const SCRATCH = new Uint8Array(16384);

/** Decode quoted-printable to bytes, then to text in `charset` (default UTF-8). Stray '=' signs are dropped. */
function decodeQuotedPrintable(value: string, charset: string): string {
  // Every UTF-16 code unit becomes at most 3 bytes of UTF-8, and '=XX' becomes 1 byte.
  const bytes = value.length * 3 <= SCRATCH.length ? SCRATCH : new Uint8Array(value.length * 3);
  let length = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x3d) {
      const high = hexDigit(value.charCodeAt(i + 1));
      const low = high < 0 ? -1 : hexDigit(value.charCodeAt(i + 2));
      if (low >= 0) {
        bytes[length++] = high * 16 + low;
        i += 2;
      }
    } else if (code < 0x80) {
      bytes[length++] = code;
    } else {
      // Raw non-ASCII text inside a quoted-printable value (not allowed, but seen): keep it, as UTF-8.
      let end = i + 1;
      while (end < value.length && value.charCodeAt(end) >= 0x80) end++;
      length += UTF8_ENCODER.encodeInto(value.slice(i, end), bytes.subarray(length)).written;
      i = end - 1;
    }
  }
  return textDecoderFor(charset).decode(bytes.subarray(0, length));
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
      if (!tel) break;
      const customLabel = line.params.get('X-CUSTOM')?.find(Boolean) ?? '';
      draft.tels.push({ group: line.group, value: tel, types: line.params.get('TYPE') ?? [], customLabel });
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
    phones.push({ value: tel.value, label: groupLabel || tel.customLabel || labelFromTypes(tel.types) });
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
