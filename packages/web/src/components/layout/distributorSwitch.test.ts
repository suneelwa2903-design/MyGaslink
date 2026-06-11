/**
 * Tests for the DistributorSelector switch-effect decision logic.
 * Pure-TS unit tests (matching noteBadge.test.ts style) + a source-file
 * assertion that the component uses invalidateQueries — not resetQueries
 * — so the no-flicker guarantee can't silently regress.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldInvalidateOnDistributorSwitch } from './distributorSwitch';

describe('shouldInvalidateOnDistributorSwitch', () => {
  describe('super-admin', () => {
    it('null → X (first explicit pick) triggers invalidation — fixes the silent-skip bug', () => {
      expect(shouldInvalidateOnDistributorSwitch(null, 'dist-001', true)).toBe(true);
    });

    it('X → Y (tenant swap) triggers invalidation', () => {
      expect(shouldInvalidateOnDistributorSwitch('dist-001', 'dist-002', true)).toBe(true);
    });

    it('X → null (logout / clear) triggers invalidation', () => {
      expect(shouldInvalidateOnDistributorSwitch('dist-001', null, true)).toBe(true);
    });

    it('X → X (no real change — re-render with same value) does NOT trigger invalidation', () => {
      expect(shouldInvalidateOnDistributorSwitch('dist-001', 'dist-001', true)).toBe(false);
    });

    it('null → null does NOT trigger invalidation', () => {
      expect(shouldInvalidateOnDistributorSwitch(null, null, true)).toBe(false);
    });
  });

  describe('non-super-admin', () => {
    it('auto-select null → X does NOT invalidate — distributor-scoped queries key on distributorId and refetch on their own', () => {
      expect(shouldInvalidateOnDistributorSwitch(null, 'dist-001', false)).toBe(false);
    });

    it('any other transition for non-super-admin is a no-op (they cannot switch tenants)', () => {
      expect(shouldInvalidateOnDistributorSwitch('dist-001', 'dist-002', false)).toBe(false);
      expect(shouldInvalidateOnDistributorSwitch('dist-001', null, false)).toBe(false);
      expect(shouldInvalidateOnDistributorSwitch(null, null, false)).toBe(false);
    });
  });
});

describe('DistributorSelector — source guards', () => {
  const selectorSource = readFileSync(
    resolve(__dirname, './DistributorSelector.tsx'),
    'utf-8',
  );

  it('does NOT call queryClient.resetQueries (would cause cache flicker)', () => {
    expect(selectorSource).not.toMatch(/resetQueries\s*\(/);
  });

  it('calls queryClient.invalidateQueries (keeps prior data visible until new lands)', () => {
    expect(selectorSource).toMatch(/invalidateQueries\s*\(/);
  });

  it('routes the switch decision through the shouldInvalidateOnDistributorSwitch helper', () => {
    expect(selectorSource).toContain('shouldInvalidateOnDistributorSwitch');
  });
});
