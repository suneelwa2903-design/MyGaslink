/**
 * WI-094b (Fix 3/4) — GET /api/drivers/me/trip-stock scoped to current trip.
 *
 * Before this fix the endpoint summed EVERY order the driver touched today,
 * so a driver who finished Trip 1 (delivered + empties collected) and started
 * Trip 2 saw Trip 1's gone-fulls and returned-empties piled on top of Trip 2's
 * cargo — a wildly inflated truck count. The fix pins the aggregation to the
 * driver's CURRENT DVA (latest tripNumber for today), mirroring the trip-sheet
 * PDF service: dispatched/delivered orders carry `order.tripNumber ===
 * DVA.tripNumber`; pending_dispatch orders (not yet stamped) count as the
 * upcoming load.
 *
 * Tests:
 *   1 ✅ current trip only — Trip 1's delivered fulls/empties excluded
 *   2 ✅ fresh trip (no orders) → zero
 *   3 ✅ empties accumulate from delivered orders within the current trip
 *   4 ❌ cross-tenant — dist-001 driver never sees dist-002 stock
 *   5 ❌ same-tenant — driver A never sees driver B's stock
 *   6 ❌ cancelled orders excluded from fulls
 *
 * Endpoints are "today"-scoped by design (anti-pattern #7's far-future trick
 * does not apply). Synthetic phones (99130000*) / emails (@test-trip-stock.local)
 * / order numbers (TEST-TSS-*) / vehicles (TEST-TSS-VEH-*) / cylinder types
 * (TEST-TSS-CYL-*) keep cleanup from touching real rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken } from './helpers.js';
import { startOfUtcDay } from '../utils/dateOnly.js';
import type { Express } from 'express';

const PHONES = ['9913000001', '9913000002', '9913000003', '9913000004', '9913000005', '9913000006'];
const today = startOfUtcDay();

let app: Express;

// Per-scenario handles
let aToken = '', bToken = '', cToken = '', eToken = '', fToken = '', dToken = '';
let cylA = '', cylB = '', cylC = '', cylE = '', cylF = '', cylD = '';

async function cleanup() {
  await prisma.orderItem.deleteMany({ where: { order: { orderNumber: { startsWith: 'TEST-TSS-' } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: 'TEST-TSS-' } } });
  await prisma.driverVehicleAssignment.deleteMany({ where: { driver: { phone: { in: PHONES } } } });
  await prisma.vehicle.deleteMany({ where: { vehicleNumber: { startsWith: 'TEST-TSS-VEH-' } } });
  await prisma.cylinderType.deleteMany({ where: { typeName: { startsWith: 'TEST-TSS-CYL-' } } });
  await prisma.driver.deleteMany({ where: { phone: { in: PHONES } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: '@test-trip-stock.local' } } });
}

async function mkDriver(distributorId: string, phone: string, name: string, vehicleNumber: string) {
  const email = `tss-${name.toLowerCase()}@test-trip-stock.local`;
  const passwordHash = await bcrypt.hash('TestDriver@123', 10);
  const user = await prisma.user.create({
    data: { email, passwordHash, firstName: 'TSS', lastName: name, phone, role: 'driver', status: 'active', distributorId },
  });
  const driver = await prisma.driver.create({
    data: { distributorId, driverName: `TSS ${name}`, phone, status: 'active' },
  });
  const vehicle = await prisma.vehicle.create({
    data: { distributorId, vehicleNumber, vehicleType: 'Truck', status: 'returned' },
  });
  const token = generateToken({ userId: user.id, email, role: 'driver' as any, distributorId });
  return { driverId: driver.id, vehicleId: vehicle.id, token };
}

async function mkCyl(distributorId: string, typeName: string) {
  const c = await prisma.cylinderType.create({ data: { distributorId, typeName, capacity: 14.2 } });
  return c.id;
}

async function mkDva(driverId: string, vehicleId: string, distributorId: string, tripNumber: number, status: string) {
  await prisma.driverVehicleAssignment.create({
    data: { driverId, vehicleId, distributorId, assignmentDate: today, tripNumber, status: status as any },
  });
}

async function mkOrder(opts: {
  distributorId: string; customerId: string; driverId: string; vehicleId: string;
  orderNumber: string; status: string; tripNumber: number | null;
  cylinderTypeId: string; quantity: number; deliveredQuantity?: number; emptiesCollected?: number;
}) {
  await prisma.order.create({
    data: {
      orderNumber: opts.orderNumber, distributorId: opts.distributorId, customerId: opts.customerId,
      driverId: opts.driverId, vehicleId: opts.vehicleId, orderDate: today, deliveryDate: today,
      status: opts.status as any, orderType: 'delivery', totalAmount: 1000, tripNumber: opts.tripNumber,
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
  const cust1 = await prisma.customer.findFirstOrThrow({ where: { distributorId: 'dist-001', deletedAt: null } });

  // ── Driver A (dist-002): Test 1 — current trip only ──────────────────────
  const a = await mkDriver('dist-002', PHONES[0], 'A', 'TEST-TSS-VEH-A');
  aToken = a.token;
  cylA = await mkCyl('dist-002', 'TEST-TSS-CYL-A');
  await mkDva(a.driverId, a.vehicleId, 'dist-002', 1, 'reconciled');
  await mkDva(a.driverId, a.vehicleId, 'dist-002', 2, 'loaded_and_dispatched');
  // Trip 1 (excluded): delivered 4 fulls + 5 empties — must NOT appear.
  await mkOrder({ distributorId: 'dist-002', customerId: cust2.id, driverId: a.driverId, vehicleId: a.vehicleId, orderNumber: 'TEST-TSS-A-T1D', status: 'delivered', tripNumber: 1, cylinderTypeId: cylA, quantity: 4, deliveredQuantity: 4, emptiesCollected: 5 });
  // Trip 2 (current): 1 pending_delivery (2 fulls) + 1 delivered (3 empties).
  await mkOrder({ distributorId: 'dist-002', customerId: cust2.id, driverId: a.driverId, vehicleId: a.vehicleId, orderNumber: 'TEST-TSS-A-T2P', status: 'pending_delivery', tripNumber: 2, cylinderTypeId: cylA, quantity: 2 });
  await mkOrder({ distributorId: 'dist-002', customerId: cust2.id, driverId: a.driverId, vehicleId: a.vehicleId, orderNumber: 'TEST-TSS-A-T2D', status: 'delivered', tripNumber: 2, cylinderTypeId: cylA, quantity: 3, deliveredQuantity: 3, emptiesCollected: 3 });

  // ── Driver B (dist-002): Test 5 isolation partner ────────────────────────
  const b = await mkDriver('dist-002', PHONES[1], 'B', 'TEST-TSS-VEH-B');
  bToken = b.token;
  cylB = await mkCyl('dist-002', 'TEST-TSS-CYL-B');
  await mkDva(b.driverId, b.vehicleId, 'dist-002', 1, 'loaded_and_dispatched');
  await mkOrder({ distributorId: 'dist-002', customerId: cust2.id, driverId: b.driverId, vehicleId: b.vehicleId, orderNumber: 'TEST-TSS-B-P', status: 'pending_delivery', tripNumber: 1, cylinderTypeId: cylB, quantity: 7 });

  // ── Driver C (dist-002): Test 2 — fresh trip, no orders ──────────────────
  const c = await mkDriver('dist-002', PHONES[2], 'C', 'TEST-TSS-VEH-C');
  cToken = c.token;
  cylC = await mkCyl('dist-002', 'TEST-TSS-CYL-C');
  await mkDva(c.driverId, c.vehicleId, 'dist-002', 1, 'dispatch_ready');

  // ── Driver E (dist-002): Test 3 — empties accumulate in current trip ─────
  const e = await mkDriver('dist-002', PHONES[3], 'E', 'TEST-TSS-VEH-E');
  eToken = e.token;
  cylE = await mkCyl('dist-002', 'TEST-TSS-CYL-E');
  await mkDva(e.driverId, e.vehicleId, 'dist-002', 1, 'loaded_and_dispatched');
  await mkOrder({ distributorId: 'dist-002', customerId: cust2.id, driverId: e.driverId, vehicleId: e.vehicleId, orderNumber: 'TEST-TSS-E-D1', status: 'delivered', tripNumber: 1, cylinderTypeId: cylE, quantity: 1, deliveredQuantity: 1, emptiesCollected: 1 });
  await mkOrder({ distributorId: 'dist-002', customerId: cust2.id, driverId: e.driverId, vehicleId: e.vehicleId, orderNumber: 'TEST-TSS-E-D2', status: 'delivered', tripNumber: 1, cylinderTypeId: cylE, quantity: 1, deliveredQuantity: 1, emptiesCollected: 1 });
  await mkOrder({ distributorId: 'dist-002', customerId: cust2.id, driverId: e.driverId, vehicleId: e.vehicleId, orderNumber: 'TEST-TSS-E-P', status: 'pending_delivery', tripNumber: 1, cylinderTypeId: cylE, quantity: 1 });

  // ── Driver F (dist-002): Test 6 — cancelled order excluded ───────────────
  const f = await mkDriver('dist-002', PHONES[4], 'F', 'TEST-TSS-VEH-F');
  fToken = f.token;
  cylF = await mkCyl('dist-002', 'TEST-TSS-CYL-F');
  await mkDva(f.driverId, f.vehicleId, 'dist-002', 1, 'loaded_and_dispatched');
  await mkOrder({ distributorId: 'dist-002', customerId: cust2.id, driverId: f.driverId, vehicleId: f.vehicleId, orderNumber: 'TEST-TSS-F-P', status: 'pending_delivery', tripNumber: 1, cylinderTypeId: cylF, quantity: 3 });
  await mkOrder({ distributorId: 'dist-002', customerId: cust2.id, driverId: f.driverId, vehicleId: f.vehicleId, orderNumber: 'TEST-TSS-F-C', status: 'cancelled', tripNumber: 1, cylinderTypeId: cylF, quantity: 5 });

  // ── Driver D (dist-001): Test 4 — cross-tenant ───────────────────────────
  const d = await mkDriver('dist-001', PHONES[5], 'D', 'TEST-TSS-VEH-D');
  dToken = d.token;
  cylD = await mkCyl('dist-001', 'TEST-TSS-CYL-D');
  await mkDva(d.driverId, d.vehicleId, 'dist-001', 1, 'loaded_and_dispatched');
  await mkOrder({ distributorId: 'dist-001', customerId: cust1.id, driverId: d.driverId, vehicleId: d.vehicleId, orderNumber: 'TEST-TSS-D-P', status: 'pending_delivery', tripNumber: 1, cylinderTypeId: cylD, quantity: 9 });
});

afterAll(cleanup);

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const get = (t: string) => request(app).get('/api/drivers/me/trip-stock').set(auth(t));
type Row = { cylinderTypeId: string; fullQuantity: number; deliveredQuantity: number; emptyQuantity: number };
const sum = (rows: Row[], k: keyof Row) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);

describe('WI-094b — GET /drivers/me/trip-stock scoped to current trip', () => {
  it('✅ 1 — returns only the current trip (Trip 1 fulls/empties excluded)', async () => {
    const res = await get(aToken);
    expect(res.status).toBe(200);
    const rows: Row[] = res.body.data.items;
    const row = rows.find((r) => r.cylinderTypeId === cylA)!;
    expect(row).toBeTruthy();
    expect(row.fullQuantity).toBe(2);   // Trip 2 pending only — NOT Trip 1's 4 delivered
    expect(row.emptyQuantity).toBe(3);  // Trip 2 delivered empties only — NOT Trip 1's 5
    expect(sum(rows, 'fullQuantity')).toBe(2);
    expect(sum(rows, 'emptyQuantity')).toBe(3);
  });

  it('✅ 2 — fresh trip with no orders returns zero', async () => {
    const res = await get(cToken);
    expect(res.status).toBe(200);
    const rows: Row[] = res.body.data.items;
    expect(sum(rows, 'fullQuantity')).toBe(0);
    expect(sum(rows, 'emptyQuantity')).toBe(0);
  });

  it('✅ 3 — empties accumulate from current-trip delivered orders', async () => {
    const res = await get(eToken);
    expect(res.status).toBe(200);
    const rows: Row[] = res.body.data.items;
    expect(sum(rows, 'emptyQuantity')).toBe(2); // 1 + 1 from two delivered
    expect(sum(rows, 'fullQuantity')).toBe(1);  // the still-pending one
  });

  it('❌ 4 — cross-tenant: dist-001 driver never sees dist-002 stock', async () => {
    const res = await get(dToken);
    expect(res.status).toBe(200);
    const rows: Row[] = res.body.data.items;
    expect(rows.some((r) => r.cylinderTypeId === cylD)).toBe(true);
    expect(rows.some((r) => [cylA, cylB, cylC, cylE, cylF].includes(r.cylinderTypeId))).toBe(false);
  });

  it('❌ 5 — same-tenant: driver A and B never see each other’s stock', async () => {
    const resA = await get(aToken);
    const resB = await get(bToken);
    const rowsA: Row[] = resA.body.data.items;
    const rowsB: Row[] = resB.body.data.items;
    expect(rowsA.some((r) => r.cylinderTypeId === cylB)).toBe(false);
    expect(rowsB.some((r) => r.cylinderTypeId === cylA)).toBe(false);
    expect(rowsB.find((r) => r.cylinderTypeId === cylB)?.fullQuantity).toBe(7);
  });

  it('❌ 6 — cancelled order excluded from fulls', async () => {
    const res = await get(fToken);
    expect(res.status).toBe(200);
    const rows: Row[] = res.body.data.items;
    expect(sum(rows, 'fullQuantity')).toBe(3); // pending 3 only — NOT the cancelled 5
  });
});

// WI-094c (Change 2) — GET /drivers/me/assignment orders scoped to current trip.
describe('WI-094c — GET /drivers/me/assignment orders scoped to current trip', () => {
  const assignment = (t: string) => request(app).get('/api/drivers/me/assignment').set(auth(t));

  it('✅ 7 — assignment.orders shows only current-trip orders (Trip 1 excluded)', async () => {
    // Driver A: Trip 1 delivered (TEST-TSS-A-T1D, tripNumber=1) + Trip 2 current
    // (A-T2P pending + A-T2D delivered, tripNumber=2). Current DVA is trip 2.
    const res = await assignment(aToken);
    expect(res.status).toBe(200);
    const nums: string[] = res.body.data.orders.map((o: any) => o.orderNumber);
    expect(nums).toEqual(expect.arrayContaining(['TEST-TSS-A-T2P', 'TEST-TSS-A-T2D']));
    expect(nums).not.toContain('TEST-TSS-A-T1D');
  });

  it('❌ 8 — cross-tenant: dist-001 driver sees only its own orders', async () => {
    const res = await assignment(dToken);
    expect(res.status).toBe(200);
    const nums: string[] = res.body.data.orders.map((o: any) => o.orderNumber);
    expect(nums).toContain('TEST-TSS-D-P');
    expect(nums.some((n) => n.startsWith('TEST-TSS-A-'))).toBe(false);
  });
});
