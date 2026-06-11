/**
 * Group 1 (2026-06-11) — Customer portal PDF gate, OB-overdue exception.
 *
 * Pins customerPortal.ts:314-321:
 *   - cancelled/draft OB invoices still 403 (statutory-artefact rule)
 *   - OB invoice with status='overdue' (the importer's default) now passes,
 *     so the customer can download their Opening Balance Certificate.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { prisma } from '../lib/prisma.js';
import { createApp } from '../app.js';
import { generateToken } from './helpers.js';
import { UserRole } from '@gaslink/shared';
import type { Express } from 'express';

let app: Express;
let distributorId: string;
let customerId: string;
let customerToken: string;
const createdInvoiceIds: string[] = [];

beforeAll(async () => {
  app = createApp();
  // Use the seeded customer royal@kitchen.com (dist-001 customer)
  const user = await prisma.user.findUniqueOrThrow({ where: { email: 'royal@kitchen.com' } });
  customerToken = generateToken({
    userId: user.id,
    email: user.email,
    role: UserRole.CUSTOMER,
    distributorId: user.distributorId,
    customerId: user.customerId,
  });
  distributorId = user.distributorId!;
  customerId = user.customerId!;
});

afterAll(async () => {
  await prisma.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
});

beforeEach(async () => {
  if (createdInvoiceIds.length) {
    await prisma.invoice.deleteMany({ where: { id: { in: createdInvoiceIds } } });
    createdInvoiceIds.length = 0;
  }
});

async function seedInvoice(opts: { isOB: boolean; status: 'overdue' | 'cancelled' | 'draft' | 'issued' }) {
  const inv = await prisma.invoice.create({
    data: {
      invoiceNumber: `G1-PORTAL-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`,
      distributorId,
      customerId,
      issueDate: new Date('2099-12-31'),
      dueDate: new Date('2099-12-31'),
      totalAmount: 1000,
      outstandingAmount: 1000,
      amountPaid: 0,
      status: opts.status,
      isOpeningBalance: opts.isOB,
    },
  });
  createdInvoiceIds.push(inv.id);
  return inv;
}

describe('G1 — customer portal /invoices/:id/pdf gate (OB exception)', () => {
  it('positive: OB invoice with status=overdue now downloads (was 403 before)', async () => {
    const inv = await seedInvoice({ isOB: true, status: 'overdue' });
    const res = await request(app)
      .get(`/api/customer-portal/invoices/${inv.id}/pdf`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  it('regression: non-OB invoice with status=overdue still 403', async () => {
    const inv = await seedInvoice({ isOB: false, status: 'overdue' });
    const res = await request(app)
      .get(`/api/customer-portal/invoices/${inv.id}/pdf`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(403);
  });

  it('regression: OB invoice with status=cancelled is still 403 (not statutory)', async () => {
    const inv = await seedInvoice({ isOB: true, status: 'cancelled' });
    const res = await request(app)
      .get(`/api/customer-portal/invoices/${inv.id}/pdf`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(403);
  });

  it('regression: OB invoice with status=draft is still 403 (not yet issued)', async () => {
    const inv = await seedInvoice({ isOB: true, status: 'draft' });
    const res = await request(app)
      .get(`/api/customer-portal/invoices/${inv.id}/pdf`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(403);
  });

  it('regression: regular issued invoice still downloads', async () => {
    const inv = await seedInvoice({ isOB: false, status: 'issued' });
    const res = await request(app)
      .get(`/api/customer-portal/invoices/${inv.id}/pdf`)
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(200);
  });
});
