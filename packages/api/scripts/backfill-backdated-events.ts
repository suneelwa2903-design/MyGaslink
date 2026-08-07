/**
 * Backfill script — retro-emit InventoryEvents for backdated orders
 * that were created BEFORE the 2026-08-06 Gap 2 fix.
 *
 * Two categories of "broken" backdated orders exist in production DBs:
 *   (a) `inventoryAdjustedAt` is NULL — the operator never clicked
 *       "Apply Adjustment". The order has NO inventory events at all.
 *   (b) `inventoryAdjustedAt` is set but the only fulls-event is a
 *       `manual_adjustment` (pre-2026-08-06 event type). Physical-flow
 *       reports (Vehicle Ledger / Inventory Movement / Cylinder
 *       Rotation) can't see this because they filter by
 *       `eventType in ('dispatch','delivery','collection','returns_collection','reconciliation_empties_return')`.
 *
 * The fix for both is the same: emit the four proper event types
 * (dispatch + delivery + collection + reconciliation_empties_return)
 * dated on `Order.deliveryDate`. For category (b), also delete the
 * stale `manual_adjustment` rows first so they don't double-count.
 *
 * Idempotency: script scans for `isBackdated=true` orders that have NO
 * `delivery` event with `referenceType='backdated_inventory_adjustment'`.
 * Re-runs are safe — orders that were already backfilled skip.
 *
 * Also updates CustomerInventoryBalance (missing from the pre-fix path).
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-backdated-events.ts                     # dry-run (default)
 *   pnpm exec tsx scripts/backfill-backdated-events.ts --apply             # execute
 *   pnpm exec tsx scripts/backfill-backdated-events.ts --distributor dist-002   # scope to one tenant
 *
 * Runs in-tx per order; a failure on one order doesn't roll back others.
 */

import { prisma } from '../src/lib/prisma.js';
import { createInventoryEvent, recalculateSummariesFromDate } from '../src/services/inventoryService.js';

const DRY_RUN = !process.argv.includes('--apply');
const DIST_ARG_IDX = process.argv.indexOf('--distributor');
const DISTRIBUTOR_FILTER = DIST_ARG_IDX > 0 ? process.argv[DIST_ARG_IDX + 1] : null;
const SYSTEM_USER = 'backfill-2026-08-06';

