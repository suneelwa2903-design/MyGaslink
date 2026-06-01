/**
 * Wipe today's transactional data for dist-002 (Sharma test distributor),
 * wrapped in a single Prisma interactive transaction so any failure rolls
 * back the entire wipe.
 *
 * Scope per user spec:
 *  1.  PaymentAllocations on today's payments OR today's invoices (FK-safety)
 *  2.  Payments created today
 *  3.  GstDocuments for today's invoices
 *  4.  InvoiceItems for today's invoices
 *  5.  Invoices created today
 *  6.  InventoryEvents created today
 *  7.  InventorySummary rows for today
 *  8.  OrderItems for today's orders
 *  9.  Orders with deliveryDate=today OR createdAt=today
 *  10. DriverVehicleAssignments with assignmentDate=today
 *  11. PendingActions created today
 *
 * Auxiliary cascades — NOT in the user's 11 but required so the user's
 * deletes don't trip FK constraints:
 *   - GstApiLog rows that reference today's invoices/orders
 *   - CreditNote / DebitNote rows on today's invoices
 *   - InvoiceRevision rows on today's invoices
 *   - CustomerLedgerEntry rows pointing at today's invoices or payments
 *   - OrderStatusLog / DriverAssignment / PaymentCommitment /
 *     CancelledStockEvent / StockMismatchRecord / ReconciliationEmptiesReturned
 *     rows that reference today's orders or DVAs
 *
 * Preserves: customers, drivers, vehicles, cylinder types, prices, users,
 * settings, GST credentials, ALL historical data (anything not dated today),
 * and EVERY other distributor (dist-001, dist-demo, ...).
 *
 * Usage:
 *   cd packages/api && pnpm exec tsx scripts/wipe-today-dist-002.ts
 */

import { prisma } from '../src/lib/prisma.js';

const DIST = 'dist-002';

// "Today" in IST (TZ=Asia/Kolkata per CLAUDE.md).
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const TODAY = fmt.format(new Date()); // YYYY-MM-DD
const TOMORROW = (() => {
  const d = new Date(`${TODAY}T00:00:00+05:30`);
  d.setUTCDate(d.getUTCDate() + 1);
  return fmt.format(d);
})();
// START/END are *timestamps* — only safe to use on real-timestamp columns
// (createdAt, updatedAt).
const START = new Date(`${TODAY}T00:00:00+05:30`);
const END = new Date(`${TOMORROW}T00:00:00+05:30`);

// For @db.Date columns (Postgres DATE), filtering with the IST-offset
// timestamps above produced the wrong window: Prisma serialises a JS Date
// to a DATE parameter by taking the UTC date portion, so
// `new Date('2026-06-01T00:00:00+05:30')` (= 2026-05-31T18:30:00Z) hit PG
// as the SQL date '2026-05-31' — wiping YESTERDAY instead of today. The
// fix is to pass JS Dates whose UTC date portion already IS the day we
// want. `new Date('2026-06-01')` is parsed as `2026-06-01T00:00:00Z`, so
// Prisma sends the SQL date '2026-06-01'. Use these two constants for
// every @db.Date filter (deliveryDate, assignmentDate, summaryDate,
// eventDate, cancellationDate).
const TODAY_DATE = new Date(TODAY);
const TOMORROW_DATE = new Date(TOMORROW);

interface WipeReport {
  paymentAllocations: number;
  payments: number;
  gstApiLogs: number;          // aux
  gstDocuments: number;
  creditNotes: number;          // aux
  debitNotes: number;           // aux
  invoiceItems: number;
  invoiceRevisions: number;     // aux
  customerLedgerEntries: number; // aux
  invoices: number;
  orderStatusLogs: number;      // aux
  driverAssignments: number;    // aux
  paymentCommitments: number;   // aux
  cancelledStockEvents: number; // aux
  stockMismatchRecords: number; // aux
  reconciliationEmptiesReturned: number; // aux
  inventoryEvents: number;
  inventorySummaries: number;
  driverVehicleAssignments: number;
  orderItems: number;
  orders: number;
  pendingActions: number;
  customerBalances: number;       // update-to-zero, not delete
}

