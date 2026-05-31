/**
 * STAGE-E — Admin self-service profile.
 *
 * Thin wrapper around the shared ProfileScreen body
 * (src/screens/ProfileScreen.tsx). Only the role accent colour differs
 * between admin/finance/inventory — the body, form fields, save flow, and
 * change-password placeholder are identical.
 */
import { ProfileScreen } from '../../src/screens/ProfileScreen';
import { ACCENT } from '../../src/theme';

export default function AdminProfileScreen() {
  return <ProfileScreen accent={ACCENT.red} />;
}
