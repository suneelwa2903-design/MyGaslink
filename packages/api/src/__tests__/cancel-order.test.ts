import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

// CRITICAL: vi.mock must be hoisted before module imports so the dynamic
// import inside cancelOrder sees the mocked functions at call time.
vi.mock('../services/gst/gstService.js', async (orig) => {
  const original: any = await orig();
  return {
    ...original,
    cancelEwb: vi.fn(async () => ({ status: 'success' })),
    cancelIrn: vi.fn(async () => ({ status: 'success' })),
  };
});

import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, getSeedData } from './helpers.js';
import type { Express } from 'express';
import * as gstService from '../services/gst/gstService.js';

// Anti-pattern #7: use a fixed far-future date that real dev data never occupies.
const TEST_DATE = '2099-12-31';

const cancelEwbMock = gstService.cancelEwb as unknown as ReturnType<typeof vi.fn>;
const cancelIrnMock = gstService.cancelIrn as unknown as ReturnType<typeof vi.fn>;

let app: Express;
let adminToken: string;
let distributorId: string;
let seedData: Awaited<ReturnType<typeof getSeedData>>;

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function cleanupFixtures() {
  await prisma.paymentAllocation.deleteMany({
    where: { payment: { distributorId } },
  });
  await prisma.paymentTransaction.deleteMany({ where: { distributorId } });
  await prisma.customerLedgerEntry.deleteMany({
    where: { distributorId, entryDate: new Date(TEST_DATE) },
  });
  await prisma.gstDocument.deleteMany({ where: { invoice: { distributorId } } });
  await prisma.invoiceItem.deleteMany({ where: { invoice: { distributorId } } });
  await prisma.invoice.deleteMany({ where: { distributorId } });
  await prisma.cancelledStockEvent.deleteMany({ where: { distributorId } });
  await prisma.inventoryEvent.deleteMany({ where: { distributorId } });
  await prisma.inventorySummary.deleteMany({ where: { distributorId } });
  await prisma.orderStatusLog.deleteMany({ where: { order: { distributorId } } });
  await prisma.driverAssignment.deleteMany({ where: { order: { distributorId } } });
  await prisma.orderItem.deleteMany({ where: { order: { distributorId } } });
  await prisma.order.deleteMany({ where: { distributorId } });
  await prisma.pendingAction.deleteMany({ where: { distributorId } });
  await prisma.driverVehicleAssignment.deleteMany({
    where: { distributorId, assignmentDate: new Date(TEST_DATE) },
  });
  await prisma.vehicle.updateMany({ where: { distributorId }, data: { status: 'idle' } });
}

beforeAll(async () => {
  app = createApp();
  const admin = await loginAsDistAdmin();
  adminToken = admin.token;
  distributorId = admin.distributorId;
  seedData = await getSeedData();
  await cleanupFixtures();
});

