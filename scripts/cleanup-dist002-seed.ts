/**
 * cleanup-dist002-seed.ts
 *
 * Cleans ALL transactional data for dist-002 (Sharma Gas Distributors) and
 * seeds a fresh opening-stock inventory summary for today's date.
 *
 * Run:  npx tsx scripts/cleanup-dist002-seed.ts
 *
 * What is cleaned (in FK-safe order):
 *   gst_api_logs, order_status_logs, driver_assignments,
 *   payment_allocations, credit_notes, debit_notes,
 *   invoice_revisions, gst_documents, invoice_items, invoices,
 *   order_items, cancelled_stock_events, payment_transactions, orders,
 *   pending_actions, customer_ledger_entries, inventory_events,
 *   inventory_summaries, customer_inventory_balances,
 *   driver_vehicle_assignments (stale dates deleted; fresh one seeded)
 *
 * What is NOT touched:
 *   audit_logs, gst_credentials, gst_api_usage (billing), users,
 *   drivers, vehicles, customers, cylinder_types, prices, thresholds
 *
 * Opening stock seeded for TODAY:
 *   5 KG   → 30 fulls, 15 empties
 *   19 KG  → 50 fulls, 25 empties
 *   47.5 KG→ 20 fulls, 10 empties
 *   425 KG → 10 fulls,  5 empties
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DIST_ID = 'dist-002';

// Opening stock targets (as requested)
const OPENING_STOCK: Record<string, { fulls: number; empties: number }> = {
  '5 KG':    { fulls: 30,  empties: 15 },
  '19 KG':   { fulls: 50,  empties: 25 },
  '47.5 KG': { fulls: 20,  empties: 10 },
  '425 KG':  { fulls: 10,  empties:  5 },
};

function log(msg: string) {
  process.stdout.write(msg + '\n');
}

async function main() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString().split('T')[0];

  log('='.repeat(60));
  log(`  dist-002 Cleanup + Seed  —  ${todayISO}`);
  log('='.repeat(60));

  // ── 1. Verify distributor exists ────────────────────────────────────────────
  const dist = await prisma.distributor.findUnique({ where: { id: DIST_ID } });
  if (!dist) throw new Error(`Distributor ${DIST_ID} not found`);
  log(`\nDistributor: ${dist.businessName}`);

  // ── 2. Collect counts BEFORE cleanup ────────────────────────────────────────
  log('\n--- BEFORE ---');
  const before = await getCounts();
  printCounts(before);

  // ── 3. Cleanup (FK-safe order) ───────────────────────────────────────────────

  log('\n--- CLEANING ---');

  // 3a. GST API logs (references invoices/orders — delete first)
  const { count: gstLogs } = await prisma.gstApiLog.deleteMany({ where: { distributorId: DIST_ID } });
  log(`  Deleted gst_api_logs:             ${gstLogs}`);

  // 3b. Order status logs (child of orders)
  const { count: osl } = await prisma.orderStatusLog.deleteMany({ where: { order: { distributorId: DIST_ID } } });
  log(`  Deleted order_status_logs:        ${osl}`);

  // 3c. Driver assignments (child of orders)
  const { count: da } = await prisma.driverAssignment.deleteMany({ where: { order: { distributorId: DIST_ID } } });
  log(`  Deleted driver_assignments:       ${da}`);

  // 3d. Payment allocations (child of invoices + payments)
  const { count: payAlloc } = await prisma.paymentAllocation.deleteMany({ where: { payment: { distributorId: DIST_ID } } });
  log(`  Deleted payment_allocations:      ${payAlloc}`);

  // 3e. Credit notes (child of invoices)
  const { count: cn } = await prisma.creditNote.deleteMany({ where: { invoice: { distributorId: DIST_ID } } });
  log(`  Deleted credit_notes:             ${cn}`);

  // 3f. Debit notes (child of invoices)
  const { count: dn } = await prisma.debitNote.deleteMany({ where: { invoice: { distributorId: DIST_ID } } });
  log(`  Deleted debit_notes:              ${dn}`);

  // 3g. Invoice revisions (child of invoices)
  const { count: rev } = await prisma.invoiceRevision.deleteMany({ where: { invoice: { distributorId: DIST_ID } } });
  log(`  Deleted invoice_revisions:        ${rev}`);

  // 3h. GST documents (child of invoices)
  const { count: gstDocs } = await prisma.gstDocument.deleteMany({ where: { distributorId: DIST_ID } });
  log(`  Deleted gst_documents:            ${gstDocs}`);

  // 3i. Invoice items (child of invoices)
  const { count: invItems } = await prisma.invoiceItem.deleteMany({ where: { invoice: { distributorId: DIST_ID } } });
  log(`  Deleted invoice_items:            ${invItems}`);

  // 3j. Invoices
  const { count: invoices } = await prisma.invoice.deleteMany({ where: { distributorId: DIST_ID } });
  log(`  Deleted invoices:                 ${invoices}`);

  // 3k. Order items (child of orders)
  const { count: orderItems } = await prisma.orderItem.deleteMany({ where: { order: { distributorId: DIST_ID } } });
  log(`  Deleted order_items:              ${orderItems}`);

  // 3l. Cancelled stock events (FK to orders — must be before orders)
  const { count: cse } = await prisma.cancelledStockEvent.deleteMany({ where: { distributorId: DIST_ID } });
  log(`  Deleted cancelled_stock_events:   ${cse}`);

  // 3m. Payment transactions
  const { count: payments } = await prisma.paymentTransaction.deleteMany({ where: { distributorId: DIST_ID } });
  log(`  Deleted payment_transactions:     ${payments}`);

  // 3n. Orders (now safe — all children deleted)
  const { count: orders } = await prisma.order.deleteMany({ where: { distributorId: DIST_ID } });
  log(`  Deleted orders:                   ${orders}`);

  // 3o. Pending actions
  const { count: pa } = await prisma.pendingAction.deleteMany({ where: { distributorId: DIST_ID } });
  log(`  Deleted pending_actions:          ${pa}`);

  // 3p. Customer ledger entries
  const { count: ledger } = await prisma.customerLedgerEntry.deleteMany({ where: { distributorId: DIST_ID } });
  log(`  Deleted customer_ledger_entries:  ${ledger}`);

  // 3q. Inventory events
  const { count: invEvt } = await prisma.inventoryEvent.deleteMany({ where: { distributorId: DIST_ID } });
  log(`  Deleted inventory_events:         ${invEvt}`);

  // 3r. Inventory summaries (all dates)
  const { count: invSum } = await prisma.inventorySummary.deleteMany({ where: { distributorId: DIST_ID } });
  log(`  Deleted inventory_summaries:      ${invSum}`);

  // 3s. Customer inventory balances
  const { count: cib } = await prisma.customerInventoryBalance.deleteMany({ where: { customer: { distributorId: DIST_ID } } });
  log(`  Deleted customer_inventory_balances: ${cib}`);

  // 3t. Driver-vehicle assignments — delete stale; will create fresh below
  const { count: dva } = await prisma.driverVehicleAssignment.deleteMany({ where: { distributorId: DIST_ID } });
  log(`  Deleted driver_vehicle_assignments: ${dva}`);

  // ── 4. Seed fresh DVA for today ─────────────────────────────────────────────

  const kiranReddy = await prisma.driver.findFirst({
    where: { distributorId: DIST_ID, driverName: 'Kiran Reddy' },
    select: { id: true },
  });
  const vehicle = await prisma.vehicle.findFirst({
    where: { distributorId: DIST_ID },
    select: { id: true, vehicleNumber: true },
  });

  if (kiranReddy && vehicle) {
    await prisma.driverVehicleAssignment.create({
      data: {
        distributorId: DIST_ID,
        driverId: kiranReddy.id,
        vehicleId: vehicle.id,
        assignmentDate: today,
        tripNumber: 1,
        status: 'dispatch_ready',
      },
    });
    log(`\n  Created DVA: Kiran Reddy / ${vehicle.vehicleNumber} — dispatch_ready (${todayISO}, trip 1)`);
  } else {
    log('\n  WARNING: Kiran Reddy or vehicle not found — DVA not created');
  }

  // ── 5. Seed opening inventory summary for today ──────────────────────────────

  log('\n--- SEEDING OPENING STOCK ---');

  const cylTypes = await prisma.cylinderType.findMany({
    where: { distributorId: DIST_ID },
    select: { id: true, typeName: true },
  });

  const cylMap = new Map(cylTypes.map((c) => [c.typeName, c.id]));

  for (const [typeName, stock] of Object.entries(OPENING_STOCK)) {
    const cylId = cylMap.get(typeName);
    if (!cylId) {
      log(`  WARNING: CylinderType "${typeName}" not found for dist-002 — skipping`);
      continue;
    }

    // Delete any existing summary for today (idempotent)
    await prisma.inventorySummary.deleteMany({
      where: { distributorId: DIST_ID, cylinderTypeId: cylId, summaryDate: today },
    });

    await prisma.inventorySummary.create({
      data: {
        distributorId: DIST_ID,
        cylinderTypeId: cylId,
        summaryDate: today,
        openingFulls: stock.fulls,
        openingEmpties: stock.empties,
        incomingFulls: 0,
        outgoingEmpties: 0,
        deliveredQty: 0,
        collectedEmpties: 0,
        closingFulls: stock.fulls,   // no movement yet
        closingEmpties: stock.empties,
        isLocked: false,
      },
    });

    log(`  ✅ ${typeName.padEnd(8)} → ${stock.fulls} fulls, ${stock.empties} empties`);
  }

  // ── 6. Verify final state ────────────────────────────────────────────────────

  log('\n--- AFTER ---');
  const after = await getCounts();
  printCounts(after);

  // Verify inventory summary was seeded correctly
  log('\n--- INVENTORY VERIFICATION ---');
  const summaries = await prisma.inventorySummary.findMany({
    where: { distributorId: DIST_ID, summaryDate: today },
    include: { cylinderType: { select: { typeName: true } } },
    orderBy: { cylinderType: { capacity: 'asc' } },
  });

  for (const s of summaries) {
    log(`  ${s.cylinderType.typeName.padEnd(8)} openingFulls=${s.openingFulls} openingEmpties=${s.openingEmpties} isLocked=${s.isLocked}`);
  }

  log('\n' + '='.repeat(60));
  log('  Cleanup complete.');
  log('='.repeat(60));
}

async function getCounts() {
  const [orders, invoices, gstDocs, payments, pa, invSum, invEvt, dva, cse] =
    await Promise.all([
      prisma.order.count({ where: { distributorId: DIST_ID } }),
      prisma.invoice.count({ where: { distributorId: DIST_ID } }),
      prisma.gstDocument.count({ where: { distributorId: DIST_ID } }),
      prisma.paymentTransaction.count({ where: { distributorId: DIST_ID } }),
      prisma.pendingAction.count({ where: { distributorId: DIST_ID } }),
      prisma.inventorySummary.count({ where: { distributorId: DIST_ID } }),
      prisma.inventoryEvent.count({ where: { distributorId: DIST_ID } }),
      prisma.driverVehicleAssignment.count({ where: { distributorId: DIST_ID } }),
      prisma.cancelledStockEvent.count({ where: { distributorId: DIST_ID } }),
    ]);
  return { orders, invoices, gstDocs, payments, pa, invSum, invEvt, dva, cse };
}

function printCounts(c: Awaited<ReturnType<typeof getCounts>>) {
  log(`  orders=${c.orders} invoices=${c.invoices} gstDocs=${c.gstDocs} payments=${c.payments}`);
  log(`  pendingActions=${c.pa} invSummaries=${c.invSum} invEvents=${c.invEvt}`);
  log(`  dva=${c.dva} cancelledStock=${c.cse}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
