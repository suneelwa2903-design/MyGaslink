import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { loginAsDistAdmin, loginAsFinance, getSeedData, cleanupTestOrders, ensureDriverVehicleMapping, today } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let financeToken: string;
let seedData: Awaited<ReturnType<typeof getSeedData>>;

beforeAll(async () => {
  app = createApp();
  const admin = await loginAsDistAdmin();
  adminToken = admin.token;
  const finance = await loginAsFinance();
  financeToken = finance.token;
  seedData = await getSeedData();
  // Clean any existing test data
  await cleanupTestOrders('dist-001');

  // WI-064 follow-up: orderService.assignDriver now requires a
  // confirmed driver-vehicle mapping for the delivery date. Seed one
  // for drivers[0] (used by Step 4 + Returns + Bulk Assignment) so the
  // assign-driver call doesn't 400 with the missing-mapping error.
  await ensureDriverVehicleMapping({
    distributorId: 'dist-001',
    driverId: seedData.drivers[0].id,
    vehicleId: seedData.vehicles[0].id,
    date: today(),
  });
});

afterAll(async () => {
  await cleanupTestOrders('dist-001');
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('Core Workflow: Order → Assign → Deliver → Invoice → Payment', () => {
  let orderId: string;
  let invoiceId: string;

  it('Step 1: Create an order', async () => {
    const b2bCustomer = seedData.customers.find(c => c.customerType === 'B2B')!;
    const cyl19 = seedData.cylinderTypes.find(ct => ct.typeName === '19 KG')!;

    const res = await request(app)
      .post('/api/orders')
      .set(auth(adminToken))
      .send({
        customerId: b2bCustomer.id,
        deliveryDate: today(),
        specialInstructions: 'Test order for workflow',
        items: [
          { cylinderTypeId: cyl19.id, quantity: 5 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.orderId).toBeDefined();
    expect(res.body.data.status).toBe('pending_driver_assignment');
    orderId = res.body.data.orderId;
  });

  it('Step 2: List orders — new order appears', async () => {
    const res = await request(app)
      .get('/api/orders')
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    const order = res.body.data.orders.find((o: { orderId: string; status: string }) => o.orderId === orderId);
    expect(order).toBeDefined();
    expect(order.status).toBe('pending_driver_assignment');
  });

  it('Step 3: Get order by ID', async () => {
    const res = await request(app)
      .get(`/api/orders/${orderId}`)
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.data.orderId).toBe(orderId);
    expect(res.body.data.items.length).toBeGreaterThan(0);
  });

  it('Step 4: Assign driver to order', async () => {
    const driver = seedData.drivers[0];
    const vehicle = seedData.vehicles[0];

    const res = await request(app)
      .post(`/api/orders/${orderId}/assign-driver`)
      .set(auth(adminToken))
      .send({
        driverId: driver.id,
        vehicleId: vehicle.id,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('pending_dispatch');
  });

  it('Step 5: Update order status to pending_delivery (dispatch)', async () => {
    const res = await request(app)
      .put(`/api/orders/${orderId}/status`)
      .set(auth(adminToken))
      .send({ status: 'pending_delivery', notes: 'Dispatched for delivery' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('pending_delivery');
  });

  it('Step 6: Confirm delivery', async () => {
    const cyl19 = seedData.cylinderTypes.find(ct => ct.typeName === '19 KG')!;

    const res = await request(app)
      .post(`/api/orders/${orderId}/confirm-delivery`)
      .set(auth(adminToken))
      .send({
        deliveryDate: today(),
        receivedBy: 'Mr. Customer',
        items: [
          { cylinderTypeId: cyl19.id, deliveredQuantity: 5, emptiesCollected: 3 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('delivered');
  });

  it('Step 7: Invoice auto-created on delivery (or create manually)', async () => {
    // confirmDelivery auto-creates the invoice, so check if it exists first
    const listRes = await request(app)
      .get('/api/invoices')
      .set(auth(financeToken));

    const existing = listRes.body.data.invoices.find((inv: { orderId: string; invoiceId: string }) => inv.orderId === orderId);
    if (existing) {
      invoiceId = existing.invoiceId;
      expect(existing.orderId).toBe(orderId);
    } else {
      // Fallback: create manually
      const res = await request(app)
        .post(`/api/invoices/from-order/${orderId}`)
        .set(auth(financeToken));
      expect(res.status).toBe(201);
      invoiceId = res.body.data.invoiceId;
    }
    expect(invoiceId).toBeDefined();
  });

  it('Step 8: Get invoice details', async () => {
    const res = await request(app)
      .get(`/api/invoices/${invoiceId}`)
      .set(auth(financeToken));

    expect(res.status).toBe(200);
    expect(res.body.data.invoiceId).toBe(invoiceId);
    expect(res.body.data.totalAmount).toBeGreaterThan(0);
    expect(res.body.data.items.length).toBeGreaterThan(0);
  });

  it('Step 9: Record payment', async () => {
    // Get invoice amount
    const invoiceRes = await request(app)
      .get(`/api/invoices/${invoiceId}`)
      .set(auth(financeToken));
    const totalAmount = invoiceRes.body.data.totalAmount;

    const res = await request(app)
      .post('/api/payments')
      .set(auth(financeToken))
      .send({
        customerId: invoiceRes.body.data.customerId,
        amount: totalAmount,
        paymentMethod: 'cash',
        transactionDate: today(),
        referenceNumber: 'CASH-001',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.paymentId).toBeDefined();
  });

  it('Step 10: View payment ledger', async () => {
    const invoiceRes = await request(app)
      .get(`/api/invoices/${invoiceId}`)
      .set(auth(financeToken));
    const customerId = invoiceRes.body.data.customerId;

    const res = await request(app)
      .get(`/api/payments/ledger/${customerId}`)
      .set(auth(financeToken));

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });
});

describe('Order Validation', () => {
  it('should reject order without items', async () => {
    const customer = seedData.customers[0];
    const res = await request(app)
      .post('/api/orders')
      .set(auth(adminToken))
      .send({
        customerId: customer.id,
        deliveryDate: today(),
        items: [],
      });

    expect(res.status).toBe(400);
  });

  it('should reject order with invalid customer ID', async () => {
    const cyl19 = seedData.cylinderTypes.find(ct => ct.typeName === '19 KG')!;
    const res = await request(app)
      .post('/api/orders')
      .set(auth(adminToken))
      .send({
        customerId: '00000000-0000-0000-0000-000000000000',
        deliveryDate: today(),
        items: [{ cylinderTypeId: cyl19.id, quantity: 5 }],
      });

    // Should fail — customer not found for this distributor
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('should reject order with zero quantity', async () => {
    const customer = seedData.customers[0];
    const cyl19 = seedData.cylinderTypes.find(ct => ct.typeName === '19 KG')!;
    const res = await request(app)
      .post('/api/orders')
      .set(auth(adminToken))
      .send({
        customerId: customer.id,
        deliveryDate: today(),
        items: [{ cylinderTypeId: cyl19.id, quantity: 0 }],
      });

    expect(res.status).toBe(400);
  });
});

describe('Returns-Only Order', () => {
  let returnsOrderId: string;

  it('should create a returns-only order', async () => {
    const customer = seedData.customers[0];
    const cyl19 = seedData.cylinderTypes.find(ct => ct.typeName === '19 KG')!;

    const res = await request(app)
      .post('/api/orders/returns-only')
      .set(auth(adminToken))
      .send({
        customerId: customer.id,
        scheduledDate: today(),
        items: [{ cylinderTypeId: cyl19.id, expectedQuantity: 3 }],
      });

    expect(res.status).toBe(201);
    // Returns order starts as pending_driver_assignment, transitions to returns_only after collection
    expect(res.body.data.status).toBe('pending_driver_assignment');
    expect(res.body.data.orderType).toBe('returns_only');
    returnsOrderId = res.body.data.orderId;
  });

  it('should confirm returns collection', async () => {
    // First assign a driver
    const driver = seedData.drivers[0];
    const vehicle = seedData.vehicles[0];

    await request(app)
      .post(`/api/orders/${returnsOrderId}/assign-driver`)
      .set(auth(adminToken))
      .send({ driverId: driver.id, vehicleId: vehicle.id });

    const cyl19 = seedData.cylinderTypes.find(ct => ct.typeName === '19 KG')!;

    const res = await request(app)
      .post(`/api/orders/${returnsOrderId}/confirm-returns`)
      .set(auth(adminToken))
      .send({
        items: [{ cylinderTypeId: cyl19.id, collectedQuantity: 3 }],
      });

    if (res.status !== 200) console.log('Confirm returns error:', res.body);
    expect(res.status).toBe(200);
  });
});

describe('Order Cancellation', () => {
  it('should cancel a pending order', async () => {
    const customer = seedData.customers[0];
    const cyl19 = seedData.cylinderTypes.find(ct => ct.typeName === '19 KG')!;

    // Create order
    const createRes = await request(app)
      .post('/api/orders')
      .set(auth(adminToken))
      .send({
        customerId: customer.id,
        deliveryDate: today(),
        items: [{ cylinderTypeId: cyl19.id, quantity: 2 }],
      });

    const oid = createRes.body.data.orderId;

    // Cancel it
    const res = await request(app)
      .post(`/api/orders/${oid}/cancel`)
      .set(auth(adminToken))
      .send({ reason: 'Customer requested cancellation' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
  });
});

describe('Bulk Driver Assignment', () => {
  it('should bulk assign drivers to multiple orders', async () => {
    const customer = seedData.customers[0];
    const cyl19 = seedData.cylinderTypes.find(ct => ct.typeName === '19 KG')!;
    const driver = seedData.drivers[0];
    const vehicle = seedData.vehicles[0];

    // Create 2 orders
    const order1 = await request(app)
      .post('/api/orders')
      .set(auth(adminToken))
      .send({
        customerId: customer.id,
        deliveryDate: today(),
        items: [{ cylinderTypeId: cyl19.id, quantity: 3 }],
      });
    const order2 = await request(app)
      .post('/api/orders')
      .set(auth(adminToken))
      .send({
        customerId: customer.id,
        deliveryDate: today(),
        items: [{ cylinderTypeId: cyl19.id, quantity: 2 }],
      });

    const res = await request(app)
      .post('/api/orders/bulk-assign-driver')
      .set(auth(adminToken))
      .send({
        orderIds: [order1.body.data.orderId, order2.body.data.orderId],
        driverId: driver.id,
        vehicleId: vehicle.id,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Invoice Operations', () => {
  it('should list invoices', async () => {
    const res = await request(app)
      .get('/api/invoices')
      .set(auth(financeToken));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.invoices)).toBe(true);
  });

  it('should create a manual invoice', async () => {
    const customer = seedData.customers[0];
    const cyl19 = seedData.cylinderTypes.find(ct => ct.typeName === '19 KG')!;

    const res = await request(app)
      .post('/api/invoices/manual')
      .set(auth(financeToken))
      .send({
        customerId: customer.id,
        issueDate: today(),
        dueDate: today(),
        items: [
          {
            cylinderTypeId: cyl19.id,
            description: '19 KG LPG Cylinder',
            hsnCode: '27111900',
            quantity: 3,
            unitPrice: 1800,
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.totalAmount).toBeGreaterThan(0);
  });
});

describe('Credit Note', () => {
  it('should create and approve a credit note', async () => {
    // First create a manual invoice
    const customer = seedData.customers[0];

    const invRes = await request(app)
      .post('/api/invoices/manual')
      .set(auth(financeToken))
      .send({
        customerId: customer.id,
        issueDate: today(),
        dueDate: today(),
        items: [{ description: '19 KG LPG', quantity: 5, unitPrice: 1800, hsnCode: '27111900' }],
      });
    const invoiceId = invRes.body.data.invoiceId;

    // Create credit note — WI-055 amount-based shape.
    const cnRes = await request(app)
      .post('/api/invoices/credit-notes')
      .set(auth(financeToken))
      .send({
        invoiceId,
        reason: 'Damaged cylinder returned',
        amount: 1890,
      });

    if (cnRes.status !== 201) console.log('Credit note error:', cnRes.body);
    expect(cnRes.status).toBe(201);
    const cnId = cnRes.body.data.creditNoteId;

    // Approve credit note
    const approveRes = await request(app)
      .put(`/api/invoices/credit-notes/${cnId}/approve`)
      .set(auth(adminToken));

    expect(approveRes.status).toBe(200);
  });
});