afterAll(async () => {
  await cleanupFixtures();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('cancelOrder — pending_driver_assignment', () => {
  let orderId: string;

  it('creates order in pending_driver_assignment', async () => {
    const customer = seedData.customers[0];
    const cyl = seedData.cylinderTypes[0];
    const res = await request(app)
      .post('/api/orders')
      .set(auth(adminToken))
      .send({
        customerId: customer.id,
        deliveryDate: TEST_DATE,
        items: [{ cylinderTypeId: cyl.id, quantity: 2 }],
      });
    expect(res.status).toBe(201);
    orderId = res.body.data.orderId;
  });

  it('cancels the order — no GST calls, no inventory events', async () => {
    cancelEwbMock.mockClear();
    cancelIrnMock.mockClear();

    const res = await request(app)
      .post(`/api/orders/${orderId}/cancel`)
      .set(auth(adminToken))
      .send({ reason: 'Test cancel' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
    expect(cancelEwbMock).not.toHaveBeenCalled();
    expect(cancelIrnMock).not.toHaveBeenCalled();

    // No cancelled stock events for pre-dispatch orders
    const stockEvents = await prisma.cancelledStockEvent.count({
      where: { orderId },
    });
    expect(stockEvents).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('cancelOrder — payment allocation blocks cancellation', () => {
  let orderId: string;

  it('seeds order + invoice + payment allocation', async () => {
    const customer = seedData.customers[0];
    const cyl = seedData.cylinderTypes[0];

    const order = await prisma.order.create({
      data: {
        orderNumber: `TEST-CANCEL-PAY-${Date.now()}`,
        distributorId,
        customerId: customer.id,
        orderDate: new Date(),
        deliveryDate: new Date(TEST_DATE),
        status: 'pending_driver_assignment',
        totalAmount: 500,
        items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 500, discountPerUnit: 0, totalPrice: 500 }] },
      },
    });
    orderId = order.id;

    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `INV-CANCEL-PAY-${Date.now()}`,
        distributorId,
        customerId: customer.id,
        orderId,
        issueDate: new Date(),
        dueDate: new Date(),
        totalAmount: 500,
        status: 'issued',
        irnStatus: 'pending',
        ewbStatus: 'pending',
      },
    });

    const payment = await prisma.paymentTransaction.create({
      data: {
        distributorId,
        customerId: customer.id,
        amount: 500,
        transactionDate: new Date(),
        paymentMethod: 'cash',
      },
    });
    await prisma.paymentAllocation.create({
      data: {
        invoiceId: invoice.id,
        paymentId: payment.id,
        allocatedAmount: 500,
      },
    });
  });

  it('returns 409 when payment allocation exists', async () => {
    const res = await request(app)
      .post(`/api/orders/${orderId}/cancel`)
      .set(auth(adminToken))
      .send({ reason: 'Test cancel' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/payment/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('cancelOrder — pending_delivery with active EWB', () => {
  let orderId: string;
  let invoiceId: string;
  let vehicleId: string;
  let driverId: string;

  it('seeds order + invoice with active EWB + DVA', async () => {
    const customer = seedData.customers[0];
    const cyl = seedData.cylinderTypes[0];
    vehicleId = seedData.vehicles[0].id;
    driverId = seedData.drivers[0].id;

    // DVA for the test date
    await prisma.driverVehicleAssignment.upsert({
      where: { driverId_assignmentDate_tripNumber: { driverId, assignmentDate: new Date(TEST_DATE), tripNumber: 1 } },
      create: {
        driverId,
        vehicleId,
        distributorId,
        assignmentDate: new Date(TEST_DATE),
        tripNumber: 1,
        status: 'loaded_and_dispatched',
      },
      update: { status: 'loaded_and_dispatched', vehicleId },
    });

    const order = await prisma.order.create({
      data: {
        orderNumber: `TEST-CANCEL-EWB-${Date.now()}`,
        distributorId,
        customerId: customer.id,
        driverId,
        vehicleId,
        orderDate: new Date(),
        deliveryDate: new Date(TEST_DATE),
        tripNumber: 1,
        status: 'pending_delivery',
        totalAmount: 500,
        items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 500, discountPerUnit: 0, totalPrice: 500 }] },
      },
    });
    orderId = order.id;

    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `INV-CANCEL-EWB-${Date.now()}`,
        distributorId,
        customerId: customer.id,
        orderId,
        issueDate: new Date(),
        dueDate: new Date(),
        totalAmount: 500,
        status: 'issued',
        irnStatus: 'pending',
        ewbStatus: 'active',
      },
    });
    invoiceId = invoice.id;

    // Ledger entry for reversal check
    await prisma.customerLedgerEntry.create({
      data: {
        distributorId,
        customerId: customer.id,
        entryType: 'invoice_entry' as any,
        referenceId: orderId,
        invoiceId,
        amountDelta: 500,
        narration: 'Invoice',
        entryDate: new Date(TEST_DATE),
        createdBy: (await loginAsDistAdmin()).user.id,
      },
    });
  });

  it('cancels order — EWB cancelled, invoice voided, ledger reversed', async () => {
    cancelEwbMock.mockClear();
    cancelEwbMock.mockResolvedValueOnce({ status: 'success' });
    cancelIrnMock.mockClear();

    const res = await request(app)
      .post(`/api/orders/${orderId}/cancel`)
      .set(auth(adminToken))
      .send({ reason: 'Test cancel EWB' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');

    // EWB cancel called
    expect(cancelEwbMock).toHaveBeenCalledWith(invoiceId, distributorId, expect.stringContaining('cancelled'));
    // IRN cancel NOT called (irnStatus was 'pending', not 'success')
    expect(cancelIrnMock).not.toHaveBeenCalled();

    // Invoice voided
    const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(inv?.status).toBe('cancelled');

    // Ledger reversal created
    const reversalEntries = await prisma.customerLedgerEntry.findMany({
      where: { invoiceId, entryType: 'adjustment' as any },
    });
    expect(reversalEntries.length).toBeGreaterThan(0);
    // Reversal should be negative of the original 500
    const reversal = reversalEntries[0];
    expect(Number(reversal.amountDelta)).toBeLessThan(0);
  });

  it('DVA reset to dispatch_ready (was the only active order)', async () => {
    const dva = await prisma.driverVehicleAssignment.findFirst({
      where: { driverId, distributorId, assignmentDate: new Date(TEST_DATE) },
    });
    expect(dva?.status).toBe('dispatch_ready');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('cancelOrder — B2B with active IRN + EWB', () => {
  let orderId: string;
  let invoiceId: string;

  it('seeds order + invoice with irnStatus=success and ewbStatus=active', async () => {
    const customer = seedData.customers[0];
    const cyl = seedData.cylinderTypes[0];

    const order = await prisma.order.create({
      data: {
        orderNumber: `TEST-CANCEL-IRN-${Date.now()}`,
        distributorId,
        customerId: customer.id,
        orderDate: new Date(),
        deliveryDate: new Date(TEST_DATE),
        status: 'pending_delivery',
        totalAmount: 500,
        items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 500, discountPerUnit: 0, totalPrice: 500 }] },
      },
    });
    orderId = order.id;

    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `INV-CANCEL-IRN-${Date.now()}`,
        distributorId,
        customerId: customer.id,
        orderId,
        issueDate: new Date(),
        dueDate: new Date(),
        totalAmount: 500,
        status: 'issued',
        irnStatus: 'success',
        ewbStatus: 'active',
        irn: 'a'.repeat(64),
      },
    });
    invoiceId = invoice.id;
  });

  it('cancels EWB first then IRN', async () => {
    // cancelEwb mock sets ewbStatus to 'cancelled' on the invoice
    cancelEwbMock.mockClear();
    cancelEwbMock.mockImplementationOnce(async (invId: string) => {
      await prisma.invoice.update({ where: { id: invId }, data: { ewbStatus: 'cancelled' } });
      return { status: 'success' };
    });
    cancelIrnMock.mockClear();
    cancelIrnMock.mockResolvedValueOnce({ status: 'success' });

    const res = await request(app)
      .post(`/api/orders/${orderId}/cancel`)
      .set(auth(adminToken))
      .send({ reason: 'Test B2B cancel' });

    expect(res.status).toBe(200);
    // Both cancel functions called
    expect(cancelEwbMock).toHaveBeenCalledWith(invoiceId, distributorId, expect.any(String));
    expect(cancelIrnMock).toHaveBeenCalledWith(invoiceId, distributorId, expect.any(String));
    // Invoice voided
    const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(inv?.status).toBe('cancelled');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('cancelOrder — NIC EWB cancel failure creates pending action', () => {
  let orderId: string;
  let invoiceId: string;

  it('seeds order with active EWB', async () => {
    const customer = seedData.customers[0];
    const cyl = seedData.cylinderTypes[0];

    const order = await prisma.order.create({
      data: {
        orderNumber: `TEST-CANCEL-EWBFAIL-${Date.now()}`,
        distributorId,
        customerId: customer.id,
        orderDate: new Date(),
        deliveryDate: new Date(TEST_DATE),
        status: 'pending_delivery',
        totalAmount: 500,
        items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 500, discountPerUnit: 0, totalPrice: 500 }] },
      },
    });
    orderId = order.id;

    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `INV-EWBFAIL-${Date.now()}`,
        distributorId,
        customerId: customer.id,
        orderId,
        issueDate: new Date(),
        dueDate: new Date(),
        totalAmount: 500,
        status: 'issued',
        irnStatus: 'pending',
        ewbStatus: 'active',
      },
    });
    invoiceId = invoice.id;
  });

  it('order still cancelled and pending action created when EWB cancel fails', async () => {
    cancelEwbMock.mockClear();
    cancelEwbMock.mockRejectedValueOnce(new Error('NIC timeout after 24h window'));
    cancelIrnMock.mockClear();

    const res = await request(app)
      .post(`/api/orders/${orderId}/cancel`)
      .set(auth(adminToken))
      .send({ reason: 'Test EWB fail cancel' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');

    // Pending action created for EWB failure
    const pendingAction = await prisma.pendingAction.findFirst({
      where: { entityId: invoiceId, actionType: 'EWB_CANCEL_FAILED' },
    });
    expect(pendingAction).not.toBeNull();
    expect(pendingAction?.severity).toBe('high');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('cancelOrder — NIC IRN cancel failure creates pending action', () => {
  let orderId: string;
  let invoiceId: string;

  it('seeds order with irnStatus=success', async () => {
    const customer = seedData.customers[0];
    const cyl = seedData.cylinderTypes[0];

    const order = await prisma.order.create({
      data: {
        orderNumber: `TEST-CANCEL-IRNFAIL-${Date.now()}`,
        distributorId,
        customerId: customer.id,
        orderDate: new Date(),
        deliveryDate: new Date(TEST_DATE),
        status: 'pending_delivery',
        totalAmount: 500,
        items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 500, discountPerUnit: 0, totalPrice: 500 }] },
      },
    });
    orderId = order.id;

    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber: `INV-IRNFAIL-${Date.now()}`,
        distributorId,
        customerId: customer.id,
        orderId,
        issueDate: new Date(),
        dueDate: new Date(),
        totalAmount: 500,
        status: 'issued',
        irnStatus: 'success',
        ewbStatus: 'pending',
        irn: 'b'.repeat(64),
      },
    });
    invoiceId = invoice.id;
  });

  it('order still cancelled and pending action created when IRN cancel fails', async () => {
    cancelEwbMock.mockClear(); // ewbStatus is 'pending' — no EWB call expected
    cancelIrnMock.mockClear();
    cancelIrnMock.mockRejectedValueOnce(new Error('NIC 24h window expired'));

    const res = await request(app)
      .post(`/api/orders/${orderId}/cancel`)
      .set(auth(adminToken))
      .send({ reason: 'Test IRN fail cancel' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');

    // Pending action created for IRN failure
    const pendingAction = await prisma.pendingAction.findFirst({
      where: { entityId: invoiceId, actionType: 'IRN_CANCEL_FAILED' },
    });
    expect(pendingAction).not.toBeNull();
    expect(pendingAction?.severity).toBe('high');
  });
});
