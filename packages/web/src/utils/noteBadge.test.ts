/**
 * Unit tests for the CN/DN count badge label formatter.
 * Pure-TS test — no JSX rendering, no DOM. Runs in vitest's default
 * node environment.
 */
import { describe, it, expect } from 'vitest';
import { formatNoteCountLabel } from './noteBadge';

describe('formatNoteCountLabel', () => {
  it('returns just the prefix when count === 1 (singular)', () => {
    expect(formatNoteCountLabel(1, 'CN')).toBe('CN');
    expect(formatNoteCountLabel(1, 'DN')).toBe('DN');
  });

  it('returns "PREFIX ×N" for counts >= 2', () => {
    expect(formatNoteCountLabel(2, 'CN')).toBe('CN ×2');
    expect(formatNoteCountLabel(3, 'DN')).toBe('DN ×3');
    expect(formatNoteCountLabel(10, 'CN')).toBe('CN ×10');
  });

  it('returns empty string for non-positive / non-finite counts so the caller can skip rendering', () => {
    expect(formatNoteCountLabel(0, 'CN')).toBe('');
    expect(formatNoteCountLabel(-1, 'CN')).toBe('');
    expect(formatNoteCountLabel(Number.NaN, 'CN')).toBe('');
  });
});
