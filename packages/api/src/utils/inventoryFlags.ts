/**
 * WI-106 — feature flag for the dispatch-debit inventory model.
 *
 * When OFF (default — env var absent or anything other than 'true'), every
 * inventory code path behaves byte-for-byte as it did before WI-106: depot
 * fulls are debited at delivery, cancelOrder writes a `cancellation` event,
 * and the closing-stock formula uses delivered-based accounting.
 *
 * When ON (INVENTORY_DISPATCH_DEBIT='true'), depot fulls are debited at
 * dispatch time, cancelOrder skips the `cancellation` event, and the formula
 * switches to dispatch-based accounting. Roll out per-environment; lock
 * historical summaries first (see scripts/lock-historical-summaries.ts).
 *
 * Signature takes distributorId so the gate can become per-tenant later
 * without touching call sites.
 */
export function isDispatchDebitEnabled(distributorId: string): boolean {
  void distributorId;
  return process.env.INVENTORY_DISPATCH_DEBIT === 'true';
}
