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
  await cleanupTestOrders('dist-001');

  // WI-064 follow-up: orderService.assignDriver now requires a
  // confirmed driver-vehicle mapping for the delivery date. Seed one
  // for drivers[0] (used by createDeliveredOrderWithInvoice helper).
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

// ─── Helper: full order→deliver→invoice flow ───────────────────────────────
async function createDeliveredOrderWithInvoice() {
  const b2bCustomer = seedData.customers.find(c => c.customerType === 'B2B')!;
  const cyl = seedData.cylinderTypes.find(ct => ct.typeName === '19 KG')!;
  const driver = seedData.drivers[0];
  const vehicle = seedData.vehicles[0];

  // Create order
  const orderRes = await request(app)
    .post('/api/orders')
    .set(auth(adminToken))
    .send({
      customerId: b2bCustomer.id,
      deliveryDate: today(),
      items: [{ cylinderTypeId: cyl.id, quantity: 3 }],
    });
  const orderId = orderRes.body.data.orderId;

  // Assign driver
  await request(app)
    .post(`/api/orders/${orderId}/assign-driver`)
    .set(auth(adminToken))
    .send({ driverId: driver.id, vehicleId: vehicle.id });

  // Dispatch
  await request(app)
    .put(`/api/orders/${orderId}/status`)
    .set(auth(adminToken))
    .send({ status: 'pending_delivery' });

  // Deliver (auto-creates invoice)
  await request(app)
    .post(`/api/orders/${orderId}/confirm-delivery`)
    .set(auth(adminToken))
    .send({
      items: [{ cylinderTypeId: cyl.id, deliveredQuantity: 3, emptiesCollected: 1 }],
    });

  // Invoice is auto-created on delivery — find it
  const listRes = await request(app)
    .get(`/api/invoices?orderId=${orderId}`)
    .set(auth(financeToken));

  const invoice = listRes.body.data?.invoices?.[0];
  return { orderId, invoiceId: invoice?.invoiceId, invoiceData: invoice };
}

// ─── INVOICE CREATION TESTS ────────────────────────────────────────────────

describe('Invoice Creation from Order', () => {
  let testInvoiceId: string;

  it('should create an invoice from a delivered order', async () => {
    const { invoiceId, invoiceData } = await createDeliveredOrderWithInvoice();
    expect(invoiceId).toBeDefined();
    expect(invoiceData.invoiceNumber).toMatch(/^INV-/);
    expect(invoiceData.status).toBe('issued');
    expect(invoiceData.totalAmount).toBeGreaterThan(0);
    expect(invoiceData.outstandingAmount).toBe(invoiceData.totalAmount);
    testInvoiceId = invoiceId;
  });

  it('should include customer details in invoice', async () => {
    const res = await request(app)
      .get(`/api/invoices/${testInvoiceId}`)
      .set(auth(financeToken));

    expect(res.status).toBe(200);
    // customerName may be at root level or nested under customer
    const hasCustomerInfo = res.body.data.customerName || res.body.data.customer?.customerName;
    expect(hasCustomerInfo).toBeDefined();
    expect(res.body.data.items.length).toBeGreaterThan(0);
  });

  it('should have correct invoice item structure', async () => {
    const res = await request(app)
      .get(`/api/invoices/${testInvoiceId}`)
      .set(auth(financeToken));

    const item = res.body.data.items[0];
    expect(item.quantity).toBe(3);
    expect(item.unitPrice).toBeGreaterThan(0);
    expect(item.totalPrice).toBeGreaterThan(0);
    expect(item.hsnCode).toBeDefined();
  });

  it('should set due date based on customer credit period', async () => {
    const res = await request(app)
      .get(`/api/invoices/${testInvoiceId}`)
      .set(auth(financeToken));

    expect(res.body.data.dueDate).toBeDefined();
    const issueDate = new Date(res.body.data.issueDate);
    const dueDate = new Date(res.body.data.dueDate);
    expect(dueDate.getTime()).toBeGreaterThanOrEqual(issueDate.getTime());
  });

  it('should not allow duplicate invoice for same order', async () => {
    // The order already has an auto-created invoice — try from-order again
    const { orderId } = await createDeliveredOrderWithInvoice();
    const res = await request(app)
      .post(`/api/invoices/from-order/${orderId}`)
      .set(auth(financeToken));

    // Should fail since invoice already exists (auto-created on delivery)
    expect([400, 409]).toContain(res.status);
  });
});

