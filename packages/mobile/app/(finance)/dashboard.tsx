/**
 * Finance dashboard — re-exports admin dashboard.
 *
 * Replaces the previous 253-line finance-only slim version (Overview +
 * Overdue Customers tabs) with the full admin operational dashboard.
 *
 * Safe to re-export because:
 *   - (admin)/dashboard.tsx no longer has hardcoded `/(admin)/...`
 *     pushes (commit 7c8b1f2 — three router.push calls switched to
 *     group-relative paths). Finance users tapping "View all" on
 *     Stock Position / Overdue / Threshold Alerts now resolve to
 *     (finance)/inventory and (finance)/collections (the re-exports
 *     introduced in this same commit).
 *   - Admin-only widgets are role-gated at admin/dashboard.tsx:163-166;
 *     finance users see those widgets hide automatically.
 *   - Every API endpoint the dashboard reads (analytics, stock summary,
 *     overdue call list, threshold alerts) is permitted for finance —
 *     see analytics.ts and inventory.ts role grants.
 *
 * Reached as the first visible tab in (finance)/_layout.tsx.
 */
export { default } from '../(admin)/dashboard';
