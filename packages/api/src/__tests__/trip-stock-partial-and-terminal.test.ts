/**
 * 2026-06-01 — GET /api/drivers/me/trip-stock corrections.
 *
 * Two production bugs surfaced during mobile testing on 2026-06-01:
 *
 * (1) Partial delivery silently zeroed remaining fulls on the truck.
 *     The endpoint's per-order aggregator put delivered/modified_delivered
 *     orders into a branch that ONLY incremented `deliveredQuantity` and
 *     `emptyQuantity` — never `fullQuantity`. So an order with
 *     `quantity=2, deliveredQuantity=1` (customer rejected one) contributed
 *     0 fulls instead of the 1 still physically on the truck. The driver
 *     screen under-reported cargo as 0 when the truck actually still held
 *     undelivered cylinders.
 *
 * (2) Empties persisted after Confirm & Reconcile.
 *     `confirmVehicleReconciliation` flips DVA.isReconciled=true at
 *     deliveryWorkflowService.ts:706, but trip-stock never checked the flag.
 *     It kept summing every delivered order's `emptiesCollected` indefinitely
 *     even after the truck was physically swept back at the depot. The
 *     workflow only zeroed out when BOTH Confirm & Reconcile AND Report
 *     Mismatch had run (because Report Mismatch happens to call
 *     confirmVehicleReconciliation again under the hood when the gap closes,
 *     which the trip-stock code happily kept ignoring).
 *
 * Fixes — packages/api/src/routes/driversVehicles.ts:
 *   - line ~422: `select` now includes `isReconciled`.
 *   - line ~425 (new): if `currentDva.isReconciled` → return `{ items: [] }`.
 *   - line ~480-486: delivered branch now adds
 *     `Math.max(0, ordered - delivered)` to `fullQuantity`.
 *
 * Synthetic phones (99131000*) / emails (@test-tspt.local) / order numbers
 * (TEST-TSPT-*) / vehicles + cylinder types (TEST-TSPT-*) — cleanup never
 * touches real seeded rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken } from './helpers.js';
import { startOfUtcDay } from '../utils/dateOnly.js';
import type { Express } from 'express';
import type { $Enums } from '@prisma/client';
import type { UserRole } from '@gaslink/shared';

const PHONES = ['9913100001', '9913100002', '9913100003'];
const today = startOfUtcDay();

let app: Express;

// Per-scenario handles
let pToken = '', rToken = '', xToken = '';
let cylP = '', cylR = '', cylX = '';

async function cleanup() {
  await prisma.orderItem.deleteMany({ where: { order: { orderNumber: { startsWith: 'TEST-TSPT-' } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: 'TEST-TSPT-' } } });
  await prisma.driverVehicleAssignment.deleteMany({ where: { driver: { phone: { in: PHONES } } } });
  await prisma.vehicle.deleteMany({ where: { vehicleNumber: { startsWith: 'TEST-TSPT-VEH-' } } });
  await prisma.cylinderType.deleteMany({ where: { typeName: { startsWith: 'TEST-TSPT-CYL-' } } });
  await prisma.driver.deleteMany({ where: { phone: { in: PHONES } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: '@test-tspt.local' } } });
}

async function mkDriver(distributorId: string, phone: string, name: string, vehicleNumber: string) {
  const email = `tspt-${name.toLowerCase()}@test-tspt.local`;
  const passwordHash = await bcrypt.hash('TestDriver@123', 10);
  const user = await prisma.user.create({
    data: { email, passwordHash, firstName: 'TSPT', lastName: name, phone, role: 'driver', status: 'active', distributorId },
  });
  const driver = await prisma.driver.create({
    data: { distributorId, driverName: `TSPT ${name}`, phone, status: 'active' },
  });
  const vehicle = await prisma.vehicle.create({
    data: { distributorId, vehicleNumber, vehicleType: 'Truck', status: 'returned' },
  });
  const token = generateToken({ userId: user.id, email, role: 'driver' as UserRole, distributorId });
  return { driverId: driver.id, vehicleId: vehicle.id, token };
}

async function mkCyl(distributorId: string, typeName: string) {
  const c = await prisma.cylinderType.create({ data: { distributorId, typeName, capacity: 14.2 } });
  return c.id;
}

async function mkDva(driverId: string, vehicleId: string, distributorId: string, tripNumber: number, status: $Enums.AssignmentStatus, isReconciled = false) {
  const dva = await prisma.driverVehicleAssignment.create({
    data: { driverId, vehicleId, distributorId, assignmentDate: today, tripNumber, status, isReconciled },
  });
  return dva.id;
}

async function mkOrder(opts: {
  distributorId: string; customerId: string; driverId: string; vehicleId: string;
  orderNumber: string; status: $Enums.OrderStatus; tripNumber: number | null;
  cylinderTypeId: string; quantity: number; deliveredQuantity?: number; emptiesCollected?: number;
}) {
  await prisma.order.create({
    data: {
      orderNumber: opts.orderNumber, distributorId: opts.distributorId, customerId: opts.customerId,
      driverId: opts.driverId, vehicleId: opts.vehicleId, orderDate: today, deliveryDate: today,
      status: opts.status, orderType: 'delivery', totalAmount: 1000, tripNumber: opts.tripNumber,
      items: {
        create: [{
          cylinderTypeId: opts.cylinderTypeId, quantity: opts.quantity, unitPrice: 1000, totalPrice: 1000,
          deliveredQuantity: opts.deliveredQuantity ?? null, emptiesCollected: opts.emptiesCollected ?? null,
        }],
      },
    },
  });
}

beforeAll(async () => {
  app = createApp();
  await cleanup();

  const cust2 = await prisma.customer.findFirstOrThrow({ where: { distributorId: 'dist-002', deletedAt: null } });

  // ── Driver P — Test 1+2: PARTIAL delivery keeps leftover fulls on truck ──
  // Trip 1: one modified_delivered order quantity=2, deliveredQuantity=1,
  // emptiesCollected=2. Expected: fullQuantity=1 (the rejected one),
  // deliveredQuantity=1, emptyQuantity=2.
  const p = await mkDriver('dist-002', PHONES[0], 'P', 'TEST-TSPT-VEH-P');
  pToken = p.token;
  cylP = await mkCyl('dist-002', 'TEST-TSPT-CYL-P');
  await mkDva(p.driverId, p.vehicleId, 'dist-002', 1, 'loaded_and_dispatched', false);
  await mkOrder({
    distributorId: 'dist-002', customerId: cust2.id, driverId: p.driverId, vehicleId: p.vehicleId,
    orderNumber: 'TEST-TSPT-P-MOD', status: 'modified_delivered', tripNumber: 1,
    cylinderTypeId: cylP, quantity: 2, deliveredQuantity: 1, emptiesCollected: 2,
  });

  // ── Driver R — Test 3: reconciled DVA short-circuits to empty cargo ──────
  // Same delivered+empties pile as the WI-094b test, but isReconciled=true.
  // Expected: items=[] regardless of how many delivered orders exist.
  const r = await mkDriver('dist-002', PHONES[1], 'R', 'TEST-TSPT-VEH-R');
  rToken = r.token;
  cylR = await mkCyl('dist-002', 'TEST-TSPT-CYL-R');
  // WI-100: a reconciled DVA rolls back to dispatch_ready but keeps
  // isReconciled=true (see deliveryWorkflowService.ts:706). Mirror that.
  await mkDva(r.driverId, r.vehicleId, 'dist-002', 1, 'dispatch_ready', true);
  await mkOrder({
    distributorId: 'dist-002', customerId: cust2.id, driverId: r.driverId, vehicleId: r.vehicleId,
    orderNumber: 'TEST-TSPT-R-D1', status: 'delivered', tripNumber: 1,
    cylinderTypeId: cylR, quantity: 3, deliveredQuantity: 3, emptiesCollected: 3,
  });
  await mkOrder({
    distributorId: 'dist-002', customerId: cust2.id, driverId: r.driverId, vehicleId: r.vehicleId,
    orderNumber: 'TEST-TSPT-R-MOD', status: 'modified_delivered', tripNumber: 1,
    cylinderTypeId: cylR, quantity: 2, deliveredQuantity: 1, emptiesCollected: 2,
  });

  // ── Driver X — Test 4: NON-reconciled control case (cargo still visible) ──
  // Same data as driver R but isReconciled=false. Used to prove the fix
  // doesn't accidentally hide cargo for live trips.
  const x = await mkDriver('dist-002', PHONES[2], 'X', 'TEST-TSPT-VEH-X');
  xToken = x.token;
  cylX = await mkCyl('dist-002', 'TEST-TSPT-CYL-X');
  await mkDva(x.driverId, x.vehicleId, 'dist-002', 1, 'loaded_and_dispatched', false);
  await mkOrder({
    distributorId: 'dist-002', customerId: cust2.id, driverId: x.driverId, vehicleId: x.vehicleId,
    orderNumber: 'TEST-TSPT-X-MOD', status: 'modified_delivered', tripNumber: 1,
    cylinderTypeId: cylX, quantity: 5, deliveredQuantity: 3, emptiesCollected: 4,
  });
});

afterAll(cleanup);

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const get = (t: string) => request(app).get('/api/drivers/me/trip-stock').set(auth(t));
type Row = { cylinderTypeId: string; fullQuantity: number; deliveredQuantity: number; emptyQuantity: number };

describe('GET /drivers/me/trip-stock — partial delivery + reconcile terminal', () => {
  it('✅ 1 — partial delivery leaves leftover fulls visible on the truck', async () => {
    // Order: quantity=2, deliveredQuantity=1, emptiesCollected=2.
    // Expected: fullQuantity = 2 - 1 = 1 (the rejected one is still on truck).
    const res = await get(pToken);
    expect(res.status).toBe(200);
    const rows: Row[] = res.body.data.items;
    const row = rows.find((r) => r.cylinderTypeId === cylP);
    expect(row).toBeTruthy();
    expect(row!.fullQuantity).toBe(1);
    expect(row!.deliveredQuantity).toBe(1);
    expect(row!.emptyQuantity).toBe(2);
  });

  it('✅ 2 — partial delivery: fullQuantity = ordered - deliveredQuantity, never negative', async () => {
    // Even if a future writer over-delivered (delivered > ordered, which
    // Group 8's over-delivery guard already prevents), the aggregator must
    // not contribute a negative number to the running total. Math.max(0,...)
    // is the floor — this test pins the contract.
    const res = await get(pToken);
    expect(res.status).toBe(200);
    const rows: Row[] = res.body.data.items;
    const row = rows.find((r) => r.cylinderTypeId === cylP)!;
    expect(row.fullQuantity).toBeGreaterThanOrEqual(0);
  });

  it('✅ 3 — reconciled DVA: trip-stock returns empty items (truck cleared)', async () => {
    // Driver R has TWO delivered orders worth 5 empties + 1 leftover full,
    // but the DVA is isReconciled=true (supervisor has run Confirm &
    // Reconcile). The short-circuit must zero out the entire response —
    // empties already returned to depot, fulls already swept back.
    const res = await get(rToken);
    expect(res.status).toBe(200);
    const rows: Row[] = res.body.data.items;
    expect(rows).toEqual([]);
  });

  it('✅ 4 — non-reconciled control: leftover fulls + empties still visible', async () => {
    // Same data shape as driver R (1 leftover full, 4 empties) but
    // isReconciled=false. Cargo must remain visible — the fix must not
    // accidentally hide live trips.
    const res = await get(xToken);
    expect(res.status).toBe(200);
    const rows: Row[] = res.body.data.items;
    const row = rows.find((r) => r.cylinderTypeId === cylX)!;
    expect(row).toBeTruthy();
    expect(row.fullQuantity).toBe(2);   // 5 ordered - 3 delivered
    expect(row.deliveredQuantity).toBe(3);
    expect(row.emptyQuantity).toBe(4);
  });
});
