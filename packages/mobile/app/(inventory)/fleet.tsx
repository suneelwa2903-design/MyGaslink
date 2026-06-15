/**
 * 2026-06-15 — inventory fleet: re-exports admin fleet.
 *
 * The canEdit gate in (admin)/fleet.tsx includes the inventory
 * role (alongside super_admin and distributor_admin and
 * excluding finance), so inventory gets full read+write surface
 * on drivers, vehicles, and assignments — matching the API
 * permissions on POST /drivers and POST /vehicles which already
 * accept inventory.
 *
 * Replaces the prior 245-LOC purpose-built fleet screen which
 * lacked a canEdit gate (everyone-could-edit by default).
 */
export { default } from '../(admin)/fleet';
