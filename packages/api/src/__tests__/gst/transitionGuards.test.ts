// Group A Step 3-4 — GST mode transition guards.
// Pure unit tests — no DB, no HTTP. Asserts each guard fires (and only fires)
// when its preconditions are met.
import { describe, it, expect } from 'vitest';
import {
  assertSandboxAllowed,
  assertNotLiveToSandbox,
  assertNoInFlightGstDocs,
  assertLiveHasCredentials,
  GstTransitionError,
} from '../../services/gst/transitionGuards.js';

describe('assertSandboxAllowed', () => {
  it('throws when target=sandbox and is_test_tenant=false', () => {
    expect(() => assertSandboxAllowed('sandbox', false)).toThrow(GstTransitionError);
    try {
      assertSandboxAllowed('sandbox', false);
    } catch (e) {
      expect((e as GstTransitionError).code).toBe('SANDBOX_NOT_ALLOWED');
    }
  });

  it('passes when target=sandbox and is_test_tenant=true', () => {
    expect(() => assertSandboxAllowed('sandbox', true)).not.toThrow();
  });

  it('passes when target=disabled regardless of test-tenant flag', () => {
    expect(() => assertSandboxAllowed('disabled', false)).not.toThrow();
    expect(() => assertSandboxAllowed('disabled', true)).not.toThrow();
  });

  it('passes when target=live regardless of test-tenant flag', () => {
    expect(() => assertSandboxAllowed('live', false)).not.toThrow();
    expect(() => assertSandboxAllowed('live', true)).not.toThrow();
  });
});

describe('assertNotLiveToSandbox', () => {
  it('throws on live → sandbox', () => {
    expect(() => assertNotLiveToSandbox('live', 'sandbox')).toThrow(GstTransitionError);
    try {
      assertNotLiveToSandbox('live', 'sandbox');
    } catch (e) {
      expect((e as GstTransitionError).code).toBe('LIVE_TO_SANDBOX_BLOCKED');
    }
  });

  it('passes on live → disabled', () => {
    expect(() => assertNotLiveToSandbox('live', 'disabled')).not.toThrow();
  });

  it('passes on disabled → sandbox (entering sandbox from outside)', () => {
    expect(() => assertNotLiveToSandbox('disabled', 'sandbox')).not.toThrow();
  });

  it('passes on sandbox → live (the normal activation path for test tenants)', () => {
    expect(() => assertNotLiveToSandbox('sandbox', 'live')).not.toThrow();
  });
});

describe('assertNoInFlightGstDocs', () => {
  it('throws on live → disabled when in-flight docs exist', () => {
    expect(() => assertNoInFlightGstDocs('live', 'disabled', 1)).toThrow(GstTransitionError);
    expect(() => assertNoInFlightGstDocs('live', 'disabled', 99)).toThrow(GstTransitionError);
    try {
      assertNoInFlightGstDocs('live', 'disabled', 3);
    } catch (e) {
      expect((e as GstTransitionError).code).toBe('IN_FLIGHT_GST_DOCS');
      expect((e as GstTransitionError).message).toContain('3');
    }
  });

  it('passes on live → disabled when no in-flight docs', () => {
    expect(() => assertNoInFlightGstDocs('live', 'disabled', 0)).not.toThrow();
  });

  it('does NOT block disabled → live (no check on the live activation path)', () => {
    expect(() => assertNoInFlightGstDocs('disabled', 'live', 5)).not.toThrow();
  });

  it('does NOT block sandbox → disabled (no live → disabled trigger)', () => {
    expect(() => assertNoInFlightGstDocs('sandbox', 'disabled', 5)).not.toThrow();
  });
});

describe('assertLiveHasCredentials', () => {
  it('throws when activating live with no einvoice creds', () => {
    expect(() => assertLiveHasCredentials('live', false, true)).toThrow(GstTransitionError);
    try {
      assertLiveHasCredentials('live', false, true);
    } catch (e) {
      expect((e as GstTransitionError).code).toBe('LIVE_REQUIRES_CREDENTIALS');
      expect((e as GstTransitionError).message).toContain('einvoice');
    }
  });

  it('throws when activating live with no ewaybill creds', () => {
    expect(() => assertLiveHasCredentials('live', true, false)).toThrow(GstTransitionError);
    try {
      assertLiveHasCredentials('live', true, false);
    } catch (e) {
      expect((e as GstTransitionError).message).toContain('ewaybill');
    }
  });

  it('throws when both scopes missing — message lists both', () => {
    expect(() => assertLiveHasCredentials('live', false, false)).toThrow(GstTransitionError);
    try {
      assertLiveHasCredentials('live', false, false);
    } catch (e) {
      expect((e as GstTransitionError).message).toMatch(/einvoice.*ewaybill|ewaybill.*einvoice/);
    }
  });

  it('passes when both scopes have creds', () => {
    expect(() => assertLiveHasCredentials('live', true, true)).not.toThrow();
  });

  it('does NOT enforce on target=sandbox or target=disabled', () => {
    expect(() => assertLiveHasCredentials('sandbox', false, false)).not.toThrow();
    expect(() => assertLiveHasCredentials('disabled', false, false)).not.toThrow();
  });
});
