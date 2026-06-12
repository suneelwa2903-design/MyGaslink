/**
 * Phase A3 (2026-06-12) — finance reports screen.
 *
 * Re-exports the admin Reports screen verbatim. The component itself
 * does no internal navigation (verified by grep — no `router.push`
 * anywhere in admin/reports.tsx), so it can be hosted under the
 * (finance) route group without leaking into (admin) routing.
 *
 * Server-side role gating: every report endpoint
 * `GET /api/reports/:reportType` is annotated with
 *     requireRole('super_admin', 'distributor_admin', 'finance', 'inventory')
 * in routes/reports.ts line 25, so finance is permitted on all 7 report
 * types the screen exposes. CSV/PDF download endpoints inherit the same
 * permission set.
 *
 * Reached from the finance More tab → "Reports" menu item (added in
 * (finance)/more.tsx as part of A4).
 */
export { default } from '../(admin)/reports';
