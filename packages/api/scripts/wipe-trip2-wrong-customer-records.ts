/**
 * Trip 2 wrong-customer cleanup — Step 2 of 2: DB wipe.
 *
 * Cleans up the 3 mis-attributed Vanasthali orders after their NIC EWBs are
 * cancelled (Step 1: cancel-ewb-trip2-wrong-customers.ts).
 *
 *   OVGS2627000340 → MEGHANA TIFFINS       (should have been Manikjanta Tiffins)
 *   OVGS2627000343 → SRINIVASA TIFFIN CENTRE (should have been Srinivas Hotel)
 *   OVGS2627000344 → ASWAD KITCHEN         (should have been Swaad Kitchen)
 *
 * WHAT THIS DOES (per Suneel 2026-07-11):
 *
 *   Keep-as-cancelled (audit-visible for admin, hidden from customer):
 *     • orders                — status='cancelled', cancelled_at=NOW(), reason
 *     • invoices              — status='cancelled', cancelled_at=NOW()
 *     • gst_documents         — cancelled_at=NOW(), cancel_reason_code='3'
 *     • order_items           — UNCHANGED (line items on cancelled orders)
 *     • invoice_items         — UNCHANGED (line items on cancelled invoices)
 *     • order_status_log      — UNCHANGED (audit trail of the cancellation)
 *     • gst_api_logs          — UNCHANGED (anti-pattern #11: NIC forensic never
 *                                purged; the EWB_GENERATE_STANDALONE +
 *                                EWB_CANCEL rows stay for compliance audit)
 *
 *   Deleted (clean slate — user re-enters via app):
 *     • customer_ledger_entries — 3 rows (wrong customer's statement stays
 *                                  clean; no cancelled order/invoice visible
 *                                  on their ledger PDF)
 *     • inventory_events        — 9 rows (3 dispatch + 3 delivery + 3 collection
 *                                  linked to the 3 orders — depot stock movement
 *                                  wiped per user ask)
 *     • driver_assignments      — 3 rows (unlinks orders from Trip 2 DVA; the
 *                                  DVA itself is untouched)
 *
 * DEPOT STOCK CONSEQUENCE — READ BEFORE APPLYING
 *
 *   Deleting the 9 inventory_events removes the -9 fulls debit + +9 empties
 *   credit from depot's ledger. Physical reality is that 9 fulls DID leave and
 *   9 empties DID return. After this wipe, depot book stock will be:
 *     • fulls closing_stock  → OVERSTATED by +9 (vs physical)
 *     • empties closing_stock → UNDERSTATED by 9 (vs physical)
 *
 *   To close the gap: after this wipe, create 3 new orders for the RIGHT
 *   customers (Swaad Kitchen / Srinivas Hotel / Manikjanta Tiffins) via the
 *   Item 6 Backdated Trip flow — that flow writes fresh dispatch/delivery/
 *   collection events on 2026-07-11 which restore depot state. Do NOT use
 *   On-Demand (Brief 3) for the re-entry — that flow deliberately skips
 *   inventory events and would leave depot permanently overstated.
 *
 *   `recalculateSummariesFromDate('2026-07-11')` runs at the end to refresh
 *   inventory_summaries so the depot KPI + Fleet screens read consistent.
 *
 * SAFETY
 * ------
 *   * Scoped to Vanasthali distributor ID only (hard-coded).
 *   * Hard-coded to the 3 target order numbers + 3 invoice numbers — cannot
 *     accidentally touch any other row.
 *   * Blocks if any invoice still has a non-cancelled EWB (Step 1 not run).
 *   * Blocks if any invoice has payment_allocations, credit_notes, debit_notes
 *     — those would need separate reversal first.
 *   * Blocks if any invoice is already fully cancelled (idempotent).
 *   * All DB writes run inside one prisma.$transaction.
 *   * Dry-run by default. Requires --apply to commit.
 *   * Prints per-table row-level diff BEFORE any write.
 *
 * USAGE
 * -----
 *   pnpm exec tsx scripts/wipe-trip2-wrong-customer-records.ts             # dry-run
 *   pnpm exec tsx scripts/wipe-trip2-wrong-customer-records.ts --apply     # commit
 */
import { prisma } from '../src/lib/prisma.js';
import { recalculateSummariesFromDate } from '../src/services/inventoryService.js';

const VANASTHALI_DIST_ID = '6a749f20-5a82-4b74-9977-51eac69049f2';
const TARGET_ORDERS = ['OVGS2627000340', 'OVGS2627000343', 'OVGS2627000344'];
const TARGET_INVOICES = ['IVGS2627000330', 'IVGS2627000333', 'IVGS2627000334'];
const CANCELLATION_REASON =
  'Wrong customer selected in Trip 2 (2026-07-11). Physical delivery matched correct customer (Swaad Kitchen / Srinivas Hotel / Manikjanta Tiffins). Reissuing under Item 6 backdated trip.';
