/**
 * One-shot: wipe TODAY's transactional surface for dist-002 (Sharma).
 *
 * Scope (full scorched-earth on today's transactional rows, per user request
 * 2026-06-18):
 *   - inventory_summary (today only)
 *   - inventory_events (today only)
 *   - dva_load_manifests (today's DVAs only)
 *   - cancelled_stock_events (today only, by createdAt)
 *   - customer_ledger_entries (today only)
 *   - payment_allocations + payment_transactions (today only)
 *   - gst_api_logs (today only)
 *   - gst_documents (linked to today's invoices)
 *   - pending_actions (today only)
 *   - credit_notes + debit_notes (today only)
 *   - invoice_items + invoices (today only)
 *   - order_status_logs + order_items + orders (today's deliveryDate only)
 *   - Reset all today's DriverVehicleAssignment rows:
 *       tripNumber=1, status=dispatch_ready, isReconciled=false,
 *       dispatchedAt/returnedAt/reconciledAt/tripSheetNo* = null
 *   - Set all dist-002 vehicles to status='idle'
 *
 * KEEPS: customers, drivers, vehicles, cylinder types, prices, distributor
 * settings, gst_credentials, users, all of yesterday's data.
 *
 * "Today" boundary uses **IST** (Asia/Kolkata) — the timezone the dev environment
 * runs in (`TZ=Asia/Kolkata`). For date-only columns we match the UTC-midnight
 * value corresponding to today-in-IST. For createdAt columns we use the half-open
 * range [today-00:00-IST, tomorrow-00:00-IST).
 *
 * Run:
 *   cd packages/api
 *   pnpm exec tsx scripts/wipe-today-dist002.ts --confirm
 *
 * Aborts without the --confirm flag.
 */
import { prisma } from '../src/lib/prisma.js';

const DIST = 'dist-002';