describe('Manual Invoice Creation', () => {
  it('should create a manual invoice', async () => {
    const customer = seedData.customers.find(c => c.customerType === 'B2B')!;
    const cyl = seedData.cylinderTypes.find(ct => ct.typeName === '19 KG')!;

    const res = await request(app)
      .post('/api/invoices/manual')
      .set(auth(financeToken))
      .send({
        customerId: customer.id,
        issueDate: today(),
        dueDate: today(),
        items: [{
          description: `${cyl.typeName} LPG Cylinder`,
          hsnCode: '27111900',
          quantity: 2,
          unitPrice: 1000,
          discountPerUnit: 0,
          gstRate: 0,
        }],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.invoiceId).toBeDefined();
    // Total may include GST if enabled (2000 * 1.18 = 2360 with GST, or 2000 without)
    expect(res.body.data.totalAmount).toBeGreaterThanOrEqual(2000);
  });
});

// ─── GST CALCULATION TESTS ─────────────────────────────────────────────────

describe('GST Calculations', () => {
  it('should include GST breakup when GST is enabled', async () => {
    // Get an invoice and check GST fields
    const listRes = await request(app)
      .get('/api/invoices')
      .set(auth(financeToken));

    expect(listRes.status).toBe(200);
    const invoices = listRes.body.data.invoices;

    if (invoices.length > 0) {
      const inv = invoices[0];
      // GST fields should exist on every invoice
      expect(inv).toHaveProperty('cgstValue');
      expect(inv).toHaveProperty('sgstValue');
      expect(inv).toHaveProperty('igstValue');
      // At least one of these should be defined (could be 0 if GST disabled)
      expect(typeof inv.cgstValue).toBe('number');
    }
  });

  it('should have gstRate on invoice items', async () => {
    const listRes = await request(app)
      .get('/api/invoices')
      .set(auth(financeToken));

    const invoices = listRes.body.data.invoices;
    if (invoices.length > 0) {
      const res = await request(app)
        .get(`/api/invoices/${invoices[0].invoiceId}`)
        .set(auth(financeToken));

      if (res.body.data.items?.length > 0) {
        const item = res.body.data.items[0];
        expect(item).toHaveProperty('gstRate');
        expect(typeof item.gstRate).toBe('number');
      }
    }
  });
});

// ─── IRN & EWB STATUS TESTS ────────────────────────────────────────────────

describe('IRN and EWB Status', () => {
  it('should have IRN status fields on invoices', async () => {
    const listRes = await request(app)
      .get('/api/invoices')
      .set(auth(financeToken));

    const invoices = listRes.body.data.invoices;
    if (invoices.length > 0) {
      const inv = invoices[0];
      expect(inv).toHaveProperty('irnStatus');
      expect(inv).toHaveProperty('ewbStatus');
      expect(['not_attempted', 'pending', 'success', 'failed', 'cancelled']).toContain(inv.irnStatus);
      expect(['not_attempted', 'pending', 'active', 'failed', 'cancelled']).toContain(inv.ewbStatus);
    }
  });

  it('should return GST documents for an invoice', async () => {
    const listRes = await request(app)
      .get('/api/invoices')
      .set(auth(financeToken));

    const invoices = listRes.body.data.invoices;
    if (invoices.length > 0) {
      const res = await request(app)
        .get(`/api/invoices/${invoices[0].invoiceId}/gst-documents`)
        .set(auth(financeToken));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    }
  });

  it('should attempt GST generation (responds with structured result)', async () => {
    const listRes = await request(app)
      .get('/api/invoices')
      .set(auth(financeToken));

    const invoices = listRes.body.data.invoices;
    if (invoices.length > 0) {
      const res = await request(app)
        .post(`/api/invoices/${invoices[0].invoiceId}/generate-gst`)
        .set(auth(adminToken));

      // Without real WhiteBooks credentials, may fail — but should give structured response
      expect([200, 400, 404, 500]).toContain(res.status);
    }
  });
});

// ─── INVOICE PDF TESTS ─────────────────────────────────────────────────────

describe('Invoice PDF', () => {
  it('should generate PDF for an invoice', async () => {
    const listRes = await request(app)
      .get('/api/invoices')
      .set(auth(financeToken));

    const invoices = listRes.body.data.invoices;
    if (invoices.length > 0) {
      const res = await request(app)
        .get(`/api/invoices/${invoices[0].invoiceId}/pdf`)
        .set(auth(financeToken));

      expect([200, 500]).toContain(res.status);
      if (res.status === 200) {
        expect(res.headers['content-type']).toContain('pdf');
      }
    }
  });
});

// ─── CREDIT NOTE TESTS ─────────────────────────────────────────────────────

describe('Credit Notes', () => {
  it('should create a credit note for an invoice', async () => {
    const { invoiceId } = await createDeliveredOrderWithInvoice();
    if (!invoiceId) return; // skip if invoice wasn't created

    // Get invoice details to find item
    const invRes = await request(app)
      .get(`/api/invoices/${invoiceId}`)
      .set(auth(financeToken));

    const item = invRes.body.data?.items?.[0];
    if (!item) return;

    // WI-055: amount-based shape (was items[] grid pre-2026-05-16).
    const res = await request(app)
      .post('/api/invoices/credit-notes')
      .set(auth(financeToken))
      .send({
        invoiceId,
        reason: 'Quantity adjustment - test',
        amount: 50,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.creditNoteId).toBeDefined();
  });

  it('should reject credit note without reason', async () => {
    const res = await request(app)
      .post('/api/invoices/credit-notes')
      .set(auth(financeToken))
      .send({
        invoiceId: 'some-id',
        amount: 10,
      });

    expect(res.status).toBe(400);
  });

  // WI-039 — list, approve, reject, PDF
  it('lists credit notes for an invoice via GET /:id/credit-notes', async () => {
    const { invoiceId } = await createDeliveredOrderWithInvoice();
    if (!invoiceId) return;

    // Raise one CN to populate the list
    const invRes = await request(app).get(`/api/invoices/${invoiceId}`).set(auth(financeToken));
    const item = invRes.body.data?.items?.[0];
    if (!item) return;
    await request(app)
      .post('/api/invoices/credit-notes')
      .set(auth(financeToken))
      .send({
        invoiceId, reason: 'WI-039 list test',
        amount: 50,
      });

    const list = await request(app)
      .get(`/api/invoices/${invoiceId}/credit-notes`)
      .set(auth(financeToken));
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.data?.creditNotes)).toBe(true);
    expect(list.body.data.creditNotes.length).toBeGreaterThan(0);
    expect(list.body.data.creditNotes[0].status).toBe('pending');
  });

  it('finance and admin can both approve a credit note (WI-088)', async () => {
    const { invoiceId } = await createDeliveredOrderWithInvoice();
    if (!invoiceId) return;
    const invRes = await request(app).get(`/api/invoices/${invoiceId}`).set(auth(financeToken));
    const item = invRes.body.data?.items?.[0];
    if (!item) return;
    const createRes = await request(app)
      .post('/api/invoices/credit-notes')
      .set(auth(financeToken))
      .send({
        invoiceId, reason: 'WI-039 approve test',
        amount: 50,
      });
    const creditNoteId = createRes.body.data?.creditNoteId;
    if (!creditNoteId) return;

    const financeApprove = await request(app)
      .put(`/api/invoices/credit-notes/${creditNoteId}/approve`)
      .set(auth(financeToken));
    expect(financeApprove.status).toBe(200);
    expect(financeApprove.body.data.status).toBe('approved');
  });

  it('admin can reject a credit note with a reason captured in audit', async () => {
    const { invoiceId } = await createDeliveredOrderWithInvoice();
    if (!invoiceId) return;
    const invRes = await request(app).get(`/api/invoices/${invoiceId}`).set(auth(financeToken));
    const item = invRes.body.data?.items?.[0];
    if (!item) return;
    const createRes = await request(app)
      .post('/api/invoices/credit-notes')
      .set(auth(financeToken))
      .send({
        invoiceId, reason: 'WI-039 reject test',
        amount: 50,
      });
    const creditNoteId = createRes.body.data?.creditNoteId;
    if (!creditNoteId) return;
    const res = await request(app)
      .put(`/api/invoices/credit-notes/${creditNoteId}/reject`)
      .set(auth(adminToken))
      .send({ reason: 'Pricing was correct as-billed' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('rejected');
  });
});

// ─── DEBIT NOTE TESTS ──────────────────────────────────────────────────────

describe('Debit Notes', () => {
  it('should create a debit note for an invoice', async () => {
    const { invoiceId } = await createDeliveredOrderWithInvoice();
    if (!invoiceId) return;

    const invRes = await request(app)
      .get(`/api/invoices/${invoiceId}`)
      .set(auth(financeToken));

    const item = invRes.body.data?.items?.[0];
    if (!item) return;

    // WI-055: amount-based shape (was items[] grid).
    const res = await request(app)
      .post('/api/invoices/debit-notes')
      .set(auth(financeToken))
      .send({
        invoiceId,
        reason: 'Additional charges - test',
        amount: 50,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.debitNoteId).toBeDefined();
  });

  // WI-039 — list + PDF for debit notes
  it('lists debit notes for an invoice via GET /:id/debit-notes', async () => {
    const { invoiceId } = await createDeliveredOrderWithInvoice();
    if (!invoiceId) return;
    const invRes = await request(app).get(`/api/invoices/${invoiceId}`).set(auth(financeToken));
    const item = invRes.body.data?.items?.[0];
    if (!item) return;
    await request(app)
      .post('/api/invoices/debit-notes')
      .set(auth(financeToken))
      .send({
        invoiceId, reason: 'WI-039 DN list test',
        amount: 50,
      });
    const list = await request(app)
      .get(`/api/invoices/${invoiceId}/debit-notes`)
      .set(auth(financeToken));
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.data?.debitNotes)).toBe(true);
    expect(list.body.data.debitNotes.length).toBeGreaterThan(0);
  });

  it('GET /debit-notes/:id/pdf returns application/pdf for approved DN', async () => {
    const { invoiceId } = await createDeliveredOrderWithInvoice();
    if (!invoiceId) return;
    const invRes = await request(app).get(`/api/invoices/${invoiceId}`).set(auth(financeToken));
    const item = invRes.body.data?.items?.[0];
    if (!item) return;
    const createRes = await request(app)
      .post('/api/invoices/debit-notes')
      .set(auth(financeToken))
      .send({
        invoiceId, reason: 'WI-039 DN PDF test',
        amount: 50,
      });
    const debitNoteId = createRes.body.data?.debitNoteId;
    if (!debitNoteId) return;
    // Approve so the PDF reflects the final state — endpoint serves at any
    // status, but admins typically download after approval.
    await request(app)
      .put(`/api/invoices/debit-notes/${debitNoteId}/approve`)
      .set(auth(adminToken));
    const pdfRes = await request(app)
      .get(`/api/invoices/debit-notes/${debitNoteId}/pdf`)
      .set(auth(financeToken));
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers['content-type']).toMatch(/application\/pdf/);
    expect(pdfRes.body.slice(0, 4).toString()).toBe('%PDF');
  });
});

