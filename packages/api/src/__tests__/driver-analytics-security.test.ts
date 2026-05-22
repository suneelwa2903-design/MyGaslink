/**
 * WI-094 (Issue 9) — GET /api/analytics/driver-performance, driver-scoped.
 *
 * Drivers may now call this endpoint, but only ever see THEIR OWN row
 * (resolved from the token user's phone → driver). Admin/finance/inventory
 * keep the unscoped, all-drivers view. Customers are rejected.
 *
 * Asserts:
 *   1. ✅ driver gets own performance (only their driverId)
 *   2. ✅ date range filter scopes the period
 *   3. ❌ driver response contains ONLY their driverId (no other driver)
 *   4. ❌ cross-tenant — dist-001 driver/admin never see a dist-002 driver
 *   5. ❌ customer role → 403
 *   6. ✅ admin → all drivers unscoped (sees A and B)
 *
 * "today"-style fixtures; synthetic phones (99124000*) / emails / TEST-DA-*.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken, loginAsDistAdmin } from './helpers.js';
import { startOfUtcDay } from '../utils/dateOnly.js';
import type { Express } from 'express';

const A_PHONE = '9912400001', B_PHONE = '9912400002', E_PHONE = '9912400003';
const A_EMAIL = 'da-a@test-driver-analytics.local';
const B_EMAIL = 'da-b@test-driver-analytics.local';
const E_EMAIL = 'da-e@test-driver-analytics.local';
const CUST_EMAIL = 'da-cust@test-driver-analytics.local';
const ORDER_PREFIX = 'TEST-DA-';

let app: Express;
let aToken = '', bToken = '', adminToken = '', customerToken = '';
let driverAId = '', driverBId = '', driverEId = '';

async function cleanup() {
  await prisma.orderItem.deleteMany({ where: { order: { orderNumber: { startsWith: ORDER_PREFIX } } } });
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: ORDER_PREFIX } } });
  await prisma.driver.deleteMany({ where: { phone: { in: [A_PHONE, B_PHONE, E_PHONE] } } });
  await prisma.user.deleteMany({ where: { email: { in: [A_EMAIL, B_EMAIL, E_EMAIL, CUST_EMAIL] } } });
}

async function seedDriverWithDelivered(opts: {
  distributorId: string; phone: string; email: string; name: string; count: number;
}): Promise<{ token: string; driverId: string }> {
  const passwordHash = await bcrypt.hash('TestDriver@123', 10);
  const user = await prisma.user.create({
    data: { email: opts.email, passwordHash, firstName: 'DA', lastName: opts.name, phone: opts.phone, role: 'driver', status: 'active', distributorId: opts.distributorId },
  });
  const driver = await prisma.driver.create({
    data: { distributorId: opts.distributorId, driverName: `DA ${opts.name}`, phone: opts.phone, status: 'active' },
  });
  const today = startOfUtcDay();
  const customer = await prisma.customer.findFirstOrThrow({ where: { distributorId: opts.distributorId, deletedAt: null } });
  const cyl = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: opts.distributorId } });
  for (let i = 0; i < opts.count; i++) {
    await prisma.order.create({
      data: {
        orderNumber: `${ORDER_PREFIX}${opts.name}-${i}-${Date.now().toString(36)}`,
        distributorId: opts.distributorId, customerId: customer.id, driverId: driver.id,
        orderDate: today, deliveryDate: today, status: 'delivered', orderType: 'delivery', totalAmount: 1000,
        items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 1000, totalPrice: 1000 }] },
      },
    });
  }
  const token = generateToken({ userId: user.id, email: opts.email, role: 'driver' as any, distributorId: opts.distributorId });
  return { token, driverId: driver.id };
}

beforeAll(async () => {
  app = createApp();
  await cleanup();
  const a = await seedDriverWithDelivered({ distributorId: 'dist-001', phone: A_PHONE, email: A_EMAIL, name: 'DriverA', count: 2 });
  const b = await seedDriverWithDelivered({ distributorId: 'dist-001', phone: B_PHONE, email: B_EMAIL, name: 'DriverB', count: 1 });
  const e = await seedDriverWithDelivered({ distributorId: 'dist-002', phone: E_PHONE, email: E_EMAIL, name: 'DriverE', count: 1 });
  aToken = a.token; driverAId = a.driverId;
  bToken = b.token; driverBId = b.driverId;
  driverEId = e.driverId;
  const admin = await loginAsDistAdmin();
  adminToken = admin.token;
  // A REAL customer-role user (authenticate looks the user up in the DB
  // before the role guard runs — a fake id would 401, not 403).
  const custHash = await bcrypt.hash('TestCust@123', 10);
  const custUser = await prisma.user.create({
    data: { email: CUST_EMAIL, passwordHash: custHash, firstName: 'DA', lastName: 'Customer', phone: '9912400099', role: 'customer', status: 'active', distributorId: 'dist-001' },
  });
  customerToken = generateToken({ userId: custUser.id, email: CUST_EMAIL, role: 'customer' as any, distributorId: 'dist-001' });
});

afterAll(cleanup);

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const TODAY = startOfUtcDay().toISOString().split('T')[0];

describe('WI-094 — driver-performance security/scoping', () => {
  it('✅ driver gets own performance (only their driverId)', async () => {
    const res = await request(app).get('/api/analytics/driver-performance').set(auth(aToken));
    expect(res.status).toBe(200);
    const rows = res.body.data;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(1);
    expect(rows[0].driverId).toBe(driverAId);
    expect(rows[0].totalOrders).toBeGreaterThanOrEqual(2);
  });

  it('✅ date range filter scopes the period', async () => {
    const inRange = await request(app).get(`/api/analytics/driver-performance?dateFrom=${TODAY}&dateTo=${TODAY}`).set(auth(aToken));
    expect(inRange.status).toBe(200);
    expect(inRange.body.data.find((r: any) => r.driverId === driverAId)?.totalOrders).toBe(2);
    // A range that excludes today → driver A drops out (total 0 → filtered).
    const outRange = await request(app).get('/api/analytics/driver-performance?dateFrom=2024-01-01&dateTo=2024-01-02').set(auth(aToken));
    expect(outRange.status).toBe(200);
    expect(outRange.body.data.some((r: any) => r.driverId === driverAId)).toBe(false);
  });

  it('❌ driver response contains ONLY their own driverId', async () => {
    const res = await request(app).get('/api/analytics/driver-performance').set(auth(aToken));
    expect(res.body.data.every((r: any) => r.driverId === driverAId)).toBe(true);
    expect(res.body.data.some((r: any) => r.driverId === driverBId)).toBe(false);
  });

  it('❌ cross-tenant — dist-001 driver/admin never see the dist-002 driver', async () => {
    const driverRes = await request(app).get('/api/analytics/driver-performance').set(auth(aToken));
    expect(driverRes.body.data.some((r: any) => r.driverId === driverEId)).toBe(false);
    const adminRes = await request(app).get('/api/analytics/driver-performance').set(auth(adminToken));
    expect(adminRes.body.data.some((r: any) => r.driverId === driverEId)).toBe(false);
  });

  it('❌ customer role is rejected 403', async () => {
    const res = await request(app).get('/api/analytics/driver-performance').set(auth(customerToken));
    expect(res.status).toBe(403);
  });

  it('✅ admin gets all drivers unscoped (sees A and B)', async () => {
    const res = await request(app).get('/api/analytics/driver-performance').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.some((r: any) => r.driverId === driverAId)).toBe(true);
    expect(res.body.data.some((r: any) => r.driverId === driverBId)).toBe(true);
  });
});