async function main() {
  console.log(`Today (IST):  ${TODAY}`);
  console.log(`Window:       ${START.toISOString()}  →  ${END.toISOString()}`);
  console.log(`Distributor:  ${DIST}`);
  console.log('');

  // ── Pre-snapshot ──────────────────────────────────────────────────────────
  // Historical orders for dist-002 (deliveryDate strictly BEFORE today).
  // Used post-transaction to prove we didn't touch history.
  // deliveryDate is @db.Date — use TODAY_DATE so Prisma serialises to
  // the SQL date 'YYYY-MM-DD' that PG can compare to a DATE column.
  const histOrdersDist002Pre = await prisma.order.count({
    where: { distributorId: DIST, deliveryDate: { lt: TODAY_DATE } },
  });
  // Order counts on every OTHER distributor before the wipe.
  const otherDistOrdersPre = await prisma.order.groupBy({
    by: ['distributorId'],
    where: { distributorId: { not: DIST } },
    _count: { id: true },
  });

  console.log(`Pre-wipe historical orders on ${DIST}: ${histOrdersDist002Pre}`);
  console.log(`Pre-wipe orders on other distributors:`);
  for (const row of otherDistOrdersPre) {
    console.log(`  ${row.distributorId}: ${row._count.id}`);
  }
  console.log('');

  // ── Transactional wipe ───────────────────────────────────────────────────
  // Interactive transaction → any throw rolls back every preceding delete.
  // Default timeout is 5s; wipes can run longer on a busy local DB, give 60s.
  const counts = await prisma.$transaction(
    async (tx): Promise<WipeReport> => {
      // Resolve today's order/invoice/payment IDs first.
      // deliveryDate is @db.Date → use TODAY_DATE/TOMORROW_DATE.
      // createdAt is a real timestamp → use START/END (IST-offset window).
      const todayOrders = await tx.order.findMany({
        where: {
          distributorId: DIST,
          OR: [
            { deliveryDate: { gte: TODAY_DATE, lt: TOMORROW_DATE } },
            { createdAt: { gte: START, lt: END } },
          ],
        },
        select: { id: true },
      });
      const orderIds = todayOrders.map((o) => o.id);

      const todayInvoices = await tx.invoice.findMany({
        where: {
          distributorId: DIST,
          OR: [
            { createdAt: { gte: START, lt: END } },
            { orderId: { in: orderIds } },
          ],
        },
        select: { id: true },
      });
      const invIds = todayInvoices.map((i) => i.id);

      const todayPayments = await tx.paymentTransaction.findMany({
        where: { distributorId: DIST, createdAt: { gte: START, lt: END } },
        select: { id: true },
      });
      const paymentIds = todayPayments.map((p) => p.id);

      // assignmentDate is @db.Date — use the date-aligned constants.
      const todayDvas = await tx.driverVehicleAssignment.findMany({
        where: { distributorId: DIST, assignmentDate: { gte: TODAY_DATE, lt: TOMORROW_DATE } },
        select: { id: true },
      });
      const dvaIds = todayDvas.map((d) => d.id);

      // ── 1. PaymentAllocations ─────────────────────────────────────────────
      // FK on PaymentAllocation: paymentId → PaymentTransaction, invoiceId → Invoice.
      // Scope by today's payments OR today's invoices.
      const paymentAllocations = (
        await tx.paymentAllocation.deleteMany({
          where: {
            OR: [
              { paymentId: { in: paymentIds } },
              { invoiceId: { in: invIds } },
            ],
          },
        })
      ).count;

      // ── 2. Payments ────────────────────────────────────────────────────────
      const payments = (
        await tx.paymentTransaction.deleteMany({
          where: { id: { in: paymentIds } },
        })
      ).count;

      // ── (aux) GstApiLog rows scoped today on dist-002 ────────────────────
      // Forensic logs; large volume from repeated NIC retries. Safe to wipe
      // for today since by definition we're wiping the events they log.
      const gstApiLogs = (
        await tx.gstApiLog
          .deleteMany({ where: { distributorId: DIST, createdAt: { gte: START, lt: END } } })
          .catch(() => ({ count: 0 }))
      ).count;

      // ── 3. GstDocuments for today's invoices ──────────────────────────────
      const gstDocuments = (
        await tx.gstDocument.deleteMany({ where: { invoiceId: { in: invIds } } })
      ).count;

      // ── (aux) Credit + Debit notes on today's invoices ───────────────────
      const creditNotes = (
        await tx.creditNote
          .deleteMany({ where: { invoiceId: { in: invIds } } })
          .catch(() => ({ count: 0 }))
      ).count;
      const debitNotes = (
        await tx.debitNote
          .deleteMany({ where: { invoiceId: { in: invIds } } })
          .catch(() => ({ count: 0 }))
      ).count;

      // ── 4. InvoiceItems ──────────────────────────────────────────────────
      const invoiceItems = (
        await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: invIds } } })
      ).count;

      // ── (aux) InvoiceRevisions ──────────────────────────────────────────
      const invoiceRevisions = (
        await tx.invoiceRevision
          .deleteMany({ where: { invoiceId: { in: invIds } } })
          .catch(() => ({ count: 0 }))
      ).count;

      // ── (aux) CustomerLedgerEntry — references today's invoices/payments,
      //         or rows created today on dist-002. ───────────────────────────
      const customerLedgerEntries = (
        await tx.customerLedgerEntry
          .deleteMany({
            where: {
              distributorId: DIST,
              OR: [
                { invoiceId: { in: invIds } },
                { referenceId: { in: paymentIds } },
                { createdAt: { gte: START, lt: END } },
              ],
            },
          })
          .catch(() => ({ count: 0 }))
      ).count;

      // ── 5. Invoices ──────────────────────────────────────────────────────
      const invoices = (
        await tx.invoice.deleteMany({ where: { id: { in: invIds } } })
      ).count;

      // ── (aux) Order side-tables — must clear before deleting orders ─────
      const orderStatusLogs = (
        await tx.orderStatusLog
          .deleteMany({ where: { orderId: { in: orderIds } } })
          .catch(() => ({ count: 0 }))
      ).count;
      const driverAssignments = (
        await tx.driverAssignment
          .deleteMany({ where: { orderId: { in: orderIds } } })
          .catch(() => ({ count: 0 }))
      ).count;
      const paymentCommitments = (
        await tx.paymentCommitment
          .deleteMany({
            where: { distributorId: DIST, createdAt: { gte: START, lt: END } },
          })
          .catch(() => ({ count: 0 }))
      ).count;
      const cancelledStockEvents = (
        await tx.cancelledStockEvent
          .deleteMany({
            where: {
              distributorId: DIST,
              // orderId is fine. createdAt is timestamp (START/END ok).
              // cancellationDate is @db.Date — use date-aligned constants.
              OR: [
                { orderId: { in: orderIds } },
                { createdAt: { gte: START, lt: END } },
                { cancellationDate: { gte: TODAY_DATE, lt: TOMORROW_DATE } },
              ],
            },
          })
          .catch(() => ({ count: 0 }))
      ).count;
      const stockMismatchRecords = (
        await tx.stockMismatchRecord
          .deleteMany({
            where: { distributorId: DIST, createdAt: { gte: START, lt: END } },
          })
          .catch(() => ({ count: 0 }))
      ).count;
      const reconciliationEmptiesReturned = (
        await tx.reconciliationEmptiesReturned
          .deleteMany({ where: { dvaId: { in: dvaIds } } })
          .catch(() => ({ count: 0 }))
      ).count;

      // ── 6. InventoryEvents created today on dist-002 ─────────────────────
      // eventDate is @db.Date → date-aligned constants. createdAt is timestamp.
      const inventoryEvents = (
        await tx.inventoryEvent.deleteMany({
          where: {
            distributorId: DIST,
            OR: [
              { createdAt: { gte: START, lt: END } },
              { eventDate: { gte: TODAY_DATE, lt: TOMORROW_DATE } },
              { referenceId: { in: orderIds } },
            ],
          },
        })
      ).count;

      // ── 7. InventorySummary for today on dist-002 ────────────────────────
      // summaryDate is @db.Date → date-aligned constants.
      const inventorySummaries = (
        await tx.inventorySummary.deleteMany({
          where: { distributorId: DIST, summaryDate: { gte: TODAY_DATE, lt: TOMORROW_DATE } },
        })
      ).count;

      // ── 10. DriverVehicleAssignments (today) ─────────────────────────────
      // Done BEFORE orders because some DVAs may reference today's orders
      // via reconciliation children (already wiped above).
      const driverVehicleAssignments = (
        await tx.driverVehicleAssignment.deleteMany({
          where: { id: { in: dvaIds } },
        })
      ).count;

      // ── 8. OrderItems ────────────────────────────────────────────────────
      const orderItems = (
        await tx.orderItem.deleteMany({ where: { orderId: { in: orderIds } } })
      ).count;

      // ── 9. Orders ────────────────────────────────────────────────────────
      const orders = (
        await tx.order.deleteMany({ where: { id: { in: orderIds } } })
      ).count;

      // ── 11. PendingActions created today on dist-002 ─────────────────────
      const pendingActions = (
        await tx.pendingAction
          .deleteMany({
            where: { distributorId: DIST, createdAt: { gte: START, lt: END } },
          })
          .catch(() => ({ count: 0 }))
      ).count;

      // ── 12. CustomerInventoryBalances → zero (per user spec) ─────────────
      // These are stateful per (customer, cylinderType) rows that accumulate
      // from deliveries. They live OUTSIDE the "today" window but become
      // ghost state once we've wiped the deliveries that fed them. Zero them
      // for every customer belonging to this distributor — fresh slate for
      // testing.
      const customerBalances = (
        await tx.customerInventoryBalance.updateMany({
          where: { customer: { distributorId: DIST } },
          data: { withCustomerQty: 0, pendingReturns: 0, missingQty: 0 },
        })
      ).count;

      return {
        paymentAllocations,
        payments,
        gstApiLogs,
        gstDocuments,
        creditNotes,
        debitNotes,
        invoiceItems,
        invoiceRevisions,
        customerLedgerEntries,
        invoices,
        orderStatusLogs,
        driverAssignments,
        paymentCommitments,
        cancelledStockEvents,
        stockMismatchRecords,
        reconciliationEmptiesReturned,
        inventoryEvents,
        inventorySummaries,
        driverVehicleAssignments,
        orderItems,
        orders,
        pendingActions,
        customerBalances,
      };
    },
    { timeout: 60_000 },
  );

  // ── Post-snapshot verification ───────────────────────────────────────────
  // deliveryDate @db.Date → use TODAY_DATE (see top-of-file comment).
  const histOrdersDist002Post = await prisma.order.count({
    where: { distributorId: DIST, deliveryDate: { lt: TODAY_DATE } },
  });
  const otherDistOrdersPost = await prisma.order.groupBy({
    by: ['distributorId'],
    where: { distributorId: { not: DIST } },
    _count: { id: true },
  });

  const histDelta = histOrdersDist002Pre - histOrdersDist002Post;

  const otherMap = (rows: typeof otherDistOrdersPre): Map<string, number> =>
    new Map(rows.map((r) => [r.distributorId, r._count.id]));
  const pre = otherMap(otherDistOrdersPre);
  const post = otherMap(otherDistOrdersPost);
  const otherDeltas: Array<{ distributorId: string; pre: number; post: number; delta: number }> = [];
  const allDistIds = new Set<string>([...pre.keys(), ...post.keys()]);
  for (const id of allDistIds) {
    const p = pre.get(id) ?? 0;
    const q = post.get(id) ?? 0;
    otherDeltas.push({ distributorId: id, pre: p, post: q, delta: p - q });
  }

  // ── Report ───────────────────────────────────────────────────────────────
  console.log('═══ WIPE REPORT ═══');
  console.log(`Date wiped:  ${TODAY} (IST)`);
  console.log(`Distributor: ${DIST}`);
  console.log('');
  console.log('User-spec deletions (the 11 categories):');
  console.log(`   1. PaymentAllocations           ${counts.paymentAllocations}`);
  console.log(`   2. Payments                     ${counts.payments}`);
  console.log(`   3. GstDocuments                 ${counts.gstDocuments}`);
  console.log(`   4. InvoiceItems                 ${counts.invoiceItems}`);
  console.log(`   5. Invoices                     ${counts.invoices}`);
  console.log(`   6. InventoryEvents              ${counts.inventoryEvents}`);
  console.log(`   7. InventorySummary             ${counts.inventorySummaries}`);
  console.log(`   8. OrderItems                   ${counts.orderItems}`);
  console.log(`   9. Orders                       ${counts.orders}`);
  console.log(`  10. DriverVehicleAssignments     ${counts.driverVehicleAssignments}`);
  console.log(`  11. PendingActions               ${counts.pendingActions}`);
  console.log(`  12. CustomerInventoryBalances    ${counts.customerBalances} (zeroed, not deleted)`);
  console.log('');
  console.log('FK-safety auxiliary deletions (required to avoid FK violations):');
  console.log(`     GstApiLog                     ${counts.gstApiLogs}`);
  console.log(`     CreditNote                    ${counts.creditNotes}`);
  console.log(`     DebitNote                     ${counts.debitNotes}`);
  console.log(`     InvoiceRevision               ${counts.invoiceRevisions}`);
  console.log(`     CustomerLedgerEntry           ${counts.customerLedgerEntries}`);
  console.log(`     OrderStatusLog                ${counts.orderStatusLogs}`);
  console.log(`     DriverAssignment              ${counts.driverAssignments}`);
  console.log(`     PaymentCommitment             ${counts.paymentCommitments}`);
  console.log(`     CancelledStockEvent           ${counts.cancelledStockEvents}`);
  console.log(`     StockMismatchRecord           ${counts.stockMismatchRecords}`);
  console.log(`     ReconciliationEmptiesReturned ${counts.reconciliationEmptiesReturned}`);
  console.log('');
  console.log('═══ INTEGRITY CHECKS ═══');
  console.log(`Historical orders on ${DIST} (deliveryDate < today):`);
  console.log(`  pre:   ${histOrdersDist002Pre}`);
  console.log(`  post:  ${histOrdersDist002Post}`);
  console.log(`  delta: ${histDelta} ${histDelta === 0 ? '✓' : '✗ HISTORY TOUCHED'}`);
  console.log('');
  console.log('Other distributors (every distributor that is NOT dist-002):');
  let allOthersIntact = true;
  for (const row of otherDeltas) {
    const ok = row.delta === 0;
    if (!ok) allOthersIntact = false;
    console.log(
      `  ${row.distributorId.padEnd(15)}  pre=${String(row.pre).padEnd(6)}  post=${String(row.post).padEnd(6)}  delta=${row.delta} ${ok ? '✓' : '✗ TOUCHED'}`,
    );
  }
  console.log('');
  if (histDelta === 0 && allOthersIntact) {
    console.log('✓ All integrity checks passed.');
  } else {
    console.log('✗ INTEGRITY VIOLATION — see deltas above.');
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('Wipe failed — transaction rolled back. Error:');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
