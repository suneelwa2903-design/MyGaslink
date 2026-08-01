/**
 * 2026-08-01 — guard tests for the previous-month grace window on
 * backdated invoices. The rule (isBackdatedIssueDateAllowed in
 * shared/constants) is: current calendar month always allowed;
 * previous calendar month allowed only when today's day-of-month is
 * ≤ PREV_MONTH_GRACE_DAYS (10).
 *
 * These tests exercise the pure helper with a synthetic `now` so they
 * are timezone-neutral and never flake on real calendar rollovers.
 */
import { describe, it, expect } from 'vitest';
import {
  isBackdatedIssueDateAllowed,
  backdatedRejectMessage,
  PREV_MONTH_GRACE_DAYS,
} from '@gaslink/shared';

describe('isBackdatedIssueDateAllowed — previous-month grace window', () => {
  it('accepts current-month dates regardless of day-of-month', () => {
    // Simulate: today = 2026-08-25
    const now = new Date(2026, 7, 25); // month is 0-indexed → August
    expect(isBackdatedIssueDateAllowed('2026-08-01', now)).toBe(true);
    expect(isBackdatedIssueDateAllowed('2026-08-15', now)).toBe(true);
    expect(isBackdatedIssueDateAllowed('2026-08-24', now)).toBe(true);
    expect(isBackdatedIssueDateAllowed('2026-08-25', now)).toBe(true);
  });

  it('accepts previous-month dates when today.day ≤ 10', () => {
    const now = new Date(2026, 7, 5); // 2026-08-05
    expect(isBackdatedIssueDateAllowed('2026-07-15', now)).toBe(true);
    expect(isBackdatedIssueDateAllowed('2026-07-01', now)).toBe(true);
    expect(isBackdatedIssueDateAllowed('2026-07-31', now)).toBe(true);
  });

  it('boundary — accepts previous month on exactly day 10, rejects on day 11', () => {
    expect(PREV_MONTH_GRACE_DAYS).toBe(10);
    const day10 = new Date(2026, 7, 10);
    const day11 = new Date(2026, 7, 11);
    expect(isBackdatedIssueDateAllowed('2026-07-30', day10)).toBe(true);
    expect(isBackdatedIssueDateAllowed('2026-07-30', day11)).toBe(false);
  });

  it('rejects two-months-back regardless of day-of-month', () => {
    const day5 = new Date(2026, 7, 5); // grace window OPEN, but ≥ 2 months back is still out
    expect(isBackdatedIssueDateAllowed('2026-06-15', day5)).toBe(false);
    expect(isBackdatedIssueDateAllowed('2026-05-01', day5)).toBe(false);
  });

  it('rejects future dates outright', () => {
    const now = new Date(2026, 7, 5);
    expect(isBackdatedIssueDateAllowed('2026-08-06', now)).toBe(true); // in-month future — filtered by the separate before-today refine, not this helper
    expect(isBackdatedIssueDateAllowed('2026-09-01', now)).toBe(false); // NEXT month rejected here
  });

  it('rejects malformed dates', () => {
    const now = new Date(2026, 7, 5);
    expect(isBackdatedIssueDateAllowed('', now)).toBe(false);
    expect(isBackdatedIssueDateAllowed('2026-8-5', now)).toBe(false);
    expect(isBackdatedIssueDateAllowed('not-a-date', now)).toBe(false);
  });

  it('handles January → previous month is December of previous year', () => {
    const jan5 = new Date(2027, 0, 5); // 2027-01-05
    expect(isBackdatedIssueDateAllowed('2026-12-31', jan5)).toBe(true);
    expect(isBackdatedIssueDateAllowed('2026-12-01', jan5)).toBe(true);
    const jan11 = new Date(2027, 0, 11);
    expect(isBackdatedIssueDateAllowed('2026-12-31', jan11)).toBe(false);
  });
});

describe('backdatedRejectMessage — user-facing copy', () => {
  it('mentions the grace window as OPEN when today.day ≤ 10', () => {
    const day5 = new Date(2026, 7, 5);
    expect(backdatedRejectMessage(day5)).toContain('current or previous calendar month');
    expect(backdatedRejectMessage(day5)).toContain('closes on the 10th');
  });

  it('mentions the grace window as CLOSED when today.day > 10', () => {
    const day15 = new Date(2026, 7, 15);
    expect(backdatedRejectMessage(day15)).toContain('current calendar month');
    expect(backdatedRejectMessage(day15)).toContain('ended on the 10th');
  });
});