function todayBoundsIST(): { start: Date; end: Date; dateOnly: Date } {
  // Now in UTC.
  const now = new Date();
  // Today in IST: shift now by +05:30, take the date components, then shift back.
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const istYear = ist.getUTCFullYear();
  const istMonth = ist.getUTCMonth();
  const istDate = ist.getUTCDate();
  // Start of IST today, expressed in UTC: 2026-06-18 00:00 IST = 2026-06-17 18:30 UTC.
  const start = new Date(Date.UTC(istYear, istMonth, istDate, 0, 0, 0) - 5.5 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  // For date-only columns (Prisma @db.Date) the value is stored as UTC midnight
  // of that calendar date. We use the IST calendar date here — that's what
  // every helper in this codebase ultimately writes.
  const dateOnly = new Date(Date.UTC(istYear, istMonth, istDate, 0, 0, 0));
  return { start, end, dateOnly };
}

async function main() {
  if (!process.argv.includes('--confirm')) {
    console.error('Refusing to run without --confirm. This is destructive.');
    process.exit(1);
  }

  const { start, end, dateOnly } = todayBoundsIST();
  console.log(`Distributor: ${DIST}`);
  console.log(`Today (IST date-only): ${dateOnly.toISOString().split('T')[0]}`);
  console.log(`createdAt range:        [${start.toISOString()}, ${end.toISOString()})`);
  console.log('');

  const counts: Record<string, number> = {};

  // ── pre-counts ────────────────────────────────────────────────────────────
  const ordersToday = await prisma.order.findMany({
    where: { distributorId: DIST, deliveryDate: dateOnly },
    select: { id: true },
  });
  const orderIds = ordersToday.map((o) => o.id);
  const invoicesToday = await prisma.invoice.findMany({
    where: {
      distributorId: DIST,
      OR: [{ createdAt: { gte: start, lt: end } }, { orderId: { in: orderIds } }],
    },
    select: { id: true },
  });
  const invoiceIds = invoicesToday.map((i) => i.id);
  const dvasToday = await prisma.driverVehicleAssignment.findMany({
    where: { distributorId: DIST, assignmentDate: dateOnly },
    select: { id: true },
  });
  const dvaIds = dvasToday.map((d) => d.id);

  console.log(`Orders to delete:    ${orderIds.length}`);
  console.log(`Invoices to delete:  ${invoiceIds.length}`);
  console.log(`DVAs to reset:       ${dvaIds.length}`);
  console.log('');

  // ── delete in FK-safe order, inside one transaction ───────────────────────
  await prisma.$transaction(
    async (tx) => {
      // inventory summary / events
      counts.inventory_summary = (await tx.inventorySummary.deleteMany({
        where: { distributorId: DIST, summaryDate: dateOnly },
      })).count;
      counts.inventory_events = (await tx.inventoryEvent.deleteMany({
        where: {
          distributorId: DIST,
          OR: [{ eventDate: dateOnly }, { createdAt: { gte: start, lt: end } }],
        },
      })).count;

      // dva_load_manifests for today's DVAs
      counts.dva_load_manifests = dvaIds.length
        ? (await tx.dVALoadManifest.deleteMany({
            where: { distributorId: DIST, dvaId: { in: dvaIds } },
          })).count
        : 0;

      // cancelled_stock_events created today OR linked to today's orders
      counts.cancelled_stock_events = (await tx.cancelledStockEvent.deleteMany({
        where: {
          OR: [
            { distributorId: DIST, createdAt: { gte: start, lt: end } },
            ...(orderIds.length ? [{ orderId: { in: orderIds } }] : []),
          ],
        },
      })).count;

      // customer ledger
      counts.customer_ledger_entries = (await tx.customerLedgerEntry.deleteMany({
        where: { distributorId: DIST, createdAt: { gte: start, lt: end } },
      })).count;

      // payments — allocations first, then transactions
      counts.payment_allocations = (await tx.paymentAllocation.deleteMany({
        where: { payment: { distributorId: DIST, createdAt: { gte: start, lt: end } } },
      })).count;
      counts.payment_transactions = (await tx.paymentTransaction.deleteMany({
        where: { distributorId: DIST, createdAt: { gte: start, lt: end } },
      })).count;

      // GST artifacts — api logs, documents, pending actions
      counts.gst_api_logs = (await tx.gstApiLog.deleteMany({
        where: { distributorId: DIST, createdAt: { gte: start, lt: end } },
      })).count;
      counts.gst_documents = (await tx.gstDocument.deleteMany({
        where: {
          distributorId: DIST,
          OR: [
            ...(invoiceIds.length ? [{ invoiceId: { in: invoiceIds } }] : []),
            ...(orderIds.length ? [{ orderId: { in: orderIds } }] : []),
            { createdAt: { gte: start, lt: end } },
          ],
        },
      })).count;
      counts.pending_actions = (await tx.pendingAction.deleteMany({
        where: { distributorId: DIST, createdAt: { gte: start, lt: end } },
      })).count;

      // credit / debit notes — keyed to today's invoices OR created today
      counts.credit_notes = (await tx.creditNote.deleteMany({
        where: {
          OR: [
            { invoiceId: { in: invoiceIds } },
            { createdAt: { gte: start, lt: end }, invoice: { distributorId: DIST } },
          ],
        },
      })).count;
      counts.debit_notes = (await tx.debitNote.deleteMany({
        where: {
          OR: [
            { invoiceId: { in: invoiceIds } },
            { createdAt: { gte: start, lt: end }, invoice: { distributorId: DIST } },
          ],
        },
      })).count;

      // invoices — items first, then invoices
      counts.invoice_items = invoiceIds.length
        ? (await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } })).count
        : 0;
      counts.invoices = invoiceIds.length
        ? (await tx.invoice.deleteMany({ where: { id: { in: invoiceIds } } })).count
        : 0;

      // payment_commitments — must precede orders (no cascade)
      counts.payment_commitments = (await tx.paymentCommitment.deleteMany({
        where: {
          distributorId: DIST,
          OR: [
            { createdAt: { gte: start, lt: end } },
            ...(orderIds.length ? [{ orderId: { in: orderIds } }] : []),
          ],
        },
      })).count;

      // driver_assignments — must precede orders (no cascade)
      counts.driver_assignments = orderIds.length
        ? (await tx.driverAssignment.deleteMany({ where: { orderId: { in: orderIds } } })).count
        : 0;

      // orders — status logs + items cascade via @relation, but we delete
      // explicitly for symmetry / clarity in the row-count report.
      counts.order_status_logs = orderIds.length
        ? (await tx.orderStatusLog.deleteMany({ where: { orderId: { in: orderIds } } })).count
        : 0;
      counts.order_items = orderIds.length
        ? (await tx.orderItem.deleteMany({ where: { orderId: { in: orderIds } } })).count
        : 0;
      counts.orders = orderIds.length
        ? (await tx.order.deleteMany({ where: { id: { in: orderIds } } })).count
        : 0;

      // reset DVAs
      counts.dva_resets = dvaIds.length
        ? (await tx.driverVehicleAssignment.updateMany({
            where: { id: { in: dvaIds } },
            data: {
              tripNumber: 1,
              status: 'dispatch_ready',
              isReconciled: false,
              dispatchedAt: null,
              returnedAt: null,
              reconciledAt: null,
              tripSheetNo: null,
              tripSheetGeneratedAt: null,
              tripSheetNo2: null,
              tripSheetNo2GeneratedAt: null,
            },
          })).count
        : 0;

      // vehicles back to idle
      counts.vehicles_idled = (await tx.vehicle.updateMany({
        where: { distributorId: DIST, status: { not: 'idle' } },
        data: { status: 'idle' },
      })).count;
    },
    { timeout: 60_000 },
  );

  console.log('Done. Row counts:');
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
