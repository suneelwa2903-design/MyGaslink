/**
 * Group A — GST mode transition guards.
 *
 * Shared between the legacy `settingsService.updateGstMode` (locked down to
 * super_admin in Step 6) and the new `gstActivationService` (Step 5). Keeping
 * the guard logic in one place means the new activation flow and any legacy
 * code path use identical semantics.
 *
 * The guards enforce the Group A target model:
 *   - Sandbox is reserved for tenants flagged `is_test_tenant=true`
 *     (dist-demo + internal dev fixtures). Real distributors transition
 *     disabled → live directly.
 *   - live → sandbox is permanently blocked. Once a tenant is live, the only
 *     reversal is live → disabled (via the dedicated /disable endpoint that
 *     Step 5 introduces).
 *   - live → disabled requires no in-flight GST documents (open EWBs, IRNs
 *     in flight, etc.). Surfaced as a separate check so callers can pass
 *     the count via prisma queries against `gst_documents`.
 *   - sandbox → live requires Layer 2 credentials present for both scopes
 *     in `gst_credentials`. Live mode without creds would NO_PROD_CREDS at
 *     the first API call; surface earlier with a clearer message.
 *
 * All guards throw a `GstTransitionError` so callers can choose how to surface
 * (400 vs 403 vs custom UI). The HTTP-layer mapping lives in the routes.
 */

export type GstMode = 'disabled' | 'sandbox' | 'live';

export class GstTransitionError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'GstTransitionError';
  }
}

/**
 * SANDBOX_ALLOWLIST — only test tenants can hold gst_mode='sandbox'.
 * Throws when a non-test tenant attempts to enter sandbox.
 */
export function assertSandboxAllowed(
  targetMode: GstMode,
  isTestTenant: boolean,
): void {
  if (targetMode === 'sandbox' && !isTestTenant) {
    throw new GstTransitionError(
      'Sandbox mode is reserved for internal test tenants only. ' +
        'Real distributors should be activated directly from disabled to live.',
      'SANDBOX_NOT_ALLOWED',
    );
  }
}

/**
 * LIVE_TO_SANDBOX_BLOCK — once a tenant is live, they can only transition to
 * disabled, never back to sandbox. Stops accidental downgrade of a live
 * tenant's data into the sandbox payload pipeline.
 */
export function assertNotLiveToSandbox(
  fromMode: GstMode,
  targetMode: GstMode,
): void {
  if (fromMode === 'live' && targetMode === 'sandbox') {
    throw new GstTransitionError(
      'Cannot transition from live to sandbox. Use disabled if you need to ' +
        'stop GST processing; the activation flow can re-enable live later.',
      'LIVE_TO_SANDBOX_BLOCKED',
    );
  }
}

/**
 * LIVE_TO_DISABLED_INFLIGHT — when transitioning a live tenant to disabled,
 * there must be no open compliance documents. inFlightCount is the number of
 * gst_documents rows where ewb_status='active' or irn_status='pending'/'success'
 * with no cancellation, queried by the caller against gst_documents.
 */
export function assertNoInFlightGstDocs(
  fromMode: GstMode,
  targetMode: GstMode,
  inFlightCount: number,
): void {
  if (fromMode === 'live' && targetMode === 'disabled' && inFlightCount > 0) {
    throw new GstTransitionError(
      `Cannot disable GST while ${inFlightCount} in-flight document(s) exist. ` +
        'Resolve open EWBs / IRN-pending invoices first.',
      'IN_FLIGHT_GST_DOCS',
    );
  }
}

/**
 * SANDBOX_TO_LIVE_NEEDS_CREDS — moving to live requires Layer 2 credentials
 * for both einvoice and ewaybill scopes. Without them the first WhiteBooks
 * call would throw NO_PROD_CREDS (env-level) OR NO_CREDENTIALS (DB-level)
 * mid-dispatch; surface earlier so the operator can fix before any order
 * tries to ship.
 */
export function assertLiveHasCredentials(
  targetMode: GstMode,
  einvoiceCredPresent: boolean,
  ewaybillCredPresent: boolean,
): void {
  if (targetMode !== 'live') return;
  const missing: string[] = [];
  if (!einvoiceCredPresent) missing.push('einvoice');
  if (!ewaybillCredPresent) missing.push('ewaybill');
  if (missing.length > 0) {
    throw new GstTransitionError(
      `Cannot activate live mode without Layer 2 credentials for: ${missing.join(', ')}. ` +
        'Provide username/password/email/gstin via the activation flow.',
      'LIVE_REQUIRES_CREDENTIALS',
    );
  }
}
