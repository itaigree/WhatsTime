/** Locale-aware week layout: first day of the week and the usual working days. */

import { WEEKDAYS } from '../core/recurrence';
import type { Weekday } from '../core/types';

const SUNDAY_FIRST_REGIONS = new Set(['IL', 'US', 'CA', 'BR', 'JP', 'MX']);

export const SHORT_DAY_NAMES: Record<Weekday, string> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
};

export const LONG_DAY_NAMES: Record<Weekday, string> = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
};

interface WeekInfo {
  /** 1 = Monday ... 7 = Sunday */
  firstDay: number;
}

/** Intl.Locale week info: getWeekInfo() in current engines, a `weekInfo` getter in older Chrome. */
interface LocaleWeekInfo {
  getWeekInfo?: () => WeekInfo;
  weekInfo?: WeekInfo;
}

export function firstDayOfWeek(language: string): Weekday {
  try {
    const locale = new Intl.Locale(language);
    const withInfo = locale as unknown as LocaleWeekInfo;
    const info = typeof withInfo.getWeekInfo === 'function' ? withInfo.getWeekInfo() : withInfo.weekInfo;
    const fromInfo = info ? WEEKDAYS[info.firstDay - 1] : undefined;
    if (fromInfo) return fromInfo;
    const region = locale.maximize().region;
    return region && SUNDAY_FIRST_REGIONS.has(region) ? 'SU' : 'MO';
  } catch {
    return 'MO';
  }
}

/** All seven days starting from `first`. */
export function weekStartingOn(first: Weekday): Weekday[] {
  const index = WEEKDAYS.indexOf(first);
  return [...WEEKDAYS.slice(index), ...WEEKDAYS.slice(0, index)];
}

/** The working week for a region: Sun–Thu in Israel, Mon–Fri elsewhere. */
export function workweek(region: string): { label: string; days: Weekday[] } {
  return region === 'IL'
    ? { label: 'Sun–Thu', days: ['SU', 'MO', 'TU', 'WE', 'TH'] }
    : { label: 'Weekdays', days: ['MO', 'TU', 'WE', 'TH', 'FR'] };
}
