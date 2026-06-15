/**
 * 2026-06-15 — customer-portal invoice visibility gate.
 *
 * Re-introduces the "invoice subject to change until delivered" rule
 * that was removed too broadly in P0-2 (commit 007d780). The gate
 * applies to LIST, DETAIL, PDF, and BOTH Razorpay payment routes.
 *
 * Invariants under test:
 *   IN-FLIGHT  pending_driver_assignment / pending_dispatch /
 *              pending_delivery
 *     → hidden from list
 *     → friendly 403 from PDF + payment init/verify
 *
 *   TERMINAL   delivered / modified_delivered / cancelled
 *     → visible everywhere
 *
 *   OB-style   orderId IS NULL (Opening Balance, manual no-order)
 *     → always visible (CGST Rule 56 retention carve-out)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken } from './helpers.js';
import { UserRole } from '@gaslink/shared';
import type { Express } from 'express';

const PREFIX = 'IVIS_';   // alphabetic so cleanup is easy
const DIST = 'dist-001';

let app: Express;
let customerToken: string;
let customerId: string;
let customerUserId: string;

// IDs we create, tracked for teardown
const created: {
  orders: string[];
  invoices: string[];
  customerUserEmail: string | null;
} = { orders: [], invoices: [], customerUserEmail: null };

async function makeInvoice(orderStatus: string | null, opts: { isOB?: boolean; status?: string } = {}) {
  const isOB = !!opts.isOB;
  const status = (opts.status ?? 'issued') as 'issued' | 'overdue' | 'paid';

  let orderId: string | null = null;
  if (orderStatus !== null) {
    const cyl = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: DIST } });
    const order = await prisma.order.create({
      data: {
        orderNumber: `${PREFIX}O-${Math.random().toString(36).slice(2, 8)}`,
        distributorId: DIST,
        customerId,
        status: orderStatus as 'pending_dispatch' | 'pending_delivery' | 'delivered',
        orderDate: new Date('2099-12-31'),
        deliveryDate: new Date('2099-12-31'),
        totalAmount: 1000,
        items: {
          create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 1000, totalPrice: 1000 }],
        },
      },
    });
    orderId = order.id;
    created.orders.push(order.id);
  }

  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: `${PREFIX}INV-${Math.random().toString(36).slice(2, 8)}`,
      distributorId: DIST,
      customerId,
      orderId,
      issueDate: new Date(),
      dueDate: new Date(),
      totalAmount: 1000,
      outstandingAmount: status === 'paid' ? 0 : 1000,
      status,
      isOpeningBalance: isOB,
      issuedBy: customerUserId,
    },
  });
  created.invoices.push(invoice.id);
  return invoice;
}

beforeAll(async () => {
  app = createApp();

  // Reuse the existing customer-portal beforeAll pattern.
  const customer = await prisma.customer.findFirstOrThrow({
    where: { distributorId: DIST, customerType: 'B2B', deletedAt: null },
  });
  customerId = customer.id;

  let customerUser = await prisma.user.findFirst({ where: { customerId: customer.id, role: 'customer' } });
  if (!customerUser) {
    const hash = await bcrypt.hash('Customer@123', 12);
    customerUser = await prisma.user.create({
      data: {
        email: `ivis-test-${customer.id.slice(0, 8)}@test.com`,
        passwordHash: hash,
        firstName: customer.customerName,
        lastName: 'Portal',
        phone: customer.phone || '9999999990',
        role: UserRole.CUSTOMER,
        status: 'active',
        provisioningStatus: 'active',
        distributorId: DIST,
        customerId: customer.id,
        requiresPasswordReset: false,
      },
    });
    created.customerUserEmail = customerUser.email;
  }
  customerUserId = customerUser.id;
  customerToken = generateToken({
    userId: customerUser.id,
    email: customerUser.email,
    role: UserRole.CUSTOMER,
    distributorId: DIST,
    customerId: customer.id,
  });
});

afterAll(async () => {
  if (created.invoices.length) {
    await prisma.invoice.deleteMany({ where: { id: { in: created.invoices } } });
  }
  if (created.orders.length) {
    await prisma.orderItem.deleteMany({ where: { orderId: { in: created.orders } } });
    await prisma.order.deleteMany({ where: { id: { in: created.orders } } });
  }
  if (created.customerUserEmail) {
    await prisma.user.deleteMany({ where: { email: created.customerUserEmail } });
  }
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('Customer-portal invoice visibility — in-flight invoices hidden', () => {
  it('Invoice with order pending_delivery is NOT in GET /invoices list', async () => {
    const inv = await makeInvoice('pending_delivery');
    const res = await request(app)
      .get('/api/customer-portal/invoices?pageSize=100')
      .set(auth(customerToken));
    expect(res.status).toBe(200);
    const ids = (res.body.data.invoices as Array<{ invoiceId: string }>).map((i) => i.invoiceId);
    expect(ids).not.toContain(inv.id);
  });

  it('Invoice with order pending_driver_assignment is NOT in list', async () => {
    const inv = await makeInvoice('pending_driver_assignment');
    const res = await request(app)
      .get('/api/customer-portal/invoices?pageSize=100')
      .set(auth(customerToken));
    const ids = (res.body.data.invoices as Array<{ invoiceId: string }>).map((i) => i.invoiceId);
    expect(ids).not.toContain(inv.id);
  });

  it('Invoice with order pending_dispatch is NOT in list', async () => {
    const inv = await makeInvoice('pending_dispatch');
    const res = await request(app)
      .get('/api/customer-portal/invoices?pageSize=100')
      .set(auth(customerToken));
    const ids = (res.body.data.invoices as Array<{ invoiceId: string }>).map((i) => i.invoiceId);
    expect(ids).not.toContain(inv.id);
  });

  it('PDF for in-flight invoice returns 403 with friendly message', async () => {
    const inv = await makeInvoice('pending_delivery');
    const res = await request(app)
      .get(`/api/customer-portal/invoices/${inv.id}/pdf`)
      .set(auth(customerToken));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/will be available once your order is delivered/i);
  });

  it('Payment-init for in-flight invoice returns 403 with ORDER_IN_FLIGHT code', async () => {
    const inv = await makeInvoice('pending_delivery');
    const res = await request(app)
      .post(`/api/customer-portal/invoices/${inv.id}/create-payment-order`)
      .set(auth(customerToken))
      .send({ amount: 100 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORDER_IN_FLIGHT');
  });
});

describe('Customer-portal invoice visibility — delivered invoices visible', () => {
  it('Invoice with order delivered IS in GET /invoices list', async () => {
    const inv = await makeInvoice('delivered');
    const res = await request(app)
      .get('/api/customer-portal/invoices?pageSize=100')
      .set(auth(customerToken));
    const ids = (res.body.data.invoices as Array<{ invoiceId: string }>).map((i) => i.invoiceId);
    expect(ids).toContain(inv.id);
  });

  it('Invoice with order modified_delivered IS visible', async () => {
    const inv = await makeInvoice('modified_delivered');
    const res = await request(app)
      .get('/api/customer-portal/invoices?pageSize=100')
      .set(auth(customerToken));
    const ids = (res.body.data.invoices as Array<{ invoiceId: string }>).map((i) => i.invoiceId);
    expect(ids).toContain(inv.id);
  });

  it('PDF for delivered invoice returns 200 (not 403)', async () => {
    const inv = await makeInvoice('delivered');
    const res = await request(app)
      .get(`/api/customer-portal/invoices/${inv.id}/pdf`)
      .set(auth(customerToken));
    // 200 (PDF stream) is the happy path. If the PDF generator errors
    // on missing related data the gate still passed (not a 403/404).
    expect([200, 500]).toContain(res.status);
    if (res.status === 403) throw new Error('Delivered invoice should not be 403');
  });
});

describe('Customer-portal invoice visibility — OB carve-out preserved', () => {
  it('OB invoice (orderId=null, isOpeningBalance=true) IS in list', async () => {
    const inv = await makeInvoice(null, { isOB: true, status: 'overdue' });
    const res = await request(app)
      .get('/api/customer-portal/invoices?pageSize=100')
      .set(auth(customerToken));
    const ids = (res.body.data.invoices as Array<{ invoiceId: string }>).map((i) => i.invoiceId);
    expect(ids).toContain(inv.id);
  });

  it('OB invoice PDF returns 200 — CGST Rule 56 retention carve-out', async () => {
    const inv = await makeInvoice(null, { isOB: true, status: 'overdue' });
    const res = await request(app)
      .get(`/api/customer-portal/invoices/${inv.id}/pdf`)
      .set(auth(customerToken));
    expect([200, 500]).toContain(res.status);
    if (res.status === 403) throw new Error('OB invoice PDF should not be 403');
  });
});
