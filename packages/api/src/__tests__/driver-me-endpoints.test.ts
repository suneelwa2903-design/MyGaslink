import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { getSeedData, generateToken } from './helpers.js';
import { startOfUtcDay } from '../utils/dateOnly.js';
import type { Express } from 'express';
import type { UserRole } from '@gaslink/shared';

/**
 * Driver "me" endpoints — covers:
 *   GET /api/drivers/me/assignment   (today's DVA + orders)
 *   GET /api/drivers/me/trip-stock   (aggregated cargo derived from orders)
 *
 * These endpoints hardcode "today" by design — the mobile Trip and Vehicle
 * Stock tabs always show the current day. That means anti-pattern #7
 * (TEST_DATE=2099-12-31) doesn't apply: fixtures MUST be dated today, or
 * the routes won't find them.
 *
 * To avoid colliding with real test data on the shared dev DB:
 *   - Synthetic phones in the 9912200* band (seed drivers use 980000*;
 *     orders.test.ts uses 9911100*).
 *   - Synthetic emails ending in @test-me-endpoints.local.
 *   - Order numbers prefixed TEST-ME-*.
 *   - Driver/User/DVA cleanup keyed on those synthetic phones + emails so
 *     no real row is ever touched.
 */

const DRIVER_A_PHONE = '9912200001';
const DRIVER_B_PHONE = '9912200002';
const ORPHAN_PHONE = '9912200099';
const DRIVER_C_PHONE = '9912200003'; // dist-002, for EWB tests
const DRIVER_A_EMAIL = 'driver-a@test-me-endpoints.local';
const DRIVER_B_EMAIL = 'driver-b@test-me-endpoints.local';
const ORPHAN_EMAIL = 'orphan@test-me-endpoints.local';
const DRIVER_C_EMAIL = 'driver-c@test-me-endpoints.local';
const ORDER_A1_NUM = 'TEST-ME-A1';
const ORDER_A2_NUM = 'TEST-ME-A2';
const ORDER_B1_NUM = 'TEST-ME-B1';
const ORDER_C1_NUM = 'TEST-ME-C1';
const INVOICE_C1_NUM = 'TEST-ME-INV-C1';
const EWB_C1_NO = 'TESTEWB000001';

let app: Express;
let seedData: Awaited<ReturnType<typeof getSeedData>>;

let driverAId: string;
let driverBId: string;
let driverCId: string;
let driverAUserId: string;
let driverBUserId: string;
let orphanUserId: string;
let driverCUserId: string;

let driverAToken: string;
let driverBToken: string;
let orphanToken: string;
let driverCToken: string;

let cylinderTypeXId: string;
let cylinderTypeYId: string;

let dvaAId: string;
let dvaBId: string;
let dvaCId: string;
let orderCId: string;
let invoiceCId: string;

async function cleanupFixtures() {
  const orderNums = [ORDER_A1_NUM, ORDER_A2_NUM, ORDER_B1_NUM, ORDER_C1_NUM];
  const phones = [DRIVER_A_PHONE, DRIVER_B_PHONE, DRIVER_C_PHONE];
  const emails = [DRIVER_A_EMAIL, DRIVER_B_EMAIL, ORPHAN_EMAIL, DRIVER_C_EMAIL];

  // gst_documents first (FK to invoices + orders).
  await prisma.gstDocument.deleteMany({
    where: { order: { orderNumber: { in: orderNums } } },
  });
  // Invoices (FK to orders).
  await prisma.invoice.deleteMany({
    where: { invoiceNumber: { in: [INVOICE_C1_NUM] } },
  });
  // Order items, then orders.
  await prisma.orderItem.deleteMany({
    where: { order: { orderNumber: { in: orderNums } } },
  });
  await prisma.order.deleteMany({
    where: { orderNumber: { in: orderNums } },
  });
  // DVAs — keyed by our synthetic phones via driver join.
  await prisma.driverVehicleAssignment.deleteMany({
    where: { driver: { phone: { in: phones } } },
  });
  // Drivers — by synthetic phone.
  await prisma.driver.deleteMany({
    where: { phone: { in: phones } },
  });
  // Users — by synthetic email.
  await prisma.user.deleteMany({
    where: { email: { in: emails } },
  });
}

