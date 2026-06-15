/**
 * 2026-06-15 — inventory customer-create re-export.
 *
 * Registered as a hidden route in (inventory)/_layout.tsx so the
 * customer-list FAB (router.push to '/customer-create' from
 * admin/customers.tsx:615) resolves correctly when customers is
 * hosted in the (inventory) group. POST /api/customers permits
 * the inventory role.
 */
export { default } from '../(admin)/customer-create';
