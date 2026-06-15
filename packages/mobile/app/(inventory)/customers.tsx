/**
 * 2026-06-15 — inventory customers: re-exports admin customers.
 *
 * Safe after the paths-decoupling commit converted both internal
 * router.push targets (customer-detail and customer-create) to
 * group-relative. Inventory now gets the full customer list with
 * the same canEditCustomer affordances admin gets — the gate at
 * (admin)/customers.tsx:213 explicitly includes 'inventory'.
 * canEditTransport (driver / vehicle preferences) excludes
 * inventory; that gate is preserved.
 *
 * Replaces the prior 171-LOC balance-focused inventory customers
 * list and brings the customer-detail full surface (overview /
 * invoices / payments / ledger tabs) along with it.
 */
export { default } from '../(admin)/customers';
