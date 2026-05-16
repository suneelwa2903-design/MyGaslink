import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import {
  loginAsDistAdmin,
  getSeedData,
  generateToken,
} from './helpers.js';
import type { Express } from 'express';
import type { UserRole } from '@gaslink/shared';

/**
 * Orders — driver auto-scoping (security)
 *
 * Pins the fix for: GET /api/orders previously did NOT filter by driver_id
 * when the caller's role was 'driver'. A driver hitting /orders would see
 * every other driver's orders in the same distributor — a within-tenant
 * data leak.
 *
 * The route now resolves the caller → driver record via shared phone + the
 * caller's distributorId, then forces `driverId = thatDriver.id` into the
 * filter before delegating to orderService.listOrders.
 *
 * Per anti-pattern #7: any test that seeds time-sensitive data MUST use a
 * fixed far-future date that real manual-test data will never occupy, so
 * the test never accidentally sweeps real rows.
 */
const TEST_DATE = '2099-12-31';

// Synthetic phones for the two test driver users we create. Picked to be
// outside the seeded 9800000001..9800000099 band so we never collide with
// real fixtures.
const DRIVER_A_PHONE = '9911100001';
const DRIVER_B_PHONE = '9911100002';
const DRIVER_A_EMAIL = 'driver-scope-a@test-orders.local';
const DRIVER_B_EMAIL = 'driver-scope-b@test-orders.local';
const ORPHAN_EMAIL = 'driver-scope-orphan@test-orders.local';
const ORPHAN_PHONE = '9911100099'; // No driver row will match this phone.
const ORDER_A_NUM = 'TEST-DRV-SCOPE-A';
const ORDER_B_NUM = 'TEST-DRV-SCOPE-B';

let app: Express;
let adminToken: string;
let seedData: Awaited<ReturnType<typeof getSeedData>>;

let driverAId: string;
let driverBId: string;
let driverAUserId: string;
let driverBUserId: string;
let driverAToken: string;
let driverBToken: string;
let orphanToken: string;
let orderAId: string;
let orderBId: string;

async function cleanupFixtures() {
  // Orders first (FK to drivers).
  await prisma.orderItem.deleteMany({
    where: { order: { orderNumber: { in: [ORDER_A_NUM, ORDER_B_NUM] } } },
  });
  await prisma.order.deleteMany({
    where: { orderNumber: { in: [ORDER_A_NUM, ORDER_B_NUM] } },
  });
  // Drivers — guard with the synthetic phones so we never touch seed drivers.
  await prisma.driver.deleteMany({
    where: { phone: { in: [DRIVER_A_PHONE, DRIVER_B_PHONE] } },
  });
  // Users — guard with the synthetic emails.
  await prisma.user.deleteMany({
    where: { email: { in: [DRIVER_A_EMAIL, DRIVER_B_EMAIL, ORPHAN_EMAIL] } },
  });
}

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;
  seedData = await getSeedData();

  // Clean any leftovers from prior runs before reseeding.
  await cleanupFixtures();

  const passwordHash = await bcrypt.hash('TestDriver@123', 10);

  // Driver A: user + driver record linked by phone.
  const userA = await prisma.user.create({
    data: {
      email: DRIVER_A_EMAIL,
      passwordHash,
      firstName: 'ScopeTest',
      lastName: 'DriverA',
      phone: DRIVER_A_PHONE,
      role: 'driver',
      status: 'active',
      distributorId: 'dist-001',
    },
  });
  driverAUserId = userA.id;
  const driverA = await prisma.driver.create({
    data: {
      distributorId: 'dist-001',
      driverName: 'ScopeTest DriverA',
      phone: DRIVER_A_PHONE,
      status: 'active',
    },
  });
  driverAId = driverA.id;

  // Driver B: same pattern, different phone.
  const userB = await prisma.user.create({
    data: {
      email: DRIVER_B_EMAIL,
      passwordHash,
      firstName: 'ScopeTest',
      lastName: 'DriverB',
      phone: DRIVER_B_PHONE,
      role: 'driver',
      status: 'active',
      distributorId: 'dist-001',
    },
  });
  driverBUserId = userB.id;
  const driverB = await prisma.driver.create({
    data: {
      distributorId: 'dist-001',
      driverName: 'ScopeTest DriverB',
      phone: DRIVER_B_PHONE,
      status: 'active',
    },
  });
  driverBId = driverB.id;

  // Two orders, one assigned to each driver, both pending_delivery, dated
  // far-future so real dispatch flows never see them.
  const customer = seedData.customers[0];
  const cyl = seedData.cylinderTypes[1];

  const orderA = await prisma.order.create({
    data: {
      orderNumber: ORDER_A_NUM,
      distributorId: 'dist-001',
      customerId: customer.id,
      driverId: driverAId,
      orderDate: new Date(TEST_DATE),
      deliveryDate: new Date(TEST_DATE),
      status: 'pending_delivery',
      totalAmount: 1800,
      items: {
        create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 1800, totalPrice: 1800 }],
      },
    },
  });
  orderAId = orderA.id;

  const orderB = await prisma.order.create({
    data: {
      orderNumber: ORDER_B_NUM,
      distributorId: 'dist-001',
      customerId: customer.id,
      driverId: driverBId,
      orderDate: new Date(TEST_DATE),
      deliveryDate: new Date(TEST_DATE),
      status: 'pending_delivery',
      totalAmount: 1800,
      items: {
        create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 1800, totalPrice: 1800 }],
      },
    },
  });
  orderBId = orderB.id;

  // Orphan: real driver-role user, but no driver row matches their phone.
  // Used by the "returns empty list, not 403" test — exercises the safe
  // fallback when a driver account exists but isn't in the roster.
  const orphanUser = await prisma.user.create({
    data: {
      email: ORPHAN_EMAIL,
      passwordHash,
      firstName: 'ScopeTest',
      lastName: 'Orphan',
      phone: ORPHAN_PHONE,
      role: 'driver',
      status: 'active',
      distributorId: 'dist-001',
    },
  });

  driverAToken = generateToken({
    userId: driverAUserId,
    email: DRIVER_A_EMAIL,
    role: 'driver' as UserRole,
    distributorId: 'dist-001',
  });
  driverBToken = generateToken({
    userId: driverBUserId,
    email: DRIVER_B_EMAIL,
    role: 'driver' as UserRole,
    distributorId: 'dist-001',
  });
  orphanToken = generateToken({
    userId: orphanUser.id,
    email: ORPHAN_EMAIL,
    role: 'driver' as UserRole,
    distributorId: 'dist-001',
  });
});

