import { describe, expect, it } from 'vitest';
import { addDays, daysInMonth, diffDays, isValidDate, isValidTime, isoWeekdayIndex, toIcsLocal, toIcsUtc } from '../../src/core/dates';
import { formatOffset, isValidTimeZone, offsetMinutesAt, utcToZoned, zonedTimeToUtc } from '../../src/core/timezone';

describe('dates', () => {
  it('validates dates and times', () => {
    expect(isValidDate('2024-02-29')).toBe(true);
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidDate('2026-1-01')).toBe(false);
    expect(isValidTime('23:59')).toBe(true);
    expect(isValidTime('24:00')).toBe(false);
    expect(isValidTime('9:00')).toBe(false);
  });

  it('does date arithmetic across month, year and DST boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-03-27', 3)).toBe('2026-03-30');
    expect(diffDays('2026-01-01', '2027-01-01')).toBe(365);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(isoWeekdayIndex('2026-10-22')).toBe(3); // Thursday
    expect(isoWeekdayIndex('2026-10-25')).toBe(6); // Sunday
  });

  it('formats iCalendar date-times', () => {
    expect(toIcsLocal('2026-10-22', '09:05')).toBe('20261022T090500');
    expect(toIcsUtc(new Date(Date.UTC(2026, 9, 22, 7, 5, 9, 123)))).toBe('20261022T070509Z');
  });
});

describe('timezone', () => {
  it('recognises zones', () => {
    expect(isValidTimeZone('Asia/Jerusalem')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('computes offsets including half-hour zones', () => {
    expect(offsetMinutesAt('Asia/Jerusalem', Date.UTC(2026, 0, 15))).toBe(120);
    expect(offsetMinutesAt('Asia/Jerusalem', Date.UTC(2026, 6, 15))).toBe(180);
    expect(offsetMinutesAt('Asia/Kolkata', Date.UTC(2026, 6, 15))).toBe(330);
    expect(offsetMinutesAt('America/St_Johns', Date.UTC(2026, 0, 15))).toBe(-210);
    expect(formatOffset(330)).toBe('GMT+05:30');
    expect(formatOffset(-210)).toBe('GMT-03:30');
  });

  it('converts ordinary wall-clock times', () => {
    expect(zonedTimeToUtc({ date: '2026-10-22', time: '09:00' }, 'Asia/Jerusalem').toISOString()).toBe('2026-10-22T06:00:00.000Z');
    expect(zonedTimeToUtc({ date: '2026-01-10', time: '09:00' }, 'America/New_York').toISOString()).toBe('2026-01-10T14:00:00.000Z');
    expect(zonedTimeToUtc({ date: '2026-01-10', time: '23:59' }, 'UTC').toISOString()).toBe('2026-01-10T23:59:00.000Z');
  });

  it('resolves DST gaps forward and overlaps to the first occurrence', () => {
    // US spring forward 2026-03-08 02:00 -> 03:00; 02:30 does not exist.
    expect(zonedTimeToUtc({ date: '2026-03-08', time: '02:30' }, 'America/New_York').toISOString()).toBe('2026-03-08T07:30:00.000Z');
    // US fall back 2026-11-01 02:00 -> 01:00; 01:30 happens twice, take the first (EDT).
    expect(zonedTimeToUtc({ date: '2026-11-01', time: '01:30' }, 'America/New_York').toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('round-trips utcToZoned', () => {
    const d = new Date('2026-07-01T21:30:00Z');
    expect(utcToZoned(d, 'Asia/Jerusalem')).toEqual({ date: '2026-07-02', time: '00:30', second: 0 });
  });
});

describe('dates in years 1-99', () => {
  it('does not shift them into the 1900s', () => {
    expect(addDays('0050-02-28', 1)).toBe('0050-03-01');
    expect(isoWeekdayIndex('0001-01-01')).toBe(0); // proleptic Gregorian Monday
    expect(daysInMonth(4, 2)).toBe(29);
  });
});