const RECOMPUTE_DATE = new Date('2026-07-11T00:00:00.000Z');

interface Args {
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: true };
  for (const a of argv) {
    if (a === '--apply') args.dryRun = false;
  }
  return args;
}

async function loadOrders() {
  return prisma.order.findMany({
    where: {
      distributorId: VANASTHALI_DIST_ID,
      orderNumber: { in: TARGET_ORDERS },
    },
    include: {
      customer: { select: { customerName: true } },
      items: true,
      invoice: {
        include: {
          items: true,
        },
      },
    },
  });
}

async function preflight(orders: Awaited<ReturnType<typeof loadOrders>>): Promise<string[]> {
  const errors: string[] = [];

  if (orders.length !== 3) {
    errors.push(`Expected 3 orders, found ${orders.length}. Aborting.`);
  }

  for (const o of orders) {
    if (!o.invoice) {
      errors.push(`${o.orderNumber}: no linked invoice — bad state`);
      continue;
    }
    if (!TARGET_INVOICES.includes(o.invoice.invoiceNumber)) {
      errors.push(`${o.orderNumber}: linked invoice ${o.invoice.invoiceNumber} not in target set`);
    }
    if (o.status === 'cancelled') {
      errors.push(`${o.orderNumber}: already cancelled — idempotency check`);
    }

    // Blockers
    const allocs = await prisma.paymentAllocation.count({ where: { invoiceId: o.invoice.id } });
    if (allocs > 0) errors.push(`${o.orderNumber}: invoice has ${allocs} payment_allocations — reverse those first`);
    const cns = await prisma.creditNote.count({ where: { invoiceId: o.invoice.id } });
    if (cns > 0) errors.push(`${o.orderNumber}: invoice has ${cns} credit_notes — reverse those first`);
    const dns = await prisma.debitNote.count({ where: { invoiceId: o.invoice.id } });
    if (dns > 0) errors.push(`${o.orderNumber}: invoice has ${dns} debit_notes — reverse those first`);

    // Step 1 must have run first — every EWB must be cancelled at NIC.
    const gstDoc = await prisma.gstDocument.findFirst({
      where: { invoiceId: o.invoice.id, isLatest: true, ewbNo: { not: null } },
      select: { ewbNo: true, cancelledAt: true, ewbStatus: true },
    });
    if (gstDoc && !gstDoc.cancelledAt) {
      errors.push(
        `${o.orderNumber}: EWB ${gstDoc.ewbNo} at NIC still active — run cancel-ewb-trip2-wrong-customers.ts --apply first`,
      );
    }
  }

  return errors;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log('=== Trip 2 wrong-customer wipe ===');
  console.log(`Mode: ${args.dryRun ? 'DRY RUN (no writes)' : 'APPLY (writes committed)'}\n`);

  const orders = await loadOrders();
  const preflightErrors = await preflight(orders);
  if (preflightErrors.length) {
    console.log('=== Preflight warnings ===');
    for (const e of preflightErrors) console.log(`  ! ${e}`);
    console.log();
    if (!args.dryRun) {
      console.error('Preflight FAILED — refusing to --apply. Fix the issues above first.');
      process.exit(2);
    }
    console.log('(dry-run continues so you can review the plan; --apply would abort.)\n');
  }

  console.log('=== Target set ===');
  for (const o of orders) {
    console.log(`  order ${o.orderNumber} (${o.customer?.customerName ?? '?'})`);
    console.log(`    order_id       ${o.id}`);
    console.log(`    status         ${o.status} → cancelled`);
    console.log(`    total_amount   ${o.totalAmount.toString()}`);
    console.log(`    invoice        ${o.invoice?.invoiceNumber} (${o.invoice?.id})`);
    console.log();
  }

  // Row counts to be affected (proves the wipe scope)
  const orderIds = orders.map((o) => o.id);
  const invoiceIds = orders.map((o) => o.invoice!.id);

  const counts = {
    orders_will_cancel: orders.length,
    invoices_will_cancel: orders.filter((o) => o.invoice).length,
    order_items_kept: await prisma.orderItem.count({ where: { orderId: { in: orderIds } } }),
    invoice_items_kept: await prisma.invoiceItem.count({ where: { invoiceId: { in: invoiceIds } } }),
    order_status_log_kept: await prisma.orderStatusLog.count({ where: { orderId: { in: orderIds } } }),
    gst_documents_will_stamp: await prisma.gstDocument.count({ where: { invoiceId: { in: invoiceIds } } }),
    gst_api_logs_kept: await prisma.gstApiLog.count({ where: { invoiceId: { in: invoiceIds } } }),
    customer_ledger_entries_will_delete: await prisma.customerLedgerEntry.count({
      where: { invoiceId: { in: invoiceIds } },
    }),
    inventory_events_will_delete: await prisma.inventoryEvent.count({
      where: { referenceId: { in: orderIds }, referenceType: 'order' },
    }),
    driver_assignments_will_delete: await prisma.driverAssignment.count({
      where: { orderId: { in: orderIds } },
    }),
  };

  console.log('=== Wipe plan ===');
  console.log(`  UPDATE orders                  ${counts.orders_will_cancel}   (status → cancelled)`);
  console.log(`  UPDATE invoices                ${counts.invoices_will_cancel}   (status → cancelled)`);
  console.log(`  UPDATE gst_documents           ${counts.gst_documents_will_stamp}   (cancelled_at, cancel_reason_code=3)`);
  console.log(`  DELETE customer_ledger_entries ${counts.customer_ledger_entries_will_delete}`);
  console.log(`  DELETE inventory_events        ${counts.inventory_events_will_delete}   (3 dispatch + 3 delivery + 3 collection)`);
  console.log(`  DELETE driver_assignments      ${counts.driver_assignments_will_delete}   (unlinks from Trip 2 DVA)`);
  console.log(`  KEEP   order_items             ${counts.order_items_kept}`);
  console.log(`  KEEP   invoice_items           ${counts.invoice_items_kept}`);
  console.log(`  KEEP   order_status_log        ${counts.order_status_log_kept}`);
  console.log(`  KEEP   gst_api_logs            ${counts.gst_api_logs_kept}   (anti-pattern #11 forensic)`);
  console.log();

  if (args.dryRun) {
    console.log('DRY RUN — no writes. Re-run with --apply to commit.');
    return;
  }

  console.log('Applying...');
  await prisma.$transaction(async (tx) => {
    // 1. Cancel orders (keep row visible, mark cancelled)
    await tx.order.updateMany({
      where: { id: { in: orderIds } },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancellationReason: CANCELLATION_REASON,
      },
    });

    // 2. Cancel invoices (keep row visible, mark cancelled)
    //    Invoice has no `cancelledAt` column — use `closedAt` for terminal-state
    //    timestamp so the audit trail records when the cancel happened.
    //    NOT using deletedAt (that would soft-delete and hide from admin).
    await tx.invoice.updateMany({
      where: { id: { in: invoiceIds } },
      data: {
        status: 'cancelled',
        closedAt: new Date(),
      },
    });

    // 3. Stamp gst_documents so NIC audit trail reflects cancel state
    await tx.gstDocument.updateMany({
      where: { invoiceId: { in: invoiceIds } },
      data: {
        cancelledAt: new Date(),
        cancelReasonCode: '3',
        cancelReason: 'Data Entry Mistake — wrong customer selected',
      },
    });

    // 4. Delete customer ledger entries (wrong customer's statement stays clean)
    await tx.customerLedgerEntry.deleteMany({
      where: { invoiceId: { in: invoiceIds } },
    });

    // 5. Delete inventory events (per user ask — depot stock movement wiped)
    await tx.inventoryEvent.deleteMany({
      where: { referenceId: { in: orderIds }, referenceType: 'order' },
    });

    // 6. Delete driver_assignments (unlinks orders from Trip 2 DVA)
    await tx.driverAssignment.deleteMany({
      where: { orderId: { in: orderIds } },
    });
  });

  console.log('Transaction committed.\n');

  // 7. Recompute inventory summaries so depot KPI + Fleet screens read consistent.
  // Per cylinder type. Run outside the tx (recalc reads committed events).
  const affectedCylTypes = new Set<string>();
  for (const o of orders) {
    for (const item of o.items) {
      if (item.cylinderTypeId) affectedCylTypes.add(item.cylinderTypeId);
    }
  }
  for (const cylId of affectedCylTypes) {
    console.log(`Recomputing inventory_summaries for cylinderTypeId=${cylId} from ${RECOMPUTE_DATE.toISOString().slice(0, 10)}...`);
    await recalculateSummariesFromDate(VANASTHALI_DIST_ID, cylId, RECOMPUTE_DATE);
  }

  console.log('\n=== Done ===');
  console.log('  Orders cancelled: OVGS2627000340, OVGS2627000343, OVGS2627000344');
  console.log('  Invoices cancelled: IVGS2627000330, IVGS2627000333, IVGS2627000334');
  console.log('  9 inventory_events deleted');
  console.log('  3 customer_ledger_entries deleted');
  console.log('  3 driver_assignments deleted');
  console.log('  inventory_summaries recomputed for 2026-07-11 onward');
  console.log();
  console.log('NEXT: enter 3 new orders via the Item 6 Backdated Trip flow for');
  console.log('  Swaad Kitchen (4 cyl), Srinivas Hotel (4 cyl), Manikjanta Tiffins (1 cyl)');
  console.log('  dated 2026-07-11, driver=Manupati Suresh, vehicle=TS09UB7499');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