afterAll(async () => {
  await cleanupFixtures();
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('Orders — GET /api/orders driver auto-scoping', () => {
  it('driver A only sees their own order, not driver B\'s', async () => {
    const res = await request(app).get('/api/orders').set(auth(driverAToken));
    expect(res.status).toBe(200);
    const ids: string[] = res.body.data.orders.map((o: any) => o.orderId);
    expect(ids).toContain(orderAId);
    expect(ids).not.toContain(orderBId);
  });

  it('driver B only sees their own order, not driver A\'s', async () => {
    const res = await request(app).get('/api/orders').set(auth(driverBToken));
    expect(res.status).toBe(200);
    const ids: string[] = res.body.data.orders.map((o: any) => o.orderId);
    expect(ids).toContain(orderBId);
    expect(ids).not.toContain(orderAId);
  });

  it('driver sees their pending_delivery order when status filter is applied', async () => {
    const res = await request(app)
      .get('/api/orders?status=pending_delivery')
      .set(auth(driverAToken));
    expect(res.status).toBe(200);
    const numbers: string[] = res.body.data.orders.map((o: any) => o.orderNumber);
    expect(numbers).toContain(ORDER_A_NUM);
    // The status filter must still narrow, and the driver scope must still
    // exclude driver B — so order B must not appear even though it is also
    // pending_delivery.
    expect(numbers).not.toContain(ORDER_B_NUM);
  });

  it('returns empty list (not 403) when a driver user has no matching driver record', async () => {
    // The orphan user has role=driver and a phone, but no driver row in
    // dist-001 matches that phone. The route must not 403 — it should fall
    // through to an empty result so the app shows EmptyState, not an error.
    const res = await request(app).get('/api/orders').set(auth(orphanToken));
    expect(res.status).toBe(200);
    expect(res.body.data.orders).toEqual([]);
  });

  it('distributor_admin sees BOTH drivers\' orders (auto-scoping does not apply)', async () => {
    const res = await request(app).get('/api/orders').set(auth(adminToken));
    expect(res.status).toBe(200);
    const ids: string[] = res.body.data.orders.map((o: any) => o.orderId);
    expect(ids).toContain(orderAId);
    expect(ids).toContain(orderBId);
  });

  it('distributor_admin can still filter by driverId explicitly', async () => {
    const res = await request(app)
      .get(`/api/orders?driverId=${driverAId}`)
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    const ids: string[] = res.body.data.orders.map((o: any) => o.orderId);
    expect(ids).toContain(orderAId);
    expect(ids).not.toContain(orderBId);
  });
});
