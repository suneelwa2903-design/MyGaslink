/**
 * 2026-06-15 — inventory screen: re-exports admin inventory.
 *
 * Replaces the prior 1219-LOC standalone screen with a thin
 * re-export. Two important side effects:
 *
 *   1. Resolves the recentEvents anti-pattern #17 crash. The
 *      standalone file typed `/inventory/depot-history` as
 *      InventoryEvent[] but the server returns { events, meta };
 *      .map(...) blew up on every Actions sub-pill mount. Admin
 *      version at (admin)/inventory.tsx:2150-2160 unwraps the
 *      envelope correctly.
 *
 *   2. Replaces the 4 sub-pill structure (Summary / Actions /
 *      Reconciliation / Alerts) with admin's internal tab
 *      structure (Daily Summary / Depot History / Stock at
 *      Onboarding / Customer Balances / Vehicle Return). Net
 *      surface area increases; nothing is lost.
 */
export { default } from '../(admin)/inventory';
