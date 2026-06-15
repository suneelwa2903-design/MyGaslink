/**
 * 2026-06-15 — inventory analytics: re-exports admin dashboard.
 *
 * KPI card hrefs converted to group-relative in the prerequisite
 * commit (paths-decoupling sweep), so this dashboard hosts cleanly
 * inside the (inventory) route group without leaking into (admin)
 * navigation. Admin-only widgets (if any) are gated internally by
 * role checks; inventory sees the same operational view admin does.
 *
 * Replaces the prior 170-LOC purpose-built analytics screen.
 */
export { default } from '../(admin)/dashboard';
