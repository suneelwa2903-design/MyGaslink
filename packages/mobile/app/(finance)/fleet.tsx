/**
 * Finance fleet — re-exports admin fleet.
 *
 * Adds fleet to the finance role's surface (previously missing).
 * Finance gets full READ access to drivers / vehicles / assignments;
 * all WRITE buttons are hidden by the canEdit gate added in commit
 * 7c8b1f2 to (admin)/fleet.tsx. The gate flips on roles
 * {super_admin, distributor_admin, inventory} only.
 *
 * Defense-in-depth at the API layer: driversVehicles.ts excludes
 * finance from POST /drivers, POST /vehicles, and vehicle-mapping
 * mutations (lines 159, 845). Even if a button somehow surfaced, the
 * mutation would 403.
 *
 * Hidden from the bottom tab bar (5-tab limit). Reached from the
 * finance More hub.
 */
export { default } from '../(admin)/fleet';
