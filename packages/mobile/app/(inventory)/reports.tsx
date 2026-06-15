/**
 * 2026-06-15 — inventory reports: re-exports admin reports (all 7).
 *
 * Replaces the prior 3-key whitelist (inventory-movement,
 * delivery-performance, sales-summary) with the full admin
 * reports surface. Every report endpoint
 * GET /api/reports/:reportType permits the inventory role
 * (routes/reports.ts requireRole list), so the API-side gate
 * already enforces what's accessible.
 */
export { default } from '../(admin)/reports';
