import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isWithin24Hours } from './gstWindows';

describe('isWithin24Hours', () => {
  const NOW = new Date('2026-06-20T12:00:00.000Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true for a date 1 hour ago', () => {
    expect(isWithin24Hours('2026-06-20T11:00:00.000Z')).toBe(true);
  });

  it('returns true for a date 23 hours 59 minutes ago', () => {
    expect(isWithin24Hours('2026-06-19T12:01:00.000Z')).toBe(true);
  });

  it('returns false for a date exactly 24 hours ago', () => {
    expect(isWithin24Hours('2026-06-19T12:00:00.000Z')).toBe(false);
  });

  it('returns false for a date 25 hours ago', () => {
    expect(isWithin24Hours('2026-06-19T11:00:00.000Z')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isWithin24Hours(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isWithin24Hours(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isWithin24Hours('')).toBe(false);
  });

  it('returns false for an invalid date string', () => {
    expect(isWithin24Hours('not-a-date')).toBe(false);
  });

  it('returns true for a future date (clock skew tolerance)', () => {
    // Future timestamps yield negative age, < 24 → true. We treat this as
    // "yes, within window" since clock skew between client and server is the
    // most likely cause. Better to show the button than hide a legit retry.
    expect(isWithin24Hours('2026-06-21T00:00:00.000Z')).toBe(true);
  });
});
