/**
 * One-shot correction for dist-002 / 19KG / 2026-05-29.
 *
 * Cause: a Report Mismatch (write_off, +1) followed by a manual Confirm &
 * Reconcile (supervisor count, +1) credited `emptiesReturnedVerified` twice
 * against a single collected empty. Resulting state:
 *   collectedEmpties        = 1
 *   emptiesReturnedVerified = 2
 *   emptiesOnVehicle        = -1   ← off by one
 *
 * Correction: post a single `reconciliation_empties_return` event with
 * emptiesChange = -1 to back out the duplicate credit, then recompute
 * summaries from today forward.
 *
 *   collectedEmpties        = 1   (unchanged — collection event untouched)
 *   emptiesReturnedVerified = 1   (2 + (-1) — matches reality: 1 empty came back)
 *   emptiesOnVehicle        = 0   (1 - 1)
 *   closingEmpties          = -1 from current
 *
 * NOTE on deviation from the original spec: the spec asked for a
 * `manual_adjustment` event. That category only feeds the `manualEmpties`
 * term in closingEmpties — it leaves `emptiesReturnedVerified` (and thus
 * `emptiesOnVehicle`) unchanged. Since the stated acceptance criterion is
 * `emptiesOnVehicle → 0`, we use the event type that the math actually
 * moves: `reconciliation_empties_return` with a negative change. The
 * `closingEmpties` outcome is identical either way.
 *
 * Run once from packages/api:
 *   pnpm tsx scripts/fix-wi4-double-reconcile-dist002.ts
 * Re-running is safe — there's a marker check so the correction only
 * applies once. Subsequent runs print the current state and exit clean.
 */
import { prisma } from '../src/lib/prisma.js';
import { createInventoryEvent, recalculateSummariesFromDate } from '../src/services/inventoryService.js';
import { startOfUtcDay } from '../src/utils/dateOnly.js';

const DIST = 'dist-002';
const CORRECTION_NOTE = 'Correction: double-reconcile from mismatch test on 29-May-2026.';

async function main() {
  const today = startOfUtcDay();

  const cyl19 = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: DIST, capacity: 19 },
    select: { id: true, typeName: true },
  });

  // Idempotency guard.
  const existingCorrection = await prisma.inventoryEvent.findFirst({
    where: {
      distributorId: DIST,
      cylinderTypeId: cyl19.id,
      eventType: 'reconciliation_empties_return',
      notes: CORRECTION_NOTE,
    },
    select: { id: true },
  });
  if (existingCorrection) {
    console.log(`Correction already applied (event ${existingCorrection.id}). Nothing to do.`);
  } else {
    // Find the inventory user to attribute the event. Falls back to any
    // dist-002 admin so the script never fails on a fresh seed.
    const author = await prisma.user.findFirst({
      where: {
        distributorId: DIST,
        role: { in: ['inventory', 'distributor_admin'] },
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!author) {
      throw new Error('No inventory/admin user on dist-002 to attribute the correction event');
    }

    await prisma.$transaction(async (tx) => {
      await createInventoryEvent(tx, {
        distributorId: DIST,
        cylinderTypeId: cyl19.id,
        eventType: 'reconciliation_empties_return',
        fullsChange: 0,
        emptiesChange: -1,
        eventDate: today,
        referenceType: 'manual_correction',
        createdBy: author.id,
        notes: CORRECTION_NOTE,
      });
    });

    await recalculateSummariesFromDate(DIST, cyl19.id, today);
    console.log('Correction event posted and summary recomputed.');
  }

  const summary = await prisma.inventorySummary.findFirst({
    where: { distributorId: DIST, cylinderTypeId: cyl19.id, summaryDate: today },
    select: { collectedEmpties: true, emptiesReturnedVerified: true, closingEmpties: true },
  });
  if (!summary) {
    console.log('No summary row exists for today — nothing to print.');
    return;
  }
  const eov = Number(summary.collectedEmpties) - Number(summary.emptiesReturnedVerified);
  console.log(`\nState after correction:`);
  console.log(`  collectedEmpties        = ${summary.collectedEmpties}`);
  console.log(`  emptiesReturnedVerified = ${summary.emptiesReturnedVerified}`);
  console.log(`  closingEmpties          = ${summary.closingEmpties}`);
  console.log(`  emptiesOnVehicle (derived) = ${eov}`);
  if (eov !== 0) {
    console.warn(`\n⚠ emptiesOnVehicle is ${eov}, not 0 — investigate before reusing this script.`);
    process.exitCode = 2;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
