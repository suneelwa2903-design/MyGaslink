/**
 * PO Number on orders + invoices.
 *
 * Covers the persistence path (Order → Invoice snapshot), the IRN payload
 * emit gate (B2B + non-empty only), and the wire-shape exposure on GETs.
 * Uses dist-002 (Sharma — Karnataka, GST-LIVE) so createInvoiceFromOrder's
 * GST-aware branch fires and the IRN payload exercises PoDtls emission.
 *
 * Fixtures use TEST_DATE='2099-12-31' (CLAUDE.md anti-pattern #7) and are
 * tracked + cleaned in afterAll so they never leak into the shared dev DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, loginAsFinance } from './helpers.js';
import { createCustomerSchema, createOrderSchema } from '@gaslink/shared';
import { createInvoiceFromOrder } from '../services/invoiceService.js';
import { buildIrnPayload } from '../services/gst/payloadBuilders.js';
import type { Express } from 'express';

const D2 = 'dist-002';
const TEST_DATE = '2099-12-31';

let app: Express;

const trackedCustomerIds: string[] = [];
const trackedOrderIds: string[] = [];
const trackedInvoiceIds: string[] = [];

beforeAll(async () => {
  app = createApp();
  // Each describe block reloads its own admin/finance token as needed.
  // Ensure dist-002 has GST enabled. createInvoiceFromOrder's gstEnabled
  // branch only fires for sandbox/live distributors.
  const dist = await prisma.distributor.findUniqueOrThrow({ where: { id: D2 } });
  if (dist.gstMode === 'disabled') {
    await prisma.distributor.update({ where: { id: D2 }, data: { gstMode: 'sandbox' } });
  }
});

afterAll(async () => {
  if (trackedInvoiceIds.length) {
    await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: trackedInvoiceIds } } });
    await prisma.customerLedgerEntry.deleteMany({ where: { invoiceId: { in: trackedInvoiceIds } } });
    await prisma.invoice.deleteMany({ where: { id: { in: trackedInvoiceIds } } });
  }
  if (trackedOrderIds.length) {
    await prisma.orderItem.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: trackedOrderIds } } });
  }
  if (trackedCustomerIds.length) {
    await prisma.customer.deleteMany({ where: { id: { in: trackedCustomerIds } } });
  }
});

async function makeCustomer(opts: { name: string; gstin?: string; billingState?: string }) {
  const c = await prisma.customer.create({
    data: {
      distributorId: D2,
      customerName: opts.name,
      phone: `9${Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, '0')}`,
      gstin: opts.gstin ?? null,
      customerType: opts.gstin ? 'B2B' : 'B2C',
      billingState: opts.billingState ?? 'Karnataka',
      billingAddressLine1: '1 Test Rd',
      billingCity: 'Bangalore',
      billingPincode: '560001',
    },
  });
  trackedCustomerIds.push(c.id);
  return c;
}

async function makeOrder(opts: { customerId: string; poNumber?: string | null }) {
  const ct = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: D2, isActive: true },
  });
  const o = await prisma.order.create({
    data: {
      distributorId: D2,
      customerId: opts.customerId,
      orderNumber: `ORDPO-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      orderDate: new Date(TEST_DATE),
      deliveryDate: new Date(TEST_DATE),
      status: 'delivered',
      totalAmount: 1180,
      poNumber: opts.poNumber ?? null,
      items: {
        create: [{
          cylinderTypeId: ct.id, quantity: 1, deliveredQuantity: 1,
          unitPrice: 1180, discountPerUnit: 0, totalPrice: 1180,
        }],
      },
    },
  });
  trackedOrderIds.push(o.id);
  return o;
}

describe('Order.poNumber — persistence', () => {
  it('createOrderSchema accepts poNumber up to 16 chars', () => {
    const res = createOrderSchema.safeParse({
      customerId: '00000000-0000-0000-0000-000000000000',
      deliveryDate: '2099-12-31',
      poNumber: 'PO-2099-12-31',
      items: [{ cylinderTypeId: '00000000-0000-0000-0000-000000000001', quantity: 1 }],
    });
    expect(res.success).toBe(true);
  });

  it('createOrderSchema rejects poNumber longer than 16 chars', () => {
    const res = createOrderSchema.safeParse({
      customerId: '00000000-0000-0000-0000-000000000000',
      deliveryDate: '2099-12-31',
      poNumber: 'PO-1234567890ABCDEF', // 19 chars
      items: [{ cylinderTypeId: '00000000-0000-0000-0000-000000000001', quantity: 1 }],
    });
    expect(res.success).toBe(false);
  });

  it('createCustomerSchema is unrelated to PO — sanity', () => {
    // Negative cross-check: confirm we didn't accidentally bleed poNumber
    // into the customer schema (it's an order-level field).
    const res = createCustomerSchema.safeParse({
      customerName: 'X', phone: '9876543210', poNumber: 'X',
    });
    // Zod default behaviour: unknown keys are stripped, schema still passes.
    expect(res.success).toBe(true);
    if (res.success) expect((res.data as { poNumber?: unknown }).poNumber).toBeUndefined();
  });
});

describe('Order.poNumber → Invoice.poNumber snapshot', () => {
  it('B2B order with PO → invoice carries the same PO at issue time', async () => {
    const customer = await makeCustomer({
      name: 'PO Test B2B 1', gstin: '29AAACS1234A1ZN',
    });
    const order = await makeOrder({ customerId: customer.id, poNumber: 'PO/2099/A' });
    const inv = await prisma.$transaction((tx) =>
      createInvoiceFromOrder(tx, order.id, D2, 'test-user'),
    );
    trackedInvoiceIds.push(inv.id);
    expect(inv.poNumber).toBe('PO/2099/A');
  });

  it('Editing Order.poNumber AFTER invoice issue does NOT mutate Invoice.poNumber', async () => {
    const customer = await makeCustomer({
      name: 'PO Test B2B 2', gstin: '29AAACS1234A1ZN',
    });
    const order = await makeOrder({ customerId: customer.id, poNumber: 'PO/ORIG' });
    const inv = await prisma.$transaction((tx) =>
      createInvoiceFromOrder(tx, order.id, D2, 'test-user'),
    );
    trackedInvoiceIds.push(inv.id);

    // Operator edits the Order's PO post-issue.
    await prisma.order.update({
      where: { id: order.id }, data: { poNumber: 'PO/EDITED' },
    });

    // Invoice MUST still carry the original — denormalisation snapshot.
    const refetched = await prisma.invoice.findUniqueOrThrow({
      where: { id: inv.id }, select: { poNumber: true },
    });
    expect(refetched.poNumber).toBe('PO/ORIG');
  });

  it('Order without PO → invoice.poNumber is null', async () => {
    const customer = await makeCustomer({ name: 'PO Test no PO' });
    const order = await makeOrder({ customerId: customer.id, poNumber: null });
    const inv = await prisma.$transaction((tx) =>
      createInvoiceFromOrder(tx, order.id, D2, 'test-user'),
    );
    trackedInvoiceIds.push(inv.id);
    expect(inv.poNumber).toBeNull();
  });

  it('Order with whitespace-only PO → null (trim+null-fold)', async () => {
    const customer = await makeCustomer({ name: 'PO Test whitespace' });
    // Directly create with whitespace to simulate a stray POST.
    const order = await makeOrder({ customerId: customer.id, poNumber: '   ' });
    const inv = await prisma.$transaction((tx) =>
      createInvoiceFromOrder(tx, order.id, D2, 'test-user'),
    );
    trackedInvoiceIds.push(inv.id);
    expect(inv.poNumber).toBeNull();
  });
});

describe('IRN payload — PoDtls emit gate', () => {
  const seller = {
    gstin: '29AAGCB1286Q000', legalName: 'Sharma Gas', tradeName: 'Sharma',
    address: 'Depot Rd', city: 'Bangalore', pincode: '560001',
    state: 'Karnataka', stateCode: '29',
  };
  const buyerB2B = {
    gstin: '29AWGPV7107B1Z1', legalName: 'Royal Foods', tradeName: 'Royal',
    address: '5 Brigade', city: 'Bangalore', pincode: '560041',
    state: 'Karnataka', stateCode: '29',
  };
  const buyerB2C = {
    gstin: null, legalName: 'Mr Customer', tradeName: 'Mr',
    address: '12 MG Rd', city: 'Bangalore', pincode: '560002',
    state: 'Karnataka', stateCode: '29',
  };
  const item = {
    slNo: 1, description: '19 KG', hsnCode: '27111900', quantity: 1,
    unit: 'NOS', unitPrice: 1180, discountPerUnit: 0, gstRate: 18,
  };

  it('B2B + PO present → PoDtls emitted with trimmed PoNo and DocDtls.Dt = PoDt', () => {
    const p = buildIrnPayload({
      docType: 'INV', docNumber: 'TESTPO1', docDate: new Date('2099-12-31'),
      seller, buyer: buyerB2B, items: [item], isInterState: false,
      poNumber: '  PO/2099/X  ',
    });
    expect(p.PoDtls).toBeDefined();
    expect(p.PoDtls?.PoNo).toBe('PO/2099/X');
    expect(p.PoDtls?.PoDt).toBe(p.DocDtls.Dt);
  });

  it('B2B + PO over 16 chars → PoNo truncated to 16', () => {
    const p = buildIrnPayload({
      docType: 'INV', docNumber: 'TESTPO2', docDate: new Date('2099-12-31'),
      seller, buyer: buyerB2B, items: [item], isInterState: false,
      poNumber: 'ABCDEFGHIJKLMNOPQRST', // 20 chars
    });
    expect(p.PoDtls?.PoNo).toHaveLength(16);
    expect(p.PoDtls?.PoNo).toBe('ABCDEFGHIJKLMNOP');
  });

  it('B2B without PO → NO PoDtls block (omit entirely)', () => {
    const p = buildIrnPayload({
      docType: 'INV', docNumber: 'TESTPO3', docDate: new Date('2099-12-31'),
      seller, buyer: buyerB2B, items: [item], isInterState: false,
    });
    expect(p.PoDtls).toBeUndefined();
  });

  it('B2B + whitespace-only PO → NO PoDtls (anti-pattern #10 — never emit empty)', () => {
    const p = buildIrnPayload({
      docType: 'INV', docNumber: 'TESTPO4', docDate: new Date('2099-12-31'),
      seller, buyer: buyerB2B, items: [item], isInterState: false,
      poNumber: '   ',
    });
    expect(p.PoDtls).toBeUndefined();
  });

  it('B2C with PO stored → NO PoDtls (isB2C gate)', () => {
    const p = buildIrnPayload({
      docType: 'INV', docNumber: 'TESTPO5', docDate: new Date('2099-12-31'),
      seller, buyer: buyerB2C, items: [item], isInterState: false,
      poNumber: 'PO/2099/X',
    });
    expect(p.PoDtls).toBeUndefined();
  });

  it('URP buyer with PO → NO PoDtls (URP is the unregistered-buyer sentinel)', () => {
    const p = buildIrnPayload({
      docType: 'INV', docNumber: 'TESTPO6', docDate: new Date('2099-12-31'),
      seller, buyer: { ...buyerB2C, gstin: 'URP' }, items: [item], isInterState: false,
      poNumber: 'PO/2099/X',
    });
    expect(p.PoDtls).toBeUndefined();
  });
});

describe('Wire-shape — GET endpoints expose poNumber', () => {
  it('GET /api/orders/:id returns poNumber (anti-pattern #9 guard)', async () => {
    const distAdmin = await loginAsDistAdmin();
    // Make sure we're hitting dist-001 (the admin's home tenant).
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: distAdmin.distributorId, isActive: true },
    });
    const cust = await prisma.customer.findFirstOrThrow({
      where: { distributorId: distAdmin.distributorId, deletedAt: null },
    });
    const order = await prisma.order.create({
      data: {
        distributorId: distAdmin.distributorId,
        customerId: cust.id,
        orderNumber: `ORDPO-WIRE-${Date.now().toString(36)}`,
        orderDate: new Date(TEST_DATE),
        deliveryDate: new Date(TEST_DATE),
        status: 'pending_driver_assignment',
        totalAmount: 100,
        poNumber: 'PO/WIRE/1',
        items: { create: [{ cylinderTypeId: ct.id, quantity: 1, unitPrice: 100, totalPrice: 100 }] },
      },
    });
    trackedOrderIds.push(order.id);

    const res = await request(app)
      .get(`/api/orders/${order.id}`)
      .set('Authorization', `Bearer ${distAdmin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('poNumber', 'PO/WIRE/1');
    // Flat customerType alias also surfaced for the edit modal's B2B gate.
    expect(res.body.data).toHaveProperty('customerType');
  });

  it('GET /api/invoices/:id returns poNumber (denormalised snapshot)', async () => {
    const distAdmin = await loginAsDistAdmin();
    const ct = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId: distAdmin.distributorId, isActive: true },
    });
    const cust = await prisma.customer.findFirstOrThrow({
      where: { distributorId: distAdmin.distributorId, deletedAt: null },
    });
    const order = await prisma.order.create({
      data: {
        distributorId: distAdmin.distributorId,
        customerId: cust.id,
        orderNumber: `ORDPO-INV-${Date.now().toString(36)}`,
        orderDate: new Date(TEST_DATE),
        deliveryDate: new Date(TEST_DATE),
        status: 'delivered',
        totalAmount: 100,
        poNumber: 'PO/INV/1',
        items: { create: [{ cylinderTypeId: ct.id, quantity: 1, deliveredQuantity: 1, unitPrice: 100, totalPrice: 100 }] },
      },
    });
    trackedOrderIds.push(order.id);
    const inv = await prisma.$transaction((tx) =>
      createInvoiceFromOrder(tx, order.id, distAdmin.distributorId, distAdmin.user.id),
    );
    trackedInvoiceIds.push(inv.id);

    // Use finance for the GET — distributor admin works too but finance is
    // the canonical billing reader.
    const finance = await loginAsFinance();
    const res = await request(app)
      .get(`/api/invoices/${inv.id}`)
      .set('Authorization', `Bearer ${finance.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('poNumber', 'PO/INV/1');
  });
});
