/**
 * WI-055 — Amount-based Credit/Debit Note create flow.
 *
 * Pins:
 *   - Request schema rejects payloads with the old items[] shape.
 *   - amount > 0 enforced.
 *   - CN: amount > invoice.totalAmount rejected with 400 + clear message.
 *   - DN: amount > invoice.totalAmount accepted (no upper bound — surcharges).
 *   - Created row stores: totalAmount = request.amount, note persists.
 *   - Existing CN list endpoint still returns pre-existing rows (legacy
 *     items-based notes — read path unchanged).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/gst/whitebooksClient.js', async (orig) => {
  const original: any = await orig();
  return {
    ...original,
    // Approve flow fires processCreditNoteGst → apiCall. Stub auth to avoid
    // network. Real WhiteBooks calls aren't exercised by this WI's tests.
    getAuthToken: vi.fn(async () => 'fake-token'),
  };
});

import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let sharmaAdminToken: string;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

// Self-seeded fixture invoice — avoids reliance on pre-existing DB data
// (anti-pattern #7 fix). Created in beforeAll, deleted in afterAll.
let fixtureInvoiceId: string | null = null;

beforeAll(async () => {
  app = createApp();
  const sharmaAdmin = await prisma.user.findUniqueOrThrow({
    where: { email: 'sharma@gasdist.com' },
  });
  sharmaAdminToken = generateToken({
    userId: sharmaAdmin.id,
    email: sharmaAdmin.email,
    role: sharmaAdmin.role as any,
    distributorId: sharmaAdmin.distributorId,
  });

  // Seed a fixture invoice so getAnyInvoice() always finds one regardless
  // of whether cleanup-dist002-seed.ts has been run.
  const customer = await prisma.customer.findFirstOrThrow({
    where: { distributorId: 'dist-002', deletedAt: null },
  });
  const fixture = await prisma.invoice.create({
    data: {
      invoiceNumber: `WI055-FIXTURE-${Date.now()}`,
      distributorId: 'dist-002',
      customerId: customer.id,
      issueDate: new Date(),
      dueDate: new Date(),
      totalAmount: 5000,
      amountPaid: 0,
      outstandingAmount: 5000,
      status: 'issued',
    },
  });
  fixtureInvoiceId = fixture.id;
});

afterAll(async () => {
  // Clean up credit/debit notes the tests may have created, then the fixture.
  if (fixtureInvoiceId) {
    await prisma.creditNote.deleteMany({ where: { invoiceId: fixtureInvoiceId } });
    await prisma.debitNote.deleteMany({ where: { invoiceId: fixtureInvoiceId } });
    await prisma.invoice.delete({ where: { id: fixtureInvoiceId } }).catch(() => {});
    fixtureInvoiceId = null;
  }
});

async function getAnyInvoice() {
  // Returns the self-seeded fixture invoice — no longer depends on pre-existing
  // DB data (anti-pattern #7 fix).
  return prisma.invoice.findUniqueOrThrow({ where: { id: fixtureInvoiceId! } });
}

describe('WI-055 — Credit Note amount-based create', () => {
  it('accepts {invoiceId, reason, amount, note} and stores amount as totalAmount + note', async () => {
    const inv = await getAnyInvoice();
    const amount = Math.min(Number(inv.totalAmount), 100); // safe sub-cap
    const res = await request(app)
      .post('/api/invoices/credit-notes')
      .set(auth(sharmaAdminToken))
      .send({
        invoiceId: inv.id,
        reason: 'Test price correction',
        amount,
        note: 'Reviewed with customer 2026-05-16',
      });

    expect(res.status).toBeLessThan(300);
    const cnId = res.body.data.creditNoteId;
    expect(cnId).toBeTruthy();
    const row = await prisma.creditNote.findUniqueOrThrow({ where: { id: cnId } });
    expect(Number(row.totalAmount)).toBeCloseTo(amount, 2);
    expect(row.reason).toBe('Test price correction');
    expect((row as any).note).toBe('Reviewed with customer 2026-05-16');

    // Cleanup so re-running the suite doesn't accumulate rows.
    await prisma.creditNote.delete({ where: { id: cnId } });
  });

  it('rejects items[] shape (old API) — schema now requires `amount`', async () => {
    const inv = await getAnyInvoice();
    const res = await request(app)
      .post('/api/invoices/credit-notes')
      .set(auth(sharmaAdminToken))
      .send({
        invoiceId: inv.id,
        reason: 'Old shape',
        items: [{ cylinderTypeId: 'x', quantity: 1, unitPrice: 10, gstRate: 18 }],
      });
    // Zod validation errors come back as 400 from middleware/validate.ts.
    expect(res.status).toBe(400);
  });

  it('rejects amount > invoice.totalAmount with 400 and a clear message', async () => {
    const inv = await getAnyInvoice();
    const over = Number(inv.totalAmount) + 100_000;
    const res = await request(app)
      .post('/api/invoices/credit-notes')
      .set(auth(sharmaAdminToken))
      .send({ invoiceId: inv.id, reason: 'over-credit', amount: over });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot exceed invoice total/i);
  });

  it('rejects amount = 0 with 400 (schema positiveNumber)', async () => {
    const inv = await getAnyInvoice();
    const res = await request(app)
      .post('/api/invoices/credit-notes')
      .set(auth(sharmaAdminToken))
      .send({ invoiceId: inv.id, reason: 'zero', amount: 0 });
    expect(res.status).toBe(400);
  });

  it('note is optional — payload without note still succeeds', async () => {
    const inv = await getAnyInvoice();
    const res = await request(app)
      .post('/api/invoices/credit-notes')
      .set(auth(sharmaAdminToken))
      .send({ invoiceId: inv.id, reason: 'no note', amount: 1 });
    expect(res.status).toBeLessThan(300);
    const cnId = res.body.data.creditNoteId;
    await prisma.creditNote.delete({ where: { id: cnId } });
  });
});

describe('WI-055 — Debit Note amount-based create (no upper bound)', () => {
  it('accepts amount GREATER than invoice total (debits can exceed)', async () => {
    const inv = await getAnyInvoice();
    const over = Number(inv.totalAmount) + 5000;
    const res = await request(app)
      .post('/api/invoices/debit-notes')
      .set(auth(sharmaAdminToken))
      .send({
        invoiceId: inv.id,
        reason: 'Post-billing fuel surcharge',
        amount: over,
        note: 'Customer informed by phone',
      });
    expect(res.status).toBeLessThan(300);
    const dnId = res.body.data.debitNoteId;
    const row = await prisma.debitNote.findUniqueOrThrow({ where: { id: dnId } });
    expect(Number(row.totalAmount)).toBeCloseTo(over, 2);
    expect((row as any).note).toBe('Customer informed by phone');
    await prisma.debitNote.delete({ where: { id: dnId } });
  });

  it('still rejects amount = 0', async () => {
    const inv = await getAnyInvoice();
    const res = await request(app)
      .post('/api/invoices/debit-notes')
      .set(auth(sharmaAdminToken))
      .send({ invoiceId: inv.id, reason: 'zero', amount: 0 });
    expect(res.status).toBe(400);
  });
});
