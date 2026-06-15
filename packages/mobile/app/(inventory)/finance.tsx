/**
 * 2026-06-15 — inventory billing surface (route name `finance` to
 * match admin's screen file). Re-exports admin/finance.
 *
 * Registered as a hidden route in (inventory)/_layout.tsx so the
 * admin dashboard's "Overdue Invoices" KPI card (router.push to
 * '/finance') resolves correctly when the dashboard is hosted in
 * the (inventory) group. Every endpoint /api/invoices/* permits
 * the inventory role (18 sites confirmed in routes/invoices.ts).
 */
export { default } from '../(admin)/finance';
