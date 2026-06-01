import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

// CRITICAL: vi.mock must be hoisted before module imports so the dynamic
// import inside cancelOrder sees the mocked functions at call time.
vi.mock('../services/gst/gstService.js', async (orig) => {
  const original = (await orig()) as typeof import('../services/gst/gstService.js');
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
import type { $Enums } from '@prisma/client';
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
        entryType: 'invoice_entry' as $Enums.LedgerEntryType,
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

    // EWB cancel called with the new 5-arg signature (GROUP-7S).
    // Order-cancel path uses NIC code '3' (Order Cancelled).
    expect(cancelEwbMock).toHaveBeenCalledWith(
      invoiceId,
      distributorId,
      expect.stringContaining('cancelled'),
      '3',
      expect.any(String),
    );
    // IRN cancel NOT called (irnStatus was 'pending', not 'success')
    expect(cancelIrnMock).not.toHaveBeenCalled();

    // Invoice voided
    const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(inv?.status).toBe('cancelled');

    // Ledger reversal created
    const reversalEntries = await prisma.customerLedgerEntry.findMany({
      where: { invoiceId, entryType: 'adjustment' as $Enums.LedgerEntryType },
    });
    expect(reversalEntries.length).toBeGreaterThan(0);
    // Reversal should be negative of the original 500
    const reversal = reversalEntries[0];
    expect(Number(reversal.amountDelta)).toBeLessThan(0);
  });

  it('DVA stays loaded_and_dispatched — cancelled stock is still on the vehicle (WI-130)', async () => {
    // WI-130: cancelling the last pending_delivery order created an on_vehicle
    // CSE, so the trip is NOT complete. The DVA must stay loaded_and_dispatched
    // (was previously rolled to dispatch_ready, which stranded the CSE because
    // mark-vehicle-returned then 409'd on an "already complete" trip).
    const dva = await prisma.driverVehicleAssignment.findFirst({
      where: { driverId, distributorId, assignmentDate: new Date(TEST_DATE) },
    });
    expect(dva?.status).toBe('loaded_and_dispatched');
    const onVehicle = await prisma.cancelledStockEvent.count({
      where: { vehicleId, distributorId, status: 'on_vehicle' },
    });
    expect(onVehicle).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('WI-130 — last-order cancel with NO cancelled stock still rolls DVA', () => {
  it('flag ON: cancelling the last pending_dispatch order (Case B, no CSE) rolls DVA to dispatch_ready', async () => {
    process.env.INVENTORY_DISPATCH_DEBIT = 'true';
    // Use a distinct driver+vehicle so cancelOrder STEP 6's driver-scoped DVA
    // lookup can't collide with the other tests' same-date DVAs.
    const driver2 = seedData.drivers[1] ?? seedData.drivers[0];
    const vehicle2 = seedData.vehicles[1] ?? seedData.vehicles[0];
    const customer = seedData.customers[0];
    const cyl = seedData.cylinderTypes[0];
    try {
      await prisma.driverVehicleAssignment.upsert({
        where: { driverId_assignmentDate_tripNumber: { driverId: driver2.id, assignmentDate: new Date(TEST_DATE), tripNumber: 1 } },
        create: { driverId: driver2.id, vehicleId: vehicle2.id, distributorId, assignmentDate: new Date(TEST_DATE), tripNumber: 1, status: 'loaded_and_dispatched' },
        update: { status: 'loaded_and_dispatched', vehicleId: vehicle2.id },
      });
      const order = await prisma.order.create({
        data: {
          orderNumber: `TEST-WI130-NOCSE-${Date.now()}`,
          distributorId, customerId: customer.id, driverId: driver2.id, vehicleId: vehicle2.id,
          orderDate: new Date(), deliveryDate: new Date(TEST_DATE), tripNumber: 1,
          status: 'pending_dispatch', totalAmount: 500,
          items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 500, discountPerUnit: 0, totalPrice: 500 }] },
        },
      });
      const res = await request(app)
        .post(`/api/orders/${order.id}/cancel`)
        .set(auth(adminToken))
        .send({ reason: 'WI-130 no-CSE' });
      expect(res.status).toBe(200);
      // Case B (pending_dispatch under flag ON): nothing physically on the truck.
      const cse = await prisma.cancelledStockEvent.count({ where: { orderId: order.id } });
      expect(cse).toBe(0);
      // No on-vehicle stock + no live orders → DVA rolls to dispatch_ready.
      const dva = await prisma.driverVehicleAssignment.findFirst({
        where: { driverId: driver2.id, distributorId, assignmentDate: new Date(TEST_DATE), tripNumber: 1 },
      });
      expect(dva?.status).toBe('dispatch_ready');
    } finally {
      delete process.env.INVENTORY_DISPATCH_DEBIT;
    }
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
    // Both cancel functions called with the new 5-arg signature (GROUP-7S).
    expect(cancelEwbMock).toHaveBeenCalledWith(
      invoiceId, distributorId, expect.any(String), '3', expect.any(String),
    );
    expect(cancelIrnMock).toHaveBeenCalledWith(
      invoiceId, distributorId, expect.any(String), '3', expect.any(String),
    );
    // Invoice voided
    const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    expect(inv?.status).toBe('cancelled');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('WI-102 — cancelling a dispatched order leaves DVA tripNumber unchanged', () => {
  let cancelOrderId: string;
  let keepOrderId: string;
  let driverId: string;
  let vehicleId: string;

  it('seeds two dispatched orders on the same trip (tripNumber 3)', async () => {
    const customer = seedData.customers[0];
    const cyl = seedData.cylinderTypes[0];
    driverId = seedData.drivers[0].id;
    vehicleId = seedData.vehicles[0].id;

    await prisma.driverVehicleAssignment.upsert({
      where: { driverId_assignmentDate_tripNumber: { driverId, assignmentDate: new Date(TEST_DATE), tripNumber: 3 } },
      create: {
        driverId,
        vehicleId,
        distributorId,
        assignmentDate: new Date(TEST_DATE),
        tripNumber: 3,
        status: 'loaded_and_dispatched',
      },
      update: { status: 'loaded_and_dispatched', vehicleId },
    });

    const mk = async (suffix: string) =>
      prisma.order.create({
        data: {
          orderNumber: `TEST-WI102-${suffix}-${Date.now()}`,
          distributorId,
          customerId: customer.id,
          driverId,
          vehicleId,
          orderDate: new Date(),
          deliveryDate: new Date(TEST_DATE),
          tripNumber: 3,
          status: 'pending_delivery',
          totalAmount: 500,
          items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 500, discountPerUnit: 0, totalPrice: 500 }] },
        },
      });

    cancelOrderId = (await mk('CANCEL')).id;
    keepOrderId = (await mk('KEEP')).id;
  });

  it('cancels one order — DVA tripNumber stays 3, status stays loaded_and_dispatched', async () => {
    cancelEwbMock.mockClear();
    cancelIrnMock.mockClear();

    const res = await request(app)
      .post(`/api/orders/${cancelOrderId}/cancel`)
      .set(auth(adminToken))
      .send({ reason: 'WI-102 test' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');

    const dva = await prisma.driverVehicleAssignment.findFirst({
      where: { driverId, distributorId, assignmentDate: new Date(TEST_DATE), tripNumber: 3 },
    });
    // tripNumber must NOT have been decremented (was the WI-102 bug).
    expect(dva?.tripNumber).toBe(3);
    // Other live order still on trip 3 → status must remain dispatched.
    expect(dva?.status).toBe('loaded_and_dispatched');

    // Sanity: the kept order is still live on trip 3.
    const keep = await prisma.order.findUnique({ where: { id: keepOrderId } });
    expect(keep?.status).toBe('pending_delivery');
    expect(keep?.tripNumber).toBe(3);
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
