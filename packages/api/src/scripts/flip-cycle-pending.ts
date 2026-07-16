/**
 * Live Razorpay verify helper (Phase E) — one-shot script that flips
 * the test billing cycle to `pending_payment` so the Pay Now button
 * actually renders. Run with:
 *   pnpm --filter @gaslink/api tsx src/scripts/flip-cycle-pending.ts
 *
 * Intentionally NOT a route — production billing never needs this
 * transition manually.
 */
import { prisma } from '../lib/prisma.js';

const cycleId = process.argv[2];
if (!cycleId) {
  console.error('usage: tsx flip-cycle-pending.ts <cycleId>');
  process.exit(1);
}

const updated = await prisma.billingCycle.update({
  where: { id: cycleId },
  data: { billingStatus: 'pending_payment' },
});
console.log('flipped cycle', updated.id, '→', updated.billingStatus);
await prisma.$disconnect();
