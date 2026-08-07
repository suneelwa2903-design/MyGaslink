/**
 * KPI verification — INPUT (raw DB) vs OUTPUT (report services).
 *
 * Picks a narrow date window (default: last 5 days on dist-002 where
 * backdated + regular seed orders both exist), computes ground truth
 * from raw Order/OrderItem/InventoryEvent queries, then calls each
 * report service and diffs. Prints per-report per-KPI table with
 * PASS/FAIL — a mismatch means the report is reading wrong.
 *
 * This is the end-to-end proof for the 2026-08-06 Gap 2 fix — backdated
 * orders now emit dispatch+delivery+collection events, so every physical-
 * flow report should see them. If any report shows FAIL, either the
 * report has a bug OR the seed hasn't caught up.
 *
 * Usage:  pnpm exec tsx scripts/verify-report-kpis.ts
 */

import { prisma } from '../src/lib/prisma.js';
import {
  driverDailyLog, vehicleLedger, inventoryMovement, cylinderRotation,
  dayCloseSummary, deliveryPerformance,
} from '../src/services/reportsService.js';

const DIST = 'dist-002';

function dayKey(d: Date): string { return d.toISOString().slice(0, 10); }

async function main(): Promise<void> {
  // Window: last 25 days (matches backdated seed window). Pick a
  // sub-window narrow enough to eyeball but wide enough to include
  // both regular seed orders (12 months) and backdated seed orders
  // (last 25 days).
  const now = new Date();
  const dateFrom = dayKey(new Date(now.getTime() - 15 * 86400000));
  const dateTo = dayKey(new Date(now.getTime() - 1 * 86400000));
  console.log(`\n=== KPI verification: dist-002, ${dateFrom} → ${dateTo} ===\n`);

  // ─── GROUND TRUTH — raw Order + OrderItem + Event queries ────────────
  const from = new Date(`${dateFrom}T00:00:00.000Z`);
  const to = new Date(`${dateTo}T23:59:59.999Z`);

  const orders = await prisma.order.findMany({
    where: {
      distributorId: DIST,
      deliveryDate: { gte: from, lte: to },
      deletedAt: null,
    },
    include: { items: true, driver: { select: { driverName: true } } },
  });
  const orderIds = orders.map((o) => o.id);
  const events = await prisma.inventoryEvent.findMany({
    where: {
      distributorId: DIST,
      referenceType: { in: ['order', 'backdated_inventory_adjustment'] },
      referenceId: { in: orderIds },
      eventDate: { gte: from, lte: to },
    },
    select: { eventType: true, fullsChange: true, emptiesChange: true, referenceId: true, referenceType: true },
  });

  const backdatedOrders = orders.filter((o) => o.isBackdated);
  const regularOrders = orders.filter((o) => !o.isBackdated);
  const deliveredOrders = orders.filter((o) => o.status === 'delivered' || o.status === 'modified_delivered');
  const cancelledOrders = orders.filter((o) => o.status === 'cancelled');

  // Attribution-based reports (Driver Daily Log, Delivery Performance)
  // exclude driverless-non-godown orders. Ground truth mirrors that
  // filter so INPUT vs REPORT compare like-for-like.
  const attributable = (o: typeof orders[number]) => o.driverId !== null || o.isGodownPickup;
  const attrDelivered = deliveredOrders.filter(attributable);
  const attrCancelled = cancelledOrders.filter(attributable);

  const gtDelivered = attrDelivered.length;
  const gtCancelled = attrCancelled.length;
  const gtRevenue = attrDelivered.reduce((s, o) => s + Number(o.totalAmount), 0);
  const gtFullsDelivered = attrDelivered.reduce(
    (s, o) => s + o.items.reduce((si, it) => si + (it.deliveredQuantity ?? it.quantity), 0),
    0,
  );
  const gtEmptiesCollected = attrDelivered.reduce(
    (s, o) => s + o.items.reduce((si, it) => si + (it.emptiesCollected ?? 0), 0),
    0,
  );

  // Distinct (driver, day) pairs — includes drivers who had ONLY
  // cancelled orders that day (matches Driver Daily Log's driverId+
  // status IN (delivered, modified_delivered, cancelled) filter).
  const driverDayPairs = new Set(
    attrDelivered.concat(attrCancelled)
      .filter((o) => o.driverId)
      .map((o) => `${o.driverId}|${dayKey(o.deliveryDate)}`),
  );

  // Trip attribution ground truth (parent trips = distinct tripNumber per driver+day)
  const driverDayTripSet = new Map<string, Set<string>>();
  for (const o of attrDelivered.concat(attrCancelled)) {
    if (!o.driverId) continue;
    const k = `${o.driverId}|${dayKey(o.deliveryDate)}`;
    const set = driverDayTripSet.get(k) ?? new Set<string>();
    set.add(String(o.tripNumber ?? `orphan:${o.id}`));
    driverDayTripSet.set(k, set);
  }
  const gtTotalTrips = Array.from(driverDayTripSet.values()).reduce((s, set) => s + set.size, 0);

  // Dispatch + delivery event totals from InventoryEvent (physical-flow reports read these)
  const gtDispatchEvents = events.filter((e) => e.eventType === 'dispatch').reduce((s, e) => s + Math.abs(e.fullsChange), 0);
  const gtDeliveryEvents = events.filter((e) => e.eventType === 'delivery').reduce((s, e) => s + Math.abs(e.fullsChange), 0);
  const gtCollectionEvents = events.filter((e) => e.eventType === 'collection' || e.eventType === 'returns_collection').reduce((s, e) => s + Math.abs(e.emptiesChange), 0);

  console.log('─── GROUND TRUTH (raw DB) ───────────────────────');
  console.log(`  Orders in window:              ${orders.length}  (backdated: ${backdatedOrders.length}, regular: ${regularOrders.length})`);
  console.log(`  Delivered orders:              ${gtDelivered}`);
  console.log(`  Cancelled orders:              ${gtCancelled}`);
  console.log(`  Fulls delivered (OrderItem):   ${gtFullsDelivered}`);
  console.log(`  Empties collected (OrderItem): ${gtEmptiesCollected}`);
  console.log(`  Revenue (Order.totalAmount):   ₹${gtRevenue.toLocaleString('en-IN')}`);
  console.log(`  Distinct (driver, day) pairs:  ${driverDayPairs.size}`);
  console.log(`  Total trips (Σ per pair):      ${gtTotalTrips}`);
  console.log(`  Dispatch events (fulls):       ${gtDispatchEvents}`);
  console.log(`  Delivery events (fulls):       ${gtDeliveryEvents}`);
  console.log(`  Collection events (empties):   ${gtCollectionEvents}`);
  console.log();

  // ─── REPORT — Delivery Performance ────────────────────────────────
  console.log('─── REPORT: Delivery Performance ────────────────');
  const dp = await deliveryPerformance(DIST, { dateFrom, dateTo });
  const dpTotals = dp.totals as Record<string, unknown> | undefined;
  const dpFulls = Number(dpTotals?.fullsDelivered ?? 0);
  const dpRevenue = Number(dpTotals?.saleAmount ?? 0);
  const dpEmpties = Number(dpTotals?.emptiesCollected ?? 0);
  printRow('Fulls delivered', gtFullsDelivered, dpFulls);
  printRow('Empties collected', gtEmptiesCollected, dpEmpties);
  printRow('Revenue (saleAmount)', gtRevenue, dpRevenue);
  console.log();

  // ─── REPORT — Driver Daily Log (parent driver-day rows) ──────────
  console.log('─── REPORT: Driver Daily Log ────────────────────');
  const ddl = await driverDailyLog(DIST, { dateFrom, dateTo });
  const ddlParents = ddl.rows.filter((r) => r.type === 'driver_day');
  const ddlTotals = ddl.totals as Record<string, unknown>;
  printRow('Driver-day parent rows', driverDayPairs.size, ddlParents.length);
  printRow('Total trips (Σ children)', gtTotalTrips, Number(ddlTotals.trips ?? 0));
  printRow('Total deliveries', gtDelivered, Number(ddlTotals.deliveries ?? 0));
  printRow('Total cancelled', gtCancelled, Number(ddlTotals.cancelled ?? 0));
  printRow('Fulls delivered', gtFullsDelivered, Number(ddlTotals.fullsDelivered ?? 0));
  printRow('Empties collected', gtEmptiesCollected, Number(ddlTotals.emptiesCollected ?? 0));
  printRow('Revenue', gtRevenue, Number(ddlTotals.revenue ?? 0));
  console.log();

  // ─── REPORT — Vehicle Ledger (physical flow, reads InventoryEvent) ──
  // Broader ground-truth scope — Vehicle Ledger reads events NOT scoped
  // to referenceType='order' alone (it also picks up backdated-adjustment
  // events, includes returns_collection, etc.). Fetch all relevant event
  // types in the window, unrestricted by referenceType.
  const allEventsInWindow = await prisma.inventoryEvent.findMany({
    where: {
      distributorId: DIST,
      eventDate: { gte: from, lte: to },
      eventType: { in: ['dispatch', 'delivery', 'collection', 'returns_collection'] },
    },
    select: { eventType: true, fullsChange: true, emptiesChange: true },
  });
  const gtVLDispatch = allEventsInWindow.filter((e) => e.eventType === 'dispatch').reduce((s, e) => s + Math.abs(e.fullsChange), 0);
  const gtVLDelivery = allEventsInWindow.filter((e) => e.eventType === 'delivery').reduce((s, e) => s + Math.abs(e.fullsChange), 0);
  const gtVLCollection = allEventsInWindow.filter((e) => e.eventType === 'collection' || e.eventType === 'returns_collection').reduce((s, e) => s + Math.abs(e.emptiesChange), 0);
  console.log('─── REPORT: Vehicle Ledger (physical flow) ─────');
  const vl = await vehicleLedger(DIST, { dateFrom, dateTo });
  const vlTotals = vl.totals as Record<string, unknown>;
  // Vehicle Ledger's fullsDelivered column reads OrderItem.deliveredQuantity
  // (per-item, per-order attribution), NOT delivery InventoryEvents —
  // so the number matches the attributable-orders baseline (gtFullsDelivered).
  // fullsDispatched + emptiesCollected DO read events.
  printRow('Dispatched (fulls, events)', gtVLDispatch, Number(vlTotals.fullsDispatched ?? 0));
  printRow('Delivered (fulls, OrderItem)', gtFullsDelivered, Number(vlTotals.fullsDelivered ?? 0));
  printRow('Empties collected (events)', gtVLCollection, Number(vlTotals.emptiesCollected ?? 0));
  console.log();

  // ─── REPORT — Inventory Movement (reads InventoryEvent aggregated per day) ──
  // Same broader event scope as Vehicle Ledger.
  console.log('─── REPORT: Inventory Movement (aggregated) ─────');
  const im = await inventoryMovement(DIST, { dateFrom, dateTo });
  const imDispatched = im.rows.reduce((s, r) => s + Number(r.dispatched ?? 0), 0);
  const imDelivered = im.rows.reduce((s, r) => s + Number(r.delivered ?? 0), 0);
  printRow('Dispatched (Σ report rows)', gtVLDispatch, imDispatched);
  printRow('Delivered (Σ report rows)', gtVLDelivery, imDelivered);
  console.log();

  // ─── REPORT — Day-Close Summary (KPI dashboard) ──────────────────
  // Day-Close counts ALL delivered orders (including driverless-non-godown
  // orphans), not just attributable ones. Use the unfiltered baseline.
  const gtAllDelivered = deliveredOrders.length;
  const gtAllRevenue = deliveredOrders.reduce((s, o) => s + Number(o.totalAmount), 0);
  console.log('─── REPORT: Day-Close Summary ───────────────────');
  const dcs = await dayCloseSummary(DIST, { dateFrom, dateTo });
  const dcsRow = dcs.rows.find((r) => String(r.metric) === 'Delivered orders');
  printRow('Delivered orders (count)', gtAllDelivered, Number(dcsRow?.count ?? 0));
  printRow('Delivered revenue', gtAllRevenue, Number(dcsRow?.amount ?? 0));
  console.log();

  // ─── REPORT — Cylinder Rotation (customer inventory balance) ──────
  console.log('─── REPORT: Cylinder Rotation ───────────────────');
  const cr = await cylinderRotation(DIST, {});
  const crTotals = cr.totals as Record<string, unknown>;
  console.log(`  Currently held (report total):      ${Number(crTotals.heldQty ?? 0)}`);
  console.log(`  Rows (customer × cyl-type):         ${cr.rows.length}`);
  // Cylinder Rotation is current-state — not compared to a window count.
  // Just confirm > 0 (backdated orders should have moved the balance).
  console.log(`  ${cr.rows.length > 0 ? '✓ PASS' : '✗ FAIL'} — customer inventory balance populated`);
  console.log();

  await prisma.$disconnect();
}

function printRow(label: string, expected: number, actual: number): void {
  const status = expected === actual ? '✓ PASS' : '✗ FAIL';
  const delta = actual - expected;
  const deltaStr = delta === 0 ? '' : `  (Δ ${delta > 0 ? '+' : ''}${delta})`;
  console.log(`  ${status}  ${label.padEnd(30)}  input=${String(expected).padStart(10)}   report=${String(actual).padStart(10)}${deltaStr}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
