// RUN ONCE on go-live day BEFORE setting
// INVENTORY_DISPATCH_DEBIT=true in production.
// Locks all historical summaries so they are
// never recomputed under the new formula.
// Usage: npx tsx scripts/lock-historical-summaries.ts <distributorId>
//
// (Repo runner is tsx, not ts-node — the project has no ts-node dep.)
//
// Why: getInventorySummary computes-on-read for any date WITHOUT a stored
// row, and recalculateSummariesFromDate only recomputes rows where
// isLocked = false. Locking every existing summary freezes historical
// closings under the OLD (delivered-based) formula, so the carry-forward
// chain stays correct. New dates from go-live onward have no stored row
// yet and will compute under the NEW (dispatch-based) formula once the
// flag is on. This script performs NO recompute — it only sets the lock.

import { prisma } from '../src/lib/prisma.js';

async function main() {
  const distributorId = process.argv[2];
  if (!distributorId) {
    console.error('ERROR: distributorId is required.');
    console.error('Usage: npx tsx scripts/lock-historical-summaries.ts <distributorId>');
    process.exit(1);
  }

  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { id: true, businessName: true },
  });
  if (!distributor) {
    console.error(`ERROR: distributor '${distributorId}' not found.`);
    process.exit(1);
  }

  const totalRows = await prisma.inventorySummary.count({ where: { distributorId } });
  const alreadyLocked = await prisma.inventorySummary.count({ where: { distributorId, isLocked: true } });
  const toLock = totalRows - alreadyLocked;

  console.log(`Distributor: ${distributor.businessName} (${distributor.id})`);
  console.log(`Inventory summary rows: ${totalRows} total, ${alreadyLocked} already locked, ${toLock} to lock.`);

  if (toLock === 0) {
    console.log('Nothing to lock. Done.');
    return;
  }

  const result = await prisma.inventorySummary.updateMany({
    where: { distributorId, isLocked: false },
    data: { isLocked: true, lockedAt: new Date(), lockedBy: 'wi-106-cutover' },
  });

  const lockedNow = await prisma.inventorySummary.count({ where: { distributorId, isLocked: true } });
  console.log(`Locked ${result.count} summary rows. Now ${lockedNow}/${totalRows} locked.`);
  console.log('Historical summaries frozen. Safe to set INVENTORY_DISPATCH_DEBIT=true.');
}

main()
  .catch((e) => { console.error('CRASH:', e); process.exit(2); })
  .finally(() => prisma.$disconnect());
