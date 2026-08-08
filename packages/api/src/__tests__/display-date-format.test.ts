/**
 * DATE-FIX Phase 1 — unit battery for the canonical display formatters
 * (@gaslink/shared: formatDisplayDate / formatDisplayDateTime).
 *
 * These are the ONE way the whole app renders dates → dd/MM/yyyy. They are
 * display-only and must be TZ-safe (a bare YYYY-MM-DD must never roll a day),
 * robust to null/garbage, and never throw. See docs/DATE-FORMAT-AUDIT.md.
 */
import { describe, it, expect } from 'vitest';
import { formatDisplayDate, formatDisplayDateTime } from '@gaslink/shared';

describe('formatDisplayDate — positive', () => {
  it('bare ISO YYYY-MM-DD → dd/MM/yyyy', () => {
    expect(formatDisplayDate('2026-08-12')).toBe('12/08/2026');
  });
  it('zero-pads single-digit day and month', () => {
    expect(formatDisplayDate('2026-01-05')).toBe('05/01/2026');
    expect(formatDisplayDate('2026-09-09')).toBe('09/09/2026');
  });
  it('ISO datetime string → date part only', () => {
    expect(formatDisplayDate('2026-08-12T10:30:00.000Z')).toBe('12/08/2026');
    expect(formatDisplayDate('2026-08-12T23:59:59+05:30')).toBe('12/08/2026');
  });
  it('Date object → dd/MM/yyyy (local components)', () => {
    expect(formatDisplayDate(new Date(2026, 7, 12))).toBe('12/08/2026'); // month 7 = August
  });
  it('year boundary', () => {
    expect(formatDisplayDate('2026-12-31')).toBe('31/12/2026');
    expect(formatDisplayDate('2027-01-01')).toBe('01/01/2027');
  });
  it('leap day', () => {
    expect(formatDisplayDate('2024-02-29')).toBe('29/02/2024');
  });
});

describe('formatDisplayDate — TZ safety (anti-pattern #21)', () => {
  it('bare YYYY-MM-DD is split directly, never new Date() — no UTC/IST day roll', () => {
    // A midnight-boundary date that new Date(str) would parse as UTC and
    // could render as the previous day in negative-offset zones. We must
    // always echo the calendar date as written.
    expect(formatDisplayDate('2026-07-12')).toBe('12/07/2026');
    expect(formatDisplayDate('2026-03-01')).toBe('01/03/2026');
  });
});

describe('formatDisplayDate — negative / robustness', () => {
  it('null / undefined / empty → em dash', () => {
    expect(formatDisplayDate(null)).toBe('—');
    expect(formatDisplayDate(undefined)).toBe('—');
    expect(formatDisplayDate('')).toBe('—');
  });
  it('garbage string → em dash, never throws', () => {
    expect(formatDisplayDate('not-a-date')).toBe('—');
    expect(formatDisplayDate('hello world')).toBe('—');
  });
  it('non-ISO but parseable string still renders (JS Date accepts it)', () => {
    // '2026/08/12' is US-style and parseable; we render rather than dash.
    expect(formatDisplayDate('2026/08/12')).toBe('12/08/2026');
  });
  it('invalid Date → em dash', () => {
    expect(formatDisplayDate(new Date('nonsense'))).toBe('—');
  });
});

describe('formatDisplayDateTime', () => {
  it('am / pm rendering', () => {
    expect(formatDisplayDateTime(new Date(2026, 7, 12, 10, 30))).toBe('12/08/2026, 10:30 am');
    expect(formatDisplayDateTime(new Date(2026, 7, 12, 14, 5))).toBe('12/08/2026, 2:05 pm');
  });
  it('midnight → 12 am, noon → 12 pm', () => {
    expect(formatDisplayDateTime(new Date(2026, 7, 12, 0, 0))).toBe('12/08/2026, 12:00 am');
    expect(formatDisplayDateTime(new Date(2026, 7, 12, 12, 0))).toBe('12/08/2026, 12:00 pm');
  });
  it('zero-pads minutes', () => {
    expect(formatDisplayDateTime(new Date(2026, 7, 12, 9, 4))).toBe('12/08/2026, 9:04 am');
  });
  it('null / invalid → em dash', () => {
    expect(formatDisplayDateTime(null)).toBe('—');
    expect(formatDisplayDateTime(new Date('nonsense'))).toBe('—');
  });
});
