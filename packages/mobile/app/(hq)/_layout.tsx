/**
 * Feature A (2026-07-15): (hq) route group — customer_hq mobile fallback.
 *
 * The HQ portal is web-only in v1 (see docs/HQ-PORTAL-BRAINSTORM.md §7:
 * finance/procurement persona, wide tables, CSV/PDF exports — all
 * fundamentally a desk workflow). This route group renders a single
 * "please use web" screen when a customer_hq login opens the mobile
 * app; a full mobile HQ experience is deferred to a later phase and
 * would ship only the roll-up dashboard tile, not the merged ledger /
 * orders / invoices tables.
 */
import { Stack } from 'expo-router';

export default function HqLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
