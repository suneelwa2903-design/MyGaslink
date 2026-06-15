/**
 * Finance inventory — re-exports admin inventory.
 *
 * Adds inventory to the finance role's surface (previously missing).
 * API permits finance on 21 of 23 inventory endpoints — the 2 exceptions
 * (lock-day, unlock-day at inventory.ts:192, 492) are gated to
 * super_admin + distributor_admin only and will 403 silently if a
 * finance user tries them. All other actions (Summary read, Actions
 * tab, Reconciliation, Alerts, threshold view) work for finance.
 *
 * Safe to re-export because:
 *   - (admin)/inventory.tsx has zero `router.push('/(admin)/...')` calls
 *     (verified by grep).
 *   - cylinderTypes envelope is correctly unwrapped at admin
 *     /inventory.tsx:2823-2830 — no risk of inheriting the
 *     (inventory)/inventory.tsx crash that this commit's prerequisite
 *     also fixed.
 *
 * Hidden from the bottom tab bar (5-tab limit). Reached from the
 * finance More hub.
 */
export { default } from '../(admin)/inventory';
