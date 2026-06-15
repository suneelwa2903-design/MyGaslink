/**
 * Finance collections — re-exports admin collections.
 *
 * Replaces the previous 140-line slim version (which dropped to ~20%
 * of admin's affordances). Finance owns collections workflow — full
 * action surface is appropriate.
 *
 * Safe to re-export because:
 *   - (admin)/collections.tsx no longer has the hardcoded
 *     `pathname: '/(admin)/customer-detail'` push (commit 7c8b1f2
 *     switched it to the group-relative `pathname: '/customer-detail'`).
 *     Finance users tapping a customer row now land in
 *     (finance)/customer-detail (the existing re-export).
 *   - No role checks inside admin/collections.tsx that exclude finance.
 *   - All collections API endpoints (analytics/collections, the
 *     pending-actions overrides for the "Blocked" tab) permit finance.
 *
 * Reached as the 4th visible tab in (finance)/_layout.tsx.
 */
export { default } from '../(admin)/collections';
