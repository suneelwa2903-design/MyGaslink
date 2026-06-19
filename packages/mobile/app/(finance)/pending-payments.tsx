/**
 * Finance pending-payments — re-exports the admin canonical screen.
 *
 * Same role gate (RBAC enforced server-side: super_admin |
 * distributor_admin | finance). Same UI. Finance layout owns the
 * tab bar surrounding this screen.
 *
 * Pattern reference: (finance)/collections.tsx re-exports (admin)/collections.
 */
export { default } from '../(admin)/pending-payments';