async function main(): Promise<void> {
  console.log(`\n=== Backdated-order event backfill ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN (no writes)' : 'APPLY (writes)'}`);
  if (DISTRIBUTOR_FILTER) console.log(`Scope: distributor = ${DISTRIBUTOR_FILTER}`);
  console.log();

  // Step 1 — find every backdated delivered order.
  const orders = await prisma.order.findMany({
    where: {
      isBackdated: true,
      status: 'delivered',
      deletedAt: null,
      ...(DISTRIBUTOR_FILTER ? { distributorId: DISTRIBUTOR_FILTER } : {}),
    },
    include: {
      items: { select: { cylinderTypeId: true, deliveredQuantity: true, emptiesCollected: true, quantity: true } },
      driver: { select: { driverName: true } },
      vehicle: { select: { vehicleNumber: true } },
    },
    orderBy: { deliveryDate: 'asc' },
  });
  console.log(`Found ${orders.length} backdated delivered orders.`);

  // Step 2 — filter to orders that don't yet have a proper `delivery` event
  //           for the backdated_inventory_adjustment referenceType.
  const orderIds = orders.map((o) => o.id);
  if (orderIds.length === 0) {
    console.log('Nothing to backfill.');
    await prisma.$disconnect();
    return;
  }

  const properDeliveryEventOrderIds = new Set(
    (await prisma.inventoryEvent.findMany({
      where: {
        referenceType: 'backdated_inventory_adjustment',
        referenceId: { in: orderIds },
        eventType: 'delivery',
      },
      select: { referenceId: true },
      distinct: ['referenceId'],
    })).map((e) => e.referenceId).filter((v): v is string => v !== null),
  );

  const staleAdjustmentEventOrderIds = new Set(
    (await prisma.inventoryEvent.findMany({
      where: {
        referenceType: 'backdated_inventory_adjustment',
        referenceId: { in: orderIds },
        eventType: 'manual_adjustment',
      },
      select: { referenceId: true },
      distinct: ['referenceId'],
    })).map((e) => e.referenceId).filter((v): v is string => v !== null),
  );

  const toBackfill = orders.filter((o) => !properDeliveryEventOrderIds.has(o.id));
  const staleCount = toBackfill.filter((o) => staleAdjustmentEventOrderIds.has(o.id)).length;
  const untouchedCount = toBackfill.length - staleCount;
  console.log(`  ${properDeliveryEventOrderIds.size} orders already have proper events (skip).`);
  console.log(`  ${staleCount} orders have STALE manual_adjustment events (will delete + re-emit).`);
  console.log(`  ${untouchedCount} orders have NO adjustment yet (will emit fresh).`);
  console.log(`  → ${toBackfill.length} orders to backfill.\n`);

  if (DRY_RUN) {
    console.log('Dry-run complete. Re-run with --apply to execute.');
    await prisma.$disconnect();
    return;
  }

  // Step 3 — per-order backfill. Each order in its own tx.
  let ok = 0;
  let failed = 0;
  const failedOrderIds: string[] = [];
  const touchedCylTypesByDist = new Map<string, Map<string, Date>>(); // dist → cylType → earliestDate

  for (const order of toBackfill) {
    const isStale = staleAdjustmentEventOrderIds.has(order.id);
    try {
      await prisma.$transaction(async (tx) => {
        // (b) — delete stale manual_adjustment rows first.
        if (isStale) {
          await tx.inventoryEvent.deleteMany({
            where: {
              referenceType: 'backdated_inventory_adjustment',
              referenceId: order.id,
              eventType: 'manual_adjustment',
            },
          });
        }

        const notes = `Backfill 2026-08-06 for order ${order.orderNumber} (delivered ${order.deliveryDate.toISOString().slice(0, 10)})`;
        const vehicleNumber = order.vehicle?.vehicleNumber ?? null;
        const driverName = order.driver?.driverName ?? null;

        for (const item of order.items) {
          const deliveredQty = item.deliveredQuantity ?? item.quantity;
          const emptiesCollected = item.emptiesCollected ?? 0;

          if (deliveredQty > 0) {
            await createInventoryEvent(tx, {
              distributorId: order.distributorId,
              cylinderTypeId: item.cylinderTypeId,
              eventType: 'dispatch',
              fullsChange: -deliveredQty,
              emptiesChange: 0,
              eventDate: order.deliveryDate,
              referenceId: order.id,
              referenceType: 'backdated_inventory_adjustment',
              vehicleNumber,
              driverName,
              notes: `${notes} — synthetic dispatch`,
              createdBy: SYSTEM_USER,
            });
            await createInventoryEvent(tx, {
              distributorId: order.distributorId,
              cylinderTypeId: item.cylinderTypeId,
              eventType: 'delivery',
              fullsChange: -deliveredQty,
              emptiesChange: 0,
              eventDate: order.deliveryDate,
              referenceId: order.id,
              referenceType: 'backdated_inventory_adjustment',
              vehicleNumber,
              driverName,
              notes,
              createdBy: SYSTEM_USER,
            });
          }
          if (emptiesCollected > 0) {
            await createInventoryEvent(tx, {
              distributorId: order.distributorId,
              cylinderTypeId: item.cylinderTypeId,
              eventType: 'collection',
              fullsChange: 0,
              emptiesChange: emptiesCollected,
              eventDate: order.deliveryDate,
              referenceId: order.id,
              referenceType: 'backdated_inventory_adjustment',
              vehicleNumber,
              driverName,
              notes,
              createdBy: SYSTEM_USER,
            });
            await createInventoryEvent(tx, {
              distributorId: order.distributorId,
              cylinderTypeId: item.cylinderTypeId,
              eventType: 'reconciliation_empties_return',
              fullsChange: 0,
              emptiesChange: emptiesCollected,
              eventDate: order.deliveryDate,
              referenceId: order.id,
              referenceType: 'backdated_inventory_adjustment',
              vehicleNumber,
              driverName,
              notes,
              createdBy: SYSTEM_USER,
            });
          }

          // Update customer inventory balance (missing from the pre-fix
          // implementation — critical for Cylinder Rotation report).
          const balanceChange = deliveredQty - emptiesCollected;
          if (balanceChange !== 0) {
            await tx.customerInventoryBalance.upsert({
              where: {
                customerId_cylinderTypeId: {
                  customerId: order.customerId,
                  cylinderTypeId: item.cylinderTypeId,
                },
              },
              create: {
                customerId: order.customerId,
                cylinderTypeId: item.cylinderTypeId,
                withCustomerQty: balanceChange,
              },
              update: {
                withCustomerQty: { increment: balanceChange },
              },
            });
          }
        }

        // Stamp inventoryAdjustedAt if it wasn't already.
        if (!order.inventoryAdjustedAt) {
          await tx.order.update({
            where: { id: order.id },
            data: { inventoryAdjustedAt: new Date() },
          });
        }
      });

      // Track affected (dist, cyl) with earliest date so we recalc once at end.
      const distMap = touchedCylTypesByDist.get(order.distributorId) ?? new Map<string, Date>();
      for (const item of order.items) {
        const existing = distMap.get(item.cylinderTypeId);
        if (!existing || order.deliveryDate < existing) {
          distMap.set(item.cylinderTypeId, order.deliveryDate);
        }
      }
      touchedCylTypesByDist.set(order.distributorId, distMap);

      ok++;
      if (ok % 25 === 0) console.log(`  ...${ok}/${toBackfill.length} done`);
    } catch (err) {
      failed++;
      failedOrderIds.push(order.id);
      console.error(`  ✗ ${order.orderNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${ok} backfilled successfully, ${failed} failed.`);
  if (failedOrderIds.length > 0) {
    console.log(`Failed order IDs: ${failedOrderIds.join(', ')}`);
  }

  // Step 4 — one recalcSummary per (dist, cyl) from earliest touched date.
  console.log(`\nRecalculating summaries from earliest touched date per (distributor, cylinder-type)…`);
  let recalcCount = 0;
  for (const [distId, cylMap] of touchedCylTypesByDist.entries()) {
    for (const [cylId, earliestDate] of cylMap.entries()) {
      try {
        await recalculateSummariesFromDate(distId, cylId, earliestDate);
        recalcCount++;
      } catch (err) {
        console.error(`  ✗ recalc ${distId}/${cylId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  console.log(`Recalculated ${recalcCount} (distributor, cylinder-type) summary chains.`);

  console.log(`\n✅ Backfill complete.`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
