/**
 * buildPendingActionDescription — operator-facing message classifier.
 *
 * Pure function (no I/O). The 2026-05-30 surfacing fix added a NIC-code branch
 * that fires before the legacy DUPLICATE_IRN / GSTIN_INVALID / NIC_OUTAGE
 * pattern checks. These tests cover:
 *   - the new branch on known codes (glossary remedies)
 *   - the new branch on unknown codes (fallback shows code + raw excerpt)
 *   - the legacy branches are untouched for messages with no numeric code
 *   - backward-compatible errorCode values for the 4 overlap codes
 *     (2150 → DUPLICATE_IRN, 3028/3029 → GSTIN_INVALID, 5002 → NIC_OUTAGE)
 *     so existing UIs and the gst-2150-recovery.test.ts assertion still pass.
 */
import { describe, it, expect } from 'vitest';
import { buildPendingActionDescription } from '../../services/gst/gstService.js';

const CTX = {
  invoiceNumber: 'INV-PLATE-TEST',
  orderNumber: 'ORD-001',
  customerName: 'Demo Agencies',
};

describe('buildPendingActionDescription — NIC code branch (new)', () => {
  it('225 → invalid vehicle remedy + errorCode NIC_225', () => {
    const raw = 'Order ORD-001: IRN succeeded but EWB failed — {"errorCodes":"225,"}';
    const out = buildPendingActionDescription('EWB_GENERATION', raw, CTX);
    expect(out.description).toMatch(/NIC error 225/);
    expect(out.description).toMatch(/Invalid vehicle registration/);
    expect(out.description).toMatch(/KA01-AB-1234/);
    expect(out.errorCode).toBe('NIC_225');
  });

  it('702 → distance remedy + errorCode NIC_702', () => {
    const raw = '{"errorCodes":"702,"}';
    const out = buildPendingActionDescription('EWB_GENERATION', raw, CTX);
    expect(out.description).toMatch(/NIC error 702/);
    expect(out.description).toMatch(/distance/i);
    expect(out.errorCode).toBe('NIC_702');
  });

  it('616 → JSON validation remedy + errorCode NIC_616', () => {
    const raw = '{"errorCodes":"616,"}';
    const out = buildPendingActionDescription('IRN_GENERATION', raw, CTX);
    expect(out.description).toMatch(/NIC error 616/);
    expect(out.description).toMatch(/JSON validation/i);
    expect(out.errorCode).toBe('NIC_616');
  });

  it('721 → zero distance remedy', () => {
    const raw = '{"errorCodes":"721,"}';
    const out = buildPendingActionDescription('EWB_GENERATION', raw, CTX);
    expect(out.description).toMatch(/Zero distance/);
    expect(out.errorCode).toBe('NIC_721');
  });

  it('unknown code 9999 → fallback shows code + raw excerpt', () => {
    const raw = 'Order ORD-001: IRN succeeded but EWB failed — {"errorCodes":"9999,"}';
    const out = buildPendingActionDescription('EWB_GENERATION', raw, CTX);
    expect(out.description).toMatch(/NIC error 9999/);
    expect(out.description).toContain(raw.slice(0, 150));
    expect(out.description).toMatch(/Click Retry or contact support/);
    expect(out.errorCode).toBe('NIC_9999');
  });
});

describe('buildPendingActionDescription — backward-compatible errorCode for overlap codes', () => {
  // Existing gst-2150-recovery.test.ts asserts errorCode === 'DUPLICATE_IRN'.
  // We preserve that for the four codes that overlap with the legacy branches.
  it('2150 → glossary remedy text BUT errorCode stays DUPLICATE_IRN', () => {
    const raw = '{"errorCodes":"2150,"}';
    const out = buildPendingActionDescription('IRN_GENERATION', raw, CTX);
    expect(out.description).toMatch(/duplicate IRN/i);
    expect(out.errorCode).toBe('DUPLICATE_IRN');
  });

  it('3028 → glossary remedy text BUT errorCode stays GSTIN_INVALID', () => {
    const raw = '{"errorCodes":"3028,"}';
    const out = buildPendingActionDescription('IRN_GENERATION', raw, CTX);
    expect(out.description).toMatch(/Supplier GSTIN invalid/);
    expect(out.errorCode).toBe('GSTIN_INVALID');
  });

  it('3029 → glossary remedy text BUT errorCode stays GSTIN_INVALID', () => {
    const raw = '{"errorCodes":"3029,"}';
    const out = buildPendingActionDescription('IRN_GENERATION', raw, CTX);
    expect(out.description).toMatch(/Recipient GSTIN invalid/);
    expect(out.errorCode).toBe('GSTIN_INVALID');
  });

  it('5002 (no glossary entry, but in legacy table) → falls back to "NIC error N." + errorCode NIC_OUTAGE', () => {
    const raw = '{"errorCodes":"5002,"}';
    const out = buildPendingActionDescription('IRN_GENERATION', raw, CTX);
    expect(out.description).toMatch(/NIC error 5002/);
    expect(out.errorCode).toBe('NIC_OUTAGE');
  });
});

describe('buildPendingActionDescription — legacy branches untouched when no numeric code', () => {
  it('Plain "duplicate IRN" text → existing DUPLICATE_IRN classifier', () => {
    const out = buildPendingActionDescription(
      'IRN_GENERATION',
      'IRN already exists on portal — duplicate IRN detected',
      CTX,
    );
    expect(out.description).toMatch(/duplicate IRN/i);
    expect(out.errorCode).toBe('DUPLICATE_IRN');
  });

  it('Plain "invalid GSTIN" text → existing GSTIN_INVALID classifier', () => {
    const out = buildPendingActionDescription(
      'IRN_GENERATION',
      'invalid GSTIN on file',
      CTX,
    );
    expect(out.description).toMatch(/GSTIN/i);
    expect(out.errorCode).toBe('GSTIN_INVALID');
  });

  it('Connection timeout → existing NIC_OUTAGE classifier', () => {
    const out = buildPendingActionDescription(
      'IRN_GENERATION',
      'connection timeout after 30s',
      CTX,
    );
    expect(out.description).toMatch(/temporarily unavailable/i);
    expect(out.errorCode).toBe('NIC_OUTAGE');
  });

  it('EWB_GENERATION with no numeric code and no pattern match → existing generic fallback', () => {
    const out = buildPendingActionDescription(
      'EWB_GENERATION',
      'something opaque happened',
      CTX,
    );
    expect(out.description).toMatch(/failed unexpectedly/);
    expect(out.errorCode).toBeNull();
  });

  it('IRN_GENERATION with no numeric code and no pattern match → existing generic fallback', () => {
    const out = buildPendingActionDescription(
      'IRN_GENERATION',
      'something opaque happened',
      CTX,
    );
    expect(out.description).toMatch(/IRN.*generation failed/i);
    expect(out.errorCode).toBeNull();
  });
});
