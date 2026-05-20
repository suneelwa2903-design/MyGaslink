/**
 * dist-002 (Sharma Gas Distributors) clean-slate + seed script
 *
 * 1. Deletes all transactional data for dist-002
 * 2. Resets vehicle.status back to 'idle' for any dispatched vehicles
 * 3. Resets any active DVA back to 'dispatch_ready'
 * 4. Seeds incoming fulls for 4 cylinder types via API
 *
 * Run: npx tsx scripts/cleanup-dist002-seed.ts
 * Requires: API server running at localhost:5000
 */

import { prisma } from '../src/lib/prisma.js';

const BASE = 'http://localhost:5000/api';
const DIST_ID = 'dist-002';
const TODAY = new Date().toISOString().split('T')[0];

const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};
const ok   = (s: string) => `${C.green}✓${C.reset} ${s}`;
const fail = (s: string) => `${C.red}✗${C.reset} ${s}`;
const info = (s: string) => `${C.cyan}·${C.reset} ${s}`;
const head = (s: string) => `\n${C.bold}${C.cyan}${s}${C.reset}`;

async function api(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function main() {
  console.log(head('━━━ dist-002 Clean Slate + Seed ━━━'));

  // ── 1. Delete transactional data ────────────────────────────────────────────
  console.log(head('Step 1 — Delete transactional data'));

  // Cascade order: children first, parents last
  const gstApiLogs = await prisma.gstApiLog.deleteMany({ where: { distributorId: DIST_ID } });
  console.log(info(`gst_api_logs deleted: ${gstApiLogs.count}`));

  const gstDocs = await prisma.gstDocument.deleteMany({ where: { distributorId: DIST_ID } });
  console.log(info(`gst_documents deleted: ${gstDocs.count}`));

  const pendingActions = await prisma.pendingAction.deleteMany({ where: { distributorId: DIST_ID } });
  console.log(info(`pending_actions deleted: ${pendingActions.count}`));

  const cancelledStock = await prisma.cancelledStockEvent.deleteMany({ where: { distributorId: DIST_ID } });
  console.log(info(`cancelled_stock_events deleted: ${cancelledStock.count}`));

  const paymentAllocs = await prisma.paymentAllocation.deleteMany({
    where: { payment: { distributorId: DIST_ID } },
  });
  console.log(info(`payment_allocations deleted: ${paymentAllocs.count}`));

  const payments = await prisma.paymentTransaction.deleteMany({ where: { distributorId: DIST_ID } });
  console.log(info(`payment_transactions deleted: ${payments.count}`));

  const ledgerEntries = await prisma.customerLedgerEntry.deleteMany({ where: { distributorId: DIST_ID } });
  console.log(info(`customer_ledger_entries deleted: ${ledgerEntries.count}`));

  // creditNotes and debitNotes have no distributorId — already gone (cascaded with invoices above)
  // If any linger from a prior partial run, clean via invoice relation
  const creditNotes = await prisma.creditNote.deleteMany({
    where: { invoice: { distributorId: DIST_ID } },
  });
  console.log(info(`credit_notes deleted: ${creditNotes.count}`));

  const debitNotes = await prisma.debitNote.deleteMany({
    where: { invoice: { distributorId: DIST_ID } },
  });
  console.log(info(`debit_notes deleted: ${debitNotes.count}`));

  const invoiceRevisions = await prisma.invoiceRevision.deleteMany({
    where: { invoice: { distributorId: DIST_ID } },
  });
  console.log(info(`invoice_revisions deleted: ${invoiceRevisions.count}`));

  const invoiceItems = await prisma.invoiceItem.deleteMany({
    where: { invoice: { distributorId: DIST_ID } },
  });
  console.log(info(`invoice_items deleted: ${invoiceItems.count}`));

  const invoices = await prisma.invoice.deleteMany({ where: { distributorId: DIST_ID } });
  console.log(info(`invoices deleted: ${invoices.count}`));

  const orderItems = await prisma.orderItem.deleteMany({
    where: { order: { distributorId: DIST_ID } },
  });
  console.log(info(`order_items deleted: ${orderItems.count}`));

  const orderStatusLogs = await prisma.orderStatusLog.deleteMany({
    where: { order: { distributorId: DIST_ID } },
  });
  console.log(info(`order_status_logs deleted: ${orderStatusLogs.count}`));

  const driverAssignments = await prisma.driverAssignment.deleteMany({
    where: { order: { distributorId: DIST_ID } },
  });
  console.log(info(`driver_assignments deleted: ${driverAssignments.count}`));

  const orders = await prisma.order.deleteMany({ where: { distributorId: DIST_ID } });
  console.log(info(`orders deleted: ${orders.count}`));

  // Delete inventory events (incoming-fulls, adjustments, etc.)
  const invEvents = await prisma.inventoryEvent.deleteMany({ where: { distributorId: DIST_ID } });
  console.log(info(`inventory_events deleted: ${invEvents.count}`));

  // Delete inventory summaries (recalculated on seed)
  const invSummaries = await prisma.inventorySummary.deleteMany({ where: { distributorId: DIST_ID } });
  console.log(info(`inventory_summaries deleted: ${invSummaries.count}`));

  // Delete vehicle inventory snapshots
  const vehicleInventory = await prisma.vehicleInventory.deleteMany({
    where: { vehicle: { distributorId: DIST_ID } },
  });
  console.log(info(`vehicle_inventory deleted: ${vehicleInventory.count}`));

  // ── 2. Reset DVA back to dispatch_ready ──────────────────────────────────────
  console.log(head('Step 2 — Reset DVAs and vehicle statuses'));

  const dvaReset = await prisma.driverVehicleAssignment.updateMany({
    where: {
      distributorId: DIST_ID,
      status: { in: ['loaded_and_dispatched', 'reconciled'] },
    },
    data: { status: 'dispatch_ready', tripSheetNo: null, tripSheetGeneratedAt: null },
  });
  console.log(info(`DVAs reset to dispatch_ready: ${dvaReset.count}`));

  const vehicleReset = await prisma.vehicle.updateMany({
    where: { distributorId: DIST_ID, status: 'dispatched' },
    data: { status: 'idle' },
  });
  console.log(info(`vehicles reset to idle: ${vehicleReset.count}`));

  // ── 3. Seed incoming fulls via API ───────────────────────────────────────────
  console.log(head('Step 3 — Seed incoming fulls via API'));

  // Login
  const loginRes = await api('POST', '/auth/login', {
    email: 'sharma@gasdist.com',
    password: 'Gstadmin@123',
  });
  const token = loginRes.body?.data?.tokens?.accessToken ?? loginRes.body?.data?.accessToken;
  if (!token) throw new Error(`Login failed: ${JSON.stringify(loginRes.body)}`);
  console.log(info('Logged in as sharma@gasdist.com'));

  // Look up cylinder types
  const ctRes = await api('GET', '/cylinder-types', undefined, token);
  const ctList: Array<{ cylinderTypeId: string; typeName: string }> =
    ctRes.body?.data?.cylinderTypes ?? ctRes.body?.data ?? [];
  if (!ctList.length) throw new Error(`No cylinder types returned: ${JSON.stringify(ctRes.body).slice(0, 200)}`);

  const findCt = (kg: number) =>
    ctList.find((c) => c.typeName.toLowerCase() === `${kg} kg`) ??
    ctList.find((c) => new RegExp(`(^|\\s)${kg}(\\s|kg|$)`, 'i').test(c.typeName));

  const seeds: Array<{ kg: number; qty: number }> = [
    { kg: 19,    qty: 50 },
    { kg: 47.5,  qty: 20 },
    { kg: 425,   qty: 10 },
    { kg: 5,     qty: 30 },
  ];

  for (const { kg, qty } of seeds) {
    const ct = findCt(kg);
    if (!ct) {
      console.log(fail(`  ${kg} KG cylinder type not found — skipping`));
      continue;
    }
    const payload = {
      cylinderTypeId: ct.cylinderTypeId,
      quantity: qty,
      documentType: 'Purchase Order',
      documentNumber: `SEED-${kg}KG-${TODAY}`,
      documentDate: TODAY,
    };
    const r = await api('POST', '/inventory/incoming-fulls', payload, token);
    if (r.status === 201) {
      console.log(ok(`  ${kg} KG × ${qty}  (${ct.cylinderTypeId})`));
    } else {
      console.log(fail(`  ${kg} KG × ${qty}  — HTTP ${r.status}: ${JSON.stringify(r.body)}`));
    }
  }

  // ── 4. Ensure test-fixture invoice exists ────────────────────────────────────
  // Several integration tests (invoice-list-badges-cn-pdf, gst-trip-sheet-dn-pdf)
  // call prisma.invoice.findFirstOrThrow({ where: { distributorId: 'dist-002',
  // totalAmount: { gt: 1000 } } }) — they pre-date self-seeding and rely on
  // ambient dist-002 data. After a full cleanup, we need at least one issued
  // invoice to unblock those tests.
  console.log(head('Step 4 — Ensure test-fixture invoice'));

  const maruthi = await prisma.customer.findFirst({
    where: { distributorId: DIST_ID, customerName: 'Maruthi Agencies', deletedAt: null },
  });
  const existingFixture = await prisma.invoice.count({
    where: { distributorId: DIST_ID, deletedAt: null, status: { not: 'cancelled' }, totalAmount: { gt: 1000 } },
  });
  if (existingFixture === 0) {
    const today = new Date();
    const due = new Date(today);
    due.setDate(due.getDate() + 30);
    await prisma.invoice.create({
      data: {
        invoiceNumber: `FIXTURE-D002-${TODAY}`,
        distributorId: DIST_ID,
        customerId: maruthi?.id ?? null,
        issueDate: today,
        dueDate: due,
        totalAmount: 5000,
        outstandingAmount: 5000,
        status: 'issued',
      },
    });
    console.log(ok('  Fixture invoice FIXTURE-D002 created (5000 issued)'));
  } else {
    console.log(info(`  ${existingFixture} qualifying invoice(s) already exist — skipping`));
  }

  // ── 5. Summary ──────────────────────────────────────────────────────────────
  console.log(head('Done'));
  const remaining = await prisma.order.count({ where: { distributorId: DIST_ID } });
  console.log(info(`orders remaining for dist-002: ${remaining}`));
  const invCheck = await prisma.inventoryEvent.count({ where: { distributorId: DIST_ID } });
  console.log(info(`inventory events now: ${invCheck}  (should be 4 seed rows)`));
  const invTotal = await prisma.invoice.count({
    where: { distributorId: DIST_ID, status: { not: 'cancelled' } },
  });
  console.log(info(`active invoices for tests: ${invTotal}`));
  console.log('');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
