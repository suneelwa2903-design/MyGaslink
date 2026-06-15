/**
 * 2026-06-15 — inventory collections re-export.
 *
 * Registered as a hidden route in (inventory)/_layout.tsx so the
 * admin dashboard's "Outstanding" KPI card and the Overdue Call
 * List "View all" link (both router.push to '/collections')
 * resolve correctly when the dashboard is hosted in the
 * (inventory) group.
 */
export { default } from '../(admin)/collections';
