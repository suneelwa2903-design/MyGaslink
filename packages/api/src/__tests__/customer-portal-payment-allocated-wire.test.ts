/**
 * 3-fix bundle Fix 1 (2026-06-12) — wire-shape guard for the customer-portal
 * payments list. The Payments page renders the "Allocated" column as
 * `formatCurrency(p.allocatedAmount)`; before this fix the column read
 * `₹NaN` because `PaymentTransaction` has no allocatedAmount column —
 * only `allocationStatus` and the joined `allocations[]`. The mapper
 * (utils/mappers.ts > mapPayment) now derives the aggregate from the
 * joined rows so the contract Payment.allocatedAmount + unallocatedAmount
 * is honoured.
 *
 * Anti-pattern #9 guard: this test asserts the wire shape the consumer
 * relies on, so any regression — mapper drop, route bypass, schema
 * rename — surfaces here instead of in a customer's browser.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken } from './helpers.js';
import { UserRole } from '@gaslink/shared';
import type { Express } from 'express';

let app: Express;
let customerToken: string;
let customerId: string;
const createdPaymentIds: string[] = [];
const createdInvoiceIds: string[] = [];
const createdAllocationIds: string[] = [];

beforeAll(async () => {
  app = createApp();
  // Inline customer login — no shared helper exists yet and this is the
  // only test that needs the customer JWT today. Royal Kitchen is the
  // seeded dist-001 customer (royal@kitchen.com).
  const customerUser = await prisma.user.findUniqueOrThrow({
    where: { email: 'royal@kitchen.com' },
  });
  customerId = customerUser.customerId!;
  customerToken = generateToken({
    userId: customerUser.id,
    email: customerUser.email,
    role: customerUser.role as UserRole,
    distributorId: customerUser.distributorId,
    customerId,
  });
  // dist-001 super admin for invoice issuedBy.
  const seedAdminUser = await prisma.user.findFirstOrThrow({
    where: { distributorId: 'dist-001', role: 'distributor_admin' },
  });

  // Seed two invoices so a single payment can split into two allocations.
  const inv1 = await prisma.invoice.create({
    data: {
      invoiceNumber: `WIRE-INV1-${Date.now()}`,
      distributorId: 'dist-001',
      customerId,
      issueDate: new Date('2099-12-31'),
      dueDate: new Date('2099-12-31'),
      totalAmount: 800,
      amountPaid: 0,
      outstandingAmount: 800,
      status: 'issued',
      issuedBy: seedAdminUser.id,
    },
  });
  createdInvoiceIds.push(inv1.id);
  const inv2 = await prisma.invoice.create({
    data: {
      invoiceNumber: `WIRE-INV2-${Date.now()}`,
      distributorId: 'dist-001',
      customerId,
      issueDate: new Date('2099-12-31'),
      dueDate: new Date('2099-12-31'),
      totalAmount: 1200,
      amountPaid: 0,
      outstandingAmount: 1200,
      status: 'issued',
      issuedBy: seedAdminUser.id,
    },
  });
  createdInvoiceIds.push(inv2.id);

  // Payment of 2000: allocate 600+1400 (fully) so allocatedAmount=2000,
  // unallocatedAmount=0, allocationStatus=fully_allocated.
  const fullyAllocated = await prisma.paymentTransaction.create({
    data: {
      distributorId: 'dist-001',
      customerId,
      amount: 2000,
      paymentMethod: 'cash',
      transactionDate: new Date('2099-12-31'),
      allocationStatus: 'fully_allocated',
      receivedBy: seedAdminUser.id,
      allocations: {
        create: [
          { invoiceId: inv1.id, allocatedAmount: 600 },
          { invoiceId: inv2.id, allocatedAmount: 1400 },
        ],
      },
    },
    include: { allocations: true },
  });
  createdPaymentIds.push(fullyAllocated.id);
  createdAllocationIds.push(...fullyAllocated.allocations.map((a) => a.id));

  // Payment of 1500 partially allocated (700) → unallocated=800.
  const partial = await prisma.paymentTransaction.create({
    data: {
      distributorId: 'dist-001',
      customerId,
      amount: 1500,
      paymentMethod: 'upi',
      transactionDate: new Date('2099-12-31'),
      allocationStatus: 'partially_allocated',
      receivedBy: seedAdminUser.id,
      allocations: { create: [{ invoiceId: inv1.id, allocatedAmount: 700 }] },
    },
    include: { allocations: true },
  });
  createdPaymentIds.push(partial.id);
  createdAllocationIds.push(...partial.allocations.map((a) => a.id));

  // Unallocated payment of 500 → allocatedAmount=0, unallocatedAmount=500.
  const unallocated = await prisma.paymentTransaction.create({
    data: {
      distributorId: 'dist-001',
      customerId,
      amount: 500,
      paymentMethod: 'cash',
      transactionDate: new Date('2099-12-31'),
      allocationStatus: 'unallocated',
      receivedBy: seedAdminUser.id,
    },
  });
  createdPaymentIds.push(unallocated.id);
});

afterAll(async () => {
  if (createdAllocationIds.length) {
    await prisma.paymentAllocation.deleteMany({ where: { id: { in: createdAllocationIds } } });
  }
  if (createdPaymentIds.length) {
    await prisma.paymentTransaction.deleteMany({ where: { id: { in: createdPaymentIds } } });
  }
  if (createdInvoiceIds.length) {
    await prisma.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
  }
});

describe('GET /api/customer-portal/payments — Allocated wire shape', () => {
  it('each payment row carries numeric allocatedAmount + unallocatedAmount (never undefined → ₹NaN in the table)', async () => {
    const res = await request(app)
      .get('/api/customer-portal/payments?page=1&pageSize=50')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(200);
    const payments: Array<{ paymentId: string; amount: number | string; allocatedAmount: unknown; unallocatedAmount: unknown }> =
      res.body?.data?.payments ?? [];
    expect(payments.length).toBeGreaterThanOrEqual(3);
    for (const p of payments) {
      expect(typeof p.allocatedAmount).toBe('number');
      expect(typeof p.unallocatedAmount).toBe('number');
      expect(Number.isFinite(p.allocatedAmount as number)).toBe(true);
      expect(Number.isFinite(p.unallocatedAmount as number)).toBe(true);
    }
  });

  it('fully-allocated payment (2 allocations totalling the payment amount): allocatedAmount = sum of allocs, unallocated = 0', async () => {
    const res = await request(app)
      .get('/api/customer-portal/payments?page=1&pageSize=50')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(200);
    const row = (res.body?.data?.payments ?? []).find((p: { paymentId: string }) => p.paymentId === createdPaymentIds[0]);
    expect(row).toBeDefined();
    expect(Number(row.amount)).toBe(2000);
    expect(row.allocatedAmount).toBe(2000);
    expect(row.unallocatedAmount).toBe(0);
  });

  it('partially-allocated payment: allocatedAmount = single alloc, unallocatedAmount = amount − allocated', async () => {
    const res = await request(app)
      .get('/api/customer-portal/payments?page=1&pageSize=50')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(200);
    const row = (res.body?.data?.payments ?? []).find((p: { paymentId: string }) => p.paymentId === createdPaymentIds[1]);
    expect(row).toBeDefined();
    expect(Number(row.amount)).toBe(1500);
    expect(row.allocatedAmount).toBe(700);
    expect(row.unallocatedAmount).toBe(800);
  });

  it('unallocated payment (no allocations row): allocatedAmount = 0, unallocatedAmount = payment amount', async () => {
    const res = await request(app)
      .get('/api/customer-portal/payments?page=1&pageSize=50')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(200);
    const row = (res.body?.data?.payments ?? []).find((p: { paymentId: string }) => p.paymentId === createdPaymentIds[2]);
    expect(row).toBeDefined();
    expect(Number(row.amount)).toBe(500);
    expect(row.allocatedAmount).toBe(0);
    expect(row.unallocatedAmount).toBe(500);
  });

  it('razorpaySignature is NEVER surfaced (defensive guard for Phase F secret-leak rule)', async () => {
    const res = await request(app)
      .get('/api/customer-portal/payments?page=1&pageSize=50')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(200);
    for (const p of res.body?.data?.payments ?? []) {
      expect(p).not.toHaveProperty('razorpaySignature');
    }
  });
});
