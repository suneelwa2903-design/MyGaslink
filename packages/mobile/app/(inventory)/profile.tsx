/**
 * STAGE-E — Inventory self-service profile.
 *
 * Thin wrapper around the shared ProfileScreen body
 * (src/screens/ProfileScreen.tsx). Only the role accent colour differs
 * between admin/finance/inventory — the body, form fields, save flow, and
 * change-password placeholder are identical.
 *
 * (Replaces the prior read-only profile card; Sign Out + Delete Account live
 * on the More tab now.)
 */
import { ProfileScreen } from '../../src/screens/ProfileScreen';
import { ACCENT } from '../../src/theme';

export default function InventoryProfileScreen() {
  return <ProfileScreen accent={ACCENT.green} />;
}
