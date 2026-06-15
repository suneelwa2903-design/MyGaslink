/**
 * 2026-06-15 — inventory customer-detail: re-exports admin customer-detail.
 *
 * Already proven safe — the same re-export is used by the
 * (finance) role. (admin)/customer-detail.tsx has zero router.push
 * calls, so no cross-route navigation leaks. The edit button is
 * gated by `canEdit = role in {super_admin, distributor_admin,
 * inventory}` — inventory sees the edit affordance; finance does
 * not. All four tabs (overview / invoices / payments / ledger)
 * work for inventory at the API level.
 *
 * Replaces the prior 159-LOC balance-only inventory customer
 * detail.
 */
export { default } from '../(admin)/customer-detail';