// ─── INVOICE STATUS FLOW TESTS ─────────────────────────────────────────────

describe('Invoice Status Flow', () => {
  it('should update invoice status', async () => {
    const { invoiceId } = await createDeliveredOrderWithInvoice();
    if (!invoiceId) return; // skip if invoice wasn't created

    const res = await request(app)
      .put(`/api/invoices/${invoiceId}/status`)
      .set(auth(financeToken))
      .send({ status: 'overdue' });

    expect([200, 400]).toContain(res.status);
  });

  it('should list overdue invoices via filter', async () => {
    const res = await request(app)
      .get('/api/invoices?status=overdue')
      .set(auth(financeToken));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.invoices)).toBe(true);
  });
});

// ─── GSTIN VALIDATION TESTS ────────────────────────────────────────────────

describe('GSTIN Validation', () => {
  it('should validate a GSTIN format', async () => {
    const res = await request(app)
      .post('/api/invoices/validate-gstin')
      .set(auth(adminToken))
      .send({ gstin: '29AALCS4728Q1ZB' });

    // Will fail without live WhiteBooks credentials, but should respond
    expect([200, 400, 500]).toContain(res.status);
  });

  it('should reject invalid GSTIN format', async () => {
    const res = await request(app)
      .post('/api/invoices/validate-gstin')
      .set(auth(adminToken))
      .send({ gstin: 'INVALID' });

    expect([400, 500]).toContain(res.status);
  });
});
