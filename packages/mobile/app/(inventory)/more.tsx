/**
 * 2026-06-15 — inventory More hub: re-exports admin More.
 *
 * Profile path converted to group-relative in the prerequisite
 * commit, so the More hub's "Profile" row navigates within
 * (inventory). Admin-only sections (GST setup, Users, Cylinder
 * Prices, distributor SaaS billing) are gated internally by role
 * checks — inventory sees only the menu items its role permits.
 * Billing and Collections are reachable from this hub's menu
 * since they're not in the inventory tab bar.
 *
 * Replaces the prior 156-LOC standalone inventory More menu.
 */
export { default } from '../(admin)/more';