beforeAll(async () => {
  app = createApp();
  seedData = await getSeedData();

  // Need two distinct cylinder types so the aggregation test has meaning.
  cylinderTypeXId = seedData.cylinderTypes[0].id;
  cylinderTypeYId = seedData.cylinderTypes[1].id;

  await cleanupFixtures();

  const passwordHash = await bcrypt.hash('TestDriver@123', 10);

  // Driver A user + driver record linked by phone.
  const userA = await prisma.user.create({
    data: {
      email: DRIVER_A_EMAIL,
      passwordHash,
      firstName: 'MeTest',
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
      driverName: 'MeTest DriverA',
      phone: DRIVER_A_PHONE,
      status: 'active',
    },
  });
  driverAId = driverA.id;

  // Driver B.
  const userB = await prisma.user.create({
    data: {
      email: DRIVER_B_EMAIL,
      passwordHash,
      firstName: 'MeTest',
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
      driverName: 'MeTest DriverB',
      phone: DRIVER_B_PHONE,
      status: 'active',
    },
  });
  driverBId = driverB.id;

  // Orphan: real user, no driver row matches.
  const orphan = await prisma.user.create({
    data: {
      email: ORPHAN_EMAIL,
      passwordHash,
      firstName: 'MeTest',
      lastName: 'Orphan',
      phone: ORPHAN_PHONE,
      role: 'driver',
      status: 'active',
      distributorId: 'dist-001',
    },
  });
  orphanUserId = orphan.id;

  // DVAs for today — both A and B, distinct vehicles so the route's date
  // + driverId filter works deterministically. We grab the first 2 seeded
  // vehicles to pair with the drivers; their IDs don't matter for the
  // tests as long as they exist and belong to dist-001.
  // Must use startOfUtcDay() to match the endpoints' @db.Date query (the
  // /drivers/me/* routes were fixed to bound by UTC calendar day). The old
  // setHours(0,0,0,0) seeded the PREVIOUS UTC day on this IST server.
  const today = startOfUtcDay();

  const dvaA = await prisma.driverVehicleAssignment.create({
    data: {
      driverId: driverAId,
      vehicleId: seedData.vehicles[0].id,
      distributorId: 'dist-001',
      assignmentDate: today,
      status: 'loaded_and_dispatched',
      tripNumber: 1,
    },
  });
  dvaAId = dvaA.id;

  const dvaB = await prisma.driverVehicleAssignment.create({
    data: {
      driverId: driverBId,
      vehicleId: seedData.vehicles[1].id,
      distributorId: 'dist-001',
      assignmentDate: today,
      status: 'loaded_and_dispatched',
      tripNumber: 1,
    },
  });
  dvaBId = dvaB.id;

  const customer = seedData.customers[0];

  // Driver A — 2 orders of cylinder type X, qty 3 + 2 = 5 fulls.
  await prisma.order.create({
    data: {
      orderNumber: ORDER_A1_NUM,
      distributorId: 'dist-001',
      customerId: customer.id,
      driverId: driverAId,
      orderDate: today,
      deliveryDate: today,
      status: 'pending_delivery',
      totalAmount: 5400,
      items: {
        create: [{ cylinderTypeId: cylinderTypeXId, quantity: 3, unitPrice: 1800, totalPrice: 5400 }],
      },
    },
  });
  await prisma.order.create({
    data: {
      orderNumber: ORDER_A2_NUM,
      distributorId: 'dist-001',
      customerId: customer.id,
      driverId: driverAId,
      orderDate: today,
      deliveryDate: today,
      status: 'pending_delivery',
      totalAmount: 3600,
      items: {
        create: [{ cylinderTypeId: cylinderTypeXId, quantity: 2, unitPrice: 1800, totalPrice: 3600 }],
      },
    },
  });

  // Driver B — 1 order of cylinder type Y, qty 4 fulls.
  await prisma.order.create({
    data: {
      orderNumber: ORDER_B1_NUM,
      distributorId: 'dist-001',
      customerId: customer.id,
      driverId: driverBId,
      orderDate: today,
      deliveryDate: today,
      status: 'pending_delivery',
      totalAmount: 7200,
      items: {
        create: [{ cylinderTypeId: cylinderTypeYId, quantity: 4, unitPrice: 1800, totalPrice: 7200 }],
      },
    },
  });

  // ─── dist-002 (Sharma, gst_mode='sandbox') — driver C with EWB ──────────
  // Anti-pattern #10 caveat: we don't call the real WhiteBooks sandbox
  // here. We pre-seed gst_documents with a synthetic EWB number so the
  // /me/trip-ewbs endpoint has something to project. That's intentional:
  // we're testing the projection / scoping, not the NIC integration
  // (covered by gst-preflight.test.ts).
  const dist2Customer = await prisma.customer.findFirst({
    where: { distributorId: 'dist-002', deletedAt: null },
    select: { id: true },
  });
  const dist2Cyl = await prisma.cylinderType.findFirst({
    where: { distributorId: 'dist-002', isActive: true },
    select: { id: true },
  });
  const dist2Vehicle = await prisma.vehicle.findFirst({
    where: { distributorId: 'dist-002', deletedAt: null },
    select: { id: true },
  });

  if (dist2Customer && dist2Cyl && dist2Vehicle) {
    const userC = await prisma.user.create({
      data: {
        email: DRIVER_C_EMAIL,
        passwordHash,
        firstName: 'MeTest',
        lastName: 'DriverC',
        phone: DRIVER_C_PHONE,
        role: 'driver',
        status: 'active',
        distributorId: 'dist-002',
      },
    });
    driverCUserId = userC.id;
    const driverC = await prisma.driver.create({
      data: {
        distributorId: 'dist-002',
        driverName: 'MeTest DriverC',
        phone: DRIVER_C_PHONE,
        status: 'active',
      },
    });
    driverCId = driverC.id;

    const dvaC = await prisma.driverVehicleAssignment.create({
      data: {
        driverId: driverCId,
        vehicleId: dist2Vehicle.id,
        distributorId: 'dist-002',
        assignmentDate: today,
        status: 'loaded_and_dispatched',
        tripNumber: 1,
      },
    });
    dvaCId = dvaC.id;

    const orderC = await prisma.order.create({
      data: {
        orderNumber: ORDER_C1_NUM,
        distributorId: 'dist-002',
        customerId: dist2Customer.id,
        driverId: driverCId,
        vehicleId: dist2Vehicle.id,
        orderDate: today,
        deliveryDate: today,
        status: 'pending_delivery',
        totalAmount: 1800,
        items: {
          create: [{ cylinderTypeId: dist2Cyl.id, quantity: 1, unitPrice: 1800, totalPrice: 1800 }],
        },
      },
    });
    orderCId = orderC.id;

    const invoiceC = await prisma.invoice.create({
      data: {
        invoiceNumber: INVOICE_C1_NUM,
        distributorId: 'dist-002',
        customerId: dist2Customer.id,
        orderId: orderC.id,
        issueDate: today,
        dueDate: today,
        totalAmount: 1800,
        outstandingAmount: 1800,
        status: 'issued',
        irnStatus: 'success',
        ewbStatus: 'active',
      },
    });
    invoiceCId = invoiceC.id;

    // Seed the gst_documents row with a fake-but-well-formed EWB. We mark
    // it isLatest so the trip-sheet PDF service picks it up too.
    const ewbValidTill = new Date();
    ewbValidTill.setDate(ewbValidTill.getDate() + 1);
    await prisma.gstDocument.create({
      data: {
        invoiceId: invoiceC.id,
        orderId: orderC.id,
        distributorId: 'dist-002',
        docType: 'INV',
        irnStatus: 'success',
        ewbStatus: 'active',
        ewbNo: EWB_C1_NO,
        ewbDate: today,
        ewbValidTill,
        isLatest: true,
      },
    });

    driverCToken = generateToken({
      userId: driverCUserId,
      email: DRIVER_C_EMAIL,
      role: 'driver' as UserRole,
      distributorId: 'dist-002',
    });
  }

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
    userId: orphanUserId,
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

describe('GET /api/drivers/me/assignment', () => {
  it('driver A gets their today DVA with their own orders attached', async () => {
    const res = await request(app).get('/api/drivers/me/assignment').set(auth(driverAToken));
    expect(res.status).toBe(200);
    expect(res.body.data).not.toBeNull();
    expect(res.body.data.assignmentId).toBe(dvaAId);
    const orderNumbers: string[] = res.body.data.orders.map((o: any) => o.orderNumber);
    expect(orderNumbers).toEqual(expect.arrayContaining([ORDER_A1_NUM, ORDER_A2_NUM]));
    expect(orderNumbers).not.toContain(ORDER_B1_NUM);
    // Each order should have items expanded so the mobile UI can render
    // the per-cylinder list without a second request.
    expect(res.body.data.orders[0].items.length).toBeGreaterThan(0);
    expect(res.body.data.orders[0].items[0].cylinderTypeName).toBeDefined();
  });

  it('driver B sees only their own DVA (cross-driver isolation)', async () => {
    const res = await request(app).get('/api/drivers/me/assignment').set(auth(driverBToken));
    expect(res.status).toBe(200);
    expect(res.body.data.assignmentId).toBe(dvaBId);
    const orderNumbers: string[] = res.body.data.orders.map((o: any) => o.orderNumber);
    expect(orderNumbers).toContain(ORDER_B1_NUM);
    expect(orderNumbers).not.toContain(ORDER_A1_NUM);
    expect(orderNumbers).not.toContain(ORDER_A2_NUM);
  });

  it('orphan driver (no matching driver row) returns null, NOT 403', async () => {
    const res = await request(app).get('/api/drivers/me/assignment').set(auth(orphanToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });
});

describe('GET /api/drivers/me/trip-ewbs', () => {
  /**
   * Driver A is on dist-001 (Bhargava, gst_mode='disabled'). The endpoint
   * must return an empty list without querying gst_documents — the GST
   * gate is in the route handler itself, not just downstream emptiness.
   */
  it('GST-disabled tenant: returns { items: [] } regardless of driver state', async () => {
    const res = await request(app).get('/api/drivers/me/trip-ewbs').set(auth(driverAToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ items: [] });
  });

  it('orphan driver still gets { items: [] } (never 403)', async () => {
    const res = await request(app).get('/api/drivers/me/trip-ewbs').set(auth(orphanToken));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  it('GST-enabled tenant: returns seeded EWB row with ewbNo + customer name', async () => {
    if (!driverCToken) return; // skip if dist-002 fixture couldn't be built
    const res = await request(app).get('/api/drivers/me/trip-ewbs').set(auth(driverCToken));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    const row = res.body.data.items[0];
    expect(row.ewbNo).toBe(EWB_C1_NO);
    expect(row.ewbStatus).toBe('active');
    expect(row.orderNumber).toBe(ORDER_C1_NUM);
    expect(row.invoiceNumber).toBe(INVOICE_C1_NUM);
    expect(row.customerName).toBeDefined();
  });
});

describe('GET /api/drivers/me/trip-sheet-pdf', () => {
  it('GST-disabled tenant: returns 404 (no EWB documents possible)', async () => {
    const res = await request(app).get('/api/drivers/me/trip-sheet-pdf').set(auth(driverAToken));
    expect(res.status).toBe(404);
  });

  it('orphan driver: returns 404', async () => {
    const res = await request(app).get('/api/drivers/me/trip-sheet-pdf').set(auth(orphanToken));
    expect(res.status).toBe(404);
  });

  it('GST-enabled tenant with seeded EWB: returns 200 + PDF content-type', async () => {
    if (!driverCToken) return; // skip if dist-002 fixture couldn't be built
    const res = await request(app).get('/api/drivers/me/trip-sheet-pdf').set(auth(driverCToken));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    // PDF magic bytes "%PDF-" — sanity check the payload is actually a PDF.
    expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
  });
});

describe('GET /api/drivers/me/trip-stock', () => {
  it('aggregates fulls per cylinder type for driver A', async () => {
    const res = await request(app).get('/api/drivers/me/trip-stock').set(auth(driverAToken));
    expect(res.status).toBe(200);
    const items: Array<{ cylinderTypeId: string; cylinderTypeName: string; fullQuantity: number; emptyQuantity: number }> =
      res.body.data.items;
    expect(items.length).toBe(1); // only cylinder type X
    const xRow = items.find((i) => i.cylinderTypeId === cylinderTypeXId);
    expect(xRow).toBeDefined();
    expect(xRow!.fullQuantity).toBe(5); // 3 + 2
    expect(xRow!.emptyQuantity).toBe(0); // pending_delivery, no empties yet
    // Driver A's truck has nothing of type Y.
    expect(items.find((i) => i.cylinderTypeId === cylinderTypeYId)).toBeUndefined();
  });

  it('cross-tenant: driver B only sees their own cylinder type (Y), not A\'s (X)', async () => {
    const res = await request(app).get('/api/drivers/me/trip-stock').set(auth(driverBToken));
    expect(res.status).toBe(200);
    const items: Array<{ cylinderTypeId: string; fullQuantity: number }> = res.body.data.items;
    expect(items.length).toBe(1);
    expect(items[0].cylinderTypeId).toBe(cylinderTypeYId);
    expect(items[0].fullQuantity).toBe(4);
  });

  it('orphan driver returns empty items list (not 403)', async () => {
    const res = await request(app).get('/api/drivers/me/trip-stock').set(auth(orphanToken));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });
});
