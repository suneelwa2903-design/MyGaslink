/**
 * Phase A2 (2026-06-12) — finance customer-detail screen.
 *
 * Re-exports the admin customer-detail screen verbatim. Safe to
 * re-export because:
 *   - admin/customer-detail.tsx has zero `router.push` calls (verified
 *     by grep), so it does no internal cross-route navigation that
 *     could leak finance into the (admin) namespace.
 *   - The edit button at admin/customer-detail.tsx:907-916 is gated
 *     by `canEdit = role in {super_admin, distributor_admin,
 *     inventory}`. Finance is excluded so the button is hidden
 *     automatically; no further changes needed for the role-gated
 *     bits.
 *   - All four tabs (overview / invoices / payments / ledger) plus
 *     the statement PDF download work for finance — the underlying
 *     endpoints permit the role.
 *
 * Reached from (finance)/customers.tsx via router.push('/(finance)/
 * customer-detail?customerId=...').
 */
export { default } from '../(admin)/customer-detail';
