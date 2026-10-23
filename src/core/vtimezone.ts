/**
 * Builds RFC 5545 VTIMEZONE components from the IANA data that Intl ships,
 * so .ics files carry their own zone rules and every client agrees on the
 * UTC instant of a TZID-qualified local time.
 */

import { daysInMonth } from './dates';
import { offsetMinutesAt } from './timezone';

const MINUTE = 60_000;
const DAY = 86_400_000;
/**
 * Probe interval of the transition scan; an offset that lasts less than this could be missed. The shortest-lived
 * offset in the tz database between 1970 and 2060 lasts 7 days (Brazil 2000, Gaza 2040).
 */
const SCAN_STEP = 3 * DAY;
/** Years after a run consulted to pin down its 7-day window (12 years show every position) and whether it continues. */
const LOOKAHEAD_YEARS = 12;
const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Monday ... 6 = Sunday */
  weekday: number;
}

interface Transition {
  /** Instant of the change, ms since epoch. */
  utc: number;
  /** Offsets in minutes (local minus UTC) before and after the change. */
  from: number;
  to: number;
  /** Wall-clock time of the change in the `from` offset (the RFC 5545 DTSTART/RDATE form). */
  local: WallTime;
}

interface Observance {
  from: number;
  to: number;
  start: WallTime;
  /** Sort key. */
  startUtc: number;
  props: string[];
}

/** Generating takes a few thousand Intl calls, so results are memoised (bounded: cleared when full). */
const cache = new Map<string, readonly string[]>();
const CACHE_LIMIT = 32;

/**
 * Unfolded content lines 'BEGIN:VTIMEZONE' ... 'END:VTIMEZONE' describing `tzid` well enough that RFC 5545 clients
 * compute the same UTC instants as Intl does for every date from Jan 1 of fromYear through Dec 31 of toYear.
 * Regular yearly transitions become open-ended RRULEs so the zone keeps working after toYear; irregular ones
 * become explicit RDATEs. Throws RangeError for an unknown zone.
 */
export function buildVTimezone(tzid: string, fromYear: number, toYear: number): string[] {
  const lastYear = Math.max(fromYear, toYear);
  const key = `${tzid}|${fromYear}|${lastYear}`;
  let lines = cache.get(key);
  if (!lines) {
    lines = generate(tzid, fromYear, lastYear);
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, lines);
  }
  return [...lines];
}

/** RFC 5545 UTC-OFFSET value: '+0200', '-0330', '+0545'; zero is '+0000' (never '-0000'). */
export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

function generate(tzid: string, fromYear: number, toYear: number): string[] {
  // Scanning one extra year finds the change that set the offset in force on Jan 1 of fromYear.
  const scanStart = Date.UTC(fromYear - 1, 0, 1);
  const transitions = findTransitions(tzid, scanStart, Date.UTC(toYear + 1, 0, 2));
  const { observances, leftovers } = yearlyRules(tzid, transitions, toYear);
  observances.push(...explicitDates(leftovers));
  const first = transitions[0];
  if (!first || first.utc > Date.UTC(fromYear, 0, 1) - first.from * MINUTE) {
    observances.push(fixedOffset(first ? first.from : offsetMinutesAt(tzid, scanStart), Math.min(0, scanStart)));
  }
  observances.sort((a, b) => a.startUtc - b.startUtc);
  return ['BEGIN:VTIMEZONE', `TZID:${tzid}`, ...observances.flatMap(render), 'END:VTIMEZONE'];
}

/** Every offset change in (startMs, endMs], located to the minute. */
function findTransitions(tzid: string, startMs: number, endMs: number): Transition[] {
  const result: Transition[] = [];
  let lo = startMs;
  let loOffset = offsetMinutesAt(tzid, lo);
  while (lo < endMs) {
    const probe = Math.min(lo + SCAN_STEP, endMs);
    const probeOffset = offsetMinutesAt(tzid, probe);
    while (probeOffset !== loOffset) {
      const utc = firstMinuteWithNewOffset(tzid, lo, probe, loOffset);
      const to = offsetMinutesAt(tzid, utc);
      result.push({ utc, from: loOffset, to, local: wallTime(utc + loOffset * MINUTE) });
      lo = utc;
      loOffset = to;
    }
    lo = probe;
  }
  return result;
}

/** Binary search for the first minute in (lo, hi] whose offset differs from `offset`. */
function firstMinuteWithNewOffset(tzid: string, lo: number, hi: number, offset: number): number {
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (offsetMinutesAt(tzid, mid) === offset) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Turns runs of transitions that recur every year (same offsets, month, weekday and wall time, with all days
 * inside one 7-day window) into RRULE observances. Single transitions that do not continue are left over.
 */
function yearlyRules(
  tzid: string,
  transitions: readonly Transition[],
  toYear: number,
): { observances: Observance[]; leftovers: Transition[] } {
  const observances: Observance[] = [];
  const leftovers: Transition[] = [];
  for (const chain of yearlyChains(transitions)) {
    const first = chain[0] as Transition;
    const last = chain[chain.length - 1] as Transition;
    const windowStart = chooseWindow(tzid, chain);
    const continues = last.local.year >= toYear && ruleHolds(tzid, last, windowStart, last.local.year + 1);
    if (chain.length < 2 && !continues) {
      leftovers.push(first);
      continue;
    }
    const { month, weekday } = first.local;
    let rrule = `RRULE:FREQ=YEARLY;BYMONTH=${month};${dayRule(WEEKDAY_CODES[weekday] as string, month, windowStart)}`;
    if (!continues) rrule += `;UNTIL=${formatUtc(last.utc)}`;
    observances.push(observance(first, [rrule]));
  }
  return { observances, leftovers };
}

function yearlyChains(transitions: readonly Transition[]): Transition[][] {
  const latest = new Map<string, Transition[]>();
  const chains: Transition[][] = [];
  for (const t of transitions) {
    const { month, weekday, hour, minute, second } = t.local;
    const key = [t.from, t.to, month, weekday, hour, minute, second].join('|');
    const chain = latest.get(key);
    const prev = chain?.[chain.length - 1];
    if (chain && prev?.local.year === t.local.year - 1 && daySpread([...chain, t]) <= 6) {
      chain.push(t);
    } else {
      const fresh = [t];
      latest.set(key, fresh);
      chains.push(fresh);
    }
  }
  return chains;
}

function daySpread(chain: readonly Transition[]): number {
  const days = chain.map((t) => t.local.day);
  return Math.max(...days) - Math.min(...days);
}

/** Irregular transitions grouped by offset pair: DTSTART plus one RDATE per change (DTSTART included). */
function explicitDates(transitions: readonly Transition[]): Observance[] {
  const groups = new Map<string, Transition[]>();
  for (const t of transitions) {
    const key = `${t.from}|${t.to}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups.values()].map((group) =>
    observance(group[0] as Transition, group.map((t) => `RDATE:${formatLocal(t.local)}`)),
  );
}

function observance(first: Transition, props: string[]): Observance {
  return { from: first.from, to: first.to, start: first.local, startUtc: first.utc, props };
}

/**
 * A constant offset for zones without changes and for the time before the first change. It starts in 1970, or
 * earlier when the range does, since clients treat times before the first observance as UTC.
 */
function fixedOffset(offset: number, sinceMs: number): Observance {
  return { from: offset, to: offset, start: wallTime(sinceMs), startUtc: Number.NEGATIVE_INFINITY, props: [] };
}

function render(o: Observance): string[] {
  const kind = o.to > o.from ? 'DAYLIGHT' : 'STANDARD';
  return [
    `BEGIN:${kind}`,
    `DTSTART:${formatLocal(o.start)}`,
    `TZOFFSETFROM:${formatUtcOffset(o.from)}`,
    `TZOFFSETTO:${formatUtcOffset(o.to)}`,
    ...o.props,
    `END:${kind}`,
  ];
}

const longestMonth = (month: number): number => daysInMonth(2000, month);

/**
 * First day of the 7-day BYMONTHDAY window. Every day observed in the chain must fit; when several windows fit,
 * the one that also reproduces the zone's changes in the following years wins, then the conventional ones
 * (last week of the month, 2nd, 1st, 3rd, 4th week).
 */
function chooseWindow(tzid: string, chain: readonly Transition[]): number {
  const days = chain.map((t) => t.local.day);
  const sample = chain[chain.length - 1] as Transition;
  const lo = Math.max(1, Math.max(...days) - 6);
  const hi = Math.min(Math.min(...days), longestMonth(sample.local.month) - 6);
  if (lo >= hi) return lo;
  const conventional = [longestMonth(sample.local.month) - 6, 8, 1, 15, 22];
  const rank = (start: number): number => {
    const i = conventional.indexOf(start);
    return i < 0 ? conventional.length : i;
  };
  const scored = [];
  for (let start = lo; start <= hi; start++) {
    let score = 0;
    for (let i = 1; i <= LOOKAHEAD_YEARS; i++) {
      if (ruleHolds(tzid, sample, start, sample.local.year + i)) score++;
    }
    scored.push({ start, score });
  }
  scored.sort((a, b) => b.score - a.score || rank(a.start) - rank(b.start) || a.start - b.start);
  return (scored[0] as { start: number }).start;
}

/** Whether the yearly rule of `sample` with the given window reproduces Intl's change in `year`. */
function ruleHolds(tzid: string, sample: Transition, windowStart: number, year: number): boolean {
  const { month, weekday, hour, minute, second } = sample.local;
  const day = windowDays(windowStart).find(
    (d) => d <= daysInMonth(year, month) && (new Date(Date.UTC(year, month - 1, d)).getUTCDay() + 6) % 7 === weekday,
  );
  if (day === undefined) return false;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second) - sample.from * MINUTE;
  return offsetMinutesAt(tzid, utc - MINUTE) === sample.from && offsetMinutesAt(tzid, utc) === sample.to;
}

/**
 * 'BYDAY=2SU' / 'BYDAY=-1SU' when the 7-day window is a whole week of the month (the only form some clients,
 * notably Outlook, understand), else the general 'BYDAY=FR;BYMONTHDAY=23,...,29' form (e.g. Israel's
 * "Friday before the last Sunday of March").
 */
function dayRule(weekday: string, month: number, windowStart: number): string {
  const nth = [1, 8, 15, 22].indexOf(windowStart) + 1;
  if (nth > 0) return `BYDAY=${nth}${weekday}`;
  // February's length varies, so its last week is not a fixed window.
  if (month !== 2 && windowStart === daysInMonth(2001, month) - 6) return `BYDAY=-1${weekday}`;
  return `BYDAY=${weekday};BYMONTHDAY=${windowDays(windowStart).join(',')}`;
}

function windowDays(start: number): number[] {
  return Array.from({ length: 7 }, (_, i) => start + i);
}

function wallTime(ms: number): WallTime {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: (d.getUTCDay() + 6) % 7,
  };
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function formatLocal(t: WallTime): string {
  return `${pad(t.year, 4)}${pad(t.month)}${pad(t.day)}T${pad(t.hour)}${pad(t.minute)}${pad(t.second)}`;
}

function formatUtc(ms: number): string {
  return `${formatLocal(wallTime(ms))}Z`;
}
